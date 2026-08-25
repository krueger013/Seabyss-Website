import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";

const planHash = "a".repeat(64);

function harness(start = 1_000) {
    let clock = start;
    const store = createMemoryPaymentLedgerStore();
    const ledger = createPaymentLedger({ store, nowMilliseconds: () => clock });
    return {
        ledger,
        now: () => clock,
        advance(milliseconds) { clock += milliseconds; }
    };
}

function transaction(providerTransactionId = "2119000001", overrides = {}) {
    return {
        provider: "xsolla",
        providerTransactionId,
        orderId: `order-${providerTransactionId}`,
        receiptId: `receipt-${providerTransactionId}`,
        playFabId: "4DF88C225D91FE06",
        sku: "seabyss_starter_pack_1",
        planVersion: 1,
        planHash,
        amountMinor: 399,
        currency: "USD",
        environment: "sandbox",
        createdAtUnixMs: 900,
        ...overrides
    };
}

describe("central payment ledger", () => {
    test("provider + providerTransactionId is globally unique and immutable", async () => {
        const { ledger } = harness();
        const results = await Promise.all(Array.from({ length: 10 }, () =>
            ledger.createTransaction(transaction())));
        assert.equal(results.filter((result) => result.status === "created").length, 1);
        assert.equal(results.filter((result) => result.status === "existing").length, 9);
        await assert.rejects(
            ledger.createTransaction(transaction("2119000001", { amountMinor: 699 })),
            (error) => error.code === "IMMUTABLE_CONFLICT"
        );
        const stored = await ledger.requireTransaction(transaction());
        assert.equal(stored.amountMinor, 399);
        assert.equal(stored.version, 1);
    });

    test("order, receipt, user, and SKU indexes are paginated", async () => {
        const { ledger } = harness();
        await Promise.all([
            ledger.createTransaction(transaction("2119000010")),
            ledger.createTransaction(transaction("2119000011", {
                sku: "seabyss_diamond_pack_1",
                amountMinor: 199
            })),
            ledger.createTransaction(transaction("2119000012", {
                playFabId: "OTHERPLAYER00001"
            }))
        ]);
        assert.equal((await ledger.lookup({ orderId: "order-2119000010" })).items.length, 1);
        assert.equal((await ledger.lookup({ receiptId: "receipt-2119000011" })).items.length, 1);
        assert.equal((await ledger.lookup({ sku: "seabyss_diamond_pack_1" })).items.length, 1);
        const first = await ledger.lookup({ playFabId: "4DF88C225D91FE06" }, { limit: 1 });
        assert.equal(first.items.length, 1);
        assert.equal(first.nextCursor, "1");
        const second = await ledger.lookup(
            { playFabId: "4DF88C225D91FE06" },
            { cursor: first.nextCursor, limit: 1 }
        );
        assert.equal(second.items.length, 1);
        assert.equal(second.nextCursor, null);
    });

    test("transaction leases use owner tokens, expiry, renewal, and fencing epochs", async () => {
        const clock = harness();
        await clock.ledger.createTransaction(transaction("2119000020"));
        const identity = { provider: "xsolla", providerTransactionId: "2119000020" };
        const first = await clock.ledger.acquireLease(identity, {
            owner: "worker-a",
            token: "token-a",
            ttlMilliseconds: 100
        });
        assert.equal(first.status, "acquired");
        assert.equal(first.record.leaseEpoch, 1);
        const busy = await clock.ledger.acquireLease(identity, {
            owner: "worker-b",
            token: "token-b",
            ttlMilliseconds: 100
        });
        assert.equal(busy.status, "busy");
        clock.advance(50);
        const renewed = await clock.ledger.renewLease(identity, {
            token: "token-a",
            ttlMilliseconds: 100
        });
        assert.equal(renewed.record.leaseExpiresAtUnixMs, clock.now() + 100);
        clock.advance(101);
        const promoted = await clock.ledger.acquireLease(identity, {
            owner: "worker-b",
            token: "token-b",
            ttlMilliseconds: 100
        });
        assert.equal(promoted.record.leaseEpoch, 2);
        await assert.rejects(
            clock.ledger.transition(identity, {
                toState: "Processing",
                leaseToken: "token-a",
                incrementRetry: true
            }),
            (error) => error.code === "LEASE_LOST"
        );
        await assert.rejects(
            clock.ledger.releaseLease(identity, { token: "token-a" }),
            (error) => error.code === "LEASE_LOST"
        );
        assert.equal((await clock.ledger.releaseLease(identity, { token: "token-b" })).status,
            "released");
    });

    test("checkpoints are immutable and state updates support CAS", async () => {
        const { ledger } = harness();
        await ledger.createTransaction(transaction("2119000030"));
        const identity = { provider: "xsolla", providerTransactionId: "2119000030" };
        const lease = await ledger.acquireLease(identity, {
            owner: "worker-a",
            token: "checkpoint-token",
            ttlMilliseconds: 1_000
        });
        await ledger.transition(identity, {
            toState: "Processing",
            leaseToken: "checkpoint-token",
            expectedVersion: lease.record.version,
            incrementRetry: true
        });
        const checkpoint = await ledger.recordCheckpoint(identity, {
            name: "profile_grant",
            operationId: "immutable-operation-1",
            result: { dataVersion: 8 },
            leaseToken: "checkpoint-token"
        });
        assert.equal(checkpoint.status, "ok");
        assert.equal((await ledger.recordCheckpoint(identity, {
            name: "profile_grant",
            operationId: "immutable-operation-1",
            result: { dataVersion: 8 },
            leaseToken: "checkpoint-token"
        })).status, "already_present");
        await assert.rejects(ledger.recordCheckpoint(identity, {
            name: "profile_grant",
            operationId: "different-operation",
            result: { dataVersion: 9 },
            leaseToken: "checkpoint-token"
        }), (error) => error.code === "CHECKPOINT_CONFLICT");
        await assert.rejects(ledger.transition(identity, {
            toState: "Completed",
            leaseToken: "checkpoint-token",
            expectedVersion: checkpoint.record.version - 1
        }), (error) => error.code === "VERSION_CONFLICT");
        const completed = await ledger.transition(identity, {
            toState: "Completed",
            leaseToken: "checkpoint-token",
            expectedVersion: checkpoint.record.version
        });
        assert.equal(completed.record.state, "Completed");
    });

    test("player resource leases serialize distinct transactions", async () => {
        const clock = harness();
        const first = await clock.ledger.acquireResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            owner: "worker-a",
            token: "profile-a",
            ttlMilliseconds: 100
        });
        assert.equal(first.lease.epoch, 1);
        const busy = await clock.ledger.acquireResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            owner: "worker-b",
            token: "profile-b",
            ttlMilliseconds: 100
        });
        assert.equal(busy.status, "busy");
        clock.advance(101);
        const promoted = await clock.ledger.acquireResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            owner: "worker-b",
            token: "profile-b",
            ttlMilliseconds: 100
        });
        assert.equal(promoted.lease.epoch, 2);
        await assert.rejects(clock.ledger.renewResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            token: "profile-a",
            ttlMilliseconds: 100
        }), (error) => error.code === "LEASE_LOST");
    });

    test("reversals are unique, amount-bounded, currency-checked, and indexed", async () => {
        const { ledger } = harness();
        await ledger.createTransaction(transaction("2119000040", { amountMinor: 399 }));
        const base = {
            provider: "xsolla",
            providerTransactionId: "2119000040",
            type: "refund",
            amountMinor: 100,
            currency: "USD",
            occurredAtUnixMs: 950,
            reason: "customer_request"
        };
        assert.equal((await ledger.createReversal({
            ...base,
            reversalEventId: "refund-1"
        })).status, "created");
        assert.equal((await ledger.createReversal({
            ...base,
            reversalEventId: "refund-1"
        })).status, "existing");
        await assert.rejects(ledger.createReversal({
            ...base,
            reversalEventId: "refund-1",
            amountMinor: 101
        }), (error) => error.code === "IMMUTABLE_CONFLICT");
        await assert.rejects(ledger.createReversal({
            ...base,
            reversalEventId: "refund-eur",
            currency: "EUR"
        }), (error) => error.code === "REVERSAL_CURRENCY_CONFLICT");
        await assert.rejects(ledger.createReversal({
            ...base,
            reversalEventId: "refund-too-large",
            amountMinor: 300
        }), (error) => error.code === "REVERSAL_AMOUNT_EXCEEDED");
        const indexed = await ledger.lookupReversals({
            provider: "xsolla",
            providerTransactionId: "2119000040"
        });
        assert.equal(indexed.items.length, 1);
        const original = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119000040"
        });
        assert.equal(original.reversedAmountMinor, 100);
        assert.equal(original.reversalStatus, "RefundPendingReview");
    });
});
