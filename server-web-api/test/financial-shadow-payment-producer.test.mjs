import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFinancialShadowPaymentProducer } from "../src/financial-shadow-payment-producer.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import {
    getXsollaStarterReceiptV2Key,
    serializeXsollaStarterReceiptV2
} from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { createMemoryServerEconomyPocOperationInbox } from "../src/server-economy-poc-memory-stores.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";

const PLAYER = "46789223F9CB1BB9";
const CREATED_AT = "2026-08-23T12:00:00.000Z";

function paidReceipt(sku, transactionId, overrides = {}) {
    const product = getXsollaProductPlan(sku);
    const receipt = {
        playFabId: PLAYER,
        transactionId,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: PLAYER,
        createdAtUtc: CREATED_AT,
        environment: "sandbox",
        notificationType: "payment",
        orderId: transactionId,
        productId: product.productId,
        xsollaSku: sku,
        productType: product.productType,
        source: "xsolla_sandbox",
        productPlanVersion: product.planVersion,
        currency: product.currency,
        unitAmountMinor: product.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: product.unitAmountMinor,
        promotionPolicy: "disabled",
        ...overrides
    };
    if (product.productType === "starter_pack") {
        const rewards = getStarterRewardPlan(sku);
        receipt.rewardPlanVersion = rewards.planVersion;
        receipt.rewardPlanHash = rewards.rewardPlanHash;
        receipt.rewards = rewards.rewards;
    }
    return receipt;
}

function harness({ allowed = [PLAYER] } = {}) {
    const now = Date.parse(CREATED_AT) + 1_000;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => now
    });
    const receipts = new Map();
    const inbox = createMemoryServerEconomyPocOperationInbox({ nowMilliseconds: () => now });
    let receiptReads = 0;
    let enqueueCalls = 0;
    const persistStarterPackReceiptV2 = async (receipt) => {
        const key = getXsollaStarterReceiptV2Key(receipt.transactionId);
        const value = serializeXsollaStarterReceiptV2(receipt);
        const existing = receipts.has(key);
        receipts.set(key, value);
        return { key, value, existing };
    };
    const persistDiamondPackReceiptV2 = async (receipt) => {
        const key = getXsollaDiamondReceiptV2Key(receipt.transactionId);
        const value = serializeXsollaDiamondReceiptV2(receipt);
        const existing = receipts.has(key);
        receipts.set(key, value);
        return { key, value, existing };
    };
    const persist = createXsollaLedgeredReceiptProcessor({
        ledger,
        persistStarterPackReceiptV2,
        persistDiamondPackReceiptV2,
        workerOptions: { nowMilliseconds: () => now }
    });
    const producer = createFinancialShadowPaymentProducer({
        ledger,
        policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set(allowed) },
        async loadXsollaV2Receipt({ receiptId }) {
            receiptReads += 1;
            const value = receipts.get(receiptId);
            return value === undefined ? null : { key: receiptId, value };
        },
        async enqueueCanonicalProjection(operation) {
            enqueueCalls += 1;
            return inbox.submit(operation);
        }
    });
    return {
        ledger,
        receipts,
        inbox,
        persist,
        producer,
        receiptReads: () => receiptReads,
        enqueueCalls: () => enqueueCalls
    };
}

async function persistThenProject(h, receipt) {
    await h.persist(receipt);
    return h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });
}

