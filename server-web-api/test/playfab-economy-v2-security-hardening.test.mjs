import test from "node:test";
import assert from "node:assert/strict";
import { createPlayFabEconomyV2GrantAdapter } from "../src/playfab-economy-v2-grant-adapter.js";
import {
    evaluateFinancialAuthorityReadiness,
    requiredEconomyV2RewardIds
} from "../src/financial-authority-readiness.js";

const playFabId = "46789223F9CB1BB9";
const operationId = "payment-security-hardening-operation-v1";
const now = Date.parse("2026-08-23T00:00:00.000Z");

function completeMappings() {
    return Object.fromEntries(requiredEconomyV2RewardIds().map((rewardId) => [rewardId, {
        kind: rewardId === "diamonds" ? "currency" : "inventory",
        itemId: `economy-${rewardId}`,
        stackId: "default"
    }]));
}

function readiness(catalogMappings) {
    return evaluateFinancialAuthorityReadiness({
        cutoverEnabled: true,
        economyV2Enabled: true,
        authorityV2Enabled: true,
        unityAuthorityVersion: "financial_v2",
        migrationVersion: "financial_v2",
        revisionCasEnabled: true,
        serverOwnedFieldsEnabled: true,
        financialRefreshEnabled: true,
        catalogMappings
    });
}

function inertClient() {
    return {
        async getUserAccountInfo() {},
        async getEntityToken() {},
        async executeInventoryOperations() {}
    };
}

function adapterForMappings(catalogMappings) {
    return createPlayFabEconomyV2GrantAdapter({
        client: inertClient(),
        catalogMappings,
        nowMilliseconds: () => now
    });
}

test("catalog mappings enforce resource kind, unique target stacks and canonical IDs at both gates", () => {
    const diamondsAsInventory = completeMappings();
    diamondsAsInventory.diamonds.kind = "inventory";
    assert.throws(() => adapterForMappings(diamondsAsInventory), /diamonds must use kind=currency/);
    assert.equal(readiness(diamondsAsInventory).ready, false);
    assert.ok(readiness(diamondsAsInventory).errors.includes("published Economy v2 mapping:diamonds"));

    const inventoryAsCurrency = completeMappings();
    inventoryAsCurrency.star_dust.kind = "currency";
    assert.throws(() => adapterForMappings(inventoryAsCurrency), /star_dust must use kind=inventory/);
    assert.equal(readiness(inventoryAsCurrency).ready, false);
    assert.ok(readiness(inventoryAsCurrency).errors.includes("published Economy v2 mapping:star_dust"));

    const duplicateTarget = completeMappings();
    duplicateTarget.star_dust.itemId = duplicateTarget.elite_ball.itemId;
    duplicateTarget.star_dust.stackId = duplicateTarget.elite_ball.stackId;
    assert.throws(() => adapterForMappings(duplicateTarget), /target the same itemId\/stackId/);
    const duplicateReadiness = readiness(duplicateTarget);
    assert.equal(duplicateReadiness.ready, false);
    assert.ok(duplicateReadiness.errors.some((error) => error.startsWith("unique Economy v2 target:")));

    const nonCanonical = completeMappings();
    nonCanonical.star_dust.stackId = "bad stack";
    assert.throws(() => adapterForMappings(nonCanonical), /stackId is invalid/);
    assert.equal(readiness(nonCanonical).ready, false);

    const correct = completeMappings();
    assert.doesNotThrow(() => adapterForMappings(correct));
    assert.equal(readiness(correct).ready, true);
    assert.deepEqual(readiness(correct).errors, []);
});

function response(payload, status = 200, { invalidJson = false, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
        async json() {
            if (invalidJson) throw new SyntaxError("invalid JSON");
            return payload;
        }
    };
}

function mutationHarness(firstMutationResponse) {
    const mutationBodies = [];
    const fetchImpl = async (url, options) => {
        if (url.endsWith("/Server/GetUserAccountInfo")) {
            return response({ code: 200, data: { UserInfo: { PlayFabId: playFabId,
                TitleInfo: { TitlePlayerAccount: { Id: "TPA-PLAYER" } } } } });
        }
        if (url.endsWith("/Authentication/GetEntityToken")) {
            return response({ code: 200, data: { EntityToken: "entity-token" } });
        }
        const request = JSON.parse(options.body);
        mutationBodies.push(request);
        if (mutationBodies.length === 1) return firstMutationResponse(request);
        return response({ code: 200, data: {
            IdempotencyId: request.IdempotencyId,
            TransactionIds: ["playfab-transaction-once"],
            ETag: "etag-once"
        } });
    };
    const grant = createPlayFabEconomyV2GrantAdapter({
        titleId: "142853",
        secretKey: "test-secret-never-logged",
        fetchImpl,
        catalogMappings: { diamonds: { kind: "currency", itemId: "economy-diamonds" } },
        nowMilliseconds: () => now
    });
    return { grant, mutationBodies };
}

function grantInput() {
    return {
        playFabId,
        operationId,
        idempotencyCreatedAtUtc: "2026-08-22T20:00:00.000Z",
        rewards: [{ rewardId: "diamonds", quantity: 500 }]
    };
}

async function assertAmbiguousThenIdenticalRetry(firstMutationResponse) {
    const { grant, mutationBodies } = mutationHarness(firstMutationResponse);
    const error = await grant.grant(grantInput()).catch((value) => value);
    assert.equal(error.code, "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS");
    assert.equal(error.retryable, true);
    assert.equal(error.ambiguous, true);
    const recovered = await grant.grant(grantInput());
    assert.equal(recovered.status, "confirmed");
    assert.equal(mutationBodies.length, 2);
    assert.deepEqual(mutationBodies[1], mutationBodies[0]);
}

test("HTTP 500 after mutation send is ambiguous and recovers only through identical replay", async () => {
    await assertAmbiguousThenIdenticalRetry(() => response({
        code: 500,
        error: "InternalServerError"
    }, 500));
});

test("unreadable HTTP 200 mutation JSON is ambiguous and recovers through identical replay", async () => {
    await assertAmbiguousThenIdenticalRetry(() => response(null, 200, { invalidJson: true }));
});

test("HTTP 200 with invalid transaction evidence is ambiguous and recovers through identical replay", async () => {
    await assertAmbiguousThenIdenticalRetry((request) => response({
        code: 200,
        data: { IdempotencyId: request.IdempotencyId, TransactionIds: [], ETag: "" }
    }));
});
