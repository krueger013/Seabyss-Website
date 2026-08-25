import assert from "node:assert/strict";
import { test } from "node:test";
import {
    wrapLedgeredReceiptProcessorWithFinancialShadow
} from "../src/financial-shadow-payment-hook.js";

test("receipt checkpoint completes before durable Shadow enqueue", async () => {
    const order = [];
    const wrapped = wrapLedgeredReceiptProcessorWithFinancialShadow({
        async processReceipt() {
            order.push("receipt_persisted");
            return { status: "checkpoints_pending" };
        },
        producer: {
            async projectTransaction(input) {
                order.push("shadow_enqueued");
                assert.deepEqual(input, { providerTransactionId: "920000001" });
            }
        }
    });
    const result = await wrapped({ transactionId: "920000001", rewards: ["caller-data-ignored"] });
    assert.equal(result.status, "checkpoints_pending");
    assert.deepEqual(order, ["receipt_persisted", "shadow_enqueued"]);
});

test("lost receipt-to-Shadow window fails webhook and replay enqueues idempotently", async () => {
    let receiptCalls = 0;
    let producerCalls = 0;
    const wrapped = wrapLedgeredReceiptProcessorWithFinancialShadow({
        async processReceipt() {
            receiptCalls += 1;
            return { status: "checkpoints_pending", existing: receiptCalls > 1 };
        },
        producer: {
            async projectTransaction() {
                producerCalls += 1;
                if (producerCalls === 1) throw new Error("mirror inbox temporarily unavailable");
                return { status: "projected" };
            }
        }
    });
    await assert.rejects(wrapped({ transactionId: "920000002" }), /temporarily unavailable/u);
    const replay = await wrapped({ transactionId: "920000002" });
    assert.equal(replay.status, "checkpoints_pending");
    assert.equal(receiptCalls, 2);
    assert.equal(producerCalls, 2);
});

test("Shadow OFF leaves ledgered receipt processing as a strict no-op hook", async () => {
    let calls = 0;
    const wrapped = wrapLedgeredReceiptProcessorWithFinancialShadow({
        async processReceipt() {
            calls += 1;
            return { status: "checkpoints_pending" };
        },
        producer: null
    });
    assert.deepEqual(await wrapped({ transactionId: "920000003" }), {
        status: "checkpoints_pending"
    });
    assert.equal(calls, 1);
});
