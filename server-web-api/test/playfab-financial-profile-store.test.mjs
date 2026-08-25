import test from "node:test";
import assert from "node:assert/strict";
import { createPlayFabFinancialProfileClient, createPlayFabFinancialProfileStore } from "../src/playfab-financial-profile-store.js";

const playFabId = "46789223F9CB1BB9";
function profile(diamonds = 0) {
    return { schemaVersion: 12, playerAccountId: playFabId, diamonds, ammo: [], usableItems: [], cannons: [],
        harpoons: { quantities: [], equippedHarpoonId: "" }, ownedDestinationMarkerIds: [], ownedShipDesignIds: [],
        shopEntitlements: [], shopReceiptLedger: { appliedTransactionIds: [] }, durableEconomyTransactions: [] };
}
function mockClient(initialObject = null, legacy = profile()) {
    let version = initialObject ? 4 : 0;
    let object = structuredClone(initialObject);
    let failAfterWrite = false;
    return {
        getUserAccountInfo: async () => ({ UserInfo: { TitleInfo: { TitlePlayerAccount: { Id: "TPA" } } } }),
        getEntityToken: async () => ({ EntityToken: "token" }),
        getUserInternalData: async () => ({ Data: { profile_v1: { Value: JSON.stringify(legacy) } } }),
        getObjects: async () => ({ ProfileVersion: version, Objects: object ? { SeabyssFinancialProfileV1: { DataObject: structuredClone(object) } } : {} }),
        setObjects: async (_entity, _token, expected, objects) => {
            if (expected !== version) { const error = new Error("conflict"); error.code = "EntityProfileVersionMismatch"; throw error; }
            object = structuredClone(objects[0].DataObject); version += 1;
            if (failAfterWrite) { failAfterWrite = false; throw new Error("ambiguous network failure"); }
            return { ProfileVersion: version };
        },
        conflict() { version += 1; },
        failAfterWrite() { failAfterWrite = true; },
        snapshot() { return { version, object: structuredClone(object) }; }
    };
}
function envelope(p = profile(), operations = [], fence = 0) {
    return { schemaVersion: 1, legacyPlayFabId: playFabId, lastFencingToken: fence,
        appliedOperations: operations, playerProfile: p };
}

test("migrates profile_v1 once and applies CAS with durable operation/fencing metadata", async () => {
    const client = mockClient();
    const store = createPlayFabFinancialProfileStore({ client });
    const read = await store.read(playFabId);
    assert.equal(read.version, 1);
    const changed = profile(1000);
    assert.deepEqual(await store.compareAndSet({ playFabId, expectedVersion: 1, profile: changed, operationId: "order-1", fencingToken: 7 }),
        { applied: true, reason: "applied", version: 2 });
    assert.equal(client.snapshot().object.playerProfile.diamonds, 1000);
    assert.equal(client.snapshot().object.lastFencingToken, 7);
});

test("replay is idempotent and stale fencing is rejected", async () => {
    const client = mockClient(envelope(profile(5), ["done"], 10));
    const store = createPlayFabFinancialProfileStore({ client });
    assert.equal((await store.compareAndSet({ playFabId, expectedVersion: 4, profile: profile(99), operationId: "done", fencingToken: 20 })).reason, "already_applied");
    assert.equal((await store.compareAndSet({ playFabId, expectedVersion: 4, profile: profile(99), operationId: "new", fencingToken: 9 })).reason, "stale_fencing");
    assert.equal((await store.compareAndSet({ playFabId, expectedVersion: 4, profile: profile(99), operationId: "equal", fencingToken: 10 })).reason, "stale_fencing");
    assert.equal(client.snapshot().object.playerProfile.diamonds, 5);
});

test("concurrent writers use ExpectedProfileVersion and only one wins", async () => {
    const client = mockClient(envelope());
    const store = createPlayFabFinancialProfileStore({ client });
    const a = await store.read(playFabId);
    const b = await store.read(playFabId);
    assert.equal((await store.compareAndSet({ playFabId, expectedVersion: a.version, profile: profile(1), operationId: "a", fencingToken: 1 })).applied, true);
    assert.equal((await store.compareAndSet({ playFabId, expectedVersion: b.version, profile: profile(2), operationId: "b", fencingToken: 2 })).reason, "version_conflict");
    assert.equal(client.snapshot().object.playerProfile.diamonds, 1);
});

