import test from "node:test";
import assert from "node:assert/strict";
import {
    REQUIRED_GAMEPLAY_QUANTITATIVE_IDS,
    createFinancialCanonicalGameplayRegistry
} from "../src/financial-canonical-gameplay-registry.js";
import { createPlayFabEconomyV2GameplayWriteAdapter } from "../src/playfab-economy-v2-gameplay-write-adapter.js";
import {
    createFinancialGameplayWriteJournal,
    createMemoryFinancialGameplayWriteJournalStore
} from "../src/financial-gameplay-write-journal.js";
import { createFinancialGameplayWriteService } from "../src/financial-gameplay-write-service.js";
import { createFinancialGameplayWriteHttpHandler } from "../src/financial-gameplay-write-http.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";

const CURRENCIES = new Set(["gold", "diamonds", "siren_tears", "elite_points"]);

function registry() {
    return createFinancialCanonicalGameplayRegistry({
        catalogMappings: Object.fromEntries(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.map((resourceId) => [
            resourceId,
            {
                kind: CURRENCIES.has(resourceId) ? "currency" : "inventory",
                itemId: `test_${resourceId}`,
                stackId: "default"
            }
        ]))
    });
}

function provider(registryValue, initial = {}, { ambiguousAfterApplyOnce = false } = {}) {
    const quantities = Object.fromEntries(registryValue.quantityIds.map((id) => [id, initial[id] ?? 0]));
    const resourceByTarget = new Map(registryValue.quantityIds.map((resourceId) => {
        const mapping = registryValue.descriptor(resourceId).economy;
        return [`${mapping.itemId}\u0000${mapping.stackId}`, resourceId];
    }));
    const idempotency = new Map();
    let etagVersion = 1;
    let ambiguity = ambiguousAfterApplyOnce;
    const state = {
        quantities,
        get etag() { return `etag-${etagVersion}`; },
        executeCalls: 0,
        appliedMutations: 0,
        lastRequest: null
    };
    const client = {
        async getUserAccountInfo(playFabId) {
            return { UserInfo: { PlayFabId: playFabId, TitleInfo: { TitlePlayerAccount: { Id: `entity_${playFabId}` } } } };
        },
        async getEntityToken() {
            return { EntityToken: "test_entity_token" };
        },
        async executeInventoryOperations(_entityToken, request) {
            state.executeCalls += 1;
            state.lastRequest = structuredClone(request);
            if (idempotency.has(request.IdempotencyId)) {
                return structuredClone(idempotency.get(request.IdempotencyId));
            }
            const next = { ...state.quantities };
            for (const operation of request.Operations) {
                const mutation = operation.Add || operation.Subtract;
                const resourceId = resourceByTarget.get(`${mutation.Item.Id}\u0000${mutation.Item.StackId}`);
                if (!resourceId) throw new Error("unknown provider mapping");
                next[resourceId] += operation.Add ? mutation.Amount : -mutation.Amount;
                if (!Number.isSafeInteger(next[resourceId]) || next[resourceId] < 0) {
                    const error = new Error("provider insufficient balance");
                    error.code = "PLAYFAB_ECONOMY_INSUFFICIENT";
                    throw error;
                }
            }
            Object.assign(state.quantities, next);
            etagVersion += 1;
            state.appliedMutations += 1;
            const evidence = {
                IdempotencyId: request.IdempotencyId,
                ETag: state.etag,
                TransactionIds: [`tx-${state.appliedMutations}`]
            };
            idempotency.set(request.IdempotencyId, structuredClone(evidence));
            if (ambiguity) {
                ambiguity = false;
                const error = new Error("connection closed after provider commit");
                error.code = "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS";
                error.retryable = true;
                error.ambiguous = true;
                throw error;
            }
            return structuredClone(evidence);
        }
    };
    return { state, client };
}

function intentResolver({ actionId, eventId, context }) {
    const plans = {
        earn_diamonds: [{ resourceId: "diamonds", delta: context.units ?? 10 }],
        spend_diamonds: [{ resourceId: "diamonds", delta: -(context.units ?? 5) }],
        market_exchange: [
            { resourceId: "diamonds", delta: -25 },
            { resourceId: "elite_ball", delta: 3 }
        ]
    };
    return {
        authorized: Object.hasOwn(plans, actionId),
        serverAuthority: "financial_gameplay_v2",
        actionId,
        eventId,
        reason: actionId,
        operations: plans[actionId] || []
    };
}

