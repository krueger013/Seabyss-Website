import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentWorker } from "../src/payment-worker.js";
import { createPaymentReversalService } from "../src/payment-reversal-service.js";
import {
    createMemoryPaymentAdminAuditSink,
    createPaymentReconciliationService
} from "../src/payment-reconciliation-service.js";
import { createPaymentScanners } from "../src/payment-scanners.js";
import {
    createPaymentHealthProbes,
    createPaymentMetrics,
    evaluatePaymentAlerts
} from "../src/payment-observability.js";

const planHash = "c".repeat(64);

function harness(start = 1_000_000) {
    let now = start;
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

function transaction(providerTransactionId, overrides = {}) {
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
        createdAtUnixMs: 100,
        ...overrides
    };
}

describe("payment reversals and administration", () => {
    test("refund, cancellation, and chargeback create idempotent no-clawback cases", async () => {
        const { ledger } = harness();
        for (const [index, type] of ["refund", "order_canceled", "chargeback"].entries()) {
            const transactionId = `211920000${index}`;
            await ledger.createTransaction(transaction(transactionId));
            const service = createPaymentReversalService({
                ledger,
                logger: { info() {}, warn() {}, error() {} }
            });
            const event = {
                provider: "xsolla",
                providerTransactionId: transactionId,
                reversalEventId: `${type}-event-1`,
                type,
                amountMinor: 399,
                currency: "USD",
                occurredAtUnixMs: 900_000,
                reason: "provider_notification"
            };
            const first = await service.record(event);
            const replay = await service.record(event);
            assert.equal(first.status, "created");
            assert.equal(replay.status, "existing");
            assert.equal(first.record.entitlementAction,
                "manual_review_no_automatic_clawback");
            assert.match(first.record.supportAction, /financial_review/);
        }
    });

    test("a policy attempting automatic consumable clawback fails closed", async () => {
        const { ledger } = harness();
        await ledger.createTransaction(transaction("2119200010"));
        const service = createPaymentReversalService({
            ledger,
            policy: () => ({
                supportAction: "automatic",
                entitlementAction: "debit_spent_diamonds"
            })
        });
        await assert.rejects(service.record({
            provider: "xsolla",
            providerTransactionId: "2119200010",
            reversalEventId: "unsafe-refund",
            type: "refund",
            amountMinor: 100,
            currency: "USD",
            occurredAtUnixMs: 900_000
        }), /clawback is prohibited/i);
        assert.equal((await ledger.lookupReversals({
            provider: "xsolla",
            providerTransactionId: "2119200010"
        })).items.length, 0);
    });

    test("admin retry only wakes the persistent worker and preserves operator audit", async () => {
        const { ledger } = harness();
        await ledger.createTransaction(transaction("2119200020"));
        let receiptEffects = 0;
        const admissionWorker = createPaymentWorker({
            ledger,
            workerId: "ops-admission-worker",
            steps: [{
                name: "receipt_persisted",
                async run() { receiptEffects += 1; return { persisted: true }; }
            }],
            completeAfterCheckpoints: false,
            leaseTtlMilliseconds: 1_000,
            leaseRenewIntervalMilliseconds: 0,
            logger: { info() {}, warn() {}, error() {} }
        });
        assert.equal((await admissionWorker.processPending())[0].status, "checkpoints_pending");
        assert.equal(receiptEffects, 1);
        const auditSink = createMemoryPaymentAdminAuditSink();
        let wakes = 0;
        const workerService = {
            wake() { wakes += 1; return { status: "woken" }; }
        };
        const admin = createPaymentReconciliationService({ ledger, workerService, auditSink });
        const lookup = await admin.lookup({
            operator: "support-agent-1",
            reason: "customer support lookup",
            query: { provider: "xsolla", providerTransactionId: "2119200020" }
        });
        assert.equal(lookup.items.length, 1);
        const scheduled = await admin.safeRetry({
            operator: "support-agent-1",
            reason: "resume missing checkpoints",
            provider: "xsolla",
            providerTransactionId: "2119200020"
        });
        assert.deepEqual(scheduled, {
            status: "scheduled",
            state: "Pending",
            workerStatus: "woken"
        });
        assert.equal(wakes, 1);
        const stillPending = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119200020"
        });
        assert.equal(stillPending.state, "Pending", "admin retry must never grant inline");

        let profileGrants = 0;
        const completionWorker = createPaymentWorker({
            ledger,
            workerId: "ops-completion-worker",
            steps: [{
                name: "receipt_persisted",
                async run() { throw new Error("A completed checkpoint must be skipped."); }
            }, {
                name: "profile_granted",
                async run() { profileGrants += 1; return { applied: true }; }
            }],
            leaseTtlMilliseconds: 1_000,
            leaseRenewIntervalMilliseconds: 0,
            logger: { info() {}, warn() {}, error() {} }
        });
        assert.equal((await completionWorker.processPending())[0].status, "completed");
        assert.equal(receiptEffects, 1);
        assert.equal(profileGrants, 1);
        const refused = await admin.safeRetry({
            operator: "support-agent-1",
            reason: "must not replay completed",
            provider: "xsolla",
            providerTransactionId: "2119200020"
        });
        assert.deepEqual(refused, { status: "refused", state: "Completed" });
        assert.equal(wakes, 1);
        const audit = await auditSink.list({ operator: "support-agent-1" });
        assert.deepEqual(audit.items.map((entry) => entry.action), [
            "payment_lookup",
            "payment_retry_requested",
            "payment_retry_finished",
            "payment_retry_refused"
        ]);
        const stored = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119200020"
        });
        assert.ok(stored.audit.some((entry) => entry.action === "admin_retry_requested"));
    });

    test("safe retry refuses quarantined and every Processing state", async () => {
        const clock = harness();
        const { ledger } = clock;
        await ledger.createTransaction(transaction("2119200030", { state: "Quarantined" }));
        await ledger.createTransaction(transaction("2119200031"));
        await ledger.acquireLease({ provider: "xsolla", providerTransactionId: "2119200031" }, {
            owner: "active-worker",
            token: "active-token",
            ttlMilliseconds: 10_000
        });
        await ledger.transition({ provider: "xsolla", providerTransactionId: "2119200031" }, {
            toState: "Processing",
            leaseToken: "active-token",
            incrementRetry: true
        });
        let wakes = 0;
        const admin = createPaymentReconciliationService({
            ledger,
            workerService: { wake() { wakes += 1; return { status: "woken" }; } },
            auditSink: createMemoryPaymentAdminAuditSink(),
            nowMilliseconds: clock.now
        });
        assert.equal((await admin.safeRetry({
            operator: "support-agent-2",
            reason: "unsafe quarantine retry",
            provider: "xsolla",
            providerTransactionId: "2119200030"
        })).status, "refused");
        const active = await admin.safeRetry({
            operator: "support-agent-2",
            reason: "active lease retry",
            provider: "xsolla",
            providerTransactionId: "2119200031"
        });
        assert.deepEqual(active, {
            status: "refused",
            state: "Processing",
            reason: "active_lease"
        });
        clock.advance(10_001);
        const expired = await admin.safeRetry({
            operator: "support-agent-2",
            reason: "expired processing still requires controlled recovery",
            provider: "xsolla",
            providerTransactionId: "2119200031"
        });
        assert.deepEqual(expired, {
            status: "refused",
            state: "Processing",
            reason: "processing_state"
        });
        assert.equal(wakes, 0);
    });

    test("safe retry refuses a Failed transaction linked to a refund", async () => {
        const { ledger } = harness();
        await ledger.createTransaction(transaction("2119200032"));
        await ledger.transition({
            provider: "xsolla",
            providerTransactionId: "2119200032"
        }, {
            toState: "Failed",
            incrementRetry: true,
            actor: "test-worker",
            reason: "test_failure",
            lastError: "Synthetic worker failure."
        });
        await ledger.createReversal({
            provider: "xsolla",
            providerTransactionId: "2119200032",
            reversalEventId: "refund-before-admin-retry",
            type: "refund",
            amountMinor: 100,
            currency: "USD",
            occurredAtUnixMs: 900_000,
            reason: "provider_refund"
        });
        let wakes = 0;
        const auditSink = createMemoryPaymentAdminAuditSink();
        const admin = createPaymentReconciliationService({
            ledger,
            workerService: { wake() { wakes += 1; return { status: "woken" }; } },
            auditSink
        });
        const refused = await admin.safeRetry({
            operator: "support-agent-3",
            reason: "must not grant after refund",
            provider: "xsolla",
            providerTransactionId: "2119200032"
        });
        assert.deepEqual(refused, {
            status: "refused",
            state: "Failed",
            reason: "financial_reversal"
        });
        assert.equal(wakes, 0);
        assert.deepEqual((await auditSink.list({ operator: "support-agent-3" })).items
            .map((entry) => entry.action), ["payment_retry_refused"]);
    });
});

