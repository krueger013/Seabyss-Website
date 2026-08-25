import assert from "node:assert/strict";
import test from "node:test";

import {
    CERTIFIED_FINANCIAL_TARGET_CONTRACT,
    DEPRECATED_FINANCIAL_TARGET_CONTRACT,
    PROGRESSIVE_ACCESS_CLASSIFICATIONS,
    loadProgressiveFinancialDomainBaseline,
    validateProgressiveFinancialDomainBaseline
} from "../src/progressive-financial-domain-access-validator.js";

test("checked-in progressive baseline validates the certified and deprecated target contracts", async () => {
    const result = await loadProgressiveFinancialDomainBaseline();
    assert.equal(result.activeAuthority, "Legacy");
    assert.equal(result.certifiedTargetContract, CERTIFIED_FINANCIAL_TARGET_CONTRACT);
    assert.equal(result.certifiedTargetContract, "SeabyssEconomyStateV1");
    assert.equal(result.deprecatedMigrationOnlyTarget, DEPRECATED_FINANCIAL_TARGET_CONTRACT);
    assert.equal(result.deprecatedMigrationOnlyTarget, "SeabyssFinancialAuthorityV2");
});

test("scanner exposes structured before/after counters for every domain", async () => {
    const result = await loadProgressiveFinancialDomainBaseline();
    assert.equal(result.domains.Diamonds.before.facadeMutationExpressions, 32);
    assert.equal(result.domains.Diamonds.afterPreparation.facadeMutationExpressions, 32);
    assert.equal(result.domains.Elite.before.externalMutationRoutes, 9);
    assert.equal(result.domains.Elite.afterPreparation.externalMutationRoutes, 9);
    assert.equal(result.domains.Premium.before.gameplayAndDisplayReaderPaths, 8);
    assert.equal(result.domains.Premium.afterPreparation.gameplayAndDisplayReaderPaths, 8);
});

test("scanner classifies every manifest route with the three allowed classifications", async () => {
    const result = await loadProgressiveFinancialDomainBaseline();
    assert.ok(result.totalClassifiedAccesses > 0);
    assert.deepEqual([...new Set(result.entries.map((entry) => entry.classification))].sort(),
        [...PROGRESSIVE_ACCESS_CLASSIFICATIONS].sort());
    for (const domain of ["Diamonds", "Elite", "Premium"]) {
        const counts = result.domains[domain].counts;
        assert.ok(counts.intentional_legacy_adapter > 0);
        assert.ok(counts.migration_only > 0);
        if (domain === "Diamonds") assert.equal(counts.forbidden_direct_access, 0);
        else assert.ok(counts.forbidden_direct_access > 0);
        assert.equal(counts.total,
            counts.intentional_legacy_adapter + counts.migration_only + counts.forbidden_direct_access);
    }
});

test("Diamonds is scanner-clean while Elite and Premium remain fail-closed", async () => {
    const result = await loadProgressiveFinancialDomainBaseline();
    assert.equal(result.readyForCanary, false);
    const diamonds = result.domains.Diamonds;
    assert.equal(diamonds.forbiddenPathsRemain, false);
    assert.equal(diamonds.readyForCanary, true);
    assert.deepEqual(diamonds.blockers, []);
    for (const domain of ["Elite", "Premium"]) {
        const summary = result.domains[domain];
        assert.equal(summary.forbiddenPathsRemain, true);
        assert.equal(summary.readyForCanary, false);
        assert.deepEqual(summary.blockers, ["forbidden_direct_access_remaining"]);
    }
    assert.equal(result.domains.Diamonds.counts.forbidden_direct_access, 0);
    assert.equal(result.domains.Elite.counts.forbidden_direct_access, 4);
    assert.equal(result.domains.Premium.counts.forbidden_direct_access, 4);
});

test("a baseline cannot self-certify another domain while retaining a forbidden access", async () => {
    const checkedIn = await loadProgressiveFinancialDomainBaseline();
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(
        new URL("../config/progressive-financial-domain-baseline.json", import.meta.url), "utf8"));
    raw.domains.Elite.readyForCanary = true;
    const result = validateProgressiveFinancialDomainBaseline(raw);
    assert.equal(result.domains.Elite.declaredReadyForCanary, true);
    assert.equal(result.domains.Elite.readinessConsistent, false);
    assert.equal(result.domains.Elite.readyForCanary, false);
    assert.equal(checkedIn.domains.Diamonds.declaredReadyForCanary, true);
});

test("wrong target generations are rejected", async () => {
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(
        new URL("../config/progressive-financial-domain-baseline.json", import.meta.url), "utf8"));
    const wrongCertified = structuredClone(raw);
    wrongCertified.certifiedTargetContract = "SeabyssFinancialAuthorityV2";
    assert.throws(() => validateProgressiveFinancialDomainBaseline(wrongCertified),
        /Certified target must be SeabyssEconomyStateV1/u);

    const wrongDeprecated = structuredClone(raw);
    wrongDeprecated.deprecatedMigrationOnlyTarget = "SeabyssEconomyStateV1";
    assert.throws(() => validateProgressiveFinancialDomainBaseline(wrongDeprecated),
        /Deprecated migration-only target must be SeabyssFinancialAuthorityV2/u);
});
