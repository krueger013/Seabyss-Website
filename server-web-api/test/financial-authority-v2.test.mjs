import test from "node:test";
import assert from "node:assert/strict";
import {
    applyFinancialEntitlementGrant,
    createInitialFinancialAuthority,
    verifyFinancialEntitlementGrant
} from "../src/financial-authority-v2.js";
import { createPlayFabFinancialAuthorityStore } from "../src/playfab-financial-authority-store.js";
import { planPlayFabFinancialAuthorityMigration } from "../src/playfab-financial-authority-migration.js";

const playFabId = "46789223F9CB1BB9";
const migratedAtUtc = "2026-08-23T00:00:00.000Z";
const sourceDigests = {
    profileV1: "a".repeat(64),
    financialV1: "b".repeat(64),
    legacyDm: "c".repeat(64)
};

function authority(overrides = {}) {
    return createInitialFinancialAuthority({ playFabId, migratedAtUtc, sourceDigests, ...overrides });
}

function profile(overrides = {}) {
    return {
        schemaVersion: 12,
        playerAccountId: playFabId,
        diamonds: 1000,
        ammo: [{ id: "elite_ball", amount: 13000 }],
        usableItems: [
            { id: "thors_wrath", amount: 5 },
            { id: "green_amulet", amount: 10 },
            { id: "diamond_offensive_powder", amount: 100 },
            { id: "diamond_armor_plate", amount: 100 },
            { id: "star_dust", amount: 12 }
        ],
        cannons: [{ id: "carronade", owned: 2, equipped: 0 }],
        harpoons: { quantities: [{ id: "harpoon_diamond_250", amount: 100 }] },
        ownedDestinationMarkerIds: ["destination_default"],
        ownedShipDesignIds: [],
        shopEntitlements: [],
        durableEconomyTransactions: [],
        ...overrides
    };
}

test("Starter III entitlements are server-only, revisioned, fenced and naturally idempotent", () => {
    const initial = authority();
    const input = {
        sku: "seabyss_starter_pack_3",
        transactionId: "2126372470",
        operationId: "payment:starter-3:entitlements:v1",
        fencingToken: 7,
        nowUtc: new Date("2026-08-23T01:00:00.000Z")
    };
    const first = applyFinancialEntitlementGrant(initial, input);
    assert.equal(first.status, "applied");
    assert.equal(first.authority.financialRevision, 2);
    assert.equal(first.authority.lastFencingToken, 7);
    assert.deepEqual(first.authority.paidDestinationMarkerIds,
        ["destination_red_point", "destination_blue_point"]);
    assert.deepEqual(first.authority.paidShipDesignIds, ["design_blaky"]);
    assert.deepEqual(first.authority.ownedStarterSkus, ["seabyss_starter_pack_3"]);
    assert.equal(first.authority.premium.tier, 3);
    assert.equal(first.authority.premium.expiresAtUtcIso8601, "2026-08-30T01:00:00.000Z");
    assert.equal(verifyFinancialEntitlementGrant(first.authority, input), true);
    const replay = applyFinancialEntitlementGrant(first.authority, input);
    assert.equal(replay.status, "already_applied");
    assert.deepEqual(replay.authority, first.authority);
    const stale = applyFinancialEntitlementGrant(first.authority, { ...input,
        operationId: "payment:other:entitlements:v1", fencingToken: 6 });
    assert.equal(stale.status, "stale_fencing");
});

test("concurrent Premium duration is deterministic and keeps the highest active tier", () => {
    const silver = applyFinancialEntitlementGrant(authority(), {
        sku: "seabyss_premium_silver",
        transactionId: "premium-silver",
        operationId: "op-silver",
        fencingToken: 1,
        nowUtc: new Date("2026-08-23T00:00:00.000Z")
    }).authority;
    const gold = applyFinancialEntitlementGrant(silver, {
        sku: "seabyss_premium_gold",
        transactionId: "premium-gold",
        operationId: "op-gold",
        fencingToken: 2,
        nowUtc: new Date("2026-08-23T00:00:01.000Z")
    }).authority;
    assert.equal(gold.premium.tier, 3);
    assert.equal(gold.premium.activatedAtUtcIso8601, "2026-08-23T00:00:00.000Z");
    assert.equal(gold.premium.expiresAtUtcIso8601, "2026-10-22T00:00:00.000Z");
});