describe("payment scanners and observability", () => {
    test("scanners find old Pending, Quarantined, orphan receipts, expired leases, and reversals", async () => {
        const clock = harness();
        await clock.ledger.createTransaction(transaction("2119200100"));
        await clock.ledger.createTransaction(transaction("2119200101", { state: "Quarantined" }));
        await clock.ledger.createTransaction(transaction("2119200102", { receiptId: null }));
        await clock.ledger.createTransaction(transaction("2119200103", { receiptId: null }));
        await clock.ledger.acquireLease({
            provider: "xsolla",
            providerTransactionId: "2119200102"
        }, {
            owner: "dead-worker",
            token: "expired-token",
            ttlMilliseconds: 100
        });
        await clock.ledger.createReversal({
            provider: "xsolla",
            providerTransactionId: "2119200100",
            reversalEventId: "scanner-refund",
            type: "refund",
            amountMinor: 100,
            currency: "USD",
            occurredAtUnixMs: 900_000,
            reason: "scanner_test"
        });
        clock.advance(101);
        const metrics = createPaymentMetrics({ nowMilliseconds: clock.now });
        const report = await createPaymentScanners({
            ledger: clock.ledger,
            metrics,
            nowMilliseconds: clock.now,
            pendingOlderThanMilliseconds: 1_000
        }).scan();
        assert.equal(report.counts.pending, 1);
        assert.equal(report.counts.quarantined, 1);
        assert.equal(report.counts.expiredLeases, 1);
        assert.equal(report.counts.orphanReceipts, 2);
        assert.equal(report.counts.unresolvedReversals, 1);
        assert.equal(metrics.windowCount("payment_scanner_findings", {
            sinceUnixMs: 0,
            labels: { category: "quarantined" }
        }), 1);
    });

    test("liveness/readiness are separate and alert thresholds are deterministic", async () => {
        const clock = harness();
        const metrics = createPaymentMetrics({ nowMilliseconds: clock.now });
        metrics.record("webhook_rejected_signature", { value: 10 });
        metrics.record("redis_failure");
        const probes = createPaymentHealthProbes({
            ledger: clock.ledger,
            redisProbe: async () => true,
            playFabProbe: async () => ({ ok: false, reason: "timeout" }),
            worker: { health: () => ({ healthy: true, activeJobs: 0 }) },
            nowMilliseconds: clock.now,
            timeoutMilliseconds: 100
        });
        assert.equal(probes.liveness().status, "alive");
        const readiness = await probes.readiness();
        assert.equal(readiness.status, "not_ready");
        assert.equal(readiness.checks.find((check) => check.name === "playfab").reason,
            "timeout");
        const alerts = evaluatePaymentAlerts({
            metrics,
            readiness,
            scannerReport: {
                counts: {
                    pending: 2,
                    quarantined: 1,
                    expiredLeases: 1,
                    unresolvedReversals: 1
                }
            },
            certificateExpiresAtUnixMs: clock.now() + 10 * 24 * 60 * 60 * 1000,
            nowMilliseconds: clock.now()
        });
        const codes = alerts.map((alert) => alert.code);
        assert.ok(codes.includes("signature_failures_abnormal"));
        assert.ok(codes.includes("redis_down_or_degraded"));
        assert.ok(codes.includes("quarantined_transaction"));
        assert.ok(codes.includes("payment_readiness_failed"));
        assert.ok(codes.includes("certificate_expiration"));
    });
});