describe("trusted payment producer to Financial Shadow", () => {
    test("xss2 Starter I is rebuilt from ledger, receipt and plans while offline", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_starter_pack_1", "910000001");
        const result = await persistThenProject(h, receipt);
        assert.equal(result.status, "projected");
        assert.equal(result.operation.playFabId, PLAYER);
        assert.equal(result.operation.diamonds, 1000);
        assert.equal(result.operation.eliteBall, 13000);
        assert.deepEqual(result.operation.premium, { tier: 1, durationSeconds: 86400 });
        assert.equal(result.operation.createdAtUnixMs, Date.parse(CREATED_AT));
        assert.equal(Object.hasOwn(result.operation, "effectiveAtUnixMs"), false);
        assert.equal(result.operation.kind, "xsolla_entitlement");
        assert.match(result.operation.immutableHash, /^[a-f0-9]{64}$/u);
        assert.equal(h.receiptReads(), 1);
        assert.equal(h.enqueueCalls(), 1);
    });

    test("xsd2 Diamond I derives exactly +500 with no Elite or Premium", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000002");
        const result = await persistThenProject(h, receipt);
        assert.deepEqual({
            diamonds: result.operation.diamonds,
            eliteBall: result.operation.eliteBall,
            premium: result.operation.premium
        }, { diamonds: 500, eliteBall: 0, premium: null });
        assert.equal(result.operation.playFabId, PLAYER);
    });

    test("already-persisted receipt replay creates one offline operation without reconnect", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000003");
        await h.persist(receipt);
        const first = await h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });
        const replay = await h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });
        const page = await h.inbox.scanAfter({ playFabId: PLAYER, afterSequence: 0, limit: 10 });
        assert.equal(first.status, "projected");
        assert.equal(replay.status, "already_projected");
        assert.equal(page.entries.length, 1);
        assert.equal(page.entries[0].state, "Pending");
        assert.equal(page.entries[0].operation.diamonds, 500);
        assert.equal(h.enqueueCalls(), 2);
    });

    test("caller-authored rewards and extra economics are rejected before any durable read", async () => {
        const h = harness();
        await assert.rejects(h.producer.projectTransaction({
            providerTransactionId: "910000004",
            diamonds: 999999,
            rewards: [{ rewardId: "diamonds", quantity: 999999 }]
        }), { code: "FINANCIAL_SHADOW_PAYMENT_INPUT_REJECTED" });
        assert.equal(h.receiptReads(), 0);
        assert.equal(h.enqueueCalls(), 0);
    });

    test("missing and tampered immutable receipts fail closed", async () => {
        const missing = harness();
        const missingReceipt = paidReceipt("seabyss_diamond_pack_1", "910000005");
        await missing.persist(missingReceipt);
        missing.receipts.clear();
        await assert.rejects(
            missing.producer.projectTransaction({ providerTransactionId: missingReceipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_RECEIPT_MISSING" }
        );

        const tampered = harness();
        const tamperedReceipt = paidReceipt("seabyss_diamond_pack_1", "910000006");
        await tampered.persist(tamperedReceipt);
        const key = getXsollaDiamondReceiptV2Key(tamperedReceipt.transactionId);
        const parsed = JSON.parse(tampered.receipts.get(key));
        parsed.totalAmountMinor = 1;
        tampered.receipts.set(key, JSON.stringify(parsed));
        await assert.rejects(
            tampered.producer.projectTransaction({ providerTransactionId: tamperedReceipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_RECEIPT_INVALID" }
        );
        assert.equal(tampered.enqueueCalls(), 0);
    });

    test("ledger/receipt mismatch and invalid receipt checkpoint proof are rejected", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000007");
        await h.persist(receipt);
        const valid = await h.ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: receipt.transactionId
        });
        const mismatchedProducer = createFinancialShadowPaymentProducer({
            ledger: { async requireTransaction() { return { ...valid, sku: "seabyss_diamond_pack_2" }; } },
            policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([PLAYER]) },
            async loadXsollaV2Receipt({ receiptId }) {
                return { key: receiptId, value: h.receipts.get(receiptId) };
            },
            async enqueueCanonicalProjection() { throw new Error("must not enqueue"); }
        });
        await assert.rejects(
            mismatchedProducer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_CHAIN_MISMATCH" }
        );
        const forgedCheckpointProducer = createFinancialShadowPaymentProducer({
            ledger: {
                async requireTransaction() {
                    return {
                        ...valid,
                        checkpoints: {
                            ...valid.checkpoints,
                            receipt_persisted: { ...valid.checkpoints.receipt_persisted, resultHash: "0".repeat(64) }
                        }
                    };
                }
            },
            policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([PLAYER]) },
            async loadXsollaV2Receipt() { throw new Error("must not read"); },
            async enqueueCanonicalProjection() { throw new Error("must not enqueue"); }
        });
        await assert.rejects(
            forgedCheckpointProducer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_RECEIPT_PROOF_INVALID" }
        );
    });

    test("non-canonical xsd2 key is rejected before receipt or reversal lookup", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000012");
        await h.persist(receipt);
        const valid = await h.ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: receipt.transactionId
        });
        let reads = 0;
        const producer = createFinancialShadowPaymentProducer({
            ledger: {
                async requireTransaction() {
                    return { ...valid, receiptId: `xsd2_${"A".repeat(43)}` };
                }
            },
            policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([PLAYER]) },
            async loadXsollaV2Receipt() { reads += 1; throw new Error("must not read"); },
            async enqueueCanonicalProjection() { throw new Error("must not enqueue"); }
        });
        await assert.rejects(
            producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_RECEIPT_KEY_MISMATCH" }
        );
        assert.equal(reads, 0);
    });

    test("Sandbox policy rejects a production ledger before immutable receipt read", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000011");
        await h.persist(receipt);
        const valid = await h.ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: receipt.transactionId
        });
        let reads = 0;
        const producer = createFinancialShadowPaymentProducer({
            ledger: { async requireTransaction() { return { ...valid, environment: "production" }; } },
            policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([PLAYER]) },
            async loadXsollaV2Receipt() { reads += 1; throw new Error("must not read"); },
            async enqueueCanonicalProjection() { throw new Error("must not enqueue"); }
        });
        await assert.rejects(
            producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_ENVIRONMENT_MISMATCH" }
        );
        assert.equal(reads, 0);
    });

    test("non-allowlisted canonical user is rejected before receipt read", async () => {
        const h = harness({ allowed: ["ANOTHER_TEST_PLAYER"] });
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000008");
        await h.persist(receipt);
        await assert.rejects(
            h.producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PLAYER_FORBIDDEN" }
        );
        assert.equal(h.receiptReads(), 0);
        assert.equal(h.enqueueCalls(), 0);
    });

    test("unsafe ledger state is never projected", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000009");
        await h.persist(receipt);
        const valid = await h.ledger.requireTransaction({ provider: "xsolla", providerTransactionId: receipt.transactionId });
        const unsafe = createFinancialShadowPaymentProducer({
            ledger: { async requireTransaction() { return { ...valid, state: "RefundRequired" }; } },
            policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([PLAYER]) },
            async loadXsollaV2Receipt({ receiptId }) { return { key: receiptId, value: h.receipts.get(receiptId) }; },
            async enqueueCanonicalProjection() { throw new Error("must not enqueue"); }
        });
        await assert.rejects(
            unsafe.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_LEDGER_UNTRUSTED" }
        );
    });

    test("reversal racing the durable enqueue is detected and replay cannot add a second operation", async () => {
        const h = harness();
        const receipt = paidReceipt("seabyss_diamond_pack_1", "910000010");
        await h.persist(receipt);
        let raceInserted = false;
        const producer = createFinancialShadowPaymentProducer({
            ledger: h.ledger,
            policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([PLAYER]) },
            async loadXsollaV2Receipt({ receiptId }) {
                return { key: receiptId, value: h.receipts.get(receiptId) };
            },
            async enqueueCanonicalProjection(operation) {
                const submitted = await h.inbox.submit(operation);
                if (!raceInserted) {
                    raceInserted = true;
                    await h.ledger.createReversal({
                        provider: "xsolla",
                        providerTransactionId: receipt.transactionId,
                        reversalEventId: "refund-raced-shadow-enqueue",
                        type: "refund",
                        amountMinor: 100,
                        currency: "USD",
                        occurredAtUnixMs: Date.parse(CREATED_AT) + 2_000,
                        reason: "sandbox_race_test"
                    });
                }
                return submitted;
            }
        });
        await assert.rejects(
            producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_REVERSAL_PRESENT" }
        );
        await assert.rejects(
            producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "FINANCIAL_SHADOW_PAYMENT_REVERSAL_PRESENT" }
        );
        const page = await h.inbox.scanAfter({ playFabId: PLAYER, afterSequence: 0, limit: 10 });
        assert.equal(page.entries.length, 1);
        assert.equal(page.entries[0].state, "Pending");
    });
});
