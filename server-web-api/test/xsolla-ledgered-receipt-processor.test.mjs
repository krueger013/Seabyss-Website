import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { PaymentWorkerCrash } from "../src/payment-worker.js";
import { getXsollaStarterReceiptV2Key } from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";

function starterReceipt(overrides = {}) {
    const rewardPlan = getStarterRewardPlan("seabyss_starter_pack_1");
    return {
        playFabId: "46789223F9CB1BB9",
        transactionId: "706956443",
        provider: "xsolla",
        providerTransactionId: "706956443",
        userId: "46789223F9CB1BB9",
        createdAtUtc: "2026-08-22T20:00:00.000Z",
        environment: "sandbox",
        notificationType: "payment",
        orderId: "706956443",
        productId: "starter_pack_1",
        xsollaSku: "seabyss_starter_pack_1",
        productType: "starter_pack",
        source: "xsolla_sandbox",
        productPlanVersion: 1,
        rewardPlanVersion: rewardPlan.planVersion,
        rewardPlanHash: rewardPlan.rewardPlanHash,
        rewards: rewardPlan.rewards,
        currency: "USD",
        unitAmountMinor: 399,
        quantity: 1,
        totalAmountMinor: 399,
        promotionPolicy: "disabled",
        ...overrides
    };
}

function processor({ now = () => Date.now(), persist, workerOptions = {} } = {}) {
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: now
    });
    const process = createXsollaLedgeredReceiptProcessor({
        ledger,
        persistStarterPackReceiptV2: persist,
        persistDiamondPackReceiptV2: async () => { throw new Error("not expected"); },
        workerOptions: { nowMilliseconds: now, ...workerOptions }
    });
    return { ledger, process };
}

describe("ledgered immutable Xsolla receipts", () => {
    test("creates the durable ledger before persisting and completes one checkpoint", async () => {
        let persistenceCalls = 0;
        const receipt = starterReceipt();
        const expectedKey = getXsollaStarterReceiptV2Key(receipt.transactionId);
        const { ledger, process } = processor({
            persist: async () => {
                persistenceCalls += 1;
                const pending = await ledger.requireTransaction({
                    provider: "xsolla",
                    providerTransactionId: receipt.transactionId
                });
                assert.notEqual(pending.state, "Completed");
                return { key: expectedKey, existing: false };
            }
        });
        const result = await process(receipt);
        assert.equal(result.status, "checkpoints_pending");
        assert.equal(persistenceCalls, 1);
        const stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: receipt.transactionId
        });
        assert.equal(stored.state, "Pending");
        assert.equal(stored.receiptId, expectedKey);
        assert.ok(stored.checkpoints.receipt_persisted);
    });

    test("10 concurrent workers persist exactly once and replay remains Pending", async () => {
        let writes = 0;
        const expectedKey = getXsollaStarterReceiptV2Key("706956443");
        const persisted = new Set();
        const persist = async (receipt) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            const existing = persisted.has(receipt.transactionId);
            if (!existing) {
                persisted.add(receipt.transactionId);
                writes += 1;
            }
            return { key: expectedKey, existing };
        };
        const { ledger, process } = processor({ persist });
        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () => process(starterReceipt()))
        );
        assert.equal(writes, 1);
        assert.equal(results.filter((result) => result.status === "fulfilled").length >= 1, true);
        const beforeReplay = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "706956443"
        });
        const replay = await process(starterReceipt({
            notificationType: "order_paid",
            orderId: "999999999"
        }));
        assert.equal(replay.status, "checkpoints_pending");
        assert.equal(replay.transaction.state, "Pending");
        assert.equal(replay.transaction.retryCount, beforeReplay.retryCount);
        assert.equal(writes, 1);
    });

    test("crash after receipt effect before checkpoint recovers idempotently after lease expiry", async () => {
        let clock = 1_800_000_000_000;
        let actualWrites = 0;
        let effectCalls = 0;
        let crashOnce = true;
        const key = getXsollaStarterReceiptV2Key("706956443");
        const persist = async () => {
            effectCalls += 1;
            if (actualWrites === 0) actualWrites += 1;
            return { key, existing: effectCalls > 1 };
        };
        const { process } = processor({
            now: () => clock,
            persist,
            workerOptions: {
                leaseTtlMilliseconds: 100,
                leaseRenewIntervalMilliseconds: 0,
                faultInjector: async (stage) => {
                    if (stage === "after_effect_before_checkpoint" && crashOnce) {
                        crashOnce = false;
                        throw new PaymentWorkerCrash(stage);
                    }
                }
            }
        });
        await assert.rejects(process(starterReceipt()), PaymentWorkerCrash);
        clock += 101;
        const recovered = await process(starterReceipt());
        assert.equal(recovered.status, "checkpoints_pending");
        assert.equal(recovered.transaction.state, "Pending");
        assert.ok(recovered.transaction.checkpoints.receipt_persisted);
        assert.equal(effectCalls, 2);
        assert.equal(actualWrites, 1);
    });


    test("crash after the durable checkpoint resumes without persisting the receipt again", async () => {
        let clock = 1_800_000_000_000;
        let persistenceCalls = 0;
        let crashOnce = true;
        const key = getXsollaStarterReceiptV2Key("706956443");
        const { process } = processor({
            now: () => clock,
            persist: async () => {
                persistenceCalls += 1;
                return { key, existing: false };
            },
            workerOptions: {
                leaseTtlMilliseconds: 100,
                leaseRenewIntervalMilliseconds: 0,
                faultInjector: async (stage) => {
                    if (stage === "before_checkpoints_pending" && crashOnce) {
                        crashOnce = false;
                        throw new PaymentWorkerCrash(stage);
                    }
                }
            }
        });
        await assert.rejects(process(starterReceipt()), PaymentWorkerCrash);
        clock += 101;
        const recovered = await process(starterReceipt());
        assert.equal(recovered.status, "checkpoints_pending");
        assert.equal(recovered.transaction.state, "Pending");
        assert.ok(recovered.transaction.checkpoints.receipt_persisted);
        assert.equal(persistenceCalls, 1);
    });
    test("same provider transaction with conflicting immutable economics fails closed", async () => {
        const key = getXsollaStarterReceiptV2Key("706956443");
        const { process } = processor({
            persist: async () => ({ key, existing: false })
        });
        await process(starterReceipt());
        await assert.rejects(
            process(starterReceipt({ totalAmountMinor: 699, unitAmountMinor: 699 })),
            /product plan|conflict/i
        );
    });
});
