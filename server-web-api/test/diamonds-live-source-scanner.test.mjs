import assert from "node:assert/strict";
import test from "node:test";

import {
    assertDiamondsLiveUnitySourceClean,
    scanDiamondsLiveUnitySource,
    scanDiamondsSourceTextForTests
} from "../src/diamonds-live-source-scanner.js";

test("unannotated direct AddUserVirtualCurrency DM call fails closed", () => {
    const result = scanDiamondsSourceTextForTests({
        source: `
public sealed class GameplayCheat
{
    public void Grant()
    {
        AddUserVirtualCurrency("DM", 500);
    }
}`
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].signal, "playfab_add_virtual_currency");
    assert.equal(result.findings[0].classification, "forbidden_direct_access");
    assert.equal(result.findings[0].classificationSource, "fail_closed_default");
});

test("PlayerRewardState has no blanket exemption for a future direct DM mutation", () => {
    const result = scanDiamondsSourceTextForTests({
        relativeFile: "Assets/_Seabyss/Scripts/Entities/PlayerRewardState.cs",
        source: `
public sealed class PlayerRewardState
{
    public void Grant()
    {
        AddUserVirtualCurrency("DM", 500);
    }
}`
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, "forbidden_direct_access");
    assert.equal(result.findings[0].classificationSource, "fail_closed_default");
});

test("reviewed Legacy adapter source annotation classifies a provider mutation", () => {
    const result = scanDiamondsSourceTextForTests({
        source: `
public sealed class DiamondLegacyAdapter
{
    public void Grant()
    {
        // FINANCIAL_ACCESS: intentional_legacy_adapter domain=Diamonds route=legacy_dm_adapter
        Post("/Server/AddUserVirtualCurrency");
    }
}`
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].classification, "intentional_legacy_adapter");
    assert.equal(result.findings[0].route, "legacy_dm_adapter");
    assert.equal(result.findings[0].classificationSource, "source_annotation");
});

test("reviewed migration-only profile mirror is classified and direct new mirror is forbidden", () => {
    const reviewed = scanDiamondsSourceTextForTests({
        source: `
public sealed class Projection
{
    public void Copy(Profile profile)
    {
        // FINANCIAL_ACCESS: migration_only domain=Diamonds route=profile_v1_mirror
        profile.diamonds = 500;
    }
}`
    });
    assert.equal(reviewed.findings[0].classification, "migration_only");

    const bypass = scanDiamondsSourceTextForTests({
        source: "public void Save(Profile profile) { profile.diamonds = 999; }"
    });
    assert.equal(bypass.findings[0].classification, "forbidden_direct_access");
});

test("narrow PlayFabVirtualCurrencyStore file policy remains the only implicit Legacy adapter", () => {
    const result = scanDiamondsSourceTextForTests({
        relativeFile: "Assets/_Seabyss/Scripts/Persistence/PlayFab/PlayFabVirtualCurrencyStore.cs",
        source: `public void Add() { Post("/Server/AddUserVirtualCurrency"); }`
    });
    assert.equal(result.findings[0].classification, "intentional_legacy_adapter");
    assert.equal(result.findings[0].classificationSource, "narrow_file_policy");
});

test("live Unity source scan is deterministic and contains zero forbidden Diamonds routes", async () => {
    const first = await scanDiamondsLiveUnitySource();
    const second = await assertDiamondsLiveUnitySourceClean();
    assert.equal(first.scannerDigest, second.scannerDigest);
    assert.equal(second.forbiddenRouteCount, 0);
    assert.equal(second.readyForCanary, true);
    assert.ok(second.filesScanned > 0);
});
