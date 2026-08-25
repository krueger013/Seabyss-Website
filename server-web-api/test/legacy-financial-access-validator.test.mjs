import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    auditLegacyFinancialAccess,
    createLegacyFinancialAccessBaseline,
    scanLegacyFinancialAccess,
    validateLegacyFinancialAccess
} from "../src/legacy-financial-access-validator.js";
import {
    parseLegacyFinancialAccessCliArgs,
    runLegacyFinancialAccessCli
} from "../src/validate-legacy-financial-access-cli.js";

const legacySource = `
using PlayFab.ServerModels;
public sealed class LegacyWallet
{
    private const string DiamondsCurrencyCode = "DM";

    public void Mutate(PlayerProfileData profile, Inventory inventory, string json)
    {
        PlayFabServerAPI.AddUserVirtualCurrency(new AddUserVirtualCurrencyRequest
        {
            VirtualCurrency = "DM",
            Amount = 10
        }, _ => { }, _ => { });
        profile.gold += 10;
        profile.usableItems.Add(new ItemAmount());
        inventory.AddAmmo("elite_ball", 3);
        var request = new UpdateUserInternalDataRequest
        {
            Data = new() { ["profile_v1"] = json }
        };
    }
}
`;

async function fixture(t, files) {
    const root = await mkdtemp(path.join(tmpdir(), "seabyss-legacy-financial-validator-"));
    t.after(async () => rm(root, { recursive: true, force: true }));
    for (const [relative, content] of Object.entries(files)) {
        const absolute = path.join(root, ...relative.split("/"));
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");
    }
    return root;
}

function captureStream() {
    let text = "";
    return {
        stream: { write(value) { text += String(value); } },
        read() { return text; }
    };
}

test("scanner detects direct legacy currencies, profile_v1 writes and inventory mutations", async (t) => {
    const root = await fixture(t, {
        "Assets/Game/LegacyWallet.cs": legacySource,
        "Assets/Game/MyFinancialAuthorityRuntime.cs": `
            class Lookalike { void Run(dynamic profile) { profile.diamonds = 42; } }
        `,
        "Assets/Game/CommentsOnly.cs": `
            // PlayFabServerAPI.SubtractUserVirtualCurrency("GD");
            /* profile.gold += 999; inventory.AddAmmo("elite_ball", 9); */
            class CommentsOnly { }
        `,
        "Assets/Game/FinancialResourceRegistry.cs": legacySource,
        "Assets/Game/Migrations/LegacyEconomyMigration.cs": legacySource,
        "Assets/Tests/LegacyWalletTests.cs": legacySource
    });
    const scan = await scanLegacyFinancialAccess({ root });
    assert.equal(scan.scannedFileCount, 3);
    assert.ok(scan.categoryCounts.legacy_playfab_currency >= 2);
    assert.ok(scan.categoryCounts.legacy_profile_write >= 4);
    assert.ok(scan.categoryCounts.direct_inventory_mutation >= 1);
    assert.ok(scan.findings.some((finding) =>
        finding.detector === "legacy_virtual_currency_mutation_api"
    ));
    assert.ok(scan.findings.some((finding) =>
        finding.detector === "legacy_DM_GD_currency_code"
    ));
    assert.ok(scan.findings.some((finding) =>
        finding.detector === "profile_v1_storage_write"
    ));
    assert.ok(scan.findings.some((finding) =>
        finding.path === "Assets/Game/MyFinancialAuthorityRuntime.cs"
    ), "canonical exclusions must be exact file names, not substring bypasses");
    assert.equal(scan.findings.some((finding) =>
        finding.path === "Assets/Game/CommentsOnly.cs"
    ), false);
    assert.equal(scan.findings.some((finding) =>
        finding.path.endsWith("FinancialResourceRegistry.cs") ||
        finding.path.includes("/Migrations/") || finding.path.includes("/Tests/")
    ), false);
    assert.ok(scan.ignored.some((entry) => entry.reason === "canonical_financial_file"));
    assert.ok(scan.ignored.some((entry) => entry.reason === "migration"));
    assert.ok(scan.ignored.some((entry) => entry.reason === "test"));
});

