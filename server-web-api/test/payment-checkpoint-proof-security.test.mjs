import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { PAYMENT_LEDGER_REDIS_SCRIPTS } from "../src/payment-ledger-redis-store.js";
import { createPaymentWorker } from "../src/payment-worker.js";

const planHash = "f".repeat(64);

function transaction(providerTransactionId) {
    return {
        provider: "xsolla",
        providerTransactionId,
        orderId: `order-${providerTransactionId}`,
        receiptId: `receipt-${providerTransactionId}`,
        playFabId: "46789223F9CB1BB9",
        sku: "seabyss_diamond_pack_1",
        planVersion: 1,
        planHash,
        amountMinor: 199,
        currency: "USD",
        environment: "sandbox",
        createdAtUnixMs: 1_000
    };
}

function identity(providerTransactionId) {
    return { provider: "xsolla", providerTransactionId };
}

function workerOperationId(providerTransactionId, checkpointName) {
    const identityHash = createHash("sha256")
        .update("xsolla", "utf8")
        .update("\0", "utf8")
        .update(providerTransactionId, "utf8")
        .digest("base64url");
    return `payment:${identityHash}:${checkpointName}:v1`;
}

function harness() {
    let now = 2_000;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => now
    });
    return {
        ledger,
        now: () => now,
        advance(milliseconds) { now += milliseconds; }
    };
}

async function acquireTransactionLease(ledger, id, token) {
    return ledger.acquireLease(identity(id), {
        owner: `owner-${id}`,
        token,
        ttlMilliseconds: 1_000
    });
}

function securityWorker(ledger, step) {
    return createPaymentWorker({
        ledger,
        workerId: "checkpoint-proof-worker",
        steps: [step],
        leaseTtlMilliseconds: 1_000,
        leaseRenewIntervalMilliseconds: 0,
        playerLeaseWaitMilliseconds: 0,
        playerLeasePollMilliseconds: 0,
        logger: { info() {}, warn() {}, error() {} }
    });
}

function rejectsCheckpointConflict(promise) {
    return assert.rejects(promise, (error) => error?.code === "CHECKPOINT_CONFLICT");
}

