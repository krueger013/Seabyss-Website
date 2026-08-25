import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentWorker } from "../src/payment-worker.js";
import {
    computePaymentWorkerServiceBackoff,
    createPaymentWorkerService
} from "../src/payment-worker-service.js";

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until(predicate, { timeoutMilliseconds = 1_000 } = {}) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for payment worker service.");
        await delay(2);
    }
}

function fakeLedger(overrides = {}) {
    return {
        async requireTransaction() { throw new Error("Unexpected transaction lookup."); },
        async transition() { throw new Error("Unexpected transaction transition."); },
        ...overrides
    };
}

function fakeWorker(processPending, health = () => ({ healthy: true, activeJobs: 0 })) {
    return { processPending, health };
}

function transaction(providerTransactionId) {
    return {
        provider: "xsolla",
        providerTransactionId,
        orderId: `order-${providerTransactionId}`,
        receiptId: `receipt-${providerTransactionId}`,
        playFabId: "4DF88C225D91FE06",
        sku: "seabyss_starter_pack_1",
        planVersion: 1,
        planHash: "d".repeat(64),
        amountMinor: 399,
        currency: "USD",
        environment: "sandbox",
        createdAtUnixMs: 100
    };
}

describe("persistent payment worker service", () => {
    test("computes bounded exponential backoff with deterministic jitter", () => {
        assert.equal(computePaymentWorkerServiceBackoff({
            attempt: 1,
            baseMilliseconds: 100,
            maximumMilliseconds: 1_000,
            jitterRatio: 0.2,
            randomValue: 0
        }), 80);
        assert.equal(computePaymentWorkerServiceBackoff({
            attempt: 2,
            baseMilliseconds: 100,
            maximumMilliseconds: 1_000,
            jitterRatio: 0.2,
            randomValue: 1
        }), 240);
        assert.equal(computePaymentWorkerServiceBackoff({
            attempt: 20,
            baseMilliseconds: 100,
            maximumMilliseconds: 1_000,
            jitterRatio: 0.2,
            randomValue: 1
        }), 1_000);
        assert.throws(() => computePaymentWorkerServiceBackoff({
            attempt: 0,
            baseMilliseconds: 100,
            maximumMilliseconds: 1_000
        }), /positive safe integer/i);
    });

    test("start is idempotent, polling sleeps, wake interrupts sleep, and stop drains", async () => {
        let calls = 0;
        const service = createPaymentWorkerService({
            worker: fakeWorker(async () => { calls += 1; return []; }),
            ledger: fakeLedger(),
            serviceId: "worker-service-idempotent",
            pollIntervalMilliseconds: 500
        });
        assert.deepEqual(service.start(), { status: "started" });
        assert.deepEqual(service.start(), { status: "already_running" });
        await until(() => calls === 1);
        await delay(20);
        assert.equal(calls, 1, "the idle loop must not busy-poll");
        assert.deepEqual(service.wake(), { status: "woken" });
        await until(() => calls === 2);
        assert.equal(service.health().healthy, true);
        assert.deepEqual(await service.stop(), { status: "stopped", timedOut: false });
        assert.equal(service.health().state, "stopped");
        assert.deepEqual(service.wake(), { status: "not_running" });
    });

    test("loop failures back off exponentially and recover readiness", async () => {
        let calls = 0;
        const recorded = [];
        const service = createPaymentWorkerService({
            worker: fakeWorker(async () => {
                calls += 1;
                if (calls <= 2) throw Object.assign(new Error("Redis unavailable"), {
                    code: "STORE_UNAVAILABLE"
                });
                return [];
            }),
            ledger: fakeLedger(),
            serviceId: "worker-service-recovery",
            pollIntervalMilliseconds: 100,
            retryBackoffBaseMilliseconds: 5,
            retryBackoffMaximumMilliseconds: 10,
            retryJitterRatio: 0,
            metrics: { record(event, payload) { recorded.push({ event, payload }); } }
        });
        service.start();
        await until(() => calls === 1);
        assert.equal(service.health().state, "backing_off");
        assert.equal(service.health().lastDelayMilliseconds, 5);
        await until(() => calls >= 3);
        assert.equal(service.health().state, "running");
        assert.equal(service.health().consecutiveFailures, 0);
        assert.equal(service.health().healthy, true);
        assert.ok(recorded.some((entry) => entry.event === "transaction_failed"));
        await service.stop();
    });

    test("failed transactions reaching the retry ceiling move to ManualReview", async () => {
        const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
        await ledger.createTransaction(transaction("2119300001"));
        const worker = createPaymentWorker({
            ledger,
            workerId: "retry-ceiling-engine",
            leaseTtlMilliseconds: 1_000,
            leaseRenewIntervalMilliseconds: 0,
            steps: [{
                name: "profile_granted",
                async run() { throw Object.assign(new Error("PlayFab timeout"), { code: "TIMEOUT" }); }
            }],
            logger: { info() {}, warn() {}, error() {} }
        });
        const service = createPaymentWorkerService({
            worker,
            ledger,
            serviceId: "retry-ceiling-service",
            pollIntervalMilliseconds: 100,
            retryBackoffBaseMilliseconds: 1,
            retryBackoffMaximumMilliseconds: 1,
            retryJitterRatio: 0,
            maximumRetries: 2,
            logger: { info() {}, warn() {}, error() {} }
        });
        service.start();
        await until(async () => {
            const stored = await ledger.requireTransaction({
                provider: "xsolla",
                providerTransactionId: "2119300001"
            });
            return stored.state === "ManualReview";
        });
        const stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119300001"
        });
        assert.equal(stored.retryCount, 2);
        assert.equal(stored.state, "ManualReview");
        assert.equal(service.health().exhaustedRetries, 1);
        assert.ok(stored.audit.some((entry) => entry.reason === "worker_retry_exhausted"));
        await service.stop();
    });

    test("permanent provider failures move to ManualReview after the first attempt", async () => {
        const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
        await ledger.createTransaction(transaction("2119300002"));
        const worker = createPaymentWorker({
            ledger,
            workerId: "permanent-failure-engine",
            leaseTtlMilliseconds: 1_000,
            leaseRenewIntervalMilliseconds: 0,
            steps: [{
                name: "profile_granted",
                async run() {
                    const error = new Error("Immutable receipt plan mismatch");
                    error.code = "PLAN_MISMATCH";
                    error.permanent = true;
                    throw error;
                }
            }],
            logger: { info() {}, warn() {}, error() {} }
        });
        const service = createPaymentWorkerService({
            worker,
            ledger,
            serviceId: "permanent-failure-service",
            pollIntervalMilliseconds: 100,
            retryBackoffBaseMilliseconds: 1,
            retryBackoffMaximumMilliseconds: 1,
            retryJitterRatio: 0,
            maximumRetries: 12,
            logger: { info() {}, warn() {}, error() {} }
        });
        service.start();
        await until(async () => (await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119300002"
        })).state === "ManualReview");
        const stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119300002"
        });
        assert.equal(stored.retryCount, 1);
        assert.equal(stored.state, "ManualReview");
        assert.equal(service.health().exhaustedRetries, 1);
        await service.stop();
    });

    test("stop reports a drain timeout without interrupting the active batch", async () => {
        let release;
        let started = false;
        const blocker = new Promise((resolve) => { release = resolve; });
        const metrics = [];
        const service = createPaymentWorkerService({
            worker: fakeWorker(async () => {
                started = true;
                await blocker;
                return [];
            }, () => ({ healthy: true, activeJobs: started ? 1 : 0 })),
            ledger: fakeLedger(),
            serviceId: "worker-service-drain",
            pollIntervalMilliseconds: 100,
            metrics: { record(event) { metrics.push(event); } }
        });
        service.start();
        await until(() => started);
        assert.deepEqual(await service.stop({ drainTimeoutMilliseconds: 5 }), {
            status: "draining",
            timedOut: true
        });
        assert.equal(service.health().state, "draining");
        assert.equal(service.health().drainTimedOut, true);
        assert.ok(metrics.includes("worker_stalled"));
        release();
        await until(() => service.health().state === "stopped");
    });

    test("invalid service configuration fails closed", () => {
        assert.throws(() => createPaymentWorkerService(), /not configured/i);
        assert.throws(() => createPaymentWorkerService({
            worker: fakeWorker(async () => []),
            ledger: fakeLedger(),
            pollIntervalMilliseconds: 0
        }), /positive safe integer/i);
        assert.throws(() => createPaymentWorkerService({
            worker: fakeWorker(async () => []),
            ledger: fakeLedger(),
            retryBackoffBaseMilliseconds: 10,
            retryBackoffMaximumMilliseconds: 5
        }), /retry policy/i);
    });
});
