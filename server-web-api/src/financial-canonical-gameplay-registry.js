import { createHash } from "node:crypto";
import { validateFinancialAuthority } from "./financial-authority-v2.js";
import { createFinancialCanonicalResourceRegistry } from "./financial-canonical-resource-registry.js";
import {
    listStarterRewardPlans
} from "./xsolla-starter-reward-plan-registry.js";

export const FINANCIAL_GAMEPLAY_REGISTRY_VERSION = 1;
export const GOLD_AUTHORITY_POLICY = "economy_v2_currency_required";

export const REQUIRED_PAYMENT_REWARD_IDS = Object.freeze([
    ...new Set(listStarterRewardPlans().flatMap((plan) => plan.rewards.map((reward) => reward.rewardId)))
].sort());

export const REQUIRED_PAYMENT_QUANTITATIVE_IDS = Object.freeze([
    ...new Set(listStarterRewardPlans().flatMap((plan) => plan.rewards
        .filter((reward) => reward.grantMode === "additive")
        .map((reward) => reward.rewardId)))
].sort());

export const REQUIRED_GAMEPLAY_QUANTITATIVE_IDS = Object.freeze([
    "gold",
    "diamonds",
    "siren_tears",
    "elite_points",
    "hollow_ball",
    "elite_ball",
    "illuminated_ball",
    "poison_cannonball",
    "ice_cannonball",
    "electric_cannonball",
    "green_amulet",
    "blue_amulet",
    "red_amulet",
    "star_dust",
    "thors_wrath",
    "gold_offensive_powder",
    "diamond_offensive_powder",
    "gold_armor_plate",
    "diamond_armor_plate",
    "iron_cannon",
    "carronade",
    "long_range_cannon",
    "harpoon_gold_125",
    "harpoon_diamond_250"
].sort());

export const REQUIRED_GAMEPLAY_UNIQUE_IDS = Object.freeze([
    "destination_red_point",
    "destination_blue_point",
    "design_krystal_ice",
    "design_evilz_sharky",
    "design_mersea",
    "design_blaky",
    "design_rex_abyssi",
    "design_seashell"
].sort());

export const REQUIRED_GAMEPLAY_RESOURCE_IDS = Object.freeze([
    ...REQUIRED_GAMEPLAY_QUANTITATIVE_IDS,
    ...REQUIRED_GAMEPLAY_UNIQUE_IDS,
    "premium",
    "starter_ownership"
].sort());

const CURRENCY_IDS = new Set(["gold", "diamonds", "siren_tears", "elite_points"]);
const STARTER_SKUS = Object.freeze(listStarterRewardPlans().map((plan) => plan.sku).sort());
const DESIGN_MARKET_IDS = Object.freeze({
    design_krystal_ice: "market_design_krystal_ice",
    design_evilz_sharky: "market_design_evilz_sharky",
    design_mersea: "market_design_mersea",
    design_blaky: "market_design_blaky",
    design_rex_abyssi: "market_design_rex_abyssi",
    design_seashell: "market_design_seashell"
});
const STARTER_OPERATION_TO_SKU = Object.freeze({
    starter_pack_1: "seabyss_starter_pack_1",
    starter_pack_2: "seabyss_starter_pack_2",
    starter_pack_3: "seabyss_starter_pack_3"
});

const LEGACY_QUANTITY_SOURCES = Object.freeze({
    gold: { kind: "virtual_currency", currencyCode: "GD", profileMirrorField: "gold" },
    diamonds: { kind: "virtual_currency", currencyCode: "DM", profileMirrorField: "diamonds" },
    siren_tears: { kind: "profile_scalar", field: "sirenTears" },
    elite_points: { kind: "profile_scalar", field: "elitePoints", spendPolicy: "progression_threshold_not_debit" },
    hollow_ball: collection(["ammo"], "amount"),
    elite_ball: collection(["ammo"], "amount"),
    illuminated_ball: { ...collection(["ammo"], "amount"), lifecycle: "legacy_disabled_preserve_only" },
    poison_cannonball: collection(["ammo"], "amount"),
    ice_cannonball: collection(["ammo"], "amount"),
    electric_cannonball: collection(["ammo"], "amount"),
    green_amulet: collection(["usableItems"], "amount"),
    blue_amulet: collection(["usableItems"], "amount"),
    red_amulet: collection(["usableItems"], "amount"),
    star_dust: collection(["usableItems"], "amount"),
    thors_wrath: collection(["usableItems"], "amount"),
    gold_offensive_powder: {
        ...collection(["usableItems"], "amount"),
        lifecycle: "legacy_compatibility_preserve_only"
    },
    diamond_offensive_powder: collection(["usableItems"], "amount"),
    gold_armor_plate: {
        ...collection(["usableItems"], "amount"),
        lifecycle: "legacy_compatibility_preserve_only"
    },
    diamond_armor_plate: collection(["usableItems"], "amount"),
    iron_cannon: collection(["cannons"], "owned"),
    carronade: collection(["cannons"], "owned"),
    long_range_cannon: collection(["cannons"], "owned"),
    harpoon_gold_125: collection(["harpoons", "quantities"], "amount"),
    harpoon_diamond_250: collection(["harpoons", "quantities"], "amount")
});

