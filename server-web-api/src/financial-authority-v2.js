import { createHash } from "node:crypto";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";

export const PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME = "SeabyssFinancialAuthorityV2";
export const PLAYFAB_FINANCIAL_AUTHORITY_VERSION = "financial_v2";
export const PLAYFAB_FINANCIAL_AUTHORITY_SCHEMA_VERSION = 2;

const PREMIUM_TIERS = Object.freeze({
    premium_bronze: 1,
    premium_silver: 2,
    premium_gold: 3
});

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function uniqueCanonicalList(value, name, maximumEntries = 4096) {
    if (!Array.isArray(value) || value.length > maximumEntries) {
        throw new TypeError(`${name} is invalid.`);
    }
    const result = [];
    const seen = new Set();
    for (const entry of value) {
        const normalized = canonical(entry, `${name} entry`);
        if (seen.has(normalized)) throw new TypeError(`${name} contains a duplicate.`);
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function parseUtc(value, name, allowNull = false) {
    if (allowNull && value === null) return null;
    canonical(value, name, 64);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new TypeError(`${name} must be a canonical UTC ISO-8601 timestamp.`);
    }
    return parsed;
}

function addUnique(list, value) {
    if (!list.includes(value)) list.push(value);
}

export function financialAuthorityDigest(value) {
    return createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex");
}

export function createInitialFinancialAuthority({
    playFabId,
    migratedAtUtc,
    sourceDigests,
    premium = null,
    paidDestinationMarkerIds = [],
    paidShipDesignIds = [],
    ownedStarterSkus = [],
    appliedTransactionIds = []
}) {
    canonical(playFabId, "playFabId", 128);
    const migratedAt = parseUtc(migratedAtUtc, "migratedAtUtc");
    if (!plain(sourceDigests)) throw new TypeError("sourceDigests is invalid.");
    for (const required of ["profileV1", "financialV1", "legacyDm"]) {
        if (!/^[a-f0-9]{64}$/u.test(sourceDigests[required] || "")) {
            throw new TypeError(`sourceDigests.${required} is invalid.`);
        }
    }
    const normalizedPremium = premium === null
        ? { tier: 0, activatedAtUtcIso8601: null, expiresAtUtcIso8601: null }
        : structuredClone(premium);
    const authority = {
        schemaVersion: PLAYFAB_FINANCIAL_AUTHORITY_SCHEMA_VERSION,
        authorityVersion: PLAYFAB_FINANCIAL_AUTHORITY_VERSION,
        legacyPlayFabId: playFabId,
        financialRevision: 1,
        lastFencingToken: 0,
        appliedOperations: [],
        appliedTransactionIds: uniqueCanonicalList(appliedTransactionIds, "appliedTransactionIds"),
        paidDestinationMarkerIds: uniqueCanonicalList(paidDestinationMarkerIds, "paidDestinationMarkerIds"),
        paidShipDesignIds: uniqueCanonicalList(paidShipDesignIds, "paidShipDesignIds"),
        ownedStarterSkus: uniqueCanonicalList(ownedStarterSkus, "ownedStarterSkus"),
        premium: normalizedPremium,
        migration: {
            state: "Completed",
            migratedAtUtc: migratedAt.toISOString(),
            sourceDigests: structuredClone(sourceDigests)
        }
    };
    return validateFinancialAuthority(authority, playFabId);
}

export function validateFinancialAuthority(value, expectedPlayFabId = null, {
    maximumAppliedOperations = 4096,
    maximumAppliedTransactions = 4096
} = {}) {
    if (!plain(value) || value.schemaVersion !== PLAYFAB_FINANCIAL_AUTHORITY_SCHEMA_VERSION ||
        value.authorityVersion !== PLAYFAB_FINANCIAL_AUTHORITY_VERSION) {
        throw new TypeError("Financial authority schema is invalid.");
    }
    const playFabId = canonical(value.legacyPlayFabId, "legacyPlayFabId", 128);
    if (expectedPlayFabId !== null && playFabId !== expectedPlayFabId) {
        throw new TypeError("Financial authority account identity differs.");
    }
    nonNegativeInteger(value.financialRevision, "financialRevision");
    if (value.financialRevision === 0) throw new TypeError("financialRevision must be positive.");
    nonNegativeInteger(value.lastFencingToken, "lastFencingToken");
    value.appliedOperations = uniqueCanonicalList(value.appliedOperations, "appliedOperations", maximumAppliedOperations);
    value.appliedTransactionIds = uniqueCanonicalList(
        value.appliedTransactionIds,
        "appliedTransactionIds",
        maximumAppliedTransactions
    );
    value.paidDestinationMarkerIds = uniqueCanonicalList(value.paidDestinationMarkerIds, "paidDestinationMarkerIds");
    value.paidShipDesignIds = uniqueCanonicalList(value.paidShipDesignIds, "paidShipDesignIds");
    value.ownedStarterSkus = uniqueCanonicalList(value.ownedStarterSkus, "ownedStarterSkus");
    if (!plain(value.premium)) throw new TypeError("premium is invalid.");
    nonNegativeInteger(value.premium.tier, "premium.tier");
    if (value.premium.tier > 3) throw new TypeError("premium.tier is invalid.");
    const activated = parseUtc(value.premium.activatedAtUtcIso8601, "premium.activatedAtUtcIso8601", true);
    const expires = parseUtc(value.premium.expiresAtUtcIso8601, "premium.expiresAtUtcIso8601", true);
    if ((value.premium.tier === 0 && (activated !== null || expires !== null)) ||
        (value.premium.tier > 0 && (activated === null || expires === null)) ||
        (activated !== null && expires !== null && expires <= activated)) {
        throw new TypeError("premium interval is invalid.");
    }
    if (!plain(value.migration) || value.migration.state !== "Completed" || !plain(value.migration.sourceDigests)) {
        throw new TypeError("migration proof is invalid.");
    }
    parseUtc(value.migration.migratedAtUtc, "migration.migratedAtUtc");
    for (const required of ["profileV1", "financialV1", "legacyDm"]) {
        if (!/^[a-f0-9]{64}$/u.test(value.migration.sourceDigests[required] || "")) {
            throw new TypeError(`migration.sourceDigests.${required} is invalid.`);
        }
    }
    return value;
}

function extendPremium(authority, rewardId, durationDays, transactionId, now) {
    const tier = PREMIUM_TIERS[rewardId];
    if (!tier || !Number.isSafeInteger(durationDays) || durationDays <= 0) {
        throw new TypeError("Premium reward is invalid.");
    }
    const currentExpiry = authority.premium.expiresAtUtcIso8601
        ? new Date(authority.premium.expiresAtUtcIso8601)
        : null;
    const active = currentExpiry !== null && currentExpiry > now;
    const base = active ? currentExpiry : now;
    const expires = new Date(base.getTime() + durationDays * 86_400_000);
    authority.premium = {
        tier: active ? Math.max(authority.premium.tier, tier) : tier,
        activatedAtUtcIso8601: active ? authority.premium.activatedAtUtcIso8601 : now.toISOString(),
        expiresAtUtcIso8601: expires.toISOString(),
        lastTransactionId: transactionId
    };
}

export function applyFinancialEntitlementGrant(authority, {
    sku,
    transactionId,
    operationId,
    fencingToken,
    productPlanVersion = undefined,
    rewardPlanVersion = undefined,
    nowUtc = new Date()
}) {
    validateFinancialAuthority(authority);
    canonical(sku, "sku", 255);
    canonical(transactionId, "transactionId");
    canonical(operationId, "operationId");
    nonNegativeInteger(fencingToken, "fencingToken");
    if (fencingToken === 0) throw new TypeError("fencingToken must be positive.");
    const now = nowUtc instanceof Date ? new Date(nowUtc) : new Date(nowUtc);
    if (!Number.isFinite(now.getTime())) throw new TypeError("nowUtc is invalid.");
    if (authority.appliedOperations.includes(operationId)) {
        return { status: "already_applied", authority: structuredClone(authority), changed: false };
    }
    if (fencingToken <= authority.lastFencingToken) {
        return { status: "stale_fencing", authority: structuredClone(authority), changed: false };
    }
    const next = structuredClone(authority);
    const product = getXsollaProductPlan(sku, productPlanVersion);
    if (product.productType === "starter_pack") {
        for (const reward of getStarterRewardPlan(sku, rewardPlanVersion).rewards) {
            if (reward.rewardType === "PremiumDays") {
                extendPremium(next, reward.rewardId, reward.durationDays, transactionId, now);
            } else if (reward.grantMode === "unique_unlock") {
                if (reward.rewardId === "destination_red_point" || reward.rewardId === "destination_blue_point") {
                    addUnique(next.paidDestinationMarkerIds, reward.rewardId);
                } else if (reward.rewardType === "ShipDesign") {
                    addUnique(next.paidShipDesignIds, reward.rewardId);
                } else {
                    throw new RangeError(`Unsupported unique financial reward: ${reward.rewardId}.`);
                }
            }
        }
        addUnique(next.ownedStarterSkus, sku);
    } else if (product.productType === "premium") {
        extendPremium(next, sku.replace(/^seabyss_/u, ""), product.entitlementDurationDays, transactionId, now);
    } else if (product.productType !== "diamond_pack") {
        throw new RangeError("Product is not supported by FinancialAuthorityV2.");
    }
    addUnique(next.appliedOperations, operationId);
    addUnique(next.appliedTransactionIds, transactionId);
    next.lastFencingToken = fencingToken;
    next.financialRevision += 1;
    validateFinancialAuthority(next);
    return { status: "applied", authority: next, changed: true };
}

export function verifyFinancialEntitlementGrant(authority, {
    sku,
    transactionId,
    operationId,
    productPlanVersion = undefined,
    rewardPlanVersion = undefined
}) {
    validateFinancialAuthority(authority);
    canonical(sku, "sku", 255);
    canonical(transactionId, "transactionId");
    canonical(operationId, "operationId");
    const product = getXsollaProductPlan(sku, productPlanVersion);
    if (!authority.appliedOperations.includes(operationId) ||
        !authority.appliedTransactionIds.includes(transactionId)) return false;
    if (product.productType === "starter_pack" && !authority.ownedStarterSkus.includes(sku)) return false;
    if (product.productType === "starter_pack") {
        for (const reward of getStarterRewardPlan(sku, rewardPlanVersion).rewards) {
            if (reward.rewardId === "destination_red_point" || reward.rewardId === "destination_blue_point") {
                if (!authority.paidDestinationMarkerIds.includes(reward.rewardId)) return false;
            } else if (reward.rewardType === "ShipDesign" &&
                !authority.paidShipDesignIds.includes(reward.rewardId)) return false;
        }
    }
    return true;
}
