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
import { createFinancialGameplayAuthoritativeWriteService } from "../src/financial-gameplay-authoritative-write-service.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";

const CURRENCIES = new Set(["gold", "diamonds", "siren_tears", "elite_points"]);

function registry() {
    return createFinancialCanonicalGameplayRegistry({
        catalogMappings: Object.fromEntries(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.map((resourceId) => [
            resourceId,
            {
                kind: CURRENCIES.has(resourceId) ? "currency" : "inventory",
                itemId: `authority_test_${resourceId}`,
                stackId: "default"
            }
        ]))
    });
}

const identity = {
    authenticated: true,
    authenticationType: "PlayFabSessionTicket",
    playFabId: "AUTHORITY_TEST_PLAYER"
};

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

function zeroQuantities(canonicalRegistry) {
    return Object.fromEntries(canonicalRegistry.quantityIds.map((resourceId) => [resourceId, 0]));
}

test("authoritative composition normalizes shared ledger lease loss and calls no provider", async () => {
    const canonicalRegistry = registry();
    let providerCalls = 0;
    const service = createFinancialGameplayAuthoritativeWriteService({
        registry: canonicalRegistry,
        resolveIntent: resolver,
        reader: {
            async readFinancialV2(playFabId) {
                return {
                    playFabId,
                    economyV2Etag: "etag-1",
                    economyV2Quantities: zeroQuantities(canonicalRegistry),
                    authorityV2: { migrated: true }
                };
            }
        },
        economy: { async mutate() { providerCalls += 1; } },
        journal: createFinancialGameplayWriteJournal({ store: createMemoryFinancialGameplayWriteJournalStore() }),
        leases: {
            async acquireResourceLease() { return { status: "acquired", lease: { epoch: 1 } }; },
            async renewResourceLease() { const error = new Error("expired"); error.code = "LEASE_LOST"; throw error; },
            async releaseResourceLease() { return { status: "released" }; }
        },
        workerId: "authority_lease_test",
        leaseTtlMilliseconds: 1000,
        tokenFactory: () => "authority_lease_token"
    });
    await assert.rejects(
        service.execute({
            identity,
            request: { actionId: "quest_reward", eventId: "lease_expiry_event", context: {} }
        }),
        (error) => error.code === "PLAYER_LEASE_LOST" && error.retryable === true
    );
    assert.equal(providerCalls, 0);
});

test("unknown reconciliation-read failure stays Pending and resumes via identical provider idempotency", async () => {
    const canonicalRegistry = registry();
    const state = { quantities: zeroQuantities(canonicalRegistry), etag: "etag-1", applied: 0 };
    const idempotency = new Map();
    let reads = 0;
    const economy = {
        async mutate(request) {
            if (idempotency.has(request.operationId)) return structuredClone(idempotency.get(request.operationId));
            state.quantities.diamonds += 10;
            state.etag = "etag-2";
            state.applied += 1;
            const evidence = {
                operationId: request.operationId,
                etag: state.etag,
                transactionIds: ["provider_tx_1"]
            };
            idempotency.set(request.operationId, evidence);
            return structuredClone(evidence);
        }
    };
    const reader = {
        async readFinancialV2(playFabId) {
            reads += 1;
            if (reads === 2) throw new Error("socket closed while reconciling");
            return {
                playFabId,
                economyV2Etag: state.etag,
                economyV2Quantities: structuredClone(state.quantities),
                authorityV2: { migrated: true }
            };
        }
    };
    const journal = createFinancialGameplayWriteJournal({ store: createMemoryFinancialGameplayWriteJournalStore() });
    const service = createFinancialGameplayAuthoritativeWriteService({
        registry: canonicalRegistry,
        resolveIntent: resolver,
        reader,
        economy,
        journal,
        leases: createPaymentLedger({ store: createMemoryPaymentLedgerStore() }),
        workerId: "authority_reconciliation_test",
        leaseTtlMilliseconds: 1000,
        tokenFactory: (() => { let value = 0; return () => `authority_retry_lease_${++value}`; })()
    });
    const request = { actionId: "quest_reward", eventId: "reconciliation_event", context: {} };
    await assert.rejects(
        service.execute({ identity, request }),
        (error) => error.code === "FINANCIAL_READ_UNAVAILABLE" && error.retryable === true && error.ambiguous === true
    );
    assert.equal(state.applied, 1);
    assert.equal(state.quantities.diamonds, 10);
    const completed = await service.execute({ identity, request });
    assert.equal(completed.status, "completed");
    assert.equal(state.applied, 1);
    assert.equal(state.quantities.diamonds, 10);
    assert.equal((await journal.get(identity.playFabId, completed.operationId)).state, "Completed");
});
