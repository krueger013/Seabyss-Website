import test from "node:test";
import assert from "node:assert/strict";
import { createInitialFinancialAuthority } from "../src/financial-authority-v2.js";
import {
    createFinancialCanonicalGameplayRegistry,
    GOLD_AUTHORITY_POLICY,
    REQUIRED_GAMEPLAY_QUANTITATIVE_IDS,
    REQUIRED_GAMEPLAY_RESOURCE_IDS,
    REQUIRED_GAMEPLAY_UNIQUE_IDS,
    REQUIRED_PAYMENT_REWARD_IDS
} from "../src/financial-canonical-gameplay-registry.js";

const playFabId = "0123456789ABCDEF";

function mappings() {
    return Object.fromEntries(REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.map((resourceId) => [resourceId, {
        kind: ["gold", "diamonds", "siren_tears", "elite_points"].includes(resourceId)
            ? "currency"
            : "inventory",
        itemId: `economy-${resourceId}`,
        stackId: "default"
    }]));
}

function profile() {
    return {
        schemaVersion: 12,
        playerAccountId: playFabId,
        gold: 999999,
        diamonds: 999999,
        sirenTears: 13,
        elitePoints: 29,
        ammo: [
            { id: "hollow_ball", amount: 1 },
            { id: "elite_ball", amount: 2 },
            { id: "illuminated_ball", amount: 3 },
            { id: "poison_cannonball", amount: 4 },
            { id: "ice_cannonball", amount: 5 },
            { id: "electric_cannonball", amount: 6 }
        ],
        usableItems: [
            { id: "green_amulet", amount: 7 },
            { id: "blue_amulet", amount: 8 },
            { id: "red_amulet", amount: 9 },
            { id: "star_dust", amount: 10 },
            { id: "thors_wrath", amount: 11 },
            { id: "gold_offensive_powder", amount: 19 },
            { id: "diamond_offensive_powder", amount: 12 },
            { id: "gold_armor_plate", amount: 20 },
            { id: "diamond_armor_plate", amount: 13 }
        ],
        cannons: [
            { id: "iron_cannon", owned: 14 },
            { id: "carronade", owned: 15 },
            { id: "long_range_cannon", owned: 16 }
        ],
        harpoons: { quantities: [
            { id: "harpoon_gold_125", amount: 17 },
            { id: "harpoon_diamond_250", amount: 18 }
        ] },
        ownedDestinationMarkerIds: ["destination_red_point", "destination_blue_point", "story_marker"],
        ownedShipDesignIds: [
            "design_krystal_ice",
            "design_evilz_sharky",
            "design_mersea",
            "design_blaky",
            "design_rex_abyssi",
            "design_seashell",
            "default_ship"
        ],
        shopEntitlements: [{
            productId: "premium",
            productType: 0,
            premiumTier: 2,
            activatedAtUtcIso8601: "2026-08-01T00:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-01T00:00:00.000Z"
        }],
        durableEconomyTransactions: [{
            operation: "XsollaStarterPack",
            state: "Completed",
            operationKey: "starter_pack_1"
        }]
    };
}

function authority(projection) {
    return createInitialFinancialAuthority({
        playFabId,
        migratedAtUtc: "2026-08-23T00:00:00.000Z",
        sourceDigests: {
            profileV1: "a".repeat(64),
            financialV1: "b".repeat(64),
            legacyDm: "c".repeat(64)
        },
        premium: projection.premium,
        paidDestinationMarkerIds: projection.paidDestinationMarkerIds,
        paidShipDesignIds: projection.paidShipDesignIds,
        ownedStarterSkus: projection.ownedStarterSkus
    });
}

test("registry is exhaustive for gameplay and payment while making Gold authority explicit", () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    assert.equal(registry.goldPolicy, GOLD_AUTHORITY_POLICY);
    assert.equal(registry.resources.length, REQUIRED_GAMEPLAY_RESOURCE_IDS.length);
    assert.deepEqual(registry.requiredGameplayResourceIds, REQUIRED_GAMEPLAY_RESOURCE_IDS);
    assert.deepEqual(registry.requiredPaymentRewardIds, REQUIRED_PAYMENT_REWARD_IDS);
    assert.equal(registry.descriptor("gold").economy.kind, "currency");
    assert.equal(
        registry.descriptor("gold").authorityDecision,
        "migrate_authoritative_legacy_GD_not_profile_mirror"
    );
    assert.equal(registry.descriptor("illuminated_ball").legacy.lifecycle, "legacy_disabled_preserve_only");
    assert.equal(registry.descriptor("design_blaky").marketItemId, "market_design_blaky");
    for (const id of [
        "siren_tears", "elite_points", "ice_cannonball", "iron_cannon",
        "harpoon_gold_125", "design_seashell", "premium", "starter_ownership"
    ]) assert.ok(REQUIRED_GAMEPLAY_RESOURCE_IDS.includes(id), id);
});