function mockClient(initial = null) {
    let object = initial ? structuredClone(initial) : null;
    let version = initial ? 5 : 0;
    let failAfterWrite = false;
    return {
        async getUserAccountInfo(id) {
            return { UserInfo: { PlayFabId: id, TitleInfo: { TitlePlayerAccount: { Id: "TPA" } } } };
        },
        async getEntityToken() { return { EntityToken: "token" }; },
        async getObjects() {
            return { ProfileVersion: version, Objects: object
                ? { SeabyssFinancialAuthorityV2: { DataObject: structuredClone(object) } } : {} };
        },
        async setObjects(_entity, _token, expected, objects) {
            if (expected !== version) {
                const error = new Error("conflict");
                error.code = "EntityProfileVersionMismatch";
                throw error;
            }
            object = structuredClone(objects[0].DataObject);
            version += 1;
            if (failAfterWrite) {
                failAfterWrite = false;
                throw new Error("lost response");
            }
            return { ProfileVersion: version };
        },
        failAfterWrite() { failAfterWrite = true; },
        conflict() { version += 1; },
        snapshot() { return { object: structuredClone(object), version }; }
    };
}

test("FinancialAuthorityV2 store has explicit migration, CAS, stale fencing and lost-response recovery", async () => {
    const client = mockClient();
    const store = createPlayFabFinancialAuthorityStore({ client });
    assert.deepEqual(await store.read(playFabId), {
        migrated: false, objectVersion: 0, authority: null, financialRevision: 0
    });
    const initial = authority();
    const migrated = await store.initialize({ playFabId, expectedObjectVersion: 0, authority: initial });
    assert.equal(migrated.applied, true);
    const next = applyFinancialEntitlementGrant(initial, {
        sku: "seabyss_starter_pack_1",
        transactionId: "order-1",
        operationId: "op-1",
        fencingToken: 2,
        nowUtc: new Date(migratedAtUtc)
    }).authority;
    client.failAfterWrite();
    const recovered = await store.compareAndSet({ playFabId, expectedObjectVersion: 1,
        expectedFinancialRevision: 1, authority: next, operationId: "op-1", fencingToken: 2 });
    assert.equal(recovered.reason, "already_applied");
    assert.equal(client.snapshot().object.financialRevision, 2);
    const stale = await store.compareAndSet({ playFabId, expectedObjectVersion: recovered.objectVersion,
        expectedFinancialRevision: 2, authority: next, operationId: "op-stale", fencingToken: 1 });
    assert.equal(stale.reason, "stale_fencing");
});

test("two store writers with the same revisions have exactly one CAS winner", async () => {
    const client = mockClient(authority());
    const store = createPlayFabFinancialAuthorityStore({ client });
    const loadedA = await store.read(playFabId);
    const loadedB = await store.read(playFabId);
    const nextA = applyFinancialEntitlementGrant(loadedA.authority, {
        sku: "seabyss_starter_pack_1", transactionId: "a", operationId: "op-a", fencingToken: 1,
        nowUtc: new Date(migratedAtUtc)
    }).authority;
    const nextB = applyFinancialEntitlementGrant(loadedB.authority, {
        sku: "seabyss_starter_pack_2", transactionId: "b", operationId: "op-b", fencingToken: 2,
        nowUtc: new Date(migratedAtUtc)
    }).authority;
    assert.equal((await store.compareAndSet({ playFabId, expectedObjectVersion: loadedA.objectVersion,
        expectedFinancialRevision: 1, authority: nextA, operationId: "op-a", fencingToken: 1 })).applied, true);
    assert.equal((await store.compareAndSet({ playFabId, expectedObjectVersion: loadedB.objectVersion,
        expectedFinancialRevision: 1, authority: nextB, operationId: "op-b", fencingToken: 2 })).reason,
    "version_conflict");
});

test("migration uses legacy DM only for Diamonds, unions permanent unlocks and refuses quantity guesses", () => {
    const legacy = profile({ diamonds: 1000, ownedDestinationMarkerIds: ["destination_red_point"] });
    const financial = profile({ diamonds: 1200, ownedShipDesignIds: ["design_blaky"] });
    const ready = planPlayFabFinancialAuthorityMigration({ playFabId, profileV1: legacy,
        financialProfileV1: financial, legacyDmBalance: 1500, migratedAtUtc });
    assert.equal(ready.status, "ready");
    assert.equal(ready.targetQuantities.diamonds, 1500);
    assert.deepEqual(ready.initialAuthority.paidDestinationMarkerIds, ["destination_red_point"]);
    assert.deepEqual(ready.initialAuthority.paidShipDesignIds, ["design_blaky"]);
    assert.equal(ready.conflictPolicy.diamonds, "legacy_DM_wins_during_one_time_migration");

    const changed = profile({ ammo: [{ id: "elite_ball", amount: 12999 }] });
    const conflict = planPlayFabFinancialAuthorityMigration({ playFabId, profileV1: legacy,
        financialProfileV1: changed, legacyDmBalance: 1500, migratedAtUtc });
    assert.equal(conflict.status, "manual_review");
    assert.equal(conflict.conflicts[0].resource, "elite_ball");
    const existingV2 = planPlayFabFinancialAuthorityMigration({ playFabId, profileV1: legacy,
        legacyDmBalance: 1500, economyV2Quantities: { diamonds: 1499 }, migratedAtUtc });
    assert.equal(existingV2.status, "manual_review");
});