test("reader, enum and UI lookalikes do not count as financial mutations", async (t) => {
    const root = await fixture(t, {
        "Assets/Game/ReadOnlyFinancialUi.cs": `
            enum Currency { Gold = 0, Diamonds = 1 }
            class ReadOnlyFinancialUi
            {
                private const string ProfileKey = "profile_v1";
                void Render(dynamic inventory, dynamic stack, long previewGold, int quantity)
                {
                    long gold = previewGold;
                    bool owns = inventory.OwnsShipDesign("design_blaky");
                    int owned = inventory.GetOwnedCount("carronade");
                    int amount = stack.amount;
                    Debug.Log($"quantity={quantity}; owned={owned}; amount={amount}");
                    client.GetUserInternalData(ProfileKey);
                }
            }
        `
    });
    const scan = await scanLegacyFinancialAccess({ root });
    assert.equal(scan.findingCount, 0);
    assert.deepEqual(scan.categoryCounts, {
        legacy_playfab_currency: 0,
        legacy_profile_write: 0,
        direct_inventory_mutation: 0
    });
});

test("unambiguous profile, PlayerRewardState, provider and profile_v1 writes remain detected", async (t) => {
    const root = await fixture(t, {
        "Assets/Game/PlayerRewardState.cs": `
            class PlayerRewardState
            {
                long gold;
                void Credit(long delta) { gold += delta; }
            }
        `,
        "Assets/Game/DirectFinancialWrites.cs": `
            class DirectFinancialWrites
            {
                private const string ProfileKey = "profile_v1";
                void Mutate(dynamic profile, dynamic rewards, dynamic economy, string json)
                {
                    profile.gold = 5;
                    rewards.AddGoldAsync(5);
                    rewards.TrySpendDiamondsAsync(2);
                    PlayFabServerAPI.AddUserVirtualCurrency(new() { VirtualCurrency = "DM", Amount = 5 });
                    economy.AddInventoryItems(new AddInventoryItemsRequest());
                    var write = new UpdateUserInternalDataRequest
                    {
                        Data = new() { [ProfileKey] = json }
                    };
                }
            }
        `
    });
    const scan = await scanLegacyFinancialAccess({ root });
    for (const detector of [
        "player_reward_state_compound_mutation",
        "financial_profile_field_mutation",
        "gameplay_financial_mutation_call",
        "legacy_virtual_currency_mutation_api",
        "provider_inventory_mutation_api",
        "legacy_profile_storage_write_api",
        "profile_v1_storage_write"
    ]) assert.ok(scan.findings.some((finding) => finding.detector === detector), detector);
});

test("legacy PlayFab REST currency endpoints and DM/GD declarations remain detected", async (t) => {
    const root = await fixture(t, {
        "Assets/Game/LegacyPlayFabRestWallet.cs": `
            class LegacyPlayFabRestWallet
            {
                private const string GoldCurrencyCode = "GD";
                private const string DiamondCurrencyCode = "DM";
                void Mutate(bool add)
                {
                    string endpoint = add
                        ? "/Server/AddUserVirtualCurrency"
                        : "/Server/SubtractUserVirtualCurrency";
                }
            }
        `
    });
    const scan = await scanLegacyFinancialAccess({ root });
    assert.equal(scan.categoryCounts.legacy_playfab_currency, 4);
    assert.equal(scan.findings.filter((finding) =>
        finding.detector === "legacy_virtual_currency_mutation_api"
    ).length, 2);
    assert.equal(scan.findings.filter((finding) =>
        finding.detector === "legacy_DM_GD_currency_code"
    ).length, 2);
});

test("Legacy and ShadowRead require an explicit exact baseline and reject every new occurrence", async (t) => {
    const root = await fixture(t, { "Assets/Game/LegacyWallet.cs": legacySource });
    const scan = await scanLegacyFinancialAccess({ root });
    const baseline = createLegacyFinancialAccessBaseline({ findings: scan.findings });
    assert.throws(
        () => validateLegacyFinancialAccess({ mode: "Legacy", findings: scan.findings }),
        /requires an explicit legacy financial access baseline/u
    );
    for (const mode of ["Legacy", "ShadowRead"]) {
        const unchanged = validateLegacyFinancialAccess({ mode, findings: scan.findings, baseline });
        assert.equal(unchanged.ready, true);
        assert.equal(unchanged.status, "baseline_match");
        assert.equal(unchanged.counts.newOccurrences, 0);

        const duplicated = [...scan.findings, { ...scan.findings[0], line: 999 }];
        const changed = validateLegacyFinancialAccess({ mode, findings: duplicated, baseline });
        assert.equal(changed.ready, false);
        assert.equal(changed.status, "new_legacy_access_detected");
        assert.equal(changed.counts.newOccurrences, 1);
        assert.equal(changed.newHits[0].newCount, 1);
    }
    const resolved = validateLegacyFinancialAccess({ mode: "ShadowRead", findings: [], baseline });
    assert.equal(resolved.ready, true);
    assert.equal(resolved.counts.resolvedOccurrences, scan.findingCount);
});