test("every gameplay Economy mapping is external, exhaustive, typed and uniquely stacked", () => {
    const missing = mappings();
    delete missing.gold;
    assert.throws(
        () => createFinancialCanonicalGameplayRegistry({ catalogMappings: missing }),
        /exactly cover every quantitative resource/u
    );

    const wrongCurrency = mappings();
    wrongCurrency.siren_tears.kind = "inventory";
    assert.throws(
        () => createFinancialCanonicalGameplayRegistry({ catalogMappings: wrongCurrency }),
        /mapping kind is invalid:siren_tears/u
    );

    const duplicate = mappings();
    duplicate.hollow_ball.itemId = duplicate.elite_ball.itemId;
    assert.throws(
        () => createFinancialCanonicalGameplayRegistry({ catalogMappings: duplicate }),
        /target is duplicated/u
    );

    const generated = mappings();
    generated.iron_cannon.stackId = "{guid}";
    assert.throws(
        () => createFinancialCanonicalGameplayRegistry({ catalogMappings: generated }),
        /stack must be deterministic/u
    );
});

test("legacy projection preserves every real balance and uses authoritative GD/DM instead of profile mirrors", () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const projection = registry.projectLegacy({
        playFabId,
        profile: profile(),
        legacyCurrencyBalances: { GD: 101, DM: 202 },
        confirmedStarterSkus: ["seabyss_starter_pack_2"]
    });
    assert.equal(projection.quantities.gold, 101);
    assert.equal(projection.quantities.diamonds, 202);
    assert.equal(projection.quantities.siren_tears, 13);
    assert.equal(projection.quantities.elite_points, 29);
    assert.equal(projection.quantities.illuminated_ball, 3);
    assert.equal(projection.quantities.gold_offensive_powder, 19);
    assert.equal(projection.quantities.gold_armor_plate, 20);
    assert.equal(projection.quantities.harpoon_gold_125, 17);
    assert.equal(projection.quantities.harpoon_diamond_250, 18);
    assert.deepEqual(projection.paidDestinationMarkerIds, [
        "destination_blue_point", "destination_red_point"
    ]);
    assert.deepEqual(projection.paidShipDesignIds, REQUIRED_GAMEPLAY_UNIQUE_IDS
        .filter((id) => id.startsWith("design_"))
        .sort());
    assert.deepEqual(projection.ownedStarterSkus, [
        "seabyss_starter_pack_1", "seabyss_starter_pack_2"
    ]);
    assert.match(projection.digest, /^[a-f0-9]{64}$/u);

    const v2 = registry.projectV2({
        playFabId,
        economyV2Quantities: projection.quantities,
        authority: authority(projection)
    });
    assert.deepEqual(v2.quantities, projection.quantities);
    assert.deepEqual(v2.paidShipDesignIds, projection.paidShipDesignIds);
});

test("duplicate legacy stacks and non-exhaustive v2 snapshots fail closed", () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const duplicate = profile();
    duplicate.ammo.push({ id: "elite_ball", amount: 99 });
    assert.throws(() => registry.projectLegacy({
        playFabId,
        profile: duplicate,
        legacyCurrencyBalances: { GD: 1, DM: 2 }
    }), /Duplicate legacy gameplay resource:elite_ball/u);

    const projection = registry.projectLegacy({
        playFabId,
        profile: profile(),
        legacyCurrencyBalances: { GD: 1, DM: 2 }
    });
    const incomplete = { ...projection.quantities };
    delete incomplete.gold;
    assert.throws(() => registry.projectV2({
        playFabId,
        economyV2Quantities: incomplete,
        authority: authority(projection)
    }), /not exhaustive/u);
});
