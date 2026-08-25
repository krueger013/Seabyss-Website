import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    createPlayFabXsollaStarterReceiptStore,
    getXsollaStarterReceiptKey,
    serializeXsollaStarterReceipt
} from "../src/playfab-xsolla-starter-receipt-store.js";

const receipt = Object.freeze({
    playFabId: "4DF88C225D91FE06",
    transactionId: "9223372036854775807",
    productId: "starter_pack_3",
    xsollaSku: "seabyss_starter_pack_3",
    productType: "starter_pack",
    source: "xsolla_sandbox"
});

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        async json() { return payload; }
    };
}

describe("PlayFab Xsolla Starter receipt store", () => {
    test("uses deterministic xss1 SHA-256 and the exact six-field schema", () => {
        const expectedKey = "xss1_" + createHash("sha256")
            .update(receipt.transactionId, "utf8")
            .digest("base64url");
        assert.equal(getXsollaStarterReceiptKey(receipt.transactionId), expectedKey);
        const parsed = JSON.parse(serializeXsollaStarterReceipt(receipt));
        assert.deepEqual(parsed, {
            schemaVersion: 1,
            transactionId: receipt.transactionId,
            productId: "starter_pack_3",
            xsollaSku: "seabyss_starter_pack_3",
            productType: "starter_pack",
            source: "xsolla_sandbox"
        });
        assert.equal(Object.keys(parsed).length, 6);
        for (const forbidden of ["quantity", "rewards", "items", "duration"] ) {
            assert.equal(Object.hasOwn(parsed, forbidden), false);
        }
    });

    test("writes by Master PlayFabId then verifies exact readback", async () => {
        const calls = [];
        let storedKey;
        let storedValue;
        const persist = createPlayFabXsollaStarterReceiptStore({
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

    test("accepts only canonical transaction, exact mapping, type, and source", () => {
        for (const source of ["xsolla_sandbox", "xsolla_production"]) {
            assert.doesNotThrow(() => serializeXsollaStarterReceipt({ ...receipt, source }));
        }
        for (const change of [
            { productId: "starter_pack_2" },
            { xsollaSku: "wrong_sku" },
            { xsollaSku: "constructor" },
            { xsollaSku: " seabyss_starter_pack_3" },
            { productType: "bundle" },
            { source: "client" },
            { transactionId: "001" },
            { transactionId: " 1" },
            { transactionId: "9223372036854775808" }
        ]) {
            assert.throws(() => serializeXsollaStarterReceipt({ ...receipt, ...change }));
        }
    });

    test("fails closed on PlayFab update/read/readback and malformed input", async () => {
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
            const persist = createPlayFabXsollaStarterReceiptStore({
                titleId: "local-title",
                secretKey: "local-secret",
                fetchImpl
            });
            await assert.rejects(persist(receipt));
        }

        let calls = 0;
        const persist = createPlayFabXsollaStarterReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl() { calls += 1; throw new Error("must not run"); }
        });
        await assert.rejects(persist({ ...receipt, playFabId: " " }));
        await assert.rejects(persist({ ...receipt, productId: "starter_pack_1" }));
        assert.equal(calls, 0);
    });
});