function collection(path, amountField) {
    return Object.freeze({ kind: "profile_collection", path: Object.freeze(path), amountField });
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, name, maximumLength = 512) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegative(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
    return value;
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!plain(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function mappingsObject(value) {
    if (plain(value)) return structuredClone(value);
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError("Gameplay Economy v2 mappings are required.");
    }
    let parsed;
    try { parsed = JSON.parse(value); } catch {
        throw new TypeError("Gameplay Economy v2 mappings are invalid JSON.");
    }
    if (!plain(parsed)) throw new TypeError("Gameplay Economy v2 mappings must be an object.");
    return parsed;
}

function normalizeMappings(value) {
    const mappings = mappingsObject(value);
    const suppliedIds = Object.keys(mappings).sort();
    if (JSON.stringify(suppliedIds) !== JSON.stringify(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS)) {
        throw new TypeError("Gameplay Economy v2 mappings must exactly cover every quantitative resource.");
    }
    const targets = new Set();
    for (const resourceId of REQUIRED_GAMEPLAY_QUANTITATIVE_IDS) {
        const mapping = mappings[resourceId];
        const expectedKind = CURRENCY_IDS.has(resourceId) ? "currency" : "inventory";
        if (!plain(mapping) || mapping.kind !== expectedKind) {
            throw new TypeError(`Gameplay Economy v2 mapping kind is invalid:${resourceId}`);
        }
        canonical(mapping.itemId, `${resourceId}.itemId`, 255);
        const stackId = mapping.stackId ?? "default";
        canonical(stackId, `${resourceId}.stackId`, 255);
        if (stackId === "{guid}") throw new TypeError(`Gameplay Economy v2 stack must be deterministic:${resourceId}`);
        const target = JSON.stringify([mapping.itemId, stackId]);
        if (targets.has(target)) throw new TypeError(`Gameplay Economy v2 target is duplicated:${resourceId}`);
        targets.add(target);
        mappings[resourceId] = { kind: expectedKind, itemId: mapping.itemId, stackId };
    }
    return mappings;
}

function pathArray(profile, path, name) {
    let value = profile;
    for (const segment of path) {
        if (value === undefined || value === null) return [];
        if (!plain(value)) throw new TypeError(`${name} container is invalid.`);
        value = value[segment];
    }
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
    return value;
}

function collectionAmount(profile, resourceId, source) {
    const matches = pathArray(profile, source.path, resourceId).filter((entry) => entry?.id === resourceId);
    if (matches.length > 1) throw new TypeError(`Duplicate legacy gameplay resource:${resourceId}`);
    return nonNegative(matches[0]?.[source.amountField] ?? 0, `${resourceId} quantity`);
}

function canonicalKnownSet(values, name, allowed, { ignoreUnknown = false } = {}) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new TypeError(`${name} must be an array.`);
    const seen = new Set();
    const result = [];
    for (const raw of values) {
        const value = canonical(raw, name, 255);
        if (seen.has(value)) throw new TypeError(`${name} contains a duplicate.`);
        seen.add(value);
        if (allowed.has(value)) result.push(value);
        else if (!ignoreUnknown) throw new TypeError(`${name} contains an unregistered financial ID.`);
    }
    return result.sort((left, right) => left.localeCompare(right));
}

function profileValue(value, playFabId) {
    const profile = plain(value?.playerProfile) ? value.playerProfile : value;
    if (!plain(profile) || profile.playerAccountId !== playFabId) {
        throw new TypeError("Legacy gameplay profile identity is invalid.");
    }
    return profile;
}

function legacyPremium(profile) {
    const entries = pathArray(profile, ["shopEntitlements"], "shopEntitlements")
        .filter((entry) => entry?.productId === "premium" && entry?.productType === 0);
    if (entries.length > 1) throw new TypeError("Duplicate legacy Premium entitlement.");
    if (entries.length === 0) return { tier: 0, activatedAtUtcIso8601: null, expiresAtUtcIso8601: null };
    const tier = nonNegative(Number(entries[0].premiumTier), "premium tier");
    const activated = new Date(entries[0].activatedAtUtcIso8601);
    const expires = new Date(entries[0].expiresAtUtcIso8601);
    if (tier < 1 || tier > 3 || !Number.isFinite(activated.getTime()) ||
        !Number.isFinite(expires.getTime()) || expires <= activated) {
        throw new TypeError("Legacy Premium entitlement is invalid.");
    }
    return { tier, activatedAtUtcIso8601: activated.toISOString(), expiresAtUtcIso8601: expires.toISOString() };
}

