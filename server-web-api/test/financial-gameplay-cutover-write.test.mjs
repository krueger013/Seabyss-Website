import test from "node:test";
import assert from "node:assert/strict";
import {
    REQUIRED_GAMEPLAY_QUANTITATIVE_IDS,
    createFinancialCanonicalGameplayRegistry
} from "../src/financial-canonical-gameplay-registry.js";
import {
    createFinancialGameplayWriteJournal,
    createMemoryFinancialGameplayWriteJournalStore
} from "../src/financial-gameplay-write-journal.js";
import {
    createFinancialGameplayCutoverWriteService,
    FINANCIAL_GAMEPLAY_SHARED_PLAYER_LEASE_TYPE
} from "../src/financial-gameplay-cutover-write-service.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";

const PLAYER = "CUTOVER_PLAYER_1";
const CURRENCIES = new Set(["gold", "diamonds", "siren_tears", "elite_points"]);

function registry() {
    return createFinancialCanonicalGameplayRegistry({
        catalogMappings: Object.fromEntries(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.map((resourceId) => [
            resourceId,
            {
                kind: CURRENCIES.has(resourceId) ? "currency" : "inventory",
                itemId: `cutover_test_${resourceId}`,
                stackId: "default"
            }
        ]))
    });
}

function quantities(canonicalRegistry, diamonds = 0) {
    return Object.fromEntries(canonicalRegistry.quantityIds.map((resourceId) => [
        resourceId,
        resourceId === "diamonds" ? diamonds : 0
    ]));
}

function resolver({ actionId, eventId }) {
    return {
        authorized: true,
        serverAuthority: "financial_gameplay_v2",
        actionId,
        eventId,
        reason: "quest_reward",
        operations: [{ resourceId: "diamonds", delta: 10 }]
    };
}

const identity = {
    authenticated: true,
    authenticationType: "PlayFabSessionTicket",
    playFabId: PLAYER
};

function journal() {
    return createFinancialGameplayWriteJournal({
        store: createMemoryFinancialGameplayWriteJournalStore()
    });
}

test("gameplay and payment worker contend on the exact shared playfab-profile lease", async () => {
    assert.equal(FINANCIAL_GAMEPLAY_SHARED_PLAYER_LEASE_TYPE, "playfab-profile");
    const canonicalRegistry = registry();
    const state = { diamonds: 0, etag: "etag-1", providerCalls: 0 };
    const leases = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
    const paymentLease = await leases.acquireResourceLease({
        resourceType: "playfab-profile",
        resourceId: PLAYER,
        owner: "payment_worker",
        token: "payment_worker_token",
        ttlMilliseconds: 30_000
    });
    assert.equal(paymentLease.status, "acquired");
    const service = createFinancialGameplayCutoverWriteService({
        registry: canonicalRegistry,
        resolveIntent: resolver,
        reader: {
            async readFinancialV2(playFabId) {
                return {
                    playFabId,
                    economyV2Etag: state.etag,
                    economyV2Quantities: quantities(canonicalRegistry, state.diamonds),
                    authorityV2: { migrated: true }
                };
            }
        },
        economy: {
            async mutate() {
                state.providerCalls += 1;
                state.diamonds += 10;
                state.etag = "etag-2";
                return { etag: state.etag, transactionIds: ["shared_lease_tx"] };
            }
        },
        journal: journal(),
        leases,
        workerId: "gameplay_worker",
        leaseTtlMilliseconds: 1000,
        tokenFactory: (() => { let value = 0; return () => `gameplay_lease_${++value}`; })(),
        reconciliationBackoffMilliseconds: 10,
        wait: async () => {}
    });
    const request = { actionId: "quest_reward", eventId: "shared_lease_event", context: {} };
    await assert.rejects(
        service.execute({ identity, request }),
        (error) => error.code === "PLAYER_LEASE_BUSY"
    );
    assert.equal(state.providerCalls, 0);
    await leases.releaseResourceLease({
        resourceType: "playfab-profile",
        resourceId: PLAYER,
        token: "payment_worker_token"
    });
    const result = await service.execute({ identity, request });
    assert.equal(result.status, "completed");
    assert.equal(state.providerCalls, 1);
    assert.equal(state.diamonds, 10);
});

