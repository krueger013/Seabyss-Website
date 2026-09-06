import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { PaymentWorkerCrash } from "../src/payment-worker.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { createPlayFabPaymentGrantAdapter } from "../src/playfab-payment-grant-adapter.js";
import { createXsollaProfileGrantWorker } from "../src/xsolla-profile-grant-worker.js";
import { getXsollaDiamondReceiptV2Key } from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";

function profile(playFabId) {
    return { schemaVersion: 12, playerAccountId: playFabId, updatedUtc: "", diamonds: 0,
        ammo: [], usableItems: [], cannons: [], harpoons: { quantities: [], equippedHarpoonId: "" },
        ownedDestinationMarkerIds: [], ownedShipDesignIds: [], shopEntitlements: [],
        shopReceiptLedger: { appliedTransactionIds: [] }, appliedXsollaStarterPackRewardStepIds: [],
        durableEconomyTransactions: [] };
}

function diamondReceipt(transactionId, playFabId, sku = "seabyss_diamond_pack_1") {
    const plan = getXsollaProductPlan(sku, 1);
    return { playFabId, transactionId, provider: "xsolla", providerTransactionId: transactionId,
        userId: playFabId, createdAtUtc: "2026-08-22T20:00:00.000Z", environment: "sandbox",
        notificationType: "payment", orderId: transactionId, productId: plan.productId,
        xsollaSku: plan.sku, productType: "diamond_pack", source: "xsolla_sandbox",
        productPlanVersion: plan.planVersion, currency: plan.currency,
        unitAmountMinor: plan.unitAmountMinor, quantity: 1, totalAmountMinor: plan.unitAmountMinor,
        promotionPolicy: "disabled" };
}

function createMultiPlayerProfileStore() {
    const players = new Map();
    let writes = 0;
    function state(playFabId) {
        if (!players.has(playFabId)) players.set(playFabId, {
            version: 1, value: profile(playFabId), lastFence: 0, operations: new Set()
        });
        return players.get(playFabId);
    }
    return {
        async read(playFabId) {
            const current = state(playFabId);
            return { version: current.version, profile: structuredClone(current.value) };
        },
        async compareAndSet({ playFabId, expectedVersion, profile: next, operationId, fencingToken }) {
            const current = state(playFabId);
            if (current.operations.has(operationId)) {
                return { applied: false, reason: "already_applied", version: current.version };
            }
            if (fencingToken <= current.lastFence) {
                return { applied: false, reason: "stale_fencing", version: current.version };
            }
            if (expectedVersion !== current.version) {
                return { applied: false, reason: "version_conflict", version: current.version };
            }
            current.value = structuredClone(next);
            current.version += 1;
            current.lastFence = fencingToken;
            current.operations.add(operationId);
            writes += 1;
            return { applied: true, version: current.version };
        },
        snapshot(playFabId) { return structuredClone(state(playFabId).value); },
        writes() { return writes; }
    };
}

async function prepareReceipts({ ledger, receipts, receiptValues, workerOptions = {} }) {
    const processReceipt = createXsollaLedgeredReceiptProcessor({
        ledger,
        persistStarterPackReceiptV2: async () => { throw new Error("unexpected Starter receipt"); },
        persistDiamondPackReceiptV2: async (receipt) => {
            const key = getXsollaDiamondReceiptV2Key(receipt.transactionId);
            const existing = receiptValues.has(key);
            receiptValues.set(key, { schemaVersion: 2, ...receipt });
            return { key, existing };
        },
        workerOptions: { leaseRenewIntervalMilliseconds: 0, playerLeaseWaitMilliseconds: 10_000,
            playerLeasePollMilliseconds: 1, ...workerOptions }
    });
    for (const receipt of receipts) {
        const result = await processReceipt(receipt);
        assert.equal(result.status, "checkpoints_pending");
    }
}

function adapter(profileStore, receiptValues, options = {}) {
    return createPlayFabPaymentGrantAdapter({
        profileStore,
        loadReceipt: async ({ receiptId }) => receiptValues.get(receiptId) ?? null,
        nowUtc: () => new Date("2026-08-23T00:00:00.000Z"),
        ...options
    });
}