function harness({ initial = {}, ambiguousAfterApplyOnce = false, clock, hooks } = {}) {
    const canonicalRegistry = registry();
    const fakeProvider = provider(canonicalRegistry, initial, { ambiguousAfterApplyOnce });
    const economy = createPlayFabEconomyV2GameplayWriteAdapter({
        client: fakeProvider.client,
        registry: canonicalRegistry,
        nowMilliseconds: () => clock?.value ?? Date.now()
    });
    const journal = createFinancialGameplayWriteJournal({
        store: createMemoryFinancialGameplayWriteJournalStore(),
        nowMilliseconds: () => clock?.value ?? Date.now()
    });
    const leases = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => clock?.value ?? Date.now()
    });
    const reader = {
        async readFinancialV2(playFabId) {
            return {
                playFabId,
                economyV2Etag: fakeProvider.state.etag,
                economyV2Quantities: structuredClone(fakeProvider.state.quantities),
                authorityV2: { migrated: true }
            };
        }
    };
    const service = createFinancialGameplayWriteService({
        registry: canonicalRegistry,
        resolveIntent: intentResolver,
        reader,
        economy,
        journal,
        leases,
        workerId: "test_financial_gameplay_worker",
        leaseTtlMilliseconds: 1000,
        tokenFactory: (() => { let value = 0; return () => `lease_${++value}`; })(),
        hooks
    });
    return { canonicalRegistry, fakeProvider, economy, journal, leases, reader, service };
}

const identity = (playFabId = "PLAYFAB_TEST_1") => ({
    authenticated: true,
    authenticationType: "PlayFabSessionTicket",
    playFabId
});

test("Economy adapter maps every canonical quantity and atomically Add/Subtracts with IdempotencyId only", async () => {
    const canonicalRegistry = registry();
    const fakeProvider = provider(canonicalRegistry, Object.fromEntries(
        canonicalRegistry.quantityIds.map((id) => [id, 1])
    ));
    const adapter = createPlayFabEconomyV2GameplayWriteAdapter({ client: fakeProvider.client, registry: canonicalRegistry });
    const operations = canonicalRegistry.quantityIds.map((resourceId, index) => ({
        resourceId,
        delta: index % 2 === 0 ? 2 : -1
    }));
    const result = await adapter.mutate({
        playFabId: "P1",
        operationId: "operation_exhaustive_1",
        eventId: "event_exhaustive_1",
        reason: "test_exhaustive",
        idempotencyCreatedAtUtc: new Date().toISOString(),
        fencingToken: 7,
        operations
    });
    assert.equal(result.status, "confirmed");
    assert.equal(fakeProvider.state.lastRequest.Operations.length, REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.length);
    assert.equal(fakeProvider.state.lastRequest.IdempotencyId, "operation_exhaustive_1");
    assert.equal(Object.hasOwn(fakeProvider.state.lastRequest, "ETag"), false);
    assert.equal(fakeProvider.state.lastRequest.CustomTags.fencingToken, "7");
    for (const [index, resourceId] of canonicalRegistry.quantityIds.entries()) {
        assert.equal(fakeProvider.state.quantities[resourceId], index % 2 === 0 ? 3 : 0);
    }
});

test("service accepts only authenticated PlayFab session identity", async () => {
    const { service } = harness();
    await assert.rejects(
        service.execute({ request: { actionId: "earn_diamonds", eventId: "e1", context: {} } }),
        (error) => error.code === "AUTHENTICATION_REQUIRED" && error.statusCode === 401
    );
});

test("service rejects client balances, mappings, deltas, costs and spoofed PlayFabId before resolution", async () => {
    const { service, fakeProvider } = harness();
    for (const malicious of [
        { operations: [{ resourceId: "diamonds", delta: 999999 }] },
        { balances: { diamonds: 999999 } },
        { mappings: { diamonds: "attacker_item" } },
        { costs: { diamonds: -1 } },
        { playFabId: "VICTIM" },
        { context: { nested: { balance: 999999 } } }
    ]) {
        await assert.rejects(
            service.execute({
                identity: identity(),
                request: { actionId: "earn_diamonds", eventId: `evil_${Object.keys(malicious)[0]}`, context: {}, ...malicious }
            }),
            (error) => error.code === "FORBIDDEN_CLIENT_ECONOMY_INPUT"
        );
    }
    assert.equal(fakeProvider.state.executeCalls, 0);
});

test("authoritative resolver plan applies exact debit and credit atomically", async () => {
    const { service, fakeProvider } = harness({ initial: { diamonds: 100, elite_ball: 4 } });
    const result = await service.execute({
        identity: identity(),
        request: { actionId: "market_exchange", eventId: "market_event_1", context: { offer: "elite_bundle" } }
    });
    assert.equal(result.status, "completed");
    assert.equal(fakeProvider.state.quantities.diamonds, 75);
    assert.equal(fakeProvider.state.quantities.elite_ball, 7);
    assert.equal(fakeProvider.state.appliedMutations, 1);
    assert.equal(fakeProvider.state.lastRequest.Operations.length, 2);
});

