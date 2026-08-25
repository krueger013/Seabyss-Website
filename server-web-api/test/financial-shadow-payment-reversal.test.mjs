import assert from "node:assert/strict";
import { test } from "node:test";
import { createFinancialShadowPaymentProducer } from "../src/financial-shadow-payment-producer.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";

test("a durable reversal blocks a Completed-safe payment before Shadow enqueue", async () => {
    const playFabId = "46789223F9CB1BB9";
    const transactionId = "930000001";
    const createdAtUtc = "2026-08-23T13:00:00.000Z";
    const plan = getXsollaProductPlan("seabyss_diamond_pack_1");
    const receipt = {
        playFabId,
        transactionId,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: playFabId,
        createdAtUtc,
        environment: "sandbox",
        notificationType: "payment",
        orderId: transactionId,
        productId: plan.productId,
        xsollaSku: plan.sku,
        productType: plan.productType,
        source: "xsolla_sandbox",
        productPlanVersion: plan.planVersion,
        currency: plan.currency,
        unitAmountMinor: plan.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: plan.unitAmountMinor,
        promotionPolicy: "disabled"
    };
    const now = Date.parse(createdAtUtc) + 1_000;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => now
    });
    const receiptId = getXsollaDiamondReceiptV2Key(transactionId);
    const receiptValue = serializeXsollaDiamondReceiptV2(receipt);
    const processReceipt = createXsollaLedgeredReceiptProcessor({
        ledger,
        persistStarterPackReceiptV2: async () => { throw new Error("not expected"); },
        persistDiamondPackReceiptV2: async () => ({ key: receiptId, value: receiptValue, existing: false }),
        workerOptions: { nowMilliseconds: () => now }
    });
    await processReceipt(receipt);
    await ledger.createReversal({
        provider: "xsolla",
        providerTransactionId: transactionId,
        reversalEventId: "refund-shadow-producer-test",
        type: "refund",
        amountMinor: 100,
        currency: "USD",
        occurredAtUnixMs: now,
        reason: "sandbox_test"
    });
    let enqueueCalls = 0;
    const producer = createFinancialShadowPaymentProducer({
        ledger,
        policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([playFabId]) },
        async loadXsollaV2Receipt() { return { key: receiptId, value: receiptValue }; },
        async enqueueCanonicalProjection() { enqueueCalls += 1; }
    });
    await assert.rejects(
        producer.projectTransaction({ providerTransactionId: transactionId }),
        { code: "FINANCIAL_SHADOW_PAYMENT_REVERSAL_PRESENT" }
    );
    assert.equal(enqueueCalls, 0);
});
