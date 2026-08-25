import test from "node:test";
import assert from "node:assert/strict";
import {
    evaluateFinancialAuthorityReadiness,
    parseEconomyV2CatalogMappings,
    requiredEconomyV2RewardIds
} from "../src/financial-authority-readiness.js";

function mappings() {
    return Object.fromEntries(requiredEconomyV2RewardIds().map((rewardId) => [rewardId, {
        kind: rewardId === "diamonds" ? "currency" : "inventory",
        itemId: `economy-${rewardId}`
    }]));
}

test("cutover OFF remains fail-closed without demanding provider configuration", () => {
    assert.deepEqual(evaluateFinancialAuthorityReadiness({ cutoverEnabled: false }), {
        ready: false,
        activationRequested: false,
        errors: []
    });
});

test("cutover activation requires Unity alignment, migration, CAS, refresh and every published mapping", () => {
    const result = evaluateFinancialAuthorityReadiness({ cutoverEnabled: true, economyV2Enabled: true,
        authorityV2Enabled: true, unityAuthorityVersion: "legacy_profile_v1", migrationVersion: "none",
        revisionCasEnabled: false, serverOwnedFieldsEnabled: false, financialRefreshEnabled: false,
        catalogMappings: { diamonds: { kind: "currency", itemId: "economy-dm" } } });
    assert.equal(result.ready, false);
    assert.ok(result.errors.includes("UNITY_FINANCIAL_AUTHORITY_VERSION=financial_v2"));
    assert.ok(result.errors.includes("PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED=true"));
    assert.ok(result.errors.some((error) => error === "published Economy v2 mapping:elite_ball"));
});

test("a complete explicit financial_v2 contract passes readiness evaluation", () => {
    const result = evaluateFinancialAuthorityReadiness({ cutoverEnabled: true, economyV2Enabled: true,
        authorityV2Enabled: true, unityAuthorityVersion: "financial_v2", migrationVersion: "financial_v2",
        revisionCasEnabled: true, serverOwnedFieldsEnabled: true, financialRefreshEnabled: true,
        catalogMappings: mappings() });
    assert.equal(result.ready, true);
    assert.deepEqual(result.errors, []);
});

test("catalog mappings accept strict JSON and reject malformed configuration", () => {
    assert.deepEqual(parseEconomyV2CatalogMappings('{"diamonds":{"kind":"currency","itemId":"dm"}}'),
        { diamonds: { kind: "currency", itemId: "dm" } });
    assert.throws(() => parseEconomyV2CatalogMappings("{"), /strict JSON/);
});
