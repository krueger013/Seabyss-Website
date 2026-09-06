import test from "node:test";
import assert from "node:assert/strict";
import { createPlayFabPaymentGrantAdapter, PaymentGrantPermanentError } from "../src/playfab-payment-grant-adapter.js";
import { getXsollaStarterReceiptV2Key } from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { getXsollaDiamondReceiptV2Key } from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";

const playFabId = "46789223F9CB1BB9";

for (const [n, oldQuantity, currentQuantity] of [[1, 500, 1000], [2, 1200, 2500], [3, 3000, 5000], [4, null, 8000], [5, null, 20000]]) {
    for (const [version, quantity] of (oldQuantity === null ? [[2, currentQuantity]] : [[1, oldQuantity], [2, currentQuantity]])) {
        test(`Diamond ${n} profile adapter pins receipt v${version} to ${quantity}, replay no-op`, async () => {
            const product = getXsollaProductPlan(`seabyss_diamond_pack_${n}`, version);
            const r = {
                schemaVersion: 2, transactionId: "920000001", provider: "xsolla",
                providerTransactionId: "920000001", userId: playFabId,
                createdAtUtc: "2026-08-22T20:00:00.000Z", environment: "sandbox",
                notificationType: "payment", orderId: "920000001",
                productId: product.productId, xsollaSku: product.sku,
                productType: "diamond_pack", source: "xsolla_sandbox", productPlanVersion: version,
                currency: "USD", unitAmountMinor: product.unitAmountMinor, quantity: 1,
                totalAmountMinor: product.unitAmountMinor, promotionPolicy: "disabled"
            };
            const receiptId = getXsollaDiamondReceiptV2Key(r.transactionId);
            const tx = transaction(r, { receiptId, planHash: product.planHash,
                checkpoints: { receipt_persisted: { result: { receiptId } } } });
            const profileStore = store();
            const grant = adapter(profileStore, r);
            assert.equal((await grant.grant(context(tx))).status, "applied");
            assert.equal(profileStore.snapshot().diamonds, quantity);
            assert.equal((await grant.grant(context(tx))).status, "already_applied");
            assert.equal(profileStore.snapshot().diamonds, quantity);
            assert.equal(profileStore.writes(), 1);
            await assert.rejects(grant.grant(context({ ...tx, amountMinor: 1 })), { code: "ECONOMIC_MISMATCH" });
            assert.equal(profileStore.writes(), 1);
        });
    }
}