function starterOwnership(profile, confirmedStarterSkus) {
    const allowed = new Set(STARTER_SKUS);
    const confirmed = canonicalKnownSet(confirmedStarterSkus || [], "confirmedStarterSkus", allowed);
    const legacy = pathArray(profile, ["durableEconomyTransactions"], "durableEconomyTransactions")
        .filter((entry) => entry?.operation === "XsollaStarterPack" && entry?.state === "Completed")
        .map((entry) => STARTER_OPERATION_TO_SKU[entry.operationKey])
        .filter(Boolean);
    return [...new Set([...legacy, ...confirmed])].sort((left, right) => left.localeCompare(right));
}

function withDigest(value) {
    return deepFreeze({ ...value, digest: digest(value) });
}

export function createFinancialCanonicalGameplayRegistry({
    catalogMappings,
    goldPolicy = GOLD_AUTHORITY_POLICY
} = {}) {
    if (goldPolicy !== GOLD_AUTHORITY_POLICY) {
        throw new TypeError(`Gold policy must be explicit:${GOLD_AUTHORITY_POLICY}`);
    }
    const mappings = normalizeMappings(catalogMappings);
    const paymentMappings = Object.fromEntries(REQUIRED_PAYMENT_QUANTITATIVE_IDS.map((resourceId) => [
        resourceId,
        mappings[resourceId]
    ]));
    const paymentRegistry = createFinancialCanonicalResourceRegistry({ catalogMappings: paymentMappings });
    const resources = [];
    for (const resourceId of REQUIRED_GAMEPLAY_QUANTITATIVE_IDS) {
        const source = LEGACY_QUANTITY_SOURCES[resourceId];
        if (!source) throw new TypeError(`Legacy gameplay source is missing:${resourceId}`);
        resources.push({
            resourceId,
            semantic: "quantity",
            paymentReward: REQUIRED_PAYMENT_QUANTITATIVE_IDS.includes(resourceId),
            legacy: structuredClone(source),
            economy: {
                ...structuredClone(mappings[resourceId]),
                inventoryType: mappings[resourceId].kind === "currency" ? "currency" : "catalogItem"
            },
            ...(resourceId === "gold" ? {
                authorityDecision: "migrate_authoritative_legacy_GD_not_profile_mirror"
            } : {})
        });
    }
    for (const resourceId of REQUIRED_GAMEPLAY_UNIQUE_IDS) {
        const design = Object.hasOwn(DESIGN_MARKET_IDS, resourceId);
        resources.push({
            resourceId,
            semantic: "unique_unlock",
            paymentReward: REQUIRED_PAYMENT_REWARD_IDS.includes(resourceId),
            legacy: { field: design ? "ownedShipDesignIds" : "ownedDestinationMarkerIds" },
            authorityField: design ? "paidShipDesignIds" : "paidDestinationMarkerIds",
            ...(design ? { marketItemId: DESIGN_MARKET_IDS[resourceId] } : {})
        });
    }
    resources.push({
        resourceId: "premium",
        semantic: "premium",
        paymentRewardIds: ["premium_bronze", "premium_silver", "premium_gold"],
        legacy: { field: "shopEntitlements", productId: "premium", productType: 0 },
        authorityField: "premium"
    });
    resources.push({
        resourceId: "starter_ownership",
        semantic: "ownership_set",
        skuIds: STARTER_SKUS,
        legacy: { field: "durableEconomyTransactions", receiptUnionRequired: true },
        authorityField: "ownedStarterSkus"
    });
    const byId = Object.freeze(Object.fromEntries(resources.map((entry) => [entry.resourceId, deepFreeze(entry)])));
    if (Object.keys(byId).length !== REQUIRED_GAMEPLAY_RESOURCE_IDS.length) {
        throw new TypeError("Gameplay financial registry is not exhaustive or contains duplicates.");
    }

    for (const plan of listStarterRewardPlans()) {
        for (const reward of plan.rewards) {
            const storageId = reward.grantMode === "duration_extension" ? "premium" : reward.rewardId;
            if (!Object.hasOwn(byId, storageId)) {
                throw new TypeError(`Payment reward has no canonical gameplay resource:${reward.rewardId}`);
            }
        }
    }

    function projectLegacy({
        playFabId,
        profile,
        legacyCurrencyBalances,
        confirmedStarterSkus = []
    } = {}) {
        canonical(playFabId, "playFabId", 128);
        if (!plain(legacyCurrencyBalances)) throw new TypeError("legacyCurrencyBalances is invalid.");
        const source = profileValue(profile, playFabId);
        const quantities = {};
        for (const resourceId of REQUIRED_GAMEPLAY_QUANTITATIVE_IDS) {
            const legacy = LEGACY_QUANTITY_SOURCES[resourceId];
            if (legacy.kind === "virtual_currency") {
                quantities[resourceId] = nonNegative(
                    legacyCurrencyBalances[legacy.currencyCode],
                    `${legacy.currencyCode} legacy balance`
                );
            } else if (legacy.kind === "profile_scalar") {
                quantities[resourceId] = nonNegative(source[legacy.field] ?? 0, `${resourceId} quantity`);
            } else {
                quantities[resourceId] = collectionAmount(source, resourceId, legacy);
            }
        }
        const projection = {
            schemaVersion: FINANCIAL_GAMEPLAY_REGISTRY_VERSION,
            playFabId,
            quantities,
            premium: legacyPremium(source),
            paidDestinationMarkerIds: canonicalKnownSet(
                source.ownedDestinationMarkerIds,
                "ownedDestinationMarkerIds",
                new Set(REQUIRED_GAMEPLAY_UNIQUE_IDS.filter((id) => id.startsWith("destination_"))),
                { ignoreUnknown: true }
            ),
            paidShipDesignIds: canonicalKnownSet(
                source.ownedShipDesignIds,
                "ownedShipDesignIds",
                new Set(Object.keys(DESIGN_MARKET_IDS)),
                { ignoreUnknown: true }
            ),
            ownedStarterSkus: starterOwnership(source, confirmedStarterSkus)
        };
        return withDigest(projection);
    }

    function projectV2({ playFabId, economyV2Quantities, authority } = {}) {
        canonical(playFabId, "playFabId", 128);
        if (!plain(economyV2Quantities) ||
            JSON.stringify(Object.keys(economyV2Quantities).sort()) !==
                JSON.stringify(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS)) {
            throw new TypeError("Economy v2 gameplay snapshot is not exhaustive.");
        }
        const quantities = Object.fromEntries(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.map((resourceId) => [
            resourceId,
            nonNegative(economyV2Quantities[resourceId], `${resourceId} quantity`)
        ]));
        const normalized = structuredClone(authority);
        validateFinancialAuthority(normalized, playFabId);
        const projection = {
            schemaVersion: FINANCIAL_GAMEPLAY_REGISTRY_VERSION,
            playFabId,
            quantities,
            premium: structuredClone(normalized.premium),
            paidDestinationMarkerIds: canonicalKnownSet(
                normalized.paidDestinationMarkerIds,
                "paidDestinationMarkerIds",
                new Set(REQUIRED_GAMEPLAY_UNIQUE_IDS.filter((id) => id.startsWith("destination_")))
            ),
            paidShipDesignIds: canonicalKnownSet(
                normalized.paidShipDesignIds,
                "paidShipDesignIds",
                new Set(Object.keys(DESIGN_MARKET_IDS))
            ),
            ownedStarterSkus: canonicalKnownSet(
                normalized.ownedStarterSkus,
                "ownedStarterSkus",
                new Set(STARTER_SKUS)
            )
        };
        return withDigest(projection);
    }

    function descriptor(resourceId) {
        canonical(resourceId, "resourceId", 255);
        if (!Object.hasOwn(byId, resourceId)) throw new RangeError(`Unknown gameplay financial resource:${resourceId}`);
        return byId[resourceId];
    }

    return deepFreeze({
        version: FINANCIAL_GAMEPLAY_REGISTRY_VERSION,
        goldPolicy,
        resources,
        byId,
        quantityIds: REQUIRED_GAMEPLAY_QUANTITATIVE_IDS,
        markerIds: REQUIRED_GAMEPLAY_UNIQUE_IDS.filter((id) => id.startsWith("destination_")),
        designIds: Object.keys(DESIGN_MARKET_IDS).sort(),
        starterSkus: STARTER_SKUS,
        requiredGameplayResourceIds: REQUIRED_GAMEPLAY_RESOURCE_IDS,
        requiredPaymentRewardIds: REQUIRED_PAYMENT_REWARD_IDS,
        paymentRegistry,
        descriptor,
        projectLegacy,
        projectV2,
        digest: digest({ resources, goldPolicy, requiredPaymentRewardIds: REQUIRED_PAYMENT_REWARD_IDS })
    });
}
