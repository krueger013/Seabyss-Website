import test from "node:test";
import assert from "node:assert/strict";
import { createInitialFinancialAuthority } from "../src/financial-authority-v2.js";
import {
    createFinancialCanonicalGameplayRegistry,
    REQUIRED_GAMEPLAY_QUANTITATIVE_IDS
} from "../src/financial-canonical-gameplay-registry.js";
import { createPlayFabFinancialGameplayReader } from "../src/playfab-financial-gameplay-reader.js";

const playFabId = "0123456789ABCDEF";
const entityId = "title-player-account-id";

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
        gold: 0,
        diamonds: 0,
        sirenTears: 3,
        elitePoints: 4,
        ammo: [
            { id: "hollow_ball", amount: 5 },
            { id: "elite_ball", amount: 6 },
            { id: "illuminated_ball", amount: 7 },
            { id: "poison_cannonball", amount: 8 },
            { id: "ice_cannonball", amount: 9 },
            { id: "electric_cannonball", amount: 10 }
        ],
        usableItems: [
            { id: "green_amulet", amount: 11 },
            { id: "blue_amulet", amount: 12 },
            { id: "red_amulet", amount: 13 },
            { id: "star_dust", amount: 14 },
            { id: "thors_wrath", amount: 15 },
            { id: "diamond_offensive_powder", amount: 16 },
            { id: "diamond_armor_plate", amount: 17 }
        ],
        cannons: [
            { id: "iron_cannon", owned: 18 },
            { id: "carronade", owned: 19 },
            { id: "long_range_cannon", owned: 20 }
        ],
        harpoons: { quantities: [
            { id: "harpoon_gold_125", amount: 21 },
            { id: "harpoon_diamond_250", amount: 22 }
        ] },
        ownedDestinationMarkerIds: ["destination_red_point"],
        ownedShipDesignIds: ["design_blaky", "design_seashell"],
        shopEntitlements: [],
        durableEconomyTransactions: []
    };
}

function setup() {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const legacyProjection = registry.projectLegacy({
        playFabId,
        profile: profile(),
        legacyCurrencyBalances: { GD: 100, DM: 200 },
        confirmedStarterSkus: ["seabyss_starter_pack_3"]
    });
    const authority = createInitialFinancialAuthority({
        playFabId,
        migratedAtUtc: "2026-08-23T00:00:00.000Z",
        sourceDigests: {
            profileV1: "a".repeat(64),
            financialV1: "b".repeat(64),
            legacyDm: "c".repeat(64)
        },
        premium: legacyProjection.premium,
        paidDestinationMarkerIds: legacyProjection.paidDestinationMarkerIds,
        paidShipDesignIds: legacyProjection.paidShipDesignIds,
        ownedStarterSkus: legacyProjection.ownedStarterSkus
    });
    return { registry, legacyProjection, authority };
}

function fakeClient({ wrongStack = false, etagDrift = false, migrated = true } = {}) {
    const { registry, legacyProjection, authority } = setup();
    const items = registry.quantityIds.map((resourceId) => ({
        Id: registry.byId[resourceId].economy.itemId,
        StackId: wrongStack && resourceId === "gold" ? "wrong" : "default",
        Type: registry.byId[resourceId].economy.inventoryType,
        Amount: legacyProjection.quantities[resourceId]
    }));
    const calls = [];
    return {
        registry,
        calls,
        async getUserAccountInfo(id) {
            calls.push("getUserAccountInfo");
            return { UserInfo: { PlayFabId: id, TitleInfo: { TitlePlayerAccount: { Id: entityId } } } };
        },
        async getUserInternalData() {
            calls.push("getUserInternalData");
            return { Data: { profile_v1: { Value: JSON.stringify(profile()) } } };
        },
        async getUserInventory() {
            calls.push("getUserInventory");
            return { VirtualCurrency: { GD: 100, DM: 200 } };
        },
        async getEntityToken() {
            calls.push("getEntityToken");
            return { EntityToken: "title-entity-token" };
        },
        async getObjects() {
            calls.push("getObjects");
            return {
                ProfileVersion: 7,
                Objects: {
                    SeabyssFinancialProfileV1: { DataObject: { schemaVersion: 1, playerProfile: profile() } },
                    ...(migrated ? { SeabyssFinancialAuthorityV2: { DataObject: authority } } : {})
                }
            };
        },
        async getInventoryItems(entity, token, { continuationToken }) {
            calls.push(`getInventoryItems:${continuationToken ?? "first"}`);
            const split = Math.ceil(items.length / 2);
            return continuationToken === null
                ? { ETag: "etag-1", Items: [...items.slice(0, split), {
                    Id: "unrelated-gameplay-item", StackId: "default", Type: "catalogItem", Amount: 999
                }], ContinuationToken: "next-page" }
                : { ETag: etagDrift ? "etag-2" : "etag-1", Items: items.slice(split) };
        }
    };
}

