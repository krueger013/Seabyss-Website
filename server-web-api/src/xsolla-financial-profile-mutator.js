import { createHash } from "node:crypto";
import { getXsollaProductPlan, getXsollaDiamondRewardQuantity } from "./xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";

const AMMO = new Set(["elite_ball", "poison_cannonball"]);
const ITEMS = new Set(["thors_wrath", "green_amulet", "blue_amulet", "red_amulet",
    "diamond_offensive_powder", "diamond_armor_plate", "star_dust"]);
const CANNONS = new Set(["carronade", "long_range_cannon"]);
const PREMIUM_TIERS = Object.freeze({ premium_bronze: 1, premium_silver: 2, premium_gold: 3 });

function plain(value) {
    return value && typeof value === "object" && !Array.isArray(value);
}
function text(value, name, max = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > max || value !== value.trim()) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}
function safeAdd(left, right, name) {
    if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 ||
        !Number.isSafeInteger(left + right)) throw new RangeError(`${name} would overflow.`);
    return left + right;
}
function list(profile, key) {
    if (!Array.isArray(profile[key])) throw new TypeError(`PlayerProfileData.${key} is invalid.`);
    return profile[key];
}
function validate(profile) {
    if (!plain(profile) || profile.schemaVersion !== 12) throw new TypeError("PlayerProfileData schema is invalid.");
    text(profile.playerAccountId, "playerAccountId", 128);
    if (!Number.isSafeInteger(profile.diamonds) || profile.diamonds < 0) throw new TypeError("diamonds is invalid.");
    for (const key of ["ammo", "usableItems", "cannons", "ownedDestinationMarkerIds", "ownedShipDesignIds",
        "shopEntitlements", "durableEconomyTransactions"]) list(profile, key);
    if (!plain(profile.harpoons) || !Array.isArray(profile.harpoons.quantities)) throw new TypeError("harpoons is invalid.");
    if (!plain(profile.shopReceiptLedger) || !Array.isArray(profile.shopReceiptLedger.appliedTransactionIds)) {
        throw new TypeError("shopReceiptLedger is invalid.");
    }
}
function increment(entries, id, amount, amountKey = "amount") {
    let entry = entries.find((candidate) => candidate?.id === id);
    if (!entry) {
        entry = amountKey === "owned" ? { id, owned: 0, equipped: 0 } : { id, amount: 0 };
        entries.push(entry);
    }
    entry[amountKey] = safeAdd(entry[amountKey] ?? 0, amount, id);
}
function unlock(entries, id) {
    if (!entries.includes(id)) entries.push(id);
}
function parseUtc(value, name) {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError(`${name} is invalid.`);
    return date;
}
function premium(profile, reward, transactionId, now) {
    const tier = PREMIUM_TIERS[reward.rewardId];
    if (!tier) throw new RangeError("Unknown Premium reward.");
    let entitlement = profile.shopEntitlements.find((entry) => entry?.productId === "premium" && entry?.productType === 0);
    const currentExpiry = entitlement?.expiresAtUtcIso8601 ? parseUtc(entitlement.expiresAtUtcIso8601, "Premium expiration") : null;
    const active = currentExpiry && currentExpiry > now;
    const base = active ? currentExpiry : now;
    const expiry = new Date(base.getTime() + reward.durationDays * 86400000);
    if (!entitlement) {
        entitlement = { productId: "premium", productType: 0, premiumTier: tier, activatedAtUtcIso8601: now.toISOString(),
            expiresAtUtcIso8601: expiry.toISOString(), isPermanent: false, transactionId, grantSource: "xsolla",
            appliedTransactionIds: [transactionId] };
        profile.shopEntitlements.push(entitlement);
    } else {
        entitlement.premiumTier = active ? Math.max(Number(entitlement.premiumTier) || 0, tier) : tier;
        entitlement.activatedAtUtcIso8601 = active ? entitlement.activatedAtUtcIso8601 : now.toISOString();
        entitlement.expiresAtUtcIso8601 = expiry.toISOString();
        entitlement.isPermanent = false;
        entitlement.transactionId = transactionId;
        entitlement.grantSource = "xsolla";
        entitlement.appliedTransactionIds = Array.isArray(entitlement.appliedTransactionIds) ? entitlement.appliedTransactionIds : [];
        unlock(entitlement.appliedTransactionIds, transactionId);
    }
}
function durableId(accountId, operation, operationKey, requestId) {
    return createHash("sha256").update(`${accountId.trim()}\u001f${operation.trim().toLowerCase()}\u001f${operationKey.trim()}\u001f${requestId.trim()}`, "utf8").digest("hex");
}
function addProof(profile, product, transactionId, now, rewardCount) {
    const operation = product.productType === "starter_pack" ? "XsollaStarterPack" :
        product.productType === "diamond_pack" ? "XsollaDiamondPack" : "XsollaPremium";
    const id = durableId(profile.playerAccountId, operation, product.productId, transactionId);
    if (profile.durableEconomyTransactions.some((entry) => entry?.transactionId === id)) return;
    profile.durableEconomyTransactions.push({
        version: 3, transactionId: id, accountId: profile.playerAccountId, operation,
        operationKey: product.productId, requestId: transactionId, state: "Completed",
        createdUtc: now.toISOString(), updatedUtc: now.toISOString(), currencyCode: "", currencyAmount: 0,
        currencyBalanceBefore: 0, currencyBalanceAfter: 0, nextStepIndex: rewardCount,
        payloadJson: "", failureReason: "", compensationApplied: false, providerMutationAttempted: false,
        compensationAttempted: false, manualCurrencyReconciliationRequired: false
    });
}
function applyReward(profile, reward, transactionId, now) {
    if (reward.rewardType === "Diamonds") profile.diamonds = safeAdd(profile.diamonds, reward.quantity, "diamonds");
    else if (reward.rewardType === "PremiumDays") premium(profile, reward, transactionId, now);
    else if (reward.rewardType === "ShipDesign") unlock(profile.ownedShipDesignIds, reward.rewardId);
    else if (reward.rewardId === "destination_red_point" || reward.rewardId === "destination_blue_point") {
        unlock(profile.ownedDestinationMarkerIds, reward.rewardId);
    } else if (AMMO.has(reward.rewardId)) increment(profile.ammo, reward.rewardId, reward.quantity);
    else if (ITEMS.has(reward.rewardId)) increment(profile.usableItems, reward.rewardId, reward.quantity);
    else if (CANNONS.has(reward.rewardId)) increment(profile.cannons, reward.rewardId, reward.quantity, "owned");
    else if (reward.rewardId === "harpoon_diamond_250") increment(profile.harpoons.quantities, reward.rewardId, reward.quantity);
    else throw new RangeError(`Unsupported financial reward: ${reward.rewardId}.`);
}