test("non-negative preflight refuses insufficient authoritative costs without a provider call", async () => {
    const { service, fakeProvider } = harness({ initial: { diamonds: 24 } });
    await assert.rejects(
        service.execute({
            identity: identity(),
            request: { actionId: "market_exchange", eventId: "market_event_insufficient", context: {} }
        }),
        (error) => error.code === "INSUFFICIENT_BALANCE" && error.statusCode === 409
    );
    assert.equal(fakeProvider.state.executeCalls, 0);
    assert.equal(fakeProvider.state.quantities.diamonds, 24);
});

test("completed replay returns the immutable result without a second provider mutation", async () => {
    const { service, fakeProvider } = harness();
    const request = { actionId: "earn_diamonds", eventId: "quest_event_replay", context: { units: 10 } };
    const first = await service.execute({ identity: identity(), request });
    const replay = await service.execute({ identity: identity(), request });
    assert.equal(first.status, "completed");
    assert.equal(replay.status, "already_completed");
    assert.equal(replay.operationId, first.operationId);
    assert.equal(fakeProvider.state.quantities.diamonds, 10);
    assert.equal(fakeProvider.state.appliedMutations, 1);
    assert.equal(fakeProvider.state.executeCalls, 1);
});

test("operationId binds event context immutably and rejects a changed replay", async () => {
    const { service } = harness();
    await service.execute({
        identity: identity(),
        request: { actionId: "earn_diamonds", eventId: "quest_context_bound", context: { units: 10 } }
    });
    await assert.rejects(
        service.execute({
            identity: identity(),
            request: { actionId: "earn_diamonds", eventId: "quest_context_bound", context: { units: 20 } }
        }),
        (error) => error.code === "IDEMPOTENCY_CONFLICT"
    );
});

test("ambiguous timeout after provider commit reconciles by identical idempotent replay without double grant", async () => {
    const { service, fakeProvider, journal } = harness({ ambiguousAfterApplyOnce: true });
    const request = { actionId: "earn_diamonds", eventId: "ambiguous_event_1", context: { units: 12 } };
    await assert.rejects(
        service.execute({ identity: identity(), request }),
        (error) => error.code === "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS" && error.retryable === true
    );
    assert.equal(fakeProvider.state.quantities.diamonds, 12);
    assert.equal(fakeProvider.state.appliedMutations, 1);
    const completed = await service.execute({ identity: identity(), request });
    assert.equal(completed.status, "completed");
    assert.equal(fakeProvider.state.quantities.diamonds, 12);
    assert.equal(fakeProvider.state.appliedMutations, 1);
    assert.equal(fakeProvider.state.executeCalls, 2);
    assert.equal((await journal.get("PLAYFAB_TEST_1", completed.operationId)).state, "Completed");
});

test("ten concurrent replays produce one lease winner and one provider mutation", async () => {
    const { service, fakeProvider } = harness();
    const request = { actionId: "earn_diamonds", eventId: "concurrent_event_1", context: { units: 9 } };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
        service.execute({ identity: identity(), request })
    ));
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.ok(results.filter((entry) => entry.status === "rejected")
        .every((entry) => entry.reason.code === "PLAYER_LEASE_BUSY"));
    assert.equal(fakeProvider.state.quantities.diamonds, 9);
    assert.equal(fakeProvider.state.appliedMutations, 1);
    const replay = await service.execute({ identity: identity(), request });
    assert.equal(replay.status, "already_completed");
});

test("two simultaneous transactions for one player serialize through retry with exact final sum", async () => {
    const { service, fakeProvider } = harness({ initial: { diamonds: 100 } });
    const requests = [
        { actionId: "earn_diamonds", eventId: "parallel_earn", context: { units: 10 } },
        { actionId: "spend_diamonds", eventId: "parallel_spend", context: { units: 5 } }
    ];
    const firstPass = await Promise.allSettled(requests.map((request) =>
        service.execute({ identity: identity(), request })
    ));
    const failedIndex = firstPass.findIndex((entry) => entry.status === "rejected");
    assert.notEqual(failedIndex, -1);
    assert.equal(firstPass[failedIndex].reason.code, "PLAYER_LEASE_BUSY");
    await service.execute({ identity: identity(), request: requests[failedIndex] });
    assert.equal(fakeProvider.state.quantities.diamonds, 105);
    assert.equal(fakeProvider.state.appliedMutations, 2);
});