test("ambiguous failure recovers by rereading the operation proof", async () => {
    const client = mockClient(envelope());
    const store = createPlayFabFinancialProfileStore({ client });
    client.failAfterWrite();
    const result = await store.compareAndSet({ playFabId, expectedVersion: 4, profile: profile(3), operationId: "recover", fencingToken: 1 });
    assert.equal(result.reason, "already_applied");
    assert.equal(client.snapshot().object.playerProfile.diamonds, 3);
});

test("invalid legacy schema and configured object size limit fail closed", async () => {
    await assert.rejects(createPlayFabFinancialProfileStore({ client: mockClient(null, { schemaVersion: 11 }) }).read(playFabId), /schema/);
    const client = mockClient(envelope());
    const store = createPlayFabFinancialProfileStore({ client, maximumObjectBytes: 200 });
    await assert.rejects(store.compareAndSet({ playFabId, expectedVersion: 4, profile: profile(), operationId: "large", fencingToken: 1 }), /size limit/);
    assert.equal(client.snapshot().version, 4);
    const invalidNumber = profile();
    invalidNumber.diamonds = Number.NaN;
    await assert.rejects(createPlayFabFinancialProfileStore({ client: mockClient(envelope(invalidNumber)) }).read(playFabId), /non-finite/);
});

test("HTTP client uses PlayFab endpoints and never places the secret in body or URL", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ code: 200, data: { UserInfo: {} } }) };
    };
    const client = createPlayFabFinancialProfileClient({ titleId: "142853", secretKey: "super-secret", fetchImpl });
    await client.getUserAccountInfo(playFabId);
    assert.match(calls[0].url, /Server\/GetUserAccountInfo$/);
    assert.equal(calls[0].options.headers["X-SecretKey"], "super-secret");
    assert.doesNotMatch(calls[0].url + calls[0].options.body, /super-secret/);
});

function playFabHttpResponse(status, payload, retryAfter = null) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return name.toLowerCase() === "retry-after" ? retryAfter : null;
            }
        },
        async json() {
            return structuredClone(payload);
        }
    };
}

