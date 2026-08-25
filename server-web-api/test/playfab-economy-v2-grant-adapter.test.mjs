import test from "node:test";
import assert from "node:assert/strict";
import {
    createPlayFabEconomyV2Client,
    createPlayFabEconomyV2GrantAdapter,
    PlayFabEconomyV2GrantError
} from "../src/playfab-economy-v2-grant-adapter.js";

const playFabId = "46789223F9CB1BB9";
const now = Date.parse("2026-08-23T00:00:00.000Z");
const createdAt = "2026-08-22T20:00:00.000Z";
const operationId = "payment-grant-706956443-profile-granted-v1";
const mappings = {
    diamonds: { kind: "currency", itemId: "economy-v2-dm", stackId: "default" },
    star_dust: { kind: "inventory", itemId: "economy-v2-stardust" }
};

function input(overrides = {}) {
    return { playFabId, operationId, idempotencyCreatedAtUtc: createdAt,
        rewards: [{ rewardId: "diamonds", quantity: 1000 }, { rewardId: "star_dust", quantity: 12 }],
        ...overrides };
}
function client(overrides = {}) {
    const requests = [];
    const value = {
        async getUserAccountInfo(id) {
            return { UserInfo: { PlayFabId: id, TitleInfo: { TitlePlayerAccount: { Id: "TPA-PLAYER" } } } };
        },
        async getEntityToken() { return { EntityToken: "title-token" }; },
        async executeInventoryOperations(token, request) {
            requests.push({ token, request: structuredClone(request) });
            return { IdempotencyId: request.IdempotencyId, TransactionIds: ["txn-a", "txn-b"], ETag: "etag-2" };
        },
        requests,
        ...overrides
    };
    return value;
}
function adapter(fakeClient, options = {}) {
    return createPlayFabEconomyV2GrantAdapter({ client: fakeClient, catalogMappings: mappings,
        nowMilliseconds: () => now, ...options });
}

test("normal grant resolves the legacy identity and submits one strict transactional batch", async () => {
    const fake = client();
    const result = await adapter(fake).grant(input());
    assert.equal(result.status, "confirmed");
    assert.deepEqual(result.entity, { Id: "TPA-PLAYER", Type: "title_player_account" });
    assert.deepEqual(result.transactionIds, ["txn-a", "txn-b"]);
    assert.equal(result.etag, "etag-2");
    assert.equal(result.operationCount, 2);
    assert.deepEqual(fake.requests, [{ token: "title-token", request: {
        Entity: { Id: "TPA-PLAYER", Type: "title_player_account" },
        CollectionId: "default",
        IdempotencyId: operationId,
        CustomTags: { operationId, authority: "seabyss_payment_worker" },
        Operations: [
            { Add: { Item: { Id: "economy-v2-dm", StackId: "default" }, Amount: 1000 } },
            { Add: { Item: { Id: "economy-v2-stardust", StackId: "default" }, Amount: 12 } }
        ]
    } }]);
    assert.equal(result.operationId, operationId);
    assert.equal((await adapter(fake).probe()).ok, true);
    assert.equal(adapter(fake).health().idempotencyRetentionDays, 14);
});

test("same IdempotencyId replay returns the original evidence and has one provider effect", async () => {
    const effects = new Map();
    const fake = client({
        async executeInventoryOperations(_token, request) {
            if (!effects.has(request.IdempotencyId)) {
                effects.set(request.IdempotencyId, {
                    IdempotencyId: request.IdempotencyId, TransactionIds: ["txn-once"], ETag: "etag-once"
                });
            }
            return structuredClone(effects.get(request.IdempotencyId));
        }
    });
    const grant = adapter(fake);
    const first = await grant.grant(input());
    const replay = await grant.verify(input());
    assert.deepEqual(replay.transactionIds, first.transactionIds);
    assert.equal(replay.etag, first.etag);
    assert.equal(effects.size, 1);
    assert.equal(replay.status, "verified");
    assert.equal(replay.verificationMethod, "idempotent_execute_inventory_operations_replay");
});

