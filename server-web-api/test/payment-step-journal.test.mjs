import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createPaymentWorker, PaymentWorkerCrash } from "../src/payment-worker.js";

const planHash = "b".repeat(64);

function transaction(id) {
    return {
        provider: "xsolla",
        providerTransactionId: id,
        orderId: `order-${id}`,
        receiptId: `xss2:${id}`,
        playFabId: "46789223F9CB1BB9",
        sku: "seabyss_starter_pack_1",
        planVersion: 1,
        planHash,
        amountMinor: 399,
        currency: "USD",
        environment: "sandbox",
        createdAtUnixMs: 1_000
    };
}

function harness() {
    let now = 2_000;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => now
    });
    return {
        ledger,
        advance(milliseconds) { now += milliseconds; },
        worker(options) {
            return createPaymentWorker({
                ledger,
                workerId: options.workerId,
                leaseTtlMilliseconds: 100,
                leaseRenewIntervalMilliseconds: 0,
                playerLeaseWaitMilliseconds: 0,
                playerLeasePollMilliseconds: 0,
                nowMilliseconds: () => now,
                sleep: async () => {},
                steps: options.steps,
                faultInjector: options.faultInjector || (async () => {})
            });
        }
    };
}

describe("durable payment step journal", () => {
    test("StepPending and StepApplied evidence is immutable under the active lease", async () => {
        const h = harness();
        const input = transaction("journal-1");
        await h.ledger.createTransaction(input);
        const identity = {
            provider: input.provider,
            providerTransactionId: input.providerTransactionId
        };
        const lease = await h.ledger.acquireLease(identity, {
            owner: "journal-worker",
            token: "journal-token",
            ttlMilliseconds: 100
        });
        const pending = await h.ledger.beginStep(identity, {
            name: "currency.diamonds",
            operationId: "operation-journal-1",
            reward: { rewardType: "Diamonds", rewardId: "diamonds", quantity: 1000 },
            transactionLeaseEpoch: lease.record.leaseEpoch,
            playerLeaseEpoch: 1,
            leaseToken: "journal-token"
        });
        assert.equal(pending.record.stepJournal["currency.diamonds"].status, "StepPending");
        assert.equal((await h.ledger.beginStep(identity, {
            name: "currency.diamonds",
            operationId: "operation-journal-1",
            reward: { rewardType: "Diamonds", rewardId: "diamonds", quantity: 1000 },
            transactionLeaseEpoch: lease.record.leaseEpoch,
            playerLeaseEpoch: 1,
            leaseToken: "journal-token"
        })).status, "already_present");
        const applied = await h.ledger.recordStepApplied(identity, {
            name: "currency.diamonds",
            operationId: "operation-journal-1",
            result: { status: "applied", profileVersion: 8 },
            leaseToken: "journal-token"
        });
        assert.equal(applied.record.stepJournal["currency.diamonds"].status, "StepApplied");
        assert.equal((await h.ledger.recordStepApplied(identity, {
            name: "currency.diamonds",
            operationId: "operation-journal-1",
            result: { status: "applied", profileVersion: 8 },
            leaseToken: "journal-token"
        })).status, "already_present");
        await assert.rejects(h.ledger.recordStepApplied(identity, {
            name: "currency.diamonds",
            operationId: "different-operation",
            result: { status: "applied", profileVersion: 9 },
            leaseToken: "journal-token"
        }), (error) => error.code === "CHECKPOINT_CONFLICT");
    });

    test("crash after provider mutation replays the same provider operation without a double grant",
        async () => {
            const h = harness();
            const input = transaction("journal-crash-provider");
            await h.ledger.createTransaction(input);
            const appliedOperations = new Set();
            let providerCalls = 0;
            let balance = 0;
            const step = {
                name: "currency.diamonds",
                reward: { rewardType: "Diamonds", rewardId: "diamonds", quantity: 1000 },
                async run(context) {
                    providerCalls += 1;
                    if (!appliedOperations.has(context.operationId)) {
                        appliedOperations.add(context.operationId);
                        balance += 1000;
                        return { status: "applied", balance };
                    }
                    return { status: "already_applied", balance };
                }
            };
            const first = h.worker({
                workerId: "crash-worker-a",
                steps: [step],
                faultInjector: async (stage) => {
                    if (stage === "after_effect_before_checkpoint") {
                        throw new PaymentWorkerCrash(stage);
                    }
                }
            });
            await assert.rejects(first.processTransaction(input), PaymentWorkerCrash);
            h.advance(101);
            const second = h.worker({ workerId: "crash-worker-b", steps: [step] });
            const completed = await second.processTransaction(input);
            assert.equal(completed.status, "completed");
            assert.equal(balance, 1000);
            assert.equal(providerCalls, 2);
            assert.equal(completed.transaction.stepJournal["currency.diamonds"].status,
                "StepApplied");
            assert.ok(completed.transaction.checkpoints["currency.diamonds"]);
        });

    test("crash after StepApplied uses journal evidence and never calls the provider again",
        async () => {
            const h = harness();
            const input = transaction("journal-crash-checkpoint");
            await h.ledger.createTransaction(input);
            let providerCalls = 0;
            const step = {
                name: "unlock.destination_red_point",
                reward: { rewardType: "Custom", rewardId: "destination_red_point", quantity: 1 },
                async run() {
                    providerCalls += 1;
                    return { status: "applied", owned: true };
                }
            };
            const first = h.worker({
                workerId: "checkpoint-worker-a",
                steps: [step],
                faultInjector: async (stage) => {
                    if (stage === "after_step_applied_before_checkpoint") {
                        throw new PaymentWorkerCrash(stage);
                    }
                }
            });
            await assert.rejects(first.processTransaction(input), PaymentWorkerCrash);
            h.advance(101);
            const second = h.worker({ workerId: "checkpoint-worker-b", steps: [step] });
            const completed = await second.processTransaction(input);
            assert.equal(completed.status, "completed");
            assert.equal(providerCalls, 1);
            assert.ok(completed.transaction.checkpoints["unlock.destination_red_point"]);
        });
});