test("HTTP client retries exact DataUpdateRateExceeded with identical SetObjects intent and a fresh signal", async () => {
    const calls = [];
    const delays = [];
    const client = createPlayFabFinancialProfileClient({
        titleId: "1D0C16",
        secretKey: "super-secret",
        random: () => 0,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async (url, options) => {
            calls.push({ url, body: options.body, signal: options.signal });
            if (calls.length === 1) {
                return playFabHttpResponse(429, {
                    code: 429,
                    error: "DataUpdateRateExceeded",
                    errorCode: 1287,
                    errorMessage: "super-secret must not escape"
                }, "7");
            }
            return playFabHttpResponse(200, { code: 200, data: { ProfileVersion: 42 } });
        }
    });
    const result = await client.setObjects(
        { Id: "TPA", Type: "title_player_account" },
        "entity-token",
        41,
        [{ ObjectName: "State", DataObject: { diamonds: 500 } }]
    );
    assert.deepEqual(result, { ProfileVersion: 42 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, calls[1].url);
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(JSON.parse(calls[0].body).ExpectedProfileVersion, 41);
    assert.notEqual(calls[0].signal, calls[1].signal);
    assert.deepEqual(delays, [7_000]);
});

test("HTTP client rate-limit budget is five total attempts with exponential injected jitter", async () => {
    let calls = 0;
    const delays = [];
    let observed;
    const client = createPlayFabFinancialProfileClient({
        titleId: "1D0C16",
        secretKey: "super-secret",
        random: () => 0.5,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
        fetchImpl: async () => {
            calls += 1;
            return playFabHttpResponse(429, {
                code: 429,
                error: "DataUpdateRateExceeded",
                errorCode: 1287,
                errorMessage: "super-secret must not escape"
            });
        }
    });
    try {
        await client.getObjects({ Id: "TPA", Type: "title_player_account" }, "entity-token");
    } catch (error) {
        observed = error;
    }
    assert.equal(calls, 5);
    assert.deepEqual(delays, [375, 750, 1_500, 3_000]);
    assert.equal(observed?.rateLimitRetryExhausted, true);
    assert.equal(observed?.attempts, 5);
    assert.equal(observed?.status, 429);
    assert.equal(observed?.providerErrorCode, 1287);
    assert.equal((observed?.message || "").includes("super-secret"), false);
    assert.equal(JSON.stringify(observed).includes("super-secret"), false);
});

test("HTTP client accepts Retry-After at 30 seconds but refuses excessive or invalid values", async () => {
    const acceptedDelays = [];
    let acceptedCalls = 0;
    const accepted = createPlayFabFinancialProfileClient({
        titleId: "1D0C16",
        secretKey: "secret",
        random: () => 0,
        sleep: async (milliseconds) => { acceptedDelays.push(milliseconds); },
        fetchImpl: async () => {
            acceptedCalls += 1;
            return acceptedCalls === 1
                ? playFabHttpResponse(429, {
                    code: 429, error: "DataUpdateRateExceeded", errorCode: 1287
                }, "30")
                : playFabHttpResponse(200, { code: 200, data: { Objects: {} } });
        }
    });
    await accepted.getObjects({ Id: "TPA", Type: "title_player_account" }, "token");
    assert.deepEqual(acceptedDelays, [30_000]);

    for (const retryAfter of ["31", "tomorrow", "99999999"]) {
        let calls = 0;
        let sleeps = 0;
        const refused = createPlayFabFinancialProfileClient({
            titleId: "1D0C16",
            secretKey: "secret",
            sleep: async () => { sleeps += 1; },
            fetchImpl: async () => {
                calls += 1;
                return playFabHttpResponse(429, {
                    code: 429, error: "DataUpdateRateExceeded", errorCode: 1287
                }, retryAfter);
            }
        });
        await assert.rejects(
            refused.getObjects({ Id: "TPA", Type: "title_player_account" }, "token"),
            (error) => error.rateLimitRetryRefused === true && error.attempts === undefined
        );
        assert.equal(calls, 1);
        assert.equal(sleeps, 0);
    }
});

test("HTTP client never retries timeout, network, 500, other 400, generic 429, or non-429 code 1287", async () => {
    const scenarios = [
        () => playFabHttpResponse(500, { code: 500, error: "InternalServerError" }),
        () => playFabHttpResponse(400, { code: 400, error: "InvalidParams" }),
        () => playFabHttpResponse(429, { code: 429, error: "APIRequestLimitExceeded" }),
        () => playFabHttpResponse(400, { code: 400, error: "DataUpdateRateExceeded", errorCode: 1287 }),
        () => { const error = new Error("network failure"); error.code = "ECONNRESET"; throw error; },
        () => { const error = new Error("timeout"); error.name = "AbortError"; throw error; }
    ];
    for (const scenario of scenarios) {
        let calls = 0;
        const client = createPlayFabFinancialProfileClient({
            titleId: "1D0C16",
            secretKey: "secret",
            sleep: async () => { throw new Error("non-rate-limit failure must not sleep"); },
            fetchImpl: async () => {
                calls += 1;
                return scenario();
            }
        });
        await assert.rejects(client.getUserAccountInfo(playFabId));
        assert.equal(calls, 1);
    }
});

test("HTTP client never replays an ambiguous SetObjects transport result", async () => {
    let calls = 0;
    const client = createPlayFabFinancialProfileClient({
        titleId: "1D0C16",
        secretKey: "secret",
        sleep: async () => { throw new Error("ambiguous mutation must not sleep"); },
        fetchImpl: async () => {
            calls += 1;
            const error = new Error("response lost after provider");
            error.code = "ECONNRESET";
            throw error;
        }
    });
    await assert.rejects(client.setObjects(
        { Id: "TPA", Type: "title_player_account" },
        "entity-token",
        8,
        [{ ObjectName: "State", DataObject: { diamonds: 500 } }]
    ), { code: "ECONNRESET" });
    assert.equal(calls, 1);
});

test("HTTP client rejects a retry budget that could exceed five total attempts", () => {
    assert.throws(() => createPlayFabFinancialProfileClient({
        titleId: "1D0C16",
        secretKey: "secret",
        fetchImpl: async () => playFabHttpResponse(200, { code: 200, data: {} }),
        maxRateLimitRetries: 5
    }), /maxRateLimitRetries/u);
});