test("100 multi-player payments finish with exact sums, no duplicate/lost update/block, and released leases", async () => {
    const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
    const receiptValues = new Map();
    const receipts = Array.from({ length: 100 }, (_, index) =>
        diamondReceipt(String(800000000 + index), `MULTIPLAYER${String(index % 20).padStart(3, "0")}`));
    await prepareReceipts({ ledger, receipts, receiptValues });
    const profiles = createMultiPlayerProfileStore();
    const grantAdapter = adapter(profiles, receiptValues);
    const workers = Array.from({ length: 10 }, (_, index) => createXsollaProfileGrantWorker({
        ledger, grantAdapter, workerId: `stress-worker-${index}`,
        workerOptions: { leaseRenewIntervalMilliseconds: 0, playerLeaseWaitMilliseconds: 10_000,
            playerLeasePollMilliseconds: 1 }
    }));
    const results = await Promise.all(receipts.map((receipt, index) =>
        workers[index % workers.length].processTransaction({
            provider: "xsolla", providerTransactionId: receipt.transactionId
        })));
    assert.equal(results.length, 100);
    assert.ok(results.every((result) => result.status === "completed"));
    assert.equal(profiles.writes(), 100);
    for (let index = 0; index < 20; index += 1) {
        const playFabId = `MULTIPLAYER${String(index).padStart(3, "0")}`;
        const snapshot = profiles.snapshot(playFabId);
        assert.equal(snapshot.diamonds, 2500);
        assert.equal(snapshot.shopReceiptLedger.appliedTransactionIds.length, 5);
        assert.equal(new Set(snapshot.shopReceiptLedger.appliedTransactionIds).size, 5);
        assert.equal(snapshot.durableEconomyTransactions.length, 5);
        const token = `profile-probe-${index}`;
        const acquired = await ledger.acquireResourceLease({ resourceType: "playfab-profile",
            resourceId: playFabId, owner: "lease-probe", token, ttlMilliseconds: 1000 });
        assert.equal(acquired.status, "acquired");
        await ledger.releaseResourceLease({ resourceType: "playfab-profile", resourceId: playFabId, token });
    }
    for (const receipt of receipts) {
        const stored = await ledger.requireTransaction({ provider: "xsolla", providerTransactionId: receipt.transactionId });
        assert.equal(stored.state, "Completed");
        assert.ok(stored.checkpoints.profile_granted);
        assert.equal(stored.leaseOwner, null);
        assert.equal(stored.leaseToken, null);
        assert.equal(stored.leaseExpiresAtUnixMs, null);
    }
});

test("two simultaneous transactions for one player produce the exact 500 + 1200 sum", async () => {
    const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore() });
    const receiptValues = new Map();
    const playFabId = "SAMEPLAYER000001";
    const receipts = [
        diamondReceipt("810000001", playFabId, "seabyss_diamond_pack_1"),
        diamondReceipt("810000002", playFabId, "seabyss_diamond_pack_2")
    ];
    await prepareReceipts({ ledger, receipts, receiptValues });
    const profiles = createMultiPlayerProfileStore();
    const grantAdapter = adapter(profiles, receiptValues);
    const workers = ["same-a", "same-b"].map((workerId) => createXsollaProfileGrantWorker({
        ledger, grantAdapter, workerId,
        workerOptions: { leaseRenewIntervalMilliseconds: 0, playerLeaseWaitMilliseconds: 10_000,
            playerLeasePollMilliseconds: 1 }
    }));
    const results = await Promise.all(receipts.map((receipt, index) => workers[index].processTransaction({
        provider: "xsolla", providerTransactionId: receipt.transactionId
    })));
    assert.deepEqual(results.map((result) => result.status), ["completed", "completed"]);
    const snapshot = profiles.snapshot(playFabId);
    assert.equal(snapshot.diamonds, 1700);
    assert.equal(snapshot.shopReceiptLedger.appliedTransactionIds.length, 2);
    assert.equal(profiles.writes(), 2);
});