export function applyXsollaFinancialProfileGrant(profile, {
    sku,
    transactionId,
    productPlanVersion,
    nowUtc = new Date(),
    grantSource = "xsolla"
}) {
    validate(profile);
    text(sku, "sku", 255);
    text(transactionId, "transactionId");
    if (grantSource !== "xsolla") throw new TypeError("grantSource is invalid.");
    const now = parseUtc(nowUtc, "nowUtc");
    const next = structuredClone(profile);
    if (next.shopReceiptLedger.appliedTransactionIds.includes(transactionId)) {
        return { status: "already_applied", profile: next, rewardsApplied: 0 };
    }
    const product = getXsollaProductPlan(sku, productPlanVersion);
    let rewardCount = 1;
    if (product.productType === "starter_pack") {
        const plan = getStarterRewardPlan(sku);
        rewardCount = plan.rewards.length;
        plan.rewards.forEach((reward, index) => {
            applyReward(next, reward, transactionId, now);
            next.appliedXsollaStarterPackRewardStepIds ??= [];
            unlock(next.appliedXsollaStarterPackRewardStepIds, `${transactionId}|starter:${index}:${reward.rewardId}`);
        });
    } else if (product.productType === "diamond_pack") {
        const quantity = getXsollaDiamondRewardQuantity(sku, product.planVersion);
        if (!quantity) throw new RangeError("Diamond Pack quantity is not defined.");
        next.diamonds = safeAdd(next.diamonds, quantity, "diamonds");
    } else if (product.productType === "premium") {
        const rewardId = sku.replace(/^seabyss_/, "");
        if (!PREMIUM_TIERS[rewardId] || product.entitlementDurationDays !== 30) {
            throw new RangeError("Premium product grant policy is not defined.");
        }
        premium(next, { rewardId, durationDays: product.entitlementDurationDays }, transactionId, now);
    } else {
        throw new RangeError("Product is not handled by the financial profile mutator.");
    }
    unlock(next.shopReceiptLedger.appliedTransactionIds, transactionId);
    addProof(next, product, transactionId, now, rewardCount);
    next.updatedUtc = now.toISOString();
    return { status: "applied", profile: next, rewardsApplied: rewardCount };
}
