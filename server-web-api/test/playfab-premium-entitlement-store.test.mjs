import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    createPlayFabPremiumEntitlementStore,
    getXsollaPremiumEntitlementKey,
    getXsollaPremiumGrantMetadataKey,
    serializeXsollaPremiumEntitlement,
    serializeXsollaPremiumGrantMetadata
} from "../src/playfab-premium-entitlement-store.js";

const entitlement = Object.freeze({
    playFabId: "4DF88C225D91FE06",
    transactionId: "9223372036854775807",
    activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
    expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
});

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        }
    };
}

describe("PlayFab Xsolla Premium entitlement store", () => {
    test("uses the exact xsp1 SHA-256 base64url key and ledger JSON contract", () => {
        const expectedKey = "xsp1_" + createHash("sha256")
            .update(entitlement.transactionId, "utf8")
            .digest("base64url");
        assert.equal(getXsollaPremiumEntitlementKey(entitlement.transactionId), expectedKey);
        assert.equal(serializeXsollaPremiumEntitlement(entitlement), JSON.stringify({
            schemaVersion: 1,
            transactionId: "9223372036854775807",
            activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
        }));
    });

    test("persists offline by Master PlayFabId and verifies an exact server readback", async () => {
        const calls = [];
        let expectedKey;
        let expectedValue;
        const persist = createPlayFabPremiumEntitlementStore({
            titleId: "local-title",
            secretKey: "local-secret",
            timeoutMs: 1000,
            async fetchImpl(url, options) {
                const body = JSON.parse(options.body);
                calls.push({ url, options, body });
                if (url.endsWith("/Server/UpdateUserInternalData")) {
                    expectedKey = Object.keys(body.Data)[0];
                    expectedValue = body.Data[expectedKey];
                    return response(200, { code: 200, data: { DataVersion: 7 } });
                }
                return response(200, {
                    code: 200,
                    data: { Data: { [expectedKey]: { Value: expectedValue } } }
                });
            }
        });

        const result = await persist(entitlement);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls.map((call) => call.url), [
            "https://local-title.playfabapi.com/Server/UpdateUserInternalData",
            "https://local-title.playfabapi.com/Server/GetUserInternalData"
        ]);
        assert.deepEqual(calls[0].body, {
            PlayFabId: entitlement.playFabId,
            Data: { [result.key]: result.value }
        });
        assert.deepEqual(calls[1].body, {
            PlayFabId: entitlement.playFabId,
            Keys: [result.key]
        });
        assert.ok(calls.every((call) => call.options.method === "POST"));
        assert.ok(calls.every((call) => call.options.redirect === "error"));
        assert.ok(calls.every((call) => call.options.headers["X-SecretKey"] === "local-secret"));
        assert.equal(result.value, serializeXsollaPremiumEntitlement(entitlement));
    });

    test("persists a separate deterministic sandbox marker without changing the Unity xsp1 receipt", async () => {
        const stored = new Map();
        const calls = [];
        const persist = createPlayFabPremiumEntitlementStore({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl(url, options) {
                const body = JSON.parse(options.body);
                calls.push({ url, body });
                if (url.endsWith("/Server/UpdateUserInternalData")) {
                    for (const [key, value] of Object.entries(body.Data)) {
                        stored.set(key, value);
                    }
                    return response(200, { code: 200, data: { DataVersion: 8 } });
                }
                const data = {};
                for (const key of body.Keys) {
                    if (stored.has(key)) {
                        data[key] = { Value: stored.get(key) };
                    }
                }
                return response(200, { code: 200, data: { Data: data } });
            }
        });
        const sandbox = { ...entitlement, grantSource: "xsolla_sandbox" };
        const result = await persist(sandbox);
        const receiptKey = getXsollaPremiumEntitlementKey(entitlement.transactionId);
        const metadataKey = getXsollaPremiumGrantMetadataKey(entitlement.transactionId);

        assert.equal(result.key, receiptKey);
        assert.equal(result.metadataKey, metadataKey);
        assert.equal(stored.get(receiptKey), serializeXsollaPremiumEntitlement(entitlement));
        assert.equal(stored.get(metadataKey), serializeXsollaPremiumGrantMetadata(sandbox));
        assert.deepEqual(JSON.parse(stored.get(receiptKey)), {
            schemaVersion: 1,
            transactionId: entitlement.transactionId,
            activatedAtUtcIso8601: entitlement.activatedAtUtcIso8601,
            expiresAtUtcIso8601: entitlement.expiresAtUtcIso8601
        });
        assert.deepEqual(JSON.parse(stored.get(metadataKey)), {
            schemaVersion: 1,
            transactionId: entitlement.transactionId,
            grantSource: "xsolla_sandbox"
        });
        assert.deepEqual(calls[1].body.Keys, [receiptKey, metadataKey]);
    });

    test("fails closed on write failure, read failure, or readback mismatch", async () => {
        const scenarios = [
            async () => response(500, { code: 500, error: "InternalServerError" }),
            async (url) => url.endsWith("UpdateUserInternalData")
                ? response(200, { code: 200, data: {} })
                : response(500, { code: 500, error: "InternalServerError" }),
            async (url) => url.endsWith("UpdateUserInternalData")
                ? response(200, { code: 200, data: {} })
                : response(200, { code: 200, data: { Data: {} } })
        ];

        for (const fetchImpl of scenarios) {
            const persist = createPlayFabPremiumEntitlementStore({
                titleId: "local-title",
                secretKey: "local-secret",
                fetchImpl
            });
            await assert.rejects(persist(entitlement));
        }
    });

    test("rejects malformed identifiers and timestamps before contacting PlayFab", async () => {
        let calls = 0;
        const persist = createPlayFabPremiumEntitlementStore({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl() {
                calls += 1;
                throw new Error("must not be called");
            }
        });

        await assert.rejects(persist({ ...entitlement, playFabId: " 4DF88C225D91FE06" }));
        await assert.rejects(persist({ ...entitlement, transactionId: " 1" }));
        await assert.rejects(persist({ ...entitlement, activatedAtUtcIso8601: "2026-08-09" }));
        await assert.rejects(persist({ ...entitlement, grantSource: "client" }));
        await assert.rejects(persist({
            ...entitlement,
            expiresAtUtcIso8601: entitlement.activatedAtUtcIso8601
        }));
        assert.equal(calls, 0);
    });
});