describe("payment checkpoint proof security", () => {
    test("requireAppliedStep rejects a checkpoint without a journal while legacy calls remain compatible", async () => {
        const { ledger } = harness();
        const id = "proof-no-journal";
        const token = "proof-no-journal-token";
        await ledger.createTransaction(transaction(id));
        await acquireTransactionLease(ledger, id, token);

        await rejectsCheckpointConflict(ledger.recordCheckpoint(identity(id), {
            name: "economy_v2_granted",
            operationId: "operation-no-journal",
            result: { status: "verified" },
            leaseToken: token,
            requireAppliedStep: true
        }));
        assert.equal((await ledger.requireTransaction(identity(id))).checkpoints.economy_v2_granted,
            undefined);

        const legacy = await ledger.recordCheckpoint(identity(id), {
            name: "receipt_persisted",
            operationId: "legacy-receipt-operation",
            result: { receiptId: `receipt-${id}` },
            leaseToken: token
        });
        assert.equal(legacy.status, "ok");
        assert.equal(legacy.record.checkpoints.receipt_persisted.result.receiptId,
            `receipt-${id}`);
    });

    test("StepPending is insufficient checkpoint proof", async () => {
        const { ledger } = harness();
        const id = "proof-step-pending";
        const token = "proof-step-pending-token";
        await ledger.createTransaction(transaction(id));
        const lease = await acquireTransactionLease(ledger, id, token);
        const operationId = workerOperationId(id, "economy_v2_granted");
        await ledger.beginStep(identity(id), {
            name: "economy_v2_granted",
            operationId,
            reward: { diamonds: 500 },
            transactionLeaseEpoch: lease.record.leaseEpoch,
            playerLeaseEpoch: 1,
            leaseToken: token
        });

        await rejectsCheckpointConflict(ledger.recordCheckpoint(identity(id), {
            name: "economy_v2_granted",
            operationId,
            result: { diamonds: 500 },
            leaseToken: token,
            requireAppliedStep: true
        }));
        const stored = await ledger.requireTransaction(identity(id));
        assert.equal(stored.stepJournal.economy_v2_granted.status, "StepPending");
        assert.equal(stored.checkpoints.economy_v2_granted, undefined);
    });

    test("worker refuses a forged preexisting checkpoint and never completes or runs its effect", async () => {
        const { ledger } = harness();
        const id = "proof-forged-checkpoint";
        const token = "proof-forged-token";
        const operationId = workerOperationId(id, "economy_v2_granted");
        await ledger.createTransaction(transaction(id));
        await acquireTransactionLease(ledger, id, token);
        await ledger.recordCheckpoint(identity(id), {
            name: "economy_v2_granted",
            operationId,
            result: { diamonds: 500 },
            leaseToken: token
        });
        await ledger.releaseLease(identity(id), { token });

        let effects = 0;
        const worker = securityWorker(ledger, {
            name: "economy_v2_granted",
            async run() {
                effects += 1;
                return { diamonds: 500 };
            }
        });
        await rejectsCheckpointConflict(worker.processTransaction(identity(id)));

        const stored = await ledger.requireTransaction(identity(id));
        assert.equal(effects, 0);
        assert.equal(stored.state, "Failed");
        assert.equal(stored.stepJournal.economy_v2_granted, undefined);
        assert.notEqual(stored.state, "Completed");
    });

    test("operationId and resultHash must match StepApplied before proof is accepted", async () => {
        const { ledger } = harness();
        const id = "proof-operation-result";
        const token = "proof-operation-result-token";
        const operationId = workerOperationId(id, "economy_v2_granted");
        const result = { diamonds: 500, providerTransactionId: "economy-transaction-1" };
        await ledger.createTransaction(transaction(id));
        const lease = await acquireTransactionLease(ledger, id, token);
        await ledger.beginStep(identity(id), {
            name: "economy_v2_granted",
            operationId,
            reward: { diamonds: 500 },
            transactionLeaseEpoch: lease.record.leaseEpoch,
            playerLeaseEpoch: 1,
            leaseToken: token
        });
        await ledger.recordStepApplied(identity(id), {
            name: "economy_v2_granted",
            operationId,
            result,
            leaseToken: token
        });

        await rejectsCheckpointConflict(ledger.recordCheckpoint(identity(id), {
            name: "economy_v2_granted",
            operationId: `${operationId}-forged`,
            result,
            leaseToken: token,
            requireAppliedStep: true
        }));
        await rejectsCheckpointConflict(ledger.recordCheckpoint(identity(id), {
            name: "economy_v2_granted",
            operationId,
            result: { ...result, diamonds: 1_000 },
            leaseToken: token,
            requireAppliedStep: true
        }));

        const checkpoint = await ledger.recordCheckpoint(identity(id), {
            name: "economy_v2_granted",
            operationId,
            result,
            leaseToken: token,
            requireAppliedStep: true
        });
        assert.equal(checkpoint.status, "ok");
        await ledger.releaseLease(identity(id), { token });

        const worker = securityWorker(ledger, {
            name: "economy_v2_granted",
            async run() {
                throw new Error("A valid preexisting checkpoint must be verified, not replayed.");
            }
        });
        const completed = await worker.processTransaction(identity(id));
        assert.equal(completed.status, "completed");
        assert.equal(completed.transaction.state, "Completed");
    });

    test("Redis mutation script enforces the same proof before existing-checkpoint replay", () => {
        const script = PAYMENT_LEDGER_REDIS_SCRIPTS.mutateTransaction;
        const proofGuard = script.indexOf("if command.requireAppliedStep then");
        const existingLookup = script.indexOf("local existing = record.checkpoints[command.name]");
        assert.ok(proofGuard >= 0);
        assert.ok(existingLookup > proofGuard);
        assert.match(script, /appliedStep\.status ~= "StepApplied"/u);
        assert.match(script, /appliedStep\.operationId ~= command\.checkpoint\.operationId/u);
        assert.match(script, /appliedStep\.resultHash ~= command\.checkpoint\.resultHash/u);
    });
    test("lease assertion waits for a concurrent heartbeat and rejects the stale worker", async () => {
        const { ledger } = harness();
        const id = "proof-heartbeat-stale";
        await ledger.createTransaction(transaction(id));

        let signalRenewalStarted;
        let releaseRenewal;
        const renewalStarted = new Promise((resolve) => { signalRenewalStarted = resolve; });
        const renewalGate = new Promise((resolve) => { releaseRenewal = resolve; });
        const leaseLost = Object.assign(new Error("simulated stale worker"), {
            code: "LEASE_LOST"
        });
        let transactionRenewals = 0;
        const guardedLedger = {
            ...ledger,
            async renewLease() {
                transactionRenewals += 1;
                signalRenewalStarted();
                await renewalGate;
                throw leaseLost;
            }
        };
        let assertionSettled = false;
        const worker = createPaymentWorker({
            ledger: guardedLedger,
            workerId: "heartbeat-stale-worker",
            steps: [{
                name: "economy_v2_granted",
                async run(context) {
                    await renewalStarted;
                    const assertion = context.assertLeaseOwnership();
                    void assertion.then(
                        () => { assertionSettled = true; },
                        () => { assertionSettled = true; }
                    );
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    assert.equal(assertionSettled, false);
                    releaseRenewal();
                    await assertion;
                    throw new Error("The stale worker must not reach the provider mutation.");
                }
            }],
            leaseTtlMilliseconds: 1_000,
            leaseRenewIntervalMilliseconds: 1,
            playerLeaseWaitMilliseconds: 0,
            playerLeasePollMilliseconds: 0,
            logger: { info() {}, warn() {}, error() {} }
        });

        await assert.rejects(worker.processTransaction(identity(id)),
            (error) => error?.code === "LEASE_LOST");
        const stored = await ledger.requireTransaction(identity(id));
        assert.equal(transactionRenewals, 1);
        assert.equal(stored.stepJournal.economy_v2_granted.status, "StepPending");
        assert.equal(stored.checkpoints.economy_v2_granted, undefined);
        assert.notEqual(stored.state, "Completed");
    });
});
