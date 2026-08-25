import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import {
    createXsollaFinancialExceptionRecorder
} from "../src/xsolla-financial-exception-recorder.js";

const playFabId = "4DF88C225D91FE06";
const createdAtUtc = "2026-08-22T00:00:00.000Z";

function context(overrides = {}) {
    const productPlan = getXsollaProductPlan("seabyss_starter_pack_1");
    return {
        state: "Quarantined",
        reason: "economic_mismatch",
        errorCode: "PRICE_MISMATCH",
        playFabId,
        transactionId: "800001",
        product: {
            productId: productPlan.productId,
            xsollaSku: productPlan.sku,
            productType: productPlan.productType
        },
        productPlan,
        environment: "sandbox",
        createdAtUtc,
        notificationType: "order_paid",
        ...overrides
    };
}

describe("Xsolla financial exception recorder", () => {
    test("persists an economic mismatch as Quarantined exactly once", async () => {
        const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
        const metrics = [];
        const logs = [];
        const record = createXsollaFinancialExceptionRecorder({
            ledger,
            metrics: { record(event, options) { metrics.push({ event, options }); } },
            logger: { warn(message, fields) { logs.push({ message, fields }); } }
        });
        assert.equal((await record(context())).status, "created");
        assert.equal((await record(context())).status, "existing");
        const transaction = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "800001"
        });
        assert.equal(transaction.state, "Quarantined");
        assert.equal(transaction.playFabId, playFabId);
        assert.equal(transaction.sku, "seabyss_starter_pack_1");
        assert.equal(transaction.amountMinor, 399);
        assert.equal(transaction.currency, "USD");
        assert.equal(transaction.audit.filter(
            (entry) => entry.action === "economic_mismatch_quarantined"
        ).length, 1);
        assert.deepEqual(metrics.map((entry) => entry.event), ["transaction_quarantined"]);
        assert.equal(logs.length, 2);
        assert.equal(logs[1].fields.replay, true);
    });

    test("persists duplicate-paid Starter as a distinct review state", async () => {
        const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
        const metrics = [];
        const record = createXsollaFinancialExceptionRecorder({
            ledger,
            metrics: { record(event) { metrics.push(event); } }
        });
        const result = await record(context({
            state: "DuplicatePaid",
            reason: "duplicate_paid",
            errorCode: null,
            reconciliationCaseKey: "xsr1_case",
            transactionId: "800002"
        }));
        assert.equal(result.status, "created");
        const transaction = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "800002"
        });
        assert.equal(transaction.state, "DuplicatePaid");
        assert.equal(transaction.audit.at(-1).details.reconciliationCaseKey, "xsr1_case");
        assert.deepEqual(metrics, ["duplicate_paid_starter"]);
    });

    test("fails closed on invalid state, plan, timestamp or conflicting replay", async () => {
        const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
        const record = createXsollaFinancialExceptionRecorder({ ledger });
        await assert.rejects(record(context({ state: "Completed" })), TypeError);
        await assert.rejects(record(context({ createdAtUtc: "not-a-date" })), TypeError);
        await assert.rejects(record(context({
            product: {
                productId: "starter_pack_2",
                xsollaSku: "seabyss_starter_pack_2",
                productType: "starter_pack"
            }
        })), TypeError);
        await record(context());
        await assert.rejects(record(context({
            state: "DuplicatePaid",
            reason: "duplicate_paid",
            errorCode: null
        })), /state conflicts/);
    });
});