function profile() {
    return { schemaVersion: 12, playerAccountId: playFabId, updatedUtc: "", diamonds: 0, ammo: [], usableItems: [], cannons: [],
        harpoons: { quantities: [], equippedHarpoonId: "" }, ownedDestinationMarkerIds: [], ownedShipDesignIds: [],
        shopEntitlements: [], shopReceiptLedger: { appliedTransactionIds: [] }, appliedXsollaStarterPackRewardStepIds: [],
        durableEconomyTransactions: [] };
}
function receipt(overrides = {}) {
    const plan = getStarterRewardPlan("seabyss_starter_pack_1");
    return { schemaVersion: 2, transactionId: "706956443", notificationType: "payment", orderId: "706956443", provider: "xsolla",
        providerTransactionId: "706956443", userId: playFabId, createdAtUtc: "2026-08-22T20:00:00.000Z", environment: "sandbox",
        productId: "starter_pack_1", xsollaSku: "seabyss_starter_pack_1", productType: "starter_pack", source: "xsolla_sandbox",
        productPlanVersion: 1, rewardPlanVersion: plan.planVersion, rewardPlanHash: plan.rewardPlanHash, rewards: plan.rewards,
        currency: "USD", unitAmountMinor: 399, quantity: 1, totalAmountMinor: 399, promotionPolicy: "disabled", ...overrides };
}
function transaction(r = receipt(), overrides = {}) {
    const receiptId = getXsollaStarterReceiptV2Key(r.transactionId);
    return { provider: "xsolla", providerTransactionId: r.transactionId, playFabId, sku: r.xsollaSku, receiptId,
        planVersion: r.productPlanVersion, planHash: r.rewardPlanHash, amountMinor: r.totalAmountMinor, currency: r.currency,
        environment: r.environment, checkpoints: { receipt_persisted: { result: { receiptId } } }, ...overrides };
}
function store({ conflicts = 0, stale = false, offline = false } = {}) {
    let version = 1;
    let value = profile();
    const operations = new Set();
    let writes = 0;
    return {
        async read() { if (offline) { const e = new Error("PlayFab offline"); e.code = "PLAYFAB_OFFLINE"; throw e; }
            return { version, profile: structuredClone(value) }; },
        async compareAndSet({ expectedVersion, profile: next, operationId }) {
            if (operations.has(operationId)) return { applied: false, reason: "already_applied", version };
            if (stale) return { applied: false, reason: "stale_fencing", version };
            if (conflicts > 0) { conflicts -= 1; version += 1; return { applied: false, reason: "version_conflict", version }; }
            if (expectedVersion !== version) return { applied: false, reason: "version_conflict", version };
            value = structuredClone(next); version += 1; writes += 1; operations.add(operationId);
            return { applied: true, version };
        },
        writes() { return writes; }, snapshot() { return structuredClone(value); }
    };
}
function context(tx = transaction(), overrides = {}) {
    return { transaction: tx, operationId: "payment:test:profile_granted:v1", transactionLeaseEpoch: 1, playerLeaseEpoch: 1,
        async assertLeaseOwnership() { return { transactionLeaseEpoch: 1, playerLeaseEpoch: 1 }; }, ...overrides };
}
function adapter(profileStore, r = receipt(), options = {}) {
    return createPlayFabPaymentGrantAdapter({ profileStore, loadReceipt: async () => r,
        nowUtc: () => new Date("2026-08-23T00:00:00Z"), ...options });
}

test("offline profile errors remain retryable and do not become permanent", async () => {
    const error = await adapter(store({ offline: true })).grant(context()).catch((value) => value);
    assert.equal(error.code, "PLAYFAB_OFFLINE");
    assert.notEqual(error.permanent, true);
});

test("CAS conflict retries, writes once, and replay verifies ownership proof", async () => {
    const profileStore = store({ conflicts: 2 });
    const grant = adapter(profileStore);
    const first = await grant.grant(context());
    assert.equal(first.status, "applied");
    assert.equal(first.attempts, 3);
    assert.equal(profileStore.writes(), 1);
    const replay = await grant.grant(context());
    assert.equal(replay.status, "already_applied");
    assert.equal(profileStore.writes(), 1);
    assert.equal(profileStore.snapshot().diamonds, 1000);
});

test("stale fencing fails closed with a permanent coded error", async () => {
    const error = await adapter(store({ stale: true })).grant(context()).catch((value) => value);
    assert.ok(error instanceof PaymentGrantPermanentError);
    assert.equal(error.code, "STALE_FENCING");
});

test("missing receipt/checkpoint and plan or economic mismatches are permanent", async () => {
    const missing = createPlayFabPaymentGrantAdapter({ profileStore: store(), loadReceipt: async () => null });
    assert.equal((await missing.grant(context()).catch((e) => e)).code, "RECEIPT_NOT_FOUND");
    const noCheckpoint = transaction(receipt(), { checkpoints: {} });
    assert.equal((await adapter(store()).grant(context(noCheckpoint)).catch((e) => e)).code, "RECEIPT_NOT_PERSISTED");
    const changed = receipt({ rewardPlanHash: "0".repeat(64) });
    assert.equal((await adapter(store(), changed).grant(context()).catch((e) => e)).code, "PLAN_MISMATCH");
    const badEconomics = transaction(receipt(), { amountMinor: 400 });
    assert.equal((await adapter(store()).grant(context(badEconomics)).catch((e) => e)).code, "ECONOMIC_MISMATCH");
});
