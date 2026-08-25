import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import {
    createCasProfileStep,
    createPaymentWorker,
    PaymentWorkerCrash
} from "../src/payment-worker.js";

const planHash = "b".repeat(64);

function createHarness({ fakeClock = false } = {}) {
    let now = fakeClock ? 10_000 : Date.now();
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => fakeClock ? now : Date.now()
    });
    return {
        ledger,
        advance(milliseconds) { now += milliseconds; }
    };
}

function transaction(providerTransactionId, overrides = {}) {
    return {
        provider: "xsolla",
        providerTransactionId,
        orderId: `order-${providerTransactionId}`,
        receiptId: `receipt-${providerTransactionId}`,
        playFabId: "4DF88C225D91FE06",
        sku: "seabyss_diamond_pack_1",
        planVersion: 1,
        planHash,
        amountMinor: 199,
        currency: "USD",
        environment: "sandbox",
        createdAtUnixMs: 9_000,
        ...overrides
    };
}

function worker(ledger, options = {}) {
    return createPaymentWorker({
        ledger,
        workerId: options.workerId || "test-worker",
        steps: options.steps || [],
        leaseTtlMilliseconds: options.leaseTtlMilliseconds || 1_000,
        leaseRenewIntervalMilliseconds: 0,
        playerLeaseWaitMilliseconds: options.playerLeaseWaitMilliseconds ?? 1_000,
        playerLeasePollMilliseconds: options.playerLeasePollMilliseconds ?? 2,
        nowMilliseconds: options.nowMilliseconds,
        sleep: options.sleep,
        faultInjector: options.faultInjector,
        completeAfterCheckpoints: options.completeAfterCheckpoints ?? true,
        logger: { info() {}, warn() {}, error() {} }
    });
}

