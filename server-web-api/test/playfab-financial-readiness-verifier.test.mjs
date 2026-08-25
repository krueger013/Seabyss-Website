import test from "node:test";
import assert from "node:assert/strict";
import {
    createPlayFabFinancialReadinessClient,
    createPlayFabFinancialReadinessVerifier,
    evaluatePlayFabClientWriteDenyPolicy
} from "../src/playfab-financial-readiness-verifier.js";
import { requiredEconomyV2RewardIds } from "../src/financial-authority-readiness.js";

const titleId = "142853";
const objectName = "SeabyssFinancialAuthorityV2";
const protectedResource = `pfrn:data--*!*/Profile/${objectName}`;
const now = Date.parse("2026-08-23T00:00:00.000Z");

function mappings() {
    return Object.fromEntries(requiredEconomyV2RewardIds().map((rewardId) => [rewardId, {
        kind: rewardId === "diamonds" ? "currency" : "inventory",
        itemId: `economy-${rewardId}`,
        stackId: "default"
    }]));
}

function publishedItems(catalogMappings = mappings()) {
    return Object.entries(catalogMappings).map(([rewardId, mapping]) => ({
        Id: mapping.itemId,
        Type: rewardId === "diamonds" ? "currency" : "catalogItem",
        DefaultStackId: mapping.stackId
    }));
}

function denyingPolicy(resource = protectedResource) {
    return {
        Permissions: [{
            Effect: "Deny",
            Action: "Write",
            Resource: resource,
            Principal: "*",
            Condition: { CallingEntityType: "title_player_account" },
            Comment: "Financial authority is server-owned"
        }]
    };
}

function fakeClient({ items = publishedItems(), policy = denyingPolicy(), failure = null } = {}) {
    const calls = [];
    return {
        calls,
        async getEntityToken() {
            calls.push({ method: "getEntityToken" });
            if (failure) throw failure;
            return { EntityToken: "title-entity-token", Entity: { Id: titleId, Type: "title" } };
        },
        async getPublishedCatalogItems(token, ids) {
            calls.push({ method: "getPublishedCatalogItems", token, ids: [...ids] });
            return { Items: structuredClone(items) };
        },
        async getGlobalPolicy(token) {
            calls.push({ method: "getGlobalPolicy", token });
            return structuredClone(policy);
        }
    };
}

function verifier(client, overrides = {}) {
    return createPlayFabFinancialReadinessVerifier({
        client,
        titleId,
        catalogMappings: mappings(),
        protectedResource,
        nowMilliseconds: () => now,
        ...overrides
    });
}

test("read-only evidence proves every published type/stack and the explicit title-player write deny", async () => {
    const client = fakeClient();
    const readiness = verifier(client);
    const result = await readiness.verify();
    assert.equal(result.ready, true);
    assert.equal(result.catalog.proven, true);
    assert.equal(result.catalog.publishedItemCount, requiredEconomyV2RewardIds().length);
    assert.equal(result.policy.proven, true);
    assert.equal(result.objectName, objectName);
    assert.deepEqual(result.errors, []);
    assert.equal(readiness.health().healthy, true);
    assert.deepEqual(client.calls.map((call) => call.method), [
        "getEntityToken",
        "getPublishedCatalogItems",
        "getGlobalPolicy"
    ]);
});

test("missing, wrong-type and wrong-stack published catalog evidence each fail closed", async () => {
    const cases = [
        {
            name: "missing",
            items: publishedItems().filter((item) => item.Id !== "economy-diamonds"),
            error: "published_catalog_item_missing:diamonds"
        },
        {
            name: "wrong type",
            items: publishedItems().map((item) => item.Id === "economy-diamonds"
                ? { ...item, Type: "catalogItem" } : item),
            error: "published_catalog_type_mismatch:diamonds"
        },
        {
            name: "wrong stack",
            items: publishedItems().map((item) => item.Id === "economy-star_dust"
                ? { ...item, DefaultStackId: "other" } : item),
            error: "published_catalog_stack_mismatch:star_dust"
        }
    ];
    for (const current of cases) {
        const result = await verifier(fakeClient({ items: current.items })).verify();
        assert.equal(result.ready, false, current.name);
        assert.ok(result.errors.includes(current.error), current.name);
    }
});

