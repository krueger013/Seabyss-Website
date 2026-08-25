import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";

export const REQUIRED_FINANCIAL_AUTHORITY_VERSION = "financial_v2";

function isCanonicalMappingId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 255 &&
        value === value.trim() && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

export function requiredEconomyV2RewardIds() {
    const ids = new Set(["diamonds"]);
    for (const sku of ["seabyss_starter_pack_1", "seabyss_starter_pack_2", "seabyss_starter_pack_3"]) {
        for (const reward of getStarterRewardPlan(sku).rewards) {
            if (reward.grantMode === "additive") ids.add(reward.rewardId);
        }
    }
    return Object.freeze([...ids].sort((left, right) => left.localeCompare(right)));
}

export function parseEconomyV2CatalogMappings(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return structuredClone(value);
    if (typeof value !== "string" || value.trim().length === 0) return {};
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new TypeError("PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON must be strict JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON must be an object.");
    }
    return parsed;
}

export function evaluateFinancialAuthorityReadiness({
    cutoverEnabled,
    economyV2Enabled,
    authorityV2Enabled,
    unityAuthorityVersion,
    migrationVersion,
    revisionCasEnabled,
    serverOwnedFieldsEnabled,
    financialRefreshEnabled,
    catalogMappings
} = {}) {
    if (!cutoverEnabled) return Object.freeze({ ready: false, activationRequested: false, errors: Object.freeze([]) });
    const errors = [];
    if (!economyV2Enabled) errors.push("PLAYFAB_ECONOMY_V2_ENABLED=true");
    if (!authorityV2Enabled) errors.push("PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED=true");
    if (unityAuthorityVersion !== REQUIRED_FINANCIAL_AUTHORITY_VERSION) {
        errors.push(`UNITY_FINANCIAL_AUTHORITY_VERSION=${REQUIRED_FINANCIAL_AUTHORITY_VERSION}`);
    }
    if (migrationVersion !== REQUIRED_FINANCIAL_AUTHORITY_VERSION) {
        errors.push(`PLAYFAB_FINANCIAL_MIGRATION_VERSION=${REQUIRED_FINANCIAL_AUTHORITY_VERSION}`);
    }
    if (!revisionCasEnabled) errors.push("PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED=true");
    if (!serverOwnedFieldsEnabled) errors.push("PLAYFAB_FINANCIAL_SERVER_OWNED_FIELDS_ENABLED=true");
    if (!financialRefreshEnabled) errors.push("PLAYFAB_FINANCIAL_REFRESH_ENABLED=true");
    const mappings = parseEconomyV2CatalogMappings(catalogMappings);
    const requiredRewardIds = new Set(requiredEconomyV2RewardIds());
    const targetOwners = new Map();
    for (const [rewardId, mapping] of Object.entries(mappings)) {
        if (!isCanonicalMappingId(rewardId) || !mapping || typeof mapping !== "object" ||
            Array.isArray(mapping)) {
            errors.push(`canonical Economy v2 mapping:${rewardId}`);
            continue;
        }
        const stackId = mapping.stackId === undefined || mapping.stackId === null
            ? "default" : mapping.stackId;
        const expectedKind = rewardId === "diamonds" ? "currency" : "inventory";
        if (mapping.kind !== expectedKind || !isCanonicalMappingId(mapping.itemId) ||
            !isCanonicalMappingId(stackId)) {
            errors.push(`published Economy v2 mapping:${rewardId}`);
            continue;
        }
        const targetKey = JSON.stringify([mapping.itemId, stackId]);
        const existingOwner = targetOwners.get(targetKey);
        if (existingOwner !== undefined && existingOwner !== rewardId) {
            errors.push(`unique Economy v2 target:${existingOwner},${rewardId}`);
            continue;
        }
        targetOwners.set(targetKey, rewardId);
    }
    for (const rewardId of requiredRewardIds) {
        const mapping = mappings[rewardId];
        const stackId = mapping?.stackId === undefined || mapping?.stackId === null
            ? "default" : mapping.stackId;
        const expectedKind = rewardId === "diamonds" ? "currency" : "inventory";
        if (!mapping || mapping.kind !== expectedKind || !isCanonicalMappingId(mapping.itemId) ||
            !isCanonicalMappingId(stackId)) {
            errors.push(`published Economy v2 mapping:${rewardId}`);
        }
    }
    return Object.freeze({
        ready: errors.length === 0,
        activationRequested: true,
        errors: Object.freeze(errors),
        authorityVersion: REQUIRED_FINANCIAL_AUTHORITY_VERSION,
        mappedRewardCount: Object.keys(mappings).length
    });
}
