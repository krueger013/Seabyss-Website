import { createHash } from "node:crypto";
import {
    parseEconomyV2CatalogMappings,
    requiredEconomyV2RewardIds
} from "./financial-authority-readiness.js";
import { validateFinancialAuthority } from "./financial-authority-v2.js";
import { listStarterRewardPlans } from "./xsolla-starter-reward-plan-registry.js";

export const FINANCIAL_CANONICAL_REGISTRY_VERSION = 1;
export const FINANCIAL_AUTHORITY_READ_MODES = Object.freeze([
    "Legacy",
    "ShadowRead",
    "Cutover"
]);

const STARTER_SKUS = Object.freeze(listStarterRewardPlans().map((plan) => plan.sku).sort());
const STARTER_OPERATION_TO_SKU = Object.freeze({
    starter_pack_1: "seabyss_starter_pack_1",
    starter_pack_2: "seabyss_starter_pack_2",
    starter_pack_3: "seabyss_starter_pack_3"
});

const RESOURCE_TEMPLATES = Object.freeze([
    quantity("diamonds", "Diamonds", { kind: "virtual_currency", currencyCode: "DM" }),
    quantity("elite_ball", "Consumable", { kind: "profile_collection", path: ["ammo"], amountField: "amount" }),
    quantity("poison_cannonball", "Consumable", { kind: "profile_collection", path: ["ammo"], amountField: "amount" }),
    quantity("thors_wrath", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("green_amulet", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("blue_amulet", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("red_amulet", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("diamond_offensive_powder", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("diamond_armor_plate", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("harpoon_diamond_250", "Consumable", {
        kind: "profile_collection", path: ["harpoons", "quantities"], amountField: "amount"
    }),
    quantity("star_dust", "Consumable", { kind: "profile_collection", path: ["usableItems"], amountField: "amount" }),
    quantity("carronade", "Consumable", { kind: "profile_collection", path: ["cannons"], amountField: "owned" }),
    quantity("long_range_cannon", "Consumable", { kind: "profile_collection", path: ["cannons"], amountField: "owned" }),
    premium("premium_bronze", 1),
    premium("premium_silver", 2),
    premium("premium_gold", 3),
    unique("destination_red_point", "Custom", "ownedDestinationMarkerIds", "paidDestinationMarkerIds"),
    unique("destination_blue_point", "Custom", "ownedDestinationMarkerIds", "paidDestinationMarkerIds"),
    unique("design_blaky", "ShipDesign", "ownedShipDesignIds", "paidShipDesignIds")
]);

function quantity(rewardId, rewardType, legacy) {
    return Object.freeze({ rewardId, rewardType, grantMode: "additive", semantic: "quantity", legacy });
}

function premium(rewardId, tier) {
    return Object.freeze({
        rewardId,
        rewardType: "PremiumDays",
        grantMode: "duration_extension",
        semantic: "premium",
        premiumTier: tier,
        legacy: Object.freeze({
            kind: "premium_entitlement",
            path: Object.freeze(["shopEntitlements"]),
            productId: "premium",
            productType: 0
        }),
        authorityField: "premium"
    });
}

function unique(rewardId, rewardType, legacyField, authorityField) {
    return Object.freeze({
        rewardId,
        rewardType,
        grantMode: "unique_unlock",
        semantic: "unique_unlock",
        legacy: Object.freeze({ kind: "profile_set", path: Object.freeze([legacyField]) }),
        authorityField
    });
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, name, maximumLength = 320) {
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

function pathValue(value, path, name) {
    let current = value;
    for (const segment of path) {
        if (current === undefined || current === null) return [];
        if (!plain(current)) throw new TypeError(`${name} container is invalid.`);
        current = current[segment];
    }
    if (current === undefined || current === null) return [];
    if (!Array.isArray(current)) throw new TypeError(`${name} must be an array.`);
    return current;
}

function uniqueCanonical(values, name, allowed = null) {
    if (values === undefined || values === null) return [];
    if (!Array.isArray(values)) throw new TypeError(`${name} must be an array.`);
    const result = [];
    const seen = new Set();
    for (const raw of values) {
        const value = canonical(raw, name, 255);
        if (seen.has(value)) throw new TypeError(`${name} contains a duplicate.`);
        seen.add(value);
        if (allowed === null || allowed.has(value)) result.push(value);
    }
    return result.sort((left, right) => left.localeCompare(right));
}

function unwrapProfile(value, playFabId, name) {
    const profile = plain(value?.playerProfile) ? value.playerProfile : value;
    if (!plain(profile) || profile.playerAccountId !== playFabId) {
        throw new TypeError(`${name} identity is invalid.`);
    }
    return profile;
}

function quantityFromProfile(profile, descriptor) {
    if (descriptor.legacy.kind === "virtual_currency") {
        throw new TypeError("Virtual currency requires the authoritative legacy balance.");
    }
    const entries = pathValue(profile, descriptor.legacy.path, descriptor.rewardId);
    const matches = entries.filter((entry) => entry?.id === descriptor.rewardId);
    if (matches.length > 1) throw new TypeError(`Duplicate legacy financial resource:${descriptor.rewardId}`);
    return nonNegative(matches[0]?.[descriptor.legacy.amountField] ?? 0, `${descriptor.rewardId} quantity`);
}

function premiumFromProfile(profile) {
    const entries = pathValue(profile, ["shopEntitlements"], "shopEntitlements")
        .filter((entry) => entry?.productId === "premium" && entry?.productType === 0);
    if (entries.length > 1) throw new TypeError("Duplicate legacy Premium entitlement.");
    if (entries.length === 0) {
        return Object.freeze({ tier: 0, activatedAtUtcIso8601: null, expiresAtUtcIso8601: null });
    }
    const entry = entries[0];
    const tier = nonNegative(Number(entry.premiumTier), "premium tier");
    if (tier < 1 || tier > 3) throw new TypeError("premium tier is invalid.");
    const activated = new Date(entry.activatedAtUtcIso8601);
    const expires = new Date(entry.expiresAtUtcIso8601);
    if (!Number.isFinite(activated.getTime()) || !Number.isFinite(expires.getTime()) ||
        expires.getTime() <= activated.getTime()) {
        throw new TypeError("premium interval is invalid.");
    }
    return Object.freeze({
        tier,
        activatedAtUtcIso8601: activated.toISOString(),
        expiresAtUtcIso8601: expires.toISOString()
    });
}

function ownedStarters(profile, confirmedStarterSkus) {
    const allowed = new Set(STARTER_SKUS);
    const durable = pathValue(profile, ["durableEconomyTransactions"], "durableEconomyTransactions")
        .filter((entry) => entry?.operation === "XsollaStarterPack" && entry?.state === "Completed")
        .map((entry) => STARTER_OPERATION_TO_SKU[entry.operationKey])
        .filter(Boolean);
    const confirmed = uniqueCanonical(confirmedStarterSkus || [], "confirmedStarterSkus", allowed);
    return [...new Set([...durable, ...confirmed])].sort((left, right) => left.localeCompare(right));
}

function validateRewardPlanCoverage(templateById) {
    const seen = new Set();
    for (const plan of listStarterRewardPlans()) {
        for (const reward of plan.rewards) {
            const descriptor = templateById.get(reward.rewardId);
            if (!descriptor || descriptor.rewardType !== reward.rewardType ||
                descriptor.grantMode !== reward.grantMode) {
                throw new TypeError(`Canonical financial registry does not cover ${plan.sku}:${reward.rewardId}.`);
            }
            seen.add(reward.rewardId);
        }
    }
    for (const descriptor of templateById.values()) {
        if (!seen.has(descriptor.rewardId)) {
            throw new TypeError(`Canonical financial resource is not referenced by current plans:${descriptor.rewardId}`);
        }
    }
}

export function createFinancialCanonicalResourceRegistry({ catalogMappings } = {}) {
    const parsedMappings = parseEconomyV2CatalogMappings(catalogMappings);
    const templateById = new Map(RESOURCE_TEMPLATES.map((entry) => [entry.rewardId, entry]));
    if (templateById.size !== RESOURCE_TEMPLATES.length) {
        throw new TypeError("Canonical financial registry contains duplicate reward IDs.");
    }
    validateRewardPlanCoverage(templateById);

    const additiveIds = [...requiredEconomyV2RewardIds()].sort();
    const mappedIds = Object.keys(parsedMappings).sort();
    if (JSON.stringify(additiveIds) !== JSON.stringify(mappedIds)) {
        throw new TypeError("Economy v2 mappings must exactly match the canonical additive registry.");
    }
    const resources = RESOURCE_TEMPLATES.map((template) => {
        if (template.semantic !== "quantity") return structuredClone(template);
        const mapping = parsedMappings[template.rewardId];
        const expectedKind = template.rewardId === "diamonds" ? "currency" : "inventory";
        if (!mapping || mapping.kind !== expectedKind) {
            throw new TypeError(`Economy v2 mapping kind is invalid:${template.rewardId}`);
        }
        return {
            ...structuredClone(template),
            economy: {
                kind: mapping.kind,
                itemId: mapping.itemId,
                stackId: mapping.stackId ?? "default",
                inventoryType: expectedKind === "currency" ? "currency" : "catalogItem"
            }
        };
    });
    const byId = Object.freeze(Object.fromEntries(resources.map((entry) => [entry.rewardId, deepFreeze(entry)])));
    const quantityIds = Object.freeze(resources.filter((entry) => entry.semantic === "quantity")
        .map((entry) => entry.rewardId).sort());
    const markerIds = Object.freeze(resources.filter((entry) => entry.authorityField === "paidDestinationMarkerIds")
        .map((entry) => entry.rewardId).sort());
    const designIds = Object.freeze(resources.filter((entry) => entry.authorityField === "paidShipDesignIds")
        .map((entry) => entry.rewardId).sort());

    function descriptor(rewardId) {
        canonical(rewardId, "rewardId", 255);
        if (!Object.hasOwn(byId, rewardId)) throw new RangeError(`Unknown canonical financial reward:${rewardId}`);
        return byId[rewardId];
    }

    function projectLegacy({ playFabId, profile, legacyDmBalance, confirmedStarterSkus = [] } = {}) {
        canonical(playFabId, "playFabId", 128);
        nonNegative(legacyDmBalance, "legacyDmBalance");
        const source = unwrapProfile(profile, playFabId, "legacy financial profile");
        const quantities = {};
        for (const rewardId of quantityIds) {
            quantities[rewardId] = rewardId === "diamonds"
                ? legacyDmBalance
                : quantityFromProfile(source, byId[rewardId]);
        }
        const projection = {
            schemaVersion: FINANCIAL_CANONICAL_REGISTRY_VERSION,
            playFabId,
            quantities,
            premium: premiumFromProfile(source),
            paidDestinationMarkerIds: uniqueCanonical(
                source.ownedDestinationMarkerIds,
                "ownedDestinationMarkerIds",
                new Set(markerIds)
            ),
            paidShipDesignIds: uniqueCanonical(
                source.ownedShipDesignIds,
                "ownedShipDesignIds",
                new Set(designIds)
            ),
            ownedStarterSkus: ownedStarters(source, confirmedStarterSkus)
        };
        return deepFreeze({ ...projection, digest: digest(projection) });
    }

    function projectV2({ playFabId, economyV2Quantities, authority } = {}) {
        canonical(playFabId, "playFabId", 128);
        if (!plain(economyV2Quantities)) throw new TypeError("economyV2Quantities is invalid.");
        const quantities = {};
        const supplied = Object.keys(economyV2Quantities).sort();
        if (JSON.stringify(supplied) !== JSON.stringify(quantityIds)) {
            throw new TypeError("Economy v2 snapshot is not exhaustive for the canonical registry.");
        }
        for (const rewardId of quantityIds) {
            quantities[rewardId] = nonNegative(economyV2Quantities[rewardId], `${rewardId} quantity`);
        }
        const normalizedAuthority = structuredClone(authority);
        validateFinancialAuthority(normalizedAuthority, playFabId);
        const markers = uniqueCanonical(
            normalizedAuthority.paidDestinationMarkerIds,
            "paidDestinationMarkerIds",
            new Set(markerIds)
        );
        const designs = uniqueCanonical(
            normalizedAuthority.paidShipDesignIds,
            "paidShipDesignIds",
            new Set(designIds)
        );
        if (markers.length !== normalizedAuthority.paidDestinationMarkerIds.length ||
            designs.length !== normalizedAuthority.paidShipDesignIds.length) {
            throw new TypeError("FinancialAuthorityV2 contains an unregistered paid unlock.");
        }
        const starters = uniqueCanonical(normalizedAuthority.ownedStarterSkus, "ownedStarterSkus", new Set(STARTER_SKUS));
        if (starters.length !== normalizedAuthority.ownedStarterSkus.length) {
            throw new TypeError("FinancialAuthorityV2 contains an unregistered Starter ownership.");
        }
        const projection = {
            schemaVersion: FINANCIAL_CANONICAL_REGISTRY_VERSION,
            playFabId,
            quantities,
            premium: structuredClone(normalizedAuthority.premium),
            paidDestinationMarkerIds: markers,
            paidShipDesignIds: designs,
            ownedStarterSkus: starters
        };
        return deepFreeze({ ...projection, digest: digest(projection) });
    }

    return deepFreeze({
        version: FINANCIAL_CANONICAL_REGISTRY_VERSION,
        resources,
        byId,
        quantityIds,
        markerIds,
        designIds,
        starterSkus: STARTER_SKUS,
        descriptor,
        projectLegacy,
        projectV2,
        digest: digest({ resources, starterSkus: STARTER_SKUS })
    });
}

export function compareCanonicalFinancialProjections(legacy, financialV2) {
    if (!plain(legacy) || !plain(financialV2) || legacy.playFabId !== financialV2.playFabId) {
        throw new TypeError("Canonical financial projections are not comparable.");
    }
    const differences = [];
    const quantityIds = [...new Set([
        ...Object.keys(legacy.quantities || {}),
        ...Object.keys(financialV2.quantities || {})
    ])].sort();
    for (const rewardId of quantityIds) {
        if (legacy.quantities?.[rewardId] !== financialV2.quantities?.[rewardId]) {
            differences.push(Object.freeze({
                resource: rewardId,
                legacy: legacy.quantities?.[rewardId] ?? null,
                financialV2: financialV2.quantities?.[rewardId] ?? null
            }));
        }
    }
    for (const field of ["premium", "paidDestinationMarkerIds", "paidShipDesignIds", "ownedStarterSkus"]) {
        if (JSON.stringify(stable(legacy[field])) !== JSON.stringify(stable(financialV2[field]))) {
            differences.push(Object.freeze({
                resource: field,
                legacy: structuredClone(legacy[field]),
                financialV2: structuredClone(financialV2[field])
            }));
        }
    }
    return deepFreeze({ match: differences.length === 0, differences });
}