test("expired player lease fences a stale worker before provider, then a newer epoch safely resumes", async () => {
    const clock = { value: Date.now() };
    let leases;
    let stole = false;
    const built = harness({
        clock,
        hooks: {
            async beforeProvider({ playFabId }) {
                if (stole) return;
                stole = true;
                clock.value += 2000;
                const acquired = await leases.acquireResourceLease({
                    resourceType: "financial_gameplay_player",
                    resourceId: playFabId,
                    owner: "new_worker",
                    token: "new_worker_token",
                    ttlMilliseconds: 1000
                });
                assert.equal(acquired.status, "acquired");
                await leases.releaseResourceLease({
                    resourceType: "financial_gameplay_player",
                    resourceId: playFabId,
                    token: "new_worker_token"
                });
            }
        }
    });
    leases = built.leases;
    const request = { actionId: "earn_diamonds", eventId: "fencing_event_1", context: { units: 8 } };
    await assert.rejects(
        built.service.execute({ identity: identity(), request }),
        (error) => error.code === "PLAYER_LEASE_LOST"
    );
    assert.equal(built.fakeProvider.state.executeCalls, 0);
    const result = await built.service.execute({ identity: identity(), request });
    assert.equal(result.status, "completed");
    assert.equal(built.fakeProvider.state.quantities.diamonds, 8);
    assert.equal(built.fakeProvider.state.appliedMutations, 1);
});

test("journal rejects stale fencing and forbids Completed without provider evidence", async () => {
    const journal = createFinancialGameplayWriteJournal({ store: createMemoryFinancialGameplayWriteJournalStore() });
    await journal.begin({
        playFabId: "P1",
        operationId: "op1",
        eventId: "event1",
        actionId: "action1",
        reason: "test_reason",
        operations: [{ resourceId: "diamonds", delta: 1 }],
        requestHash: "a".repeat(64)
    });
    await journal.claim({ playFabId: "P1", operationId: "op1", leaseToken: "lease2", fencingEpoch: 2 });
    await assert.rejects(
        journal.claim({ playFabId: "P1", operationId: "op1", leaseToken: "lease1", fencingEpoch: 1 }),
        (error) => error.code === "STALE_FENCING_EPOCH"
    );
    await assert.rejects(
        journal.complete({ playFabId: "P1", operationId: "op1", leaseToken: "lease2", fencingEpoch: 2, result: {} }),
        (error) => error.code === "INVALID_JOURNAL_STATE"
    );
});

function responseCapture() {
    return {
        statusCode: null,
        body: null,
        headers: {},
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
        set(name, value) { this.headers[name] = value; return this; }
    };
}

test("unwired HTTP handler authenticates session ticket and rejects identity spoofing", async () => {
    const { service } = harness();
    const logs = { warn() {}, error() {} };
    const handler = createFinancialGameplayWriteHttpHandler({
        authenticateSessionTicket: async (ticket) => ticket === "valid_ticket" ? { playFabId: "AUTHENTICATED_PLAYER" } : null,
        service,
        logger: logs
    });
    const invalid = responseCapture();
    await handler({ method: "POST", headers: { "x-playfab-sessionticket": "invalid" }, body: {} }, invalid);
    assert.equal(invalid.statusCode, 401);

    const spoof = responseCapture();
    await handler({
        method: "POST",
        headers: { "x-playfab-sessionticket": "valid_ticket" },
        body: { actionId: "earn_diamonds", eventId: "http_spoof", context: {}, playFabId: "VICTIM" }
    }, spoof);
    assert.equal(spoof.statusCode, 400);
    assert.equal(spoof.body.code, "FORBIDDEN_CLIENT_ECONOMY_INPUT");

    const valid = responseCapture();
    await handler({
        method: "POST",
        headers: { "x-playfab-sessionticket": "valid_ticket" },
        body: { actionId: "earn_diamonds", eventId: "http_valid", context: { units: 4 } }
    }, valid);
    assert.equal(valid.statusCode, 201);
    assert.equal(valid.body.status, "completed");
});

test("HTTP handler preserves a bounded provider Retry-After", async () => {
    const handler = createFinancialGameplayWriteHttpHandler({
        authenticateSessionTicket: async () => ({ playFabId: "AUTHENTICATED_PLAYER" }),
        service: {
            async execute() {
                const error = new Error("rate limited");
                error.code = "PLAYFAB_RATE_LIMITED";
                error.retryable = true;
                error.retryAfterMilliseconds = 2501;
                throw error;
            }
        },
        logger: { warn() {}, error() {} }
    });
    const response = responseCapture();
    await handler({
        method: "POST",
        headers: { "x-playfab-sessionticket": "valid_ticket" },
        body: { actionId: "earn_diamonds", eventId: "http_rate_limit", context: {} }
    }, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["Retry-After"], "3");
});
