import test from "node:test";
import assert from "node:assert/strict";
import { applyXsollaFinancialProfileGrant } from "../src/xsolla-financial-profile-mutator.js";

function profile() {
    return { schemaVersion: 12, playerAccountId: "46789223F9CB1BB9", updatedUtc: "2026-01-01T00:00:00.000Z", diamonds: 10,
        ammo: [], usableItems: [], cannons: [], harpoons: { quantities: [], equippedHarpoonId: "" },
        ownedDestinationMarkerIds: [], ownedShipDesignIds: [], shopEntitlements: [],
        shopReceiptLedger: { appliedTransactionIds: [] }, appliedXsollaStarterPackRewardStepIds: [], durableEconomyTransactions: [] };
}
const amount = (entries, id, key = "amount") => entries.find((entry) => entry.id === id)?.[key] ?? 0;

test("Starter III applies the exact registry rewards and ownership proof", () => {
    const original = profile();
    const result = applyXsollaFinancialProfileGrant(original, { sku: "seabyss_starter_pack_3", transactionId: "706956445", nowUtc: "2026-08-23T12:00:00Z" });
    const p = result.profile;
    assert.equal(original.diamonds, 10);
    assert.equal(p.diamonds, 3510);
    assert.equal(amount(p.ammo, "poison_cannonball"), 25000);
    assert.equal(amount(p.usableItems, "thors_wrath"), 25);
    assert.equal(amount(p.usableItems, "red_amulet"), 10);
    assert.equal(amount(p.usableItems, "diamond_offensive_powder"), 500);
    assert.equal(amount(p.usableItems, "diamond_armor_plate"), 500);
    assert.equal(amount(p.usableItems, "star_dust"), 50);
    assert.equal(amount(p.cannons, "carronade", "owned"), 5);
    assert.equal(amount(p.cannons, "long_range_cannon", "owned"), 5);
    assert.equal(amount(p.harpoons.quantities, "harpoon_diamond_250"), 500);
    assert.deepEqual(p.ownedDestinationMarkerIds.sort(), ["destination_blue_point", "destination_red_point"]);
    assert.deepEqual(p.ownedShipDesignIds, ["design_blaky"]);
    assert.equal(p.shopEntitlements[0].premiumTier, 3);
    assert.equal(p.shopEntitlements[0].expiresAtUtcIso8601, "2026-08-30T12:00:00.000Z");
    assert.equal(p.durableEconomyTransactions[0].operation, "XsollaStarterPack");
    assert.equal(p.durableEconomyTransactions[0].operationKey, "starter_pack_3");
    assert.equal(p.durableEconomyTransactions[0].state, "Completed");
});

test("unique unlocks are no-op and Premium extends UTC while preserving the higher active tier", () => {
    const p = profile();
    p.ownedDestinationMarkerIds.push("destination_red_point");
    p.shopEntitlements.push({ productId: "premium", productType: 0, premiumTier: 2,
        activatedAtUtcIso8601: "2026-08-20T00:00:00.000Z", expiresAtUtcIso8601: "2026-08-25T00:00:00.000Z",
        isPermanent: false, transactionId: "old", grantSource: "xsolla", appliedTransactionIds: ["old"] });
    const first = applyXsollaFinancialProfileGrant(p, { sku: "seabyss_starter_pack_1", transactionId: "new", nowUtc: "2026-08-23T12:00:00Z" });
    assert.equal(first.profile.ownedDestinationMarkerIds.filter((id) => id === "destination_red_point").length, 1);
    assert.equal(first.profile.shopEntitlements[0].premiumTier, 2);
    assert.equal(first.profile.shopEntitlements[0].expiresAtUtcIso8601, "2026-08-26T00:00:00.000Z");
    const replay = applyXsollaFinancialProfileGrant(first.profile, { sku: "seabyss_starter_pack_1", transactionId: "new", nowUtc: "2026-08-24T12:00:00Z" });
    assert.equal(replay.status, "already_applied");
    assert.equal(replay.profile.shopEntitlements[0].expiresAtUtcIso8601, "2026-08-26T00:00:00.000Z");
});

test("Diamond pack quantities are exact and repeatable with distinct transaction receipts", () => {
    for (const [sku, quantity] of Object.entries({ seabyss_diamond_pack_1: 1000, seabyss_diamond_pack_2: 2500, seabyss_diamond_pack_3: 5000, seabyss_diamond_pack_4: 8000, seabyss_diamond_pack_5: 20000 })) {
        const result = applyXsollaFinancialProfileGrant(profile(), { sku, transactionId: `tx-${quantity}`, nowUtc: "2026-08-23T00:00:00Z" });
        assert.equal(result.profile.diamonds, 10 + quantity);
        assert.deepEqual(result.profile.shopReceiptLedger.appliedTransactionIds, [`tx-${quantity}`]);
        assert.equal(result.profile.durableEconomyTransactions[0].operation, "XsollaDiamondPack");
    }
});

test("standalone Premium uses the same UTC max-tier extension policy", () => {
    const p = profile();
    p.shopEntitlements.push({ productId: "premium", productType: 0, premiumTier: 3,
        activatedAtUtcIso8601: "2026-08-01T00:00:00.000Z", expiresAtUtcIso8601: "2026-09-01T00:00:00.000Z",
        isPermanent: false, transactionId: "old", grantSource: "xsolla", appliedTransactionIds: ["old"] });
    const result = applyXsollaFinancialProfileGrant(p, { sku: "seabyss_premium_bronze", transactionId: "premium-2", nowUtc: "2026-08-23T00:00:00Z" });
    assert.equal(result.profile.shopEntitlements[0].premiumTier, 3);
    assert.equal(result.profile.shopEntitlements[0].expiresAtUtcIso8601, "2026-10-01T00:00:00.000Z");
    assert.equal(result.profile.durableEconomyTransactions[0].operation, "XsollaPremium");
    assert.equal(result.profile.shopReceiptLedger.appliedTransactionIds[0], "premium-2");
});

test("invalid schema and arithmetic overflow fail without mutating the input", () => {
    const invalid = profile(); invalid.schemaVersion = 11;
    assert.throws(() => applyXsollaFinancialProfileGrant(invalid, { sku: "seabyss_diamond_pack_1", transactionId: "x" }), /schema/);
    const overflowing = profile(); overflowing.diamonds = Number.MAX_SAFE_INTEGER;
    assert.throws(() => applyXsollaFinancialProfileGrant(overflowing, { sku: "seabyss_diamond_pack_1", transactionId: "x" }), /overflow/);
    assert.equal(overflowing.diamonds, Number.MAX_SAFE_INTEGER);
});