test("worker A becomes fenced after lease expiry while worker B completes exactly once", async () => {
    let clock = Date.parse("2026-08-23T00:00:00.000Z");
    const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore(), nowMilliseconds: () => clock });
    const receiptValues = new Map();
    const paid = diamondReceipt("820000001", "FENCEDPLAYER0001");
    await prepareReceipts({ ledger, receipts: [paid], receiptValues,
        workerOptions: { nowMilliseconds: () => clock, leaseTtlMilliseconds: 100 } });
    const profiles = createMultiPlayerProfileStore();
    let enteredLoad;
    let releaseLoad;
    const loadEntered = new Promise((resolve) => { enteredLoad = resolve; });
    const loadBlocked = new Promise((resolve) => { releaseLoad = resolve; });
    let blockA = true;
    const staleAdapter = createPlayFabPaymentGrantAdapter({
        profileStore: profiles,
        async loadReceipt({ receiptId }) {
            if (blockA) { blockA = false; enteredLoad(); await loadBlocked; }
            return receiptValues.get(receiptId);
        },
        nowUtc: () => new Date("2026-08-23T00:00:00.000Z")
    });
    const currentAdapter = adapter(profiles, receiptValues);
    const options = { nowMilliseconds: () => clock, leaseTtlMilliseconds: 100,
        leaseRenewIntervalMilliseconds: 0, playerLeaseWaitMilliseconds: 0 };
    const workerA = createXsollaProfileGrantWorker({ ledger, grantAdapter: staleAdapter,
        workerId: "stale-worker-a", workerOptions: options });
    const workerB = createXsollaProfileGrantWorker({ ledger, grantAdapter: currentAdapter,
        workerId: "current-worker-b", workerOptions: options });
    const stalePromise = workerA.processTransaction({ provider: "xsolla", providerTransactionId: paid.transactionId });
    await loadEntered;
    clock += 101;
    const current = await workerB.processTransaction({ provider: "xsolla", providerTransactionId: paid.transactionId });
    assert.equal(current.status, "completed");
    releaseLoad();
    const staleError = await stalePromise.catch((error) => error);
    assert.equal(staleError.code, "LEASE_LOST");
    assert.equal(profiles.writes(), 1);
    assert.equal(profiles.snapshot(paid.playFabId).diamonds, 500);
    const stored = await ledger.requireTransaction({ provider: "xsolla", providerTransactionId: paid.transactionId });
    assert.equal(stored.state, "Completed");
    assert.ok(stored.checkpoints.profile_granted);
});

const profileGrantFaultStages = [
    ["after_lease", "after ledger claim"],
    ["after_step_pending", "before provider journal execution"],
    ["before_checkpoint_effect", "before provider / before profile_granted"],
    ["after_effect_before_checkpoint", "after provider / before checkpoint"],
    ["after_step_applied_before_checkpoint", "before durable checkpoint"],
    ["after_checkpoint", "after checkpoint / after profile_granted"],
    ["before_complete", "before Completed"]
];

for (const [faultStage, semanticPhase] of profileGrantFaultStages) {
    test(`fault recovery at ${semanticPhase} (${faultStage}) reaches one final grant`, async () => {
        let clock = Date.parse("2026-08-23T00:00:00.000Z");
        const ledger = createPaymentLedger({
            store: createMemoryPaymentLedgerStore(),
            nowMilliseconds: () => clock
        });
        const receiptValues = new Map();
        const suffix = String(profileGrantFaultStages.findIndex(([stage]) => stage === faultStage) + 1);
        const paid = diamondReceipt(`83000000${suffix}`, `CHAOSPLAYER000${suffix}`);
        await prepareReceipts({
            ledger,
            receipts: [paid],
            receiptValues,
            workerOptions: { nowMilliseconds: () => clock, leaseTtlMilliseconds: 100 }
        });
        const profiles = createMultiPlayerProfileStore();
        const grantAdapter = adapter(profiles, receiptValues);
        let crash = true;
        const options = {
            nowMilliseconds: () => clock,
            leaseTtlMilliseconds: 100,
            leaseRenewIntervalMilliseconds: 0,
            playerLeaseWaitMilliseconds: 0
        };
        const crashing = createXsollaProfileGrantWorker({
            ledger,
            grantAdapter,
            workerId: `chaos-crash-${suffix}`,
            workerOptions: { ...options, async faultInjector(stage) {
                if (stage === faultStage && crash) {
                    crash = false;
                    throw new PaymentWorkerCrash(stage);
                }
            } }
        });
        await assert.rejects(crashing.processTransaction({
            provider: "xsolla", providerTransactionId: paid.transactionId
        }), PaymentWorkerCrash);
        clock += 101;
        const recovery = createXsollaProfileGrantWorker({ ledger, grantAdapter,
            workerId: `chaos-recover-${suffix}`, workerOptions: options });
        const result = await recovery.processTransaction({ provider: "xsolla", providerTransactionId: paid.transactionId });
        assert.equal(result.status, "completed");
        assert.equal(profiles.snapshot(paid.playFabId).diamonds, 500);
        assert.equal(profiles.writes(), 1);
        assert.ok(result.transaction.checkpoints.profile_granted);
        assert.equal(result.transaction.state, "Completed");
    });
}