test("eventually-consistent Economy read retries with bounded injectable backoff before Completed", async () => {
    const canonicalRegistry = registry();
    let reads = 0;
    let providerCalls = 0;
    const waits = [];
    const durableJournal = journal();
    const service = createFinancialGameplayCutoverWriteService({
        registry: canonicalRegistry,
        resolveIntent: resolver,
        reader: {
            async readFinancialV2(playFabId) {
                reads += 1;
                const caughtUp = reads >= 3;
                return {
                    playFabId,
                    economyV2Etag: caughtUp ? "etag-2" : "etag-1",
                    economyV2Quantities: quantities(canonicalRegistry, caughtUp ? 10 : 0),
                    authorityV2: { migrated: true }
                };
            }
        },
        economy: {
            async mutate() {
                providerCalls += 1;
                return { etag: "etag-2", transactionIds: ["eventual_tx"] };
            }
        },
        journal: durableJournal,
        leases: createPaymentLedger({ store: createMemoryPaymentLedgerStore() }),
        workerId: "eventual_consistency_worker",
        leaseTtlMilliseconds: 1000,
        tokenFactory: () => "eventual_consistency_lease",
        reconciliationAttempts: 4,
        reconciliationBackoffMilliseconds: 10,
        wait: async (milliseconds) => { waits.push(milliseconds); }
    });
    const result = await service.execute({
        identity,
        request: { actionId: "quest_reward", eventId: "eventual_read_event", context: {} }
    });
    assert.equal(result.status, "completed");
    assert.equal(providerCalls, 1);
    assert.equal(reads, 3);
    assert.deepEqual(waits, [10]);
    assert.equal((await durableJournal.get(PLAYER, result.operationId)).state, "Completed");
});

test("shared lease expiry is normalized to PLAYER_LEASE_LOST and blocks provider", async () => {
    const canonicalRegistry = registry();
    let providerCalls = 0;
    const observedResourceTypes = [];
    const leases = {
        async acquireResourceLease(input) {
            observedResourceTypes.push(input.resourceType);
            return { status: "acquired", lease: { epoch: 1 } };
        },
        async renewResourceLease(input) {
            observedResourceTypes.push(input.resourceType);
            const error = new Error("expired shared lease");
            error.code = "LEASE_LOST";
            throw error;
        },
        async releaseResourceLease(input) {
            observedResourceTypes.push(input.resourceType);
            return { status: "released" };
        }
    };
    const service = createFinancialGameplayCutoverWriteService({
        registry: canonicalRegistry,
        resolveIntent: resolver,
        reader: {
            async readFinancialV2(playFabId) {
                return {
                    playFabId,
                    economyV2Etag: "etag-1",
                    economyV2Quantities: quantities(canonicalRegistry),
                    authorityV2: { migrated: true }
                };
            }
        },
        economy: { async mutate() { providerCalls += 1; } },
        journal: journal(),
        leases,
        workerId: "lease_loss_worker",
        leaseTtlMilliseconds: 1000,
        tokenFactory: () => "lease_loss_token",
        reconciliationBackoffMilliseconds: 10,
        wait: async () => {}
    });
    await assert.rejects(
        service.execute({
            identity,
            request: { actionId: "quest_reward", eventId: "lease_loss_event", context: {} }
        }),
        (error) => error.code === "PLAYER_LEASE_LOST" && error.retryable === true
    );
    assert.equal(providerCalls, 0);
    assert.ok(observedResourceTypes.length >= 3);
    assert.ok(observedResourceTypes.every((resourceType) => resourceType === "playfab-profile"));
});