test("ambiguous timeout is coded and retrying the identical request confirms one effect", async () => {
    let calls = 0;
    const effects = new Map();
    const fake = client({
        async executeInventoryOperations(_token, request) {
            calls += 1;
            if (!effects.has(request.IdempotencyId)) effects.set(request.IdempotencyId, {
                IdempotencyId: request.IdempotencyId, TransactionIds: ["txn-timeout"], ETag: "etag-timeout"
            });
            if (calls === 1) {
                throw new PlayFabEconomyV2GrantError("PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
                    "ambiguous", { retryable: true, ambiguous: true });
            }
            return structuredClone(effects.get(request.IdempotencyId));
        }
    });
    const grant = adapter(fake);
    const error = await grant.grant(input()).catch((value) => value);
    assert.equal(error.code, "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS");
    assert.equal(error.ambiguous, true);
    assert.equal(error.retryable, true);
    const recovered = await grant.grant(input());
    assert.deepEqual(recovered.transactionIds, ["txn-timeout"]);
    assert.equal(effects.size, 1);
});

test("429 is retryable with bounded Retry-After evidence", async () => {
    const fetchImpl = async (url) => {
        if (url.endsWith("/Server/GetUserAccountInfo")) return response({ code: 200,
            data: { UserInfo: { PlayFabId: playFabId, TitleInfo: { TitlePlayerAccount: { Id: "TPA" } } } } });
        if (url.endsWith("/Authentication/GetEntityToken")) return response({ code: 200,
            data: { EntityToken: "token" } });
        return response({ code: 429, error: "APIRequestLimitExceeded" }, 429, { "retry-after": "3" });
    };
    const grant = createPlayFabEconomyV2GrantAdapter({ titleId: "142853", secretKey: "secret",
        fetchImpl, catalogMappings: mappings, nowMilliseconds: () => now });
    const error = await grant.grant(input()).catch((value) => value);
    assert.equal(error.code, "PLAYFAB_THROTTLED");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMilliseconds, 3000);
});

test("missing catalog mapping and expired idempotency windows fail before PlayFab", async () => {
    const fake = client();
    const grant = createPlayFabEconomyV2GrantAdapter({ client: fake,
        catalogMappings: { diamonds: mappings.diamonds }, nowMilliseconds: () => now });
    const missing = await grant.grant(input()).catch((value) => value);
    assert.equal(missing.code, "CATALOG_MAPPING_MISSING");
    assert.equal(fake.requests.length, 0);
    const expired = await adapter(fake).grant(input({ idempotencyCreatedAtUtc: "2026-08-09T00:00:00.000Z" }))
        .catch((value) => value);
    assert.equal(expired.code, "IDEMPOTENCY_WINDOW_EXPIRED");
    assert.equal(fake.requests.length, 0);
});

function response(payload, status = 200, headers = {}) {
    return { ok: status >= 200 && status < 300, status,
        headers: { get(name) { return headers[name.toLowerCase()] ?? null; } },
        async json() { return payload; } };
}

test("real HTTP client never places the secret in URL/body/error or logs", async () => {
    const secret = "never-log-this-secret";
    const calls = [];
    const messages = [];
    const originalError = console.error;
    console.error = (...args) => { messages.push(args.join(" ")); };
    try {
        const fetchImpl = async (url, options) => {
            calls.push({ url, options });
            return response({ code: 500, error: "InternalServerError", errorMessage: secret }, 500);
        };
        const http = createPlayFabEconomyV2Client({ titleId: "142853", secretKey: secret, fetchImpl });
        const error = await http.getUserAccountInfo(playFabId).catch((value) => value);
        assert.equal(error.code, "PLAYFAB_CONTROL_REJECTED");
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.doesNotMatch(messages.join(" "), new RegExp(secret));
        assert.equal(calls[0].options.headers["X-SecretKey"], secret);
        assert.doesNotMatch(calls[0].url + calls[0].options.body, new RegExp(secret));
    } finally {
        console.error = originalError;
    }
});
