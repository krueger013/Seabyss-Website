import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { aggregateLegacyFinancialBaseline, validateFinancialShadowCutoverTracker } from "../src/financial-shadow-coverage-tracker.js";

const readJson = async relativePath => JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));

test("tracker matches baseline v2 and reports exactly 14 partial, zero full/migrated/cutover paths", async () => {
    const baseline = await readJson("../config/legacy-financial-access-baseline-v2.json");
    const tracker = await readJson("../config/financial-shadow-cutover-tracker.json");
    const result = validateFinancialShadowCutoverTracker({ baseline, tracker });
    assert.deepEqual(result, {
        pathCount: 22,
        occurrenceCount: 121,
        auditedPathCount: 22,
        partialShadowPathCount: 14,
        fullShadowPathCount: 0,
        shadowCoveredPathCount: 0,
        migratedPathCount: 0,
        cutoverReadyPathCount: 0,
        cutoverReady: false,
        baselineDigest: "2285076de72cb00a1233655bb8ccbf3c17fa2a5457d366a058fdf8b520c5476d"
    });
    assert.equal(tracker.paths.filter(entry => entry.coverageStatus === "partial").length, 14);
    assert.equal(tracker.paths.every(entry => !entry.shadowCovered && !entry.migrated && !entry.cutoverReady), true);
    assert.equal(tracker.paths.filter(entry => entry.coverageStatus === "partial")
        .every(entry => entry.coveredDomains.length > 0 && entry.exclusions.length > 0 && entry.evidence.shadowCoverage.length > 0), true);
});

test("partial tracker path set is the exact audited Unity candidate set", async () => {
    const tracker = await readJson("../config/financial-shadow-cutover-tracker.json");
    assert.deepEqual(tracker.paths.filter(entry => entry.coverageStatus === "partial").map(entry => entry.path), [
        "Boarding/PlayerPirateCrew.cs",
        "Captains/PlayerCaptainInventory.cs",
        "Cauldron/CauldronManager.cs",
        "Entities/Combat/PlayerCannonInventory.cs",
        "Entities/npcs/CombatTarget.cs",
        "Entities/PlayerRewardState.cs",
        "Guilds/GuildService.cs",
        "Loot/FloatingLootChestManager.cs",
        "Persistence/BossRewardProfileDeliveryProcessor.cs",
        "Persistence/PlayerProfileCoordinator.cs",
        "PirateExams/PirateExamRewardService.cs",
        "Quests/QuestRewardService.cs",
        "SeaMonsters/SeaMonsterRewardService.cs",
        "Shop/XsollaStarterPackGrantService.cs"
    ]);
    assert.deepEqual(tracker.paths.find(entry => entry.path === "Persistence/PlayerProfileCoordinator.cs").coveredDomains,
        ["Diamonds", "Elite", "Premium"]);
});

test("baseline aggregation is deterministic and preserves category evidence", async () => {
    const baseline = await readJson("../config/legacy-financial-access-baseline-v2.json");
    const grouped = aggregateLegacyFinancialBaseline(baseline);
    assert.equal(grouped.length, 22);
    assert.equal(grouped.reduce((sum, entry) => sum + entry.occurrenceCount, 0), 121);
    assert.deepEqual(grouped.find(entry => entry.path === "Persistence/PlayerProfileCoordinator.cs"), {
        path: "Persistence/PlayerProfileCoordinator.cs",
        occurrenceCount: 24,
        domains: ["direct_inventory_mutation", "legacy_profile_write"],
        fingerprintCount: 22
    });
});

test("tracker rejects unsupported full coverage and migration claims", async () => {
    const baseline = await readJson("../config/legacy-financial-access-baseline-v2.json");
    const original = await readJson("../config/financial-shadow-cutover-tracker.json");
    const tracker = structuredClone(original);
    tracker.paths[0].coverageStatus = "full";
    tracker.paths[0].shadowCovered = true;
    tracker.summary.partialShadowPathCount -= 1;
    tracker.summary.fullShadowPathCount += 1;
    tracker.summary.shadowCoveredPathCount += 1;
    assert.throws(() => validateFinancialShadowCutoverTracker({ baseline, tracker }),
        error => error.code === "FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS");
});

test("tracker rejects any missing baseline path or occurrence drift", async () => {
    const baseline = await readJson("../config/legacy-financial-access-baseline-v2.json");
    const original = await readJson("../config/financial-shadow-cutover-tracker.json");
    const missing = structuredClone(original);
    missing.paths.pop();
    assert.throws(() => validateFinancialShadowCutoverTracker({ baseline, tracker: missing }),
        error => error.code === "FINANCIAL_SHADOW_TRACKER_PATH_SET_MISMATCH");
    const drifted = structuredClone(original);
    drifted.paths[0].occurrenceCount += 1;
    drifted.summary.occurrenceCount += 1;
    assert.throws(() => validateFinancialShadowCutoverTracker({ baseline, tracker: drifted }),
        error => error.code === "FINANCIAL_SHADOW_TRACKER_PATH_SET_MISMATCH");
});
