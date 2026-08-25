import { createHash } from "node:crypto";
import {
    createInitialFinancialAuthority,
    financialAuthorityDigest
} from "./financial-authority-v2.js";

const QUANTITATIVE_REWARD_IDS = Object.freeze([
    "elite_ball",
    "poison_cannonball",
    "thors_wrath",
    "green_amulet",
    "blue_amulet",
    "red_amulet",
    "diamond_offensive_powder",
    "diamond_armor_plate",
    "harpoon_diamond_250",
    "star_dust",
    "carronade",
    "long_range_cannon"
]);

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

function profileFromFinancialV1(value) {
    if (value === null || value === undefined) return null;
    return plain(value?.playerProfile) ? value.playerProfile : value;
}

function entryAmount(entries, id, key = "amount") {
    if (!Array.isArray(entries)) return 0;
    const found = entries.find((entry) => entry?.id === id);
    return nonNegative(found?.[key] ?? 0, `${id} quantity`);
}

function quantities(profile) {
    if (!plain(profile)) throw new TypeError("profile_v1 is invalid.");
    const result = {};
    for (const id of QUANTITATIVE_REWARD_IDS) {
        if (id === "elite_ball" || id === "poison_cannonball") result[id] = entryAmount(profile.ammo, id);
        else if (id === "carronade" || id === "long_range_cannon") result[id] = entryAmount(profile.cannons, id, "owned");
        else if (id === "harpoon_diamond_250") result[id] = entryAmount(profile.harpoons?.quantities, id);
        else result[id] = entryAmount(profile.usableItems, id);
    }
    return result;
}

function canonicalSet(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0).map((value) => value.trim()))]
        .sort((left, right) => left.localeCompare(right));
}

function paidMarkers(profile) {
    return canonicalSet(profile?.ownedDestinationMarkerIds)
        .filter((id) => id === "destination_red_point" || id === "destination_blue_point");
}

function paidDesigns(profile) {
    return canonicalSet(profile?.ownedShipDesignIds);
}

function premium(profile) {
    const entry = Array.isArray(profile?.shopEntitlements)
        ? profile.shopEntitlements.find((candidate) => candidate?.productId === "premium" && candidate?.productType === 0)
        : null;
    if (!entry) return { tier: 0, activatedAtUtcIso8601: null, expiresAtUtcIso8601: null };
    const tier = nonNegative(Number(entry.premiumTier) || 0, "premium tier");
    if (tier < 1 || tier > 3 || typeof entry.activatedAtUtcIso8601 !== "string" ||
        typeof entry.expiresAtUtcIso8601 !== "string") {
        throw new TypeError("Premium source is invalid.");
    }
    return {
        tier,
        activatedAtUtcIso8601: new Date(entry.activatedAtUtcIso8601).toISOString(),
        expiresAtUtcIso8601: new Date(entry.expiresAtUtcIso8601).toISOString()
    };
}

function ownedStarters(profile) {
    if (!Array.isArray(profile?.durableEconomyTransactions)) return [];
    const productToSku = {
        starter_pack_1: "seabyss_starter_pack_1",
        starter_pack_2: "seabyss_starter_pack_2",
        starter_pack_3: "seabyss_starter_pack_3"
    };
    return canonicalSet(profile.durableEconomyTransactions
        .filter((entry) => entry?.operation === "XsollaStarterPack" && entry?.state === "Completed")
        .map((entry) => productToSku[entry.operationKey])
        .filter(Boolean));
}