test("legacy reader uses real profile_v1 plus GD/DM and never touches Entity or Economy v2", async () => {
    const fake = fakeClient();
    const reader = createPlayFabFinancialGameplayReader({
        client: fake,
        registry: fake.registry,
        readConfirmedStarterOwnership: async () => ["seabyss_starter_pack_3"]
    });
    const snapshot = await reader.readLegacy(playFabId);
    assert.equal(snapshot.projection.quantities.gold, 100);
    assert.equal(snapshot.projection.quantities.diamonds, 200);
    assert.equal(snapshot.projection.quantities.illuminated_ball, 7);
    assert.deepEqual(snapshot.confirmedStarterSkus, ["seabyss_starter_pack_3"]);
    assert.deepEqual(fake.calls.sort(), [
        "getUserAccountInfo", "getUserInternalData", "getUserInventory"
    ]);
});

test("migration reader paginates Economy v2, reads AuthorityV2 and returns an exhaustive canonical snapshot", async () => {
    const fake = fakeClient();
    const reader = createPlayFabFinancialGameplayReader({
        client: fake,
        registry: fake.registry,
        readConfirmedStarterOwnership: async () => ["seabyss_starter_pack_3"],
        nowMilliseconds: () => Date.parse("2026-08-23T12:00:00.000Z")
    });
    const snapshot = await reader.readMigrationSources(playFabId);
    assert.equal(snapshot.titlePlayerAccountId, entityId);
    assert.equal(snapshot.legacyGoldBalance, 100);
    assert.equal(snapshot.legacyDmBalance, 200);
    assert.equal(snapshot.economyV2Etag, "etag-1");
    assert.equal(Object.keys(snapshot.economyV2Quantities).length, REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.length);
    assert.equal(snapshot.authorityV2.migrated, true);
    assert.equal(snapshot.financialV2Projection.digest, snapshot.legacyProjection.digest);
    assert.equal(snapshot.observedAtUtc, "2026-08-23T12:00:00.000Z");
    assert.ok(fake.calls.includes("getObjects"));
    assert.ok(fake.calls.includes("getInventoryItems:first"));
    assert.ok(fake.calls.includes("getInventoryItems:next-page"));
});

test("wrong canonical stack and ETag drift each fail closed", async () => {
    const wrong = fakeClient({ wrongStack: true });
    await assert.rejects(
        createPlayFabFinancialGameplayReader({ client: wrong, registry: wrong.registry })
            .readFinancialV2(playFabId),
        (error) => error.code === "ECONOMY_V2_MAPPING_MISMATCH"
    );

    const drift = fakeClient({ etagDrift: true });
    await assert.rejects(
        createPlayFabFinancialGameplayReader({ client: drift, registry: drift.registry })
            .readFinancialV2(playFabId),
        (error) => error.code === "ECONOMY_V2_SNAPSHOT_DRIFT" && error.retryable === true
    );
});

test("unmigrated AuthorityV2 remains explicit and never fabricates a v2 projection", async () => {
    const fake = fakeClient({ migrated: false });
    const snapshot = await createPlayFabFinancialGameplayReader({ client: fake, registry: fake.registry })
        .readFinancialV2(playFabId);
    assert.equal(snapshot.authorityV2.migrated, false);
    assert.equal(snapshot.projection, null);
});
