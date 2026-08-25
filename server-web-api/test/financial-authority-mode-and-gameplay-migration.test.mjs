import test from "node:test";
import assert from "node:assert/strict";
import { createInitialFinancialAuthority } from "../src/financial-authority-v2.js";
import { createFinancialAuthorityModeReader } from "../src/financial-authority-mode-reader.js";
import {
    createFinancialCanonicalGameplayRegistry,
    GOLD_AUTHORITY_POLICY,
    REQUIRED_GAMEPLAY_QUANTITATIVE_IDS
} from "../src/financial-canonical-gameplay-registry.js";
import {
    createPlayFabCanonicalFinancialMigrationDryRun
} from "../src/playfab-canonical-financial-migration-dry-run.js";

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
        gold: 999,
        diamonds: 999,
        sirenTears: 3,
        elitePoints: 4,
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
            { id: "diamond_offensive_powder", amount: 12 },
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
        ownedDestinationMarkerIds: ["destination_red_point"],
        ownedShipDesignIds: ["design_blaky"],
        shopEntitlements: [],
        durableEconomyTransactions: []
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

function sourceSnapshot(registry) {
    const profileV1 = profile();
    const legacyCurrencyBalances = { GD: 101, DM: 202 };
    const legacyProjection = registry.projectLegacy({
        playFabId,
        profile: profileV1,
        legacyCurrencyBalances
    });
    const economyV2Quantities = Object.fromEntries(
        REQUIRED_GAMEPLAY_QUANTITATIVE_IDS.map((resourceId) => [resourceId, 0])
    );
    return {
        playFabId,
        profileV1,
        financialProfileV1: null,
        legacyCurrencyBalances,
        confirmedStarterSkus: [],
        legacyProjection,
        economyV2Quantities,
        economyV2Etag: "etag-1",
        authorityV2: { migrated: false, authority: null },
        financialV2Projection: null
    };
}

test("Legacy reads only legacy sources and Cutover rejects an unmigrated account without fallback", async () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const snapshot = sourceSnapshot(registry);
    let legacyReads = 0;
    let v2Reads = 0;
    const legacy = createFinancialAuthorityModeReader({
        mode: "Legacy",
        sourceReader: {
            async readLegacy() {
                legacyReads += 1;
                return { projection: snapshot.legacyProjection };
            }
        }
    });
    const legacyResult = await legacy.read(playFabId);
    assert.equal(legacyResult.status, "legacy");
    assert.equal(legacyResult.projection.quantities.gold, 101);
    assert.equal(legacyReads, 1);

    const cutover = createFinancialAuthorityModeReader({
        mode: "Cutover",
        sourceReader: {
            async readFinancialV2() {
                v2Reads += 1;
                return { authorityV2: { migrated: false }, projection: null };
            }
        }
    });
    await assert.rejects(
        cutover.read(playFabId),
        (error) => error.code === "FINANCIAL_AUTHORITY_NOT_MIGRATED"
    );
    assert.equal(v2Reads, 1);
    assert.deepEqual(cutover.health(), {
        mode: "Cutover",
        reads: 1,
        failures: 1,
        lastReadStatus: "failed"
    });
});

test("ShadowRead reports match or mismatch while legacy remains authoritative", async () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const snapshot = sourceSnapshot(registry);
    const currentAuthority = authority(snapshot.legacyProjection);
    snapshot.economyV2Quantities = structuredClone(snapshot.legacyProjection.quantities);
    snapshot.authorityV2 = { migrated: true, authority: currentAuthority };
    snapshot.financialV2Projection = registry.projectV2({
        playFabId,
        economyV2Quantities: snapshot.economyV2Quantities,
        authority: currentAuthority
    });
    const matching = createFinancialAuthorityModeReader({
        mode: "ShadowRead",
        sourceReader: { async readMigrationSources() { return snapshot; } }
    });
    const match = await matching.read(playFabId);
    assert.equal(match.status, "shadow_match");
    assert.equal(match.authoritativeSource, "profile_v1_and_legacy_virtual_currency");
    assert.equal(match.cutoverEligible, true);
    assert.equal(match.shadow.match, true);

    const mismatched = structuredClone(snapshot);
    mismatched.economyV2Quantities.gold += 1;
    mismatched.financialV2Projection = registry.projectV2({
        playFabId,
        economyV2Quantities: mismatched.economyV2Quantities,
        authority: currentAuthority
    });
    const shadow = createFinancialAuthorityModeReader({
        mode: "ShadowRead",
        sourceReader: { async readMigrationSources() { return mismatched; } }
    });
    const mismatch = await shadow.read(playFabId);
    assert.equal(mismatch.status, "shadow_mismatch");
    assert.equal(mismatch.cutoverEligible, false);
    assert.equal(mismatch.projection.quantities.gold, 101);
    assert.ok(mismatch.shadow.differences.some((difference) => difference.resource === "gold"));
});