function equal(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function union(left, right) {
    return canonicalSet([...(left || []), ...(right || [])]);
}

function migrationId(playFabId, sources) {
    return `financial-migration:${createHash("sha256")
        .update(playFabId, "utf8")
        .update("\0", "utf8")
        .update(sources.profileV1, "utf8")
        .update(sources.financialV1, "utf8")
        .update(sources.legacyDm, "utf8")
        .digest("base64url")}:v2`;
}

export function planPlayFabFinancialAuthorityMigration({
    playFabId,
    profileV1,
    financialProfileV1 = null,
    legacyDmBalance,
    economyV2Quantities = {},
    migratedAtUtc
} = {}) {
    canonical(playFabId, "playFabId", 128);
    nonNegative(legacyDmBalance, "legacyDmBalance");
    if (!plain(profileV1) || profileV1.playerAccountId !== playFabId) throw new TypeError("profileV1 identity is invalid.");
    const financialProfile = profileFromFinancialV1(financialProfileV1);
    if (financialProfile !== null && financialProfile.playerAccountId !== playFabId) {
        throw new TypeError("financialProfileV1 identity is invalid.");
    }
    if (!plain(economyV2Quantities)) throw new TypeError("economyV2Quantities is invalid.");
    const sourceDigests = {
        profileV1: financialAuthorityDigest(profileV1),
        financialV1: financialAuthorityDigest(financialProfileV1),
        legacyDm: financialAuthorityDigest({ currency: "DM", balance: legacyDmBalance })
    };
    const legacyQuantities = quantities(profileV1);
    const financialQuantities = financialProfile === null ? legacyQuantities : quantities(financialProfile);
    const conflicts = [];
    if (financialProfile !== null) {
        for (const id of QUANTITATIVE_REWARD_IDS) {
            if (legacyQuantities[id] !== financialQuantities[id]) {
                conflicts.push({ resource: id, reason: "legacy_financial_v1_quantity_conflict",
                    profileV1: legacyQuantities[id], financialV1: financialQuantities[id] });
            }
        }
        const legacyPremium = premium(profileV1);
        const financialPremium = premium(financialProfile);
        if (!equal(legacyPremium, financialPremium)) {
            conflicts.push({ resource: "premium", reason: "legacy_financial_v1_premium_conflict",
                profileV1: legacyPremium, financialV1: financialPremium });
        }
    }
    const targetQuantities = { diamonds: legacyDmBalance, ...legacyQuantities };
    for (const [id, raw] of Object.entries(economyV2Quantities)) {
        const current = nonNegative(raw, `economyV2Quantities.${id}`);
        if (!Object.hasOwn(targetQuantities, id)) {
            conflicts.push({ resource: id, reason: "unknown_existing_economy_v2_resource", economyV2: current });
        } else if (current !== 0 && current !== targetQuantities[id]) {
            conflicts.push({ resource: id, reason: "economy_v2_target_conflict",
                target: targetQuantities[id], economyV2: current });
        }
    }
    if (conflicts.length > 0) {
        return Object.freeze({
            status: "manual_review",
            playFabId,
            authorityVersion: "financial_v2",
            sourceDigests: Object.freeze(sourceDigests),
            conflicts: Object.freeze(conflicts.map((conflict) => Object.freeze(conflict)))
        });
    }
    const initialAuthority = createInitialFinancialAuthority({
        playFabId,
        migratedAtUtc,
        sourceDigests,
        premium: premium(profileV1),
        paidDestinationMarkerIds: union(paidMarkers(profileV1), paidMarkers(financialProfile)),
        paidShipDesignIds: union(paidDesigns(profileV1), paidDesigns(financialProfile)),
        ownedStarterSkus: union(ownedStarters(profileV1), ownedStarters(financialProfile)),
        appliedTransactionIds: []
    });
    return Object.freeze({
        status: "ready",
        playFabId,
        authorityVersion: "financial_v2",
        operationId: migrationId(playFabId, sourceDigests),
        sourceDigests: Object.freeze(sourceDigests),
        targetQuantities: Object.freeze(targetQuantities),
        initialAuthority: Object.freeze(initialAuthority),
        conflictPolicy: Object.freeze({
            diamonds: "legacy_DM_wins_during_one_time_migration",
            quantitativeMismatch: "manual_review",
            permanentUnlocks: "monotonic_union",
            premiumMismatch: "manual_review"
        })
    });
}

export { QUANTITATIVE_REWARD_IDS };
