import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { PaymentWorkerCrash } from "../src/payment-worker.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { createPlayFabPaymentGrantAdapter } from "../src/playfab-payment-grant-adapter.js";
import { createXsollaProfileGrantWorker } from "../src/xsolla-profile-grant-worker.js";
import { getXsollaStarterReceiptV2Key } from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";

const playFabId = "46789223F9CB1BB9";
function receipt() {
    const plan = getStarterRewardPlan("seabyss_starter_pack_1");
    return { playFabId, transactionId: "706956443", provider: "xsolla", providerTransactionId: "706956443", userId: playFabId,
        createdAtUtc: "2026-08-22T20:00:00.000Z", environment: "sandbox", notificationType: "payment", orderId: "706956443",
        productId: "starter_pack_1", xsollaSku: "seabyss_starter_pack_1", productType: "starter_pack", source: "xsolla_sandbox",
        productPlanVersion: 1, rewardPlanVersion: plan.planVersion, rewardPlanHash: plan.rewardPlanHash, rewards: plan.rewards,
        currency: "USD", unitAmountMinor: 399, quantity: 1, totalAmountMinor: 399, promotionPolicy: "disabled" };
}
function profile() { return { schemaVersion: 12, playerAccountId: playFabId, updatedUtc: "", diamonds: 0, ammo: [], usableItems: [], cannons: [],
    harpoons: { quantities: [], equippedHarpoonId: "" }, ownedDestinationMarkerIds: [], ownedShipDesignIds: [], shopEntitlements: [],
    shopReceiptLedger: { appliedTransactionIds: [] }, appliedXsollaStarterPackRewardStepIds: [], durableEconomyTransactions: [] }; }
function profileStore() {
    let version = 1, value = profile(), fence = 0, writes = 0;
    const operations = new Set();
    return { async read() { return { version, profile: structuredClone(value) }; },
        async compareAndSet({ expectedVersion, profile: next, operationId, fencingToken }) {
            if (operations.has(operationId)) return { applied: false, reason: "already_applied", version };
            if (fencingToken <= fence) return { applied: false, reason: "stale_fencing", version };
            if (expectedVersion !== version) return { applied: false, reason: "version_conflict", version };
            value = structuredClone(next); fence = fencingToken; version += 1; writes += 1; operations.add(operationId);
            return { applied: true, version };
        }, snapshot() { return structuredClone(value); }, writes() { return writes; } };
}
async function harness({ now = Date.now(), faultInjector = async () => {}, leaseTtlMilliseconds = 1000 } = {}) {
    let clock = now;
    const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore(), nowMilliseconds: () => clock });
    const r = receipt();
    const key = getXsollaStarterReceiptV2Key(r.transactionId);
    const processReceipt = createXsollaLedgeredReceiptProcessor({ ledger,
        persistStarterPackReceiptV2: async () => ({ key, existing: false }),
        persistDiamondPackReceiptV2: async () => { throw new Error("unexpected"); },
        workerOptions: { nowMilliseconds: () => clock, leaseTtlMilliseconds, leaseRenewIntervalMilliseconds: 0 } });
    await processReceipt(r);
    const store = profileStore();
    const adapter = createPlayFabPaymentGrantAdapter({ profileStore: store, loadReceipt: async () => ({ schemaVersion: 2, ...r }),
        nowUtc: () => new Date("2026-08-23T00:00:00Z") });
    const makeWorker = (workerId, injector = faultInjector) => createXsollaProfileGrantWorker({ ledger, grantAdapter: adapter, workerId,
        workerOptions: { nowMilliseconds: () => clock, leaseTtlMilliseconds, leaseRenewIntervalMilliseconds: 0,
            playerLeaseWaitMilliseconds: 0, faultInjector: injector } });
    return { ledger, r, store, makeWorker, advance(ms) { clock += ms; } };
}

test("offline profile grant completes only after exact profile_granted checkpoint", async () => {
    const h = await harness();
    let stored = await h.ledger.requireTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId });
    assert.equal(stored.state, "Pending");
    assert.ok(stored.checkpoints.receipt_persisted);
    assert.equal(stored.checkpoints.profile_granted, undefined);
    const result = await h.makeWorker("offline-profile").processPending();
    assert.equal(result[0].status, "completed");
    stored = await h.ledger.requireTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId });
    assert.equal(stored.state, "Completed");
    assert.ok(stored.checkpoints.profile_granted);
    assert.equal(h.store.snapshot().diamonds, 1000);
});

test("crash after provider effect before journal/checkpoint replays without double grant", async () => {
    let crash = true;
    const h = await harness({ now: 1_800_000_000_000, leaseTtlMilliseconds: 100,
        faultInjector: async (stage) => { if (stage === "after_effect_before_checkpoint" && crash) { crash = false; throw new PaymentWorkerCrash(stage); } } });
    await assert.rejects(h.makeWorker("crash").processTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId }), PaymentWorkerCrash);
    assert.equal(h.store.snapshot().diamonds, 1000);
    assert.equal(h.store.writes(), 1);
    h.advance(101);
    const result = await h.makeWorker("recover", async () => {}).processTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId });
    assert.equal(result.status, "completed");
    assert.equal(h.store.snapshot().diamonds, 1000);
    assert.equal(h.store.writes(), 1);
    assert.ok(result.transaction.checkpoints.profile_granted);
});

test("10 workers serialize one receipt and produce one profile write", async () => {
    const h = await harness();
    const workers = Array.from({ length: 10 }, (_, index) => h.makeWorker(`profile-${index}`));
    const results = await Promise.all(workers.map((worker) => worker.processTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId })));
    assert.equal(results.filter((result) => result.status === "completed").length, 1);
    assert.ok(results.every((result) => ["completed", "busy", "already_completed"].includes(result.status)));
    assert.equal(h.store.writes(), 1);
    assert.equal(h.store.snapshot().diamonds, 1000);
});

test("worker rejects legacy receipt IDs before calling the adapter", async () => {
    let calls = 0;
    const adapter = { async grant() { calls += 1; }, health() { return { healthy: true }; } };
    const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
    const r = receipt();
    await ledger.createTransaction({ provider: "xsolla", providerTransactionId: r.transactionId,
        orderId: r.transactionId, receiptId: "xss1_legacy", playFabId, sku: r.xsollaSku,
        planVersion: r.productPlanVersion, planHash: r.rewardPlanHash, amountMinor: r.totalAmountMinor,
        currency: r.currency, environment: r.environment });
    const worker = createXsollaProfileGrantWorker({ ledger, grantAdapter: adapter, workerId: "legacy-guard",
        workerOptions: { leaseRenewIntervalMilliseconds: 0, playerLeaseWaitMilliseconds: 0 } });
    const error = await worker.processTransaction({ provider: "xsolla", providerTransactionId: r.transactionId })
        .catch((value) => value);
    assert.equal(error.code, "UNSUPPORTED_RECEIPT");
    const stored = await ledger.requireTransaction({ provider: "xsolla", providerTransactionId: r.transactionId });
    assert.equal(stored.state, "Failed"); // The persistent service promotes permanent failures immediately.
    assert.equal(calls, 0);
});