test("policy proof rejects missing deny, conditional gaps and a resource unrelated to the authority object", async () => {
    const missing = await verifier(fakeClient({ policy: { Permissions: [] } })).verify();
    assert.equal(missing.ready, false);
    assert.ok(missing.errors.includes(
        "client_write_policy_unproven:explicit_title_player_write_deny_missing"
    ));

    const conditionalGapPolicy = denyingPolicy();
    conditionalGapPolicy.Permissions[0].Condition = {
        CallingEntityType: "title_player_account",
        Region: "CA"
    };
    const conditional = await verifier(fakeClient({ policy: conditionalGapPolicy })).verify();
    assert.equal(conditional.ready, false);

    const unrelated = evaluatePlayFabClientWriteDenyPolicy({
        policy: denyingPolicy("pfrn:data--*!*/Profile/OtherObject"),
        protectedResource: "pfrn:data--*!*/Profile/OtherObject",
        objectName
    });
    assert.deepEqual(unrelated, {
        proven: false,
        reason: "policy_resource_does_not_cover_authority_object"
    });
});

test("invalid local expectations fail before any provider interface is called", async () => {
    const client = fakeClient();
    const result = await verifier(client, {
        protectedResource: "pfrn:data--*!*/Profile/OtherObject"
    }).verify();
    assert.equal(result.ready, false);
    assert.ok(result.errors.includes("policy resource must cover FinancialAuthorityV2"));
    assert.deepEqual(client.calls, []);
});

test("provider failures become sanitized fail-closed evidence", async () => {
    const failure = new Error("provider body must not escape");
    failure.code = "SIMULATED_PROVIDER_DOWN";
    const result = await verifier(fakeClient({ failure })).verify();
    assert.equal(result.ready, false);
    assert.deepEqual(result.errors, ["SIMULATED_PROVIDER_DOWN"]);
    assert.equal(result.policy.reason, "provider_probe_failed");
    assert.doesNotMatch(JSON.stringify(result), /provider body must not escape/);
});

function response(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() { return payload; }
    };
}

test("HTTP implementation calls only official read-only PlayFab endpoints and never serializes the secret", async () => {
    const secret = "temporary-test-secret-never-serialize";
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options: { ...options, headers: { ...options.headers } } });
        if (url.endsWith("/Authentication/GetEntityToken")) {
            return response({ code: 200, data: {
                EntityToken: "title-token",
                Entity: { Id: titleId, Type: "title" }
            } });
        }
        if (url.endsWith("/Catalog/GetItems")) {
            const request = JSON.parse(options.body);
            const byId = new Map(publishedItems().map((item) => [item.Id, item]));
            return response({ code: 200, data: {
                Items: request.Ids.map((id) => byId.get(id))
            } });
        }
        if (url.endsWith("/Profile/GetGlobalPolicy")) {
            return response({ code: 200, data: denyingPolicy() });
        }
        throw new Error("Unexpected endpoint");
    };
    const client = createPlayFabFinancialReadinessClient({
        titleId,
        secretKey: secret,
        fetchImpl
    });
    const result = await verifier(client).verify();
    assert.equal(result.ready, true);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
        "/Authentication/GetEntityToken",
        "/Catalog/GetItems",
        "/Profile/GetGlobalPolicy"
    ]);
    assert.ok(calls.every((call) => call.options.method === "POST"));
    assert.ok(calls.every((call) => !/Set|Update|Execute|Add|Subtract/u.test(new URL(call.url).pathname)));
    assert.equal(calls[0].options.headers["X-SecretKey"], secret);
    assert.ok(calls.slice(1).every((call) => call.options.headers["X-SecretKey"] === undefined));
    assert.ok(calls.every((call) => !(call.url + call.options.body).includes(secret)));
});
