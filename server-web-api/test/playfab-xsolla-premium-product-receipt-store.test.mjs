import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    createPlayFabXsollaPremiumProductReceiptStore,
    getXsollaPremiumProductReceiptKey,
    serializeXsollaPremiumProductReceipt
} from "../src/playfab-xsolla-premium-product-receipt-store.js";

const receipt = Object.freeze({
    playFabId: "4DF88C225D91FE06",
    transactionId: "9223372036854775807",
    productId: "premium",
    xsollaSku: "seabyss_premium_gold",
    productType: "premium",
    premiumTier: "gold",
    activatedAtUtc: "2026-08-18T15:20:30.000Z",
    expiresAtUtc: "2026-09-17T15:20:30.000Z",
    source: "xsolla_sandbox"
});

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        async json() { return payload; }
    };
}

describe("PlayFab Xsolla standalone Premium receipt store", () => {
    test("uses deterministic xsp2 SHA-256 and the exact v2 schema", () => {
        const expectedKey = "xsp2_" + createHash("sha256")
            .update(receipt.transactionId, "utf8")
            .digest("base64url");
        assert.equal(getXsollaPremiumProductReceiptKey(receipt.transactionId), expectedKey);
        const parsed = JSON.parse(serializeXsollaPremiumProductReceipt(receipt));
        assert.deepEqual(parsed, {
            schemaVersion: 2,
            transactionId: receipt.transactionId,
            productId: "premium",
            xsollaSku: "seabyss_premium_gold",
            productType: "premium",
            premiumTier: "gold",
            activatedAtUtc: "2026-08-18T15:20:30.000Z",
            expiresAtUtc: "2026-09-17T15:20:30.000Z",
            source: "xsolla_sandbox"
        });
        assert.equal(Object.keys(parsed).length, 9);
        for (const forbidden of ["quantity", "duration", "rewards", "items"]) {
            assert.equal(Object.hasOwn(parsed, forbidden), false);
        }
    });

    test("writes by Master PlayFabId then verifies exact readback", async () => {
        const calls = [];
        let storedKey;
        let storedValue;
        const persist = createPlayFabXsollaPremiumProductReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            timeoutMs: 1000,
            async fetchImpl(url, options) {
                const body = JSON.parse(options.body);
                calls.push({ url, options, body });
                if (url.endsWith("/Server/UpdateUserInternalData")) {
                    storedKey = Object.keys(body.Data)[0];
                    storedValue = body.Data[storedKey];
                    return response(200, { code: 200, data: { DataVersion: 1 } });
                }
                return response(200, {
                    code: 200,
                    data: { Data: { [storedKey]: { Value: storedValue } } }
                });
            }
        });

        const result = await persist(receipt);
        assert.deepEqual(calls.map((call) => call.url), [
            "https://local-title.playfabapi.com/Server/GetUserInternalData",
            "https://local-title.playfabapi.com/Server/UpdateUserInternalData",
            "https://local-title.playfabapi.com/Server/GetUserInternalData"
        ]);
        assert.deepEqual(calls[0].body, {
            PlayFabId: receipt.playFabId,
            Keys: [result.key]
        });
        assert.deepEqual(calls[1].body, {
            PlayFabId: receipt.playFabId,
            Data: { [result.key]: result.value }
        });
        assert.deepEqual(calls[2].body, {
            PlayFabId: receipt.playFabId,
            Keys: [result.key]
        });
        assert.ok(calls.every((call) => call.options.headers["X-SecretKey"] === "local-secret"));
    });

    test("enforces exact SKU/tier, canonical timestamps, 30 days, and server source", () => {
        const validTiers = [
            ["seabyss_premium_bronze", "bronze"],
            ["seabyss_premium_silver", "silver"],
            ["seabyss_premium_gold", "gold"]
        ];
        for (const [xsollaSku, premiumTier] of validTiers) {
            assert.doesNotThrow(() => serializeXsollaPremiumProductReceipt({
                ...receipt,
                xsollaSku,
                premiumTier,
                source: "xsolla_production"
            }));
        }
        for (const change of [
            { productId: "premium_gold" },
            { productType: "subscription" },
            { xsollaSku: "seabyss_premium_gold ", premiumTier: "gold" },
            { xsollaSku: "seabyss_premium_gold", premiumTier: "silver" },
            { source: "client" },
            { activatedAtUtc: "2026-08-18T15:20:30Z" },
            { expiresAtUtc: "2026-09-18T15:20:30.000Z" },
            { transactionId: "001" },
            { transactionId: "9223372036854775808" }
        ]) {
            assert.throws(() => serializeXsollaPremiumProductReceipt({ ...receipt, ...change }));
        }
    });

    test("fails closed on PlayFab update/read/readback and malformed player", async () => {
        const scenarios = [
            async () => response(500, { code: 500 }),
            async (url) => url.endsWith("UpdateUserInternalData")
                ? response(200, { code: 200, data: {} })
                : response(500, { code: 500 }),
            async (url) => url.endsWith("UpdateUserInternalData")
                ? response(200, { code: 200, data: {} })
                : response(200, { code: 200, data: { Data: {} } })
        ];
        for (const fetchImpl of scenarios) {
            const persist = createPlayFabXsollaPremiumProductReceiptStore({
                titleId: "local-title",
                secretKey: "local-secret",
                fetchImpl
            });
            await assert.rejects(persist(receipt));
        }

        let calls = 0;
        const persist = createPlayFabXsollaPremiumProductReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl() { calls += 1; throw new Error("must not run"); }
        });
        await assert.rejects(persist({ ...receipt, playFabId: " PLAYER" }));
        assert.equal(calls, 0);
    });
});