describe("offline idempotent payment worker", () => {
    test("10 workers processing one transaction grant exactly once", async () => {
        const { ledger } = createHarness();
        await ledger.createTransaction(transaction("2119100001"));
        let effects = 0;
        const steps = [{
            name: "grant_profile",
            async run() {
                effects += 1;
                await new Promise((resolve) => setTimeout(resolve, 25));
                return { grantVersion: 1 };
            }
        }];
        const workers = Array.from({ length: 10 }, (_, index) =>
            worker(ledger, { workerId: `worker-${index}`, steps }));
        const results = await Promise.all(workers.map((item) =>
            item.processTransaction({
                provider: "xsolla",
                providerTransactionId: "2119100001"
            })));
        assert.equal(effects, 1);
        assert.equal(results.filter((result) => result.status === "completed").length, 1);
        assert.ok(results.every((result) => ["completed", "busy", "already_completed"]
            .includes(result.status)));
        const stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100001"
        });
        assert.equal(stored.state, "Completed");
        assert.equal(Object.keys(stored.checkpoints).length, 1);
    });

    test("crash after external effect resumes with the same operation ID and no double grant", async () => {
        const clock = createHarness({ fakeClock: true });
        await clock.ledger.createTransaction(transaction("2119100002"));
        const applied = new Set();
        let calls = 0;
        const steps = [{
            name: "provider_grant",
            async run({ operationId }) {
                calls += 1;
                applied.add(operationId);
                return { operationId, grantCount: applied.size };
            }
        }];
        let crash = true;
        const first = worker(clock.ledger, {
            workerId: "crashing-worker",
            steps,
            leaseTtlMilliseconds: 100,
            nowMilliseconds: () => 10_000,
            async faultInjector(stage) {
                if (stage === "after_effect_before_checkpoint" && crash) {
                    crash = false;
                    throw new PaymentWorkerCrash(stage);
                }
            }
        });
        await assert.rejects(first.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100002"
        }), PaymentWorkerCrash);
        assert.equal(applied.size, 1);
        assert.equal((await clock.ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100002"
        })).state, "Processing");

        clock.advance(101);
        const recovered = worker(clock.ledger, {
            workerId: "recovery-worker",
            steps,
            leaseTtlMilliseconds: 100,
            nowMilliseconds: () => 10_101
        });
        assert.equal((await recovered.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100002"
        })).status, "completed");
        assert.equal(calls, 2);
        assert.equal(applied.size, 1);
    });

    test("crash after checkpoint resumes without invoking the effect again", async () => {
        const clock = createHarness({ fakeClock: true });
        await clock.ledger.createTransaction(transaction("2119100003"));
        let effects = 0;
        const steps = [{
            name: "immutable_receipt",
            async run() {
                effects += 1;
                return { receipt: "written" };
            }
        }];
        let crash = true;
        const first = worker(clock.ledger, {
            workerId: "checkpoint-crash",
            steps,
            leaseTtlMilliseconds: 100,
            nowMilliseconds: () => 10_000,
            async faultInjector(stage) {
                if (stage === "after_checkpoint" && crash) {
                    crash = false;
                    throw new PaymentWorkerCrash(stage);
                }
            }
        });
        await assert.rejects(first.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100003"
        }), PaymentWorkerCrash);
        clock.advance(101);
        const recovered = worker(clock.ledger, {
            workerId: "checkpoint-recovery",
            steps,
            leaseTtlMilliseconds: 100,
            nowMilliseconds: () => 10_101
        });
        assert.equal((await recovered.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100003"
        })).status, "completed");
        assert.equal(effects, 1);
    });

    test("PlayFab timeout persists Failed and a controlled retry resumes", async () => {
        const { ledger } = createHarness();
        await ledger.createTransaction(transaction("2119100004"));
        let fail = true;
        const steps = [{
            name: "playfab_profile",
            async run() {
                if (fail) {
                    const error = new Error("simulated PlayFab timeout");
                    error.code = "PLAYFAB_TIMEOUT";
                    throw error;
                }
                return { dataVersion: 2 };
            }
        }];
        const paymentWorker = worker(ledger, { steps });
        await assert.rejects(paymentWorker.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100004"
        }), /PlayFab timeout/);
        let stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100004"
        });
        assert.equal(stored.state, "Failed");
        assert.equal(stored.retryCount, 1);
        fail = false;
        assert.equal((await paymentWorker.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100004"
        })).status, "completed");
        stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100004"
        });
        assert.equal(stored.retryCount, 2);
        assert.equal(stored.state, "Completed");
    });

    test("two transactions for one player are serialized and CAS conflicts are retried", async () => {
        const { ledger } = createHarness();
        await Promise.all([
            ledger.createTransaction(transaction("2119100010", {
                sku: "seabyss_starter_pack_1",
                amountMinor: 399
            })),
            ledger.createTransaction(transaction("2119100011", {
                sku: "seabyss_diamond_pack_1",
                amountMinor: 199
            }))
        ]);

        const profile = { version: 0, value: { diamonds: 0 } };
        const applied = new Map();
        let injectConflict = true;
        let activeMutations = 0;
        let maximumActiveMutations = 0;
        const profileStore = {
            async read() {
                return { version: profile.version, profile: structuredClone(profile.value) };
            },
            async compareAndSet({ expectedVersion, profile: next, operationId }) {
                if (applied.has(operationId)) {
                    return { applied: false, reason: "already_applied", version: profile.version };
                }
                if (injectConflict) {
                    injectConflict = false;
                    profile.value.diamonds += 5;
                    profile.version += 1;
                    return { applied: false, reason: "version_conflict", version: profile.version };
                }
                if (profile.version !== expectedVersion) {
                    return { applied: false, reason: "version_conflict", version: profile.version };
                }
                profile.value = structuredClone(next);
                profile.version += 1;
                applied.set(operationId, profile.version);
                return { applied: true, version: profile.version };
            }
        };
        const casStep = createCasProfileStep({
            name: "profile_cas_grant",
            profileStore,
            async mutate(current) {
                activeMutations += 1;
                maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations);
                await new Promise((resolve) => setTimeout(resolve, 15));
                current.diamonds += 1;
                activeMutations -= 1;
                return current;
            }
        });
        const first = worker(ledger, { workerId: "same-player-a", steps: [casStep] });
        const second = worker(ledger, { workerId: "same-player-b", steps: [casStep] });
        const results = await Promise.all([
            first.processTransaction({ provider: "xsolla", providerTransactionId: "2119100010" }),
            second.processTransaction({ provider: "xsolla", providerTransactionId: "2119100011" })
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), ["completed", "completed"]);
        assert.equal(profile.value.diamonds, 7);
        assert.equal(profile.version, 3);
        assert.equal(maximumActiveMutations, 1);
        assert.equal(applied.size, 2);
    });

    test("batch processing completes pending receipts without a connected player", async () => {
        const { ledger } = createHarness();
        await Promise.all([
            ledger.createTransaction(transaction("2119100020")),
            ledger.createTransaction(transaction("2119100021", {
                playFabId: "OFFLINEPLAYER0001"
            }))
        ]);
        let effects = 0;
        const paymentWorker = worker(ledger, {
            steps: [{ name: "offline_grant", async run() { effects += 1; return { ok: true }; } }]
        });
        const results = await paymentWorker.processPending();
        assert.equal(results.filter((result) => result.status === "completed").length, 2);
        assert.equal(effects, 2);
    });

    test("can leave completed checkpoints Pending without changing the default completion policy", async () => {
        const { ledger } = createHarness();
        await Promise.all([
            ledger.createTransaction(transaction("2119100030")),
            ledger.createTransaction(transaction("2119100031"))
        ]);
        const steps = [{ name: "receipt_only", async run() { return { persisted: true }; } }];
        const deferredWorker = worker(ledger, { steps, completeAfterCheckpoints: false });
        const defaultWorker = worker(ledger, { steps });
        const deferred = await deferredWorker.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100030"
        });
        const completed = await defaultWorker.processTransaction({
            provider: "xsolla",
            providerTransactionId: "2119100031"
        });
        assert.equal(deferred.status, "checkpoints_pending");
        assert.equal(deferred.transaction.state, "Pending");
        assert.ok(deferred.transaction.checkpoints.receipt_only);
        assert.equal(completed.status, "completed");
        assert.equal(completed.transaction.state, "Completed");
    });
});