test("Cutover ignores a legacy baseline and requires exactly zero findings", async (t) => {
    const root = await fixture(t, { "Assets/Game/LegacyWallet.cs": legacySource });
    const scan = await scanLegacyFinancialAccess({ root });
    const baseline = createLegacyFinancialAccessBaseline({ findings: scan.findings });
    const blocked = validateLegacyFinancialAccess({ mode: "Cutover", findings: scan.findings, baseline });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.status, "cutover_legacy_access_present");
    assert.equal(blocked.counts.newOccurrences, scan.findingCount);
    const clean = validateLegacyFinancialAccess({ mode: "Cutover", findings: [], baseline });
    assert.equal(clean.ready, true);
    assert.equal(clean.status, "cutover_clean");
});

test("baseline fingerprints are transparent, counted and tamper evident", async (t) => {
    const root = await fixture(t, { "Assets/Game/LegacyWallet.cs": legacySource });
    const scan = await scanLegacyFinancialAccess({ root });
    const baseline = createLegacyFinancialAccessBaseline({ findings: scan.findings });
    assert.equal(baseline.kind, "seabyss_unity_legacy_financial_access_baseline");
    assert.equal(baseline.entries.reduce((sum, entry) => sum + entry.count, 0), scan.findingCount);
    for (const entry of baseline.entries) {
        assert.match(entry.fingerprint, /^[a-f0-9]{64}$/u);
        assert.equal(typeof entry.path, "string");
        assert.equal(typeof entry.snippet, "string");
        assert.ok(entry.count > 0);
    }
    const tampered = structuredClone(baseline);
    tampered.entries[0].snippet += " tampered";
    assert.throws(
        () => validateLegacyFinancialAccess({ mode: "Legacy", findings: scan.findings, baseline: tampered }),
        /fingerprint is invalid/u
    );
});

test("audit returns deterministic counters without mutating the scanned tree", async (t) => {
    const root = await fixture(t, { "Assets/Game/LegacyWallet.cs": legacySource });
    const scan = await scanLegacyFinancialAccess({ root });
    const baseline = createLegacyFinancialAccessBaseline({ findings: scan.findings });
    const result = await auditLegacyFinancialAccess({
        root,
        mode: "ShadowRead",
        baseline
    });
    assert.equal(result.ready, true);
    assert.equal(result.scan.scannedFileCount, 1);
    assert.equal(result.scan.findingCount, scan.findingCount);
    assert.deepEqual(result.scan.categoryCounts, scan.categoryCounts);
    assert.equal(result.validation.counts.newOccurrences, 0);
});

test("CLI emits a baseline, validates it and returns distinct policy/configuration exit codes", async (t) => {
    const root = await fixture(t, { "Assets/Game/LegacyWallet.cs": legacySource });
    assert.throws(
        () => parseLegacyFinancialAccessCliArgs(["--root", root, "--mode", "Legacy"]),
        /requires --baseline/u
    );
    const emittedOut = captureStream();
    const emittedErr = captureStream();
    assert.equal(await runLegacyFinancialAccessCli(
        ["--root", root, "--emit-baseline", "--compact"],
        { stdout: emittedOut.stream, stderr: emittedErr.stream }
    ), 0);
    assert.equal(emittedErr.read(), "");
    const baseline = JSON.parse(emittedOut.read());
    assert.ok(baseline.generationEvidence.findingCount > 0);
    const baselinePath = path.join(root, "legacy-financial-baseline.json");
    await writeFile(baselinePath, JSON.stringify(baseline), "utf8");

    const validationOut = captureStream();
    assert.equal(await runLegacyFinancialAccessCli([
        "--root", root,
        "--mode", "ShadowRead",
        "--baseline", baselinePath,
        "--compact"
    ], { stdout: validationOut.stream, stderr: captureStream().stream }), 0);
    assert.equal(JSON.parse(validationOut.read()).status, "baseline_match");

    const cutoverOut = captureStream();
    assert.equal(await runLegacyFinancialAccessCli([
        "--root", root,
        "--mode", "Cutover",
        "--compact"
    ], { stdout: cutoverOut.stream, stderr: captureStream().stream }), 1);
    assert.equal(JSON.parse(cutoverOut.read()).status, "cutover_legacy_access_present");

    const configErr = captureStream();
    assert.equal(await runLegacyFinancialAccessCli(
        ["--root", root, "--mode", "Unknown"],
        { stdout: captureStream().stream, stderr: configErr.stream }
    ), 2);
    assert.equal(JSON.parse(configErr.read()).status, "validator_configuration_error");
});