test("ShadowRead provider failure is fail-closed and never silently falls back", async () => {
    const reader = createFinancialAuthorityModeReader({
        mode: "ShadowRead",
        sourceReader: {
            async readMigrationSources() {
                const error = new Error("provider unavailable");
                error.retryable = true;
                throw error;
            }
        }
    });
    await assert.rejects(reader.read(playFabId), (error) =>
        error.code === "FINANCIAL_SHADOW_READ_FAILED" && error.retryable === true
    );
    assert.equal(reader.health().failures, 1);
});

test("migration dry-run derives an exhaustive read-only plan from true legacy and v2 sources", async () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const snapshot = sourceSnapshot(registry);
    const dryRun = createPlayFabCanonicalFinancialMigrationDryRun({
        registry,
        sourceReader: { async readMigrationSources() { return snapshot; } },
        nowMilliseconds: () => Date.parse("2026-08-23T12:00:00.000Z")
    });
    const result = await dryRun.run(playFabId);
    assert.equal(result.status, "ready");
    assert.equal(result.readOnly, true);
    assert.equal(result.providerWriteCount, 0);
    assert.equal(result.goldPolicy, GOLD_AUTHORITY_POLICY);
    assert.equal(result.targetQuantities.gold, 101);
    assert.equal(result.targetQuantities.diamonds, 202);
    assert.equal(result.targetQuantities.illuminated_ball, 3);
    assert.equal(result.plannedEconomyRewards.length,
        Object.values(result.targetQuantities).filter((quantity) => quantity > 0).length);
    assert.ok(result.plannedEconomyRewards.some((reward) =>
        reward.rewardId === "gold" && reward.quantity === 101
    ));
    assert.equal(result.plannedAuthorityInitialization.legacyPlayFabId, playFabId);
    assert.equal(result.plannedAuthorityInitialization.paidShipDesignIds.includes("design_blaky"), true);
    assert.match(result.planHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(dryRun.health(), {
        readOnly: true,
        providerWritesEnabled: false,
        runs: 1,
        manualReviews: 0,
        failures: 0,
        registryDigest: registry.digest
    });
});

test("migration dry-run quarantines partial v2 state and recognizes an exact migrated state", async () => {
    const registry = createFinancialCanonicalGameplayRegistry({ catalogMappings: mappings() });
    const partial = sourceSnapshot(registry);
    partial.economyV2Quantities.gold = 50;
    const conflicting = createPlayFabCanonicalFinancialMigrationDryRun({
        registry,
        sourceReader: { async readMigrationSources() { return partial; } },
        nowMilliseconds: () => Date.parse("2026-08-23T12:00:00.000Z")
    });
    const manualReview = await conflicting.run(playFabId);
    assert.equal(manualReview.status, "manual_review");
    assert.equal(manualReview.providerWriteCount, 0);
    assert.ok(manualReview.conflicts.some((conflict) =>
        conflict.resource === "gold" && conflict.reason === "economy_v2_target_conflict"
    ));

    const migrated = sourceSnapshot(registry);
    migrated.economyV2Quantities = structuredClone(migrated.legacyProjection.quantities);
    const currentAuthority = authority(migrated.legacyProjection);
    migrated.authorityV2 = { migrated: true, authority: currentAuthority };
    migrated.financialV2Projection = registry.projectV2({
        playFabId,
        economyV2Quantities: migrated.economyV2Quantities,
        authority: currentAuthority
    });
    const exact = createPlayFabCanonicalFinancialMigrationDryRun({
        registry,
        sourceReader: { async readMigrationSources() { return migrated; } },
        nowMilliseconds: () => Date.parse("2026-08-23T12:00:00.000Z")
    });
    const alreadyMigrated = await exact.run(playFabId);
    assert.equal(alreadyMigrated.status, "already_migrated");
    assert.equal(alreadyMigrated.providerWriteCount, 0);
    assert.deepEqual(alreadyMigrated.plannedEconomyRewards, []);
    assert.equal(alreadyMigrated.plannedAuthorityInitialization, null);
});
