import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    createPlayFabXsollaDiamondReceiptStore,
    getXsollaDiamondReceiptKey,
    serializeXsollaDiamondReceipt
} from "../src/playfab-xsolla-diamond-receipt-store.js";

const receipt = Object.freeze({
    playFabId: "4DF88C225D91FE06",
    transactionId: "9223372036854775807",
    productId: "diamond_pack_3",
    xsollaSku: "seabyss_diamond_pack_3",
    productType: "diamond_pack",
    source: "xsolla_sandbox"
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

describe("PlayFab Xsolla Diamond receipt store", () => {
    test("uses the deterministic xsd1 SHA-256 key and strict quantity-free schema", () => {
        const expectedKey = "xsd1_" + createHash("sha256")
            .update(receipt.transactionId, "utf8")
            .digest("base64url");
        assert.equal(getXsollaDiamondReceiptKey(receipt.transactionId), expectedKey);
        const parsed = JSON.parse(serializeXsollaDiamondReceipt(receipt));
        assert.deepEqual(parsed, {
            schemaVersion: 1,
            transactionId: receipt.transactionId,
            productId: receipt.productId,
            xsollaSku: receipt.xsollaSku,
            productType: "diamond_pack",
            source: "xsolla_sandbox"
        });
        assert.equal(Object.keys(parsed).length, 6);
        assert.equal(Object.hasOwn(parsed, "quantity"), false);
    });

    test("persists by Master PlayFabId and verifies exact readback", async () => {
        const calls = [];
        let storedKey;
        let storedValue;
        const persist = createPlayFabXsollaDiamondReceiptStore({
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
            "https://local-title.playfabapi.com/Server/UpdateUserInternalData",
            "https://local-title.playfabapi.com/Server/GetUserInternalData"
        ]);
        assert.deepEqual(calls[0].body, {
            PlayFabId: receipt.playFabId,
            Data: { [result.key]: result.value }
        });
        assert.deepEqual(calls[1].body, {
            PlayFabId: receipt.playFabId,
            Keys: [result.key]
        });
        assert.ok(calls.every((call) => call.options.method === "POST"));
        assert.ok(calls.every((call) => call.options.redirect === "error"));
        assert.ok(calls.every(
            (call) => call.options.headers["X-SecretKey"] === "local-secret"
        ));
    });

    test("accepts only the exact official SKU/product mapping and two server sources", () => {
        for (const source of ["xsolla_sandbox", "xsolla_production"]) {
            assert.doesNotThrow(() => serializeXsollaDiamondReceipt({
                ...receipt,
                source
            }));
        }
        const invalid = [
            { productId: "diamond_pack_2" },
            { xsollaSku: "wrong_sku" },
            { xsollaSku: "constructor" },
            { xsollaSku: "toString" },
            { xsollaSku: " seabyss_diamond_pack_3" },
            { productType: "Premium" },
            { source: "client" },
            { transactionId: "001" },
            { transactionId: " 1" },
            { transactionId: "9223372036854775808" }
        ];
        for (const change of invalid) {
            assert.throws(() => serializeXsollaDiamondReceipt({
                ...receipt,
                ...change
            }));
        }
    });

    test("fails closed on update, read, and exact-readback errors", async () => {
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
            const persist = createPlayFabXsollaDiamondReceiptStore({
                titleId: "local-title",
                secretKey: "local-secret",
                fetchImpl
            });
            await assert.rejects(persist(receipt));
        }
    });

    test("rejects malformed player and receipt data before PlayFab", async () => {
        let calls = 0;
        const persist = createPlayFabXsollaDiamondReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl() {
                calls += 1;
                throw new Error("must not be called");
            }
        });
        await assert.rejects(persist({ ...receipt, playFabId: " 4DF88C225D91FE06" }));
        await assert.rejects(persist({ ...receipt, transactionId: "0" }));
        await assert.rejects(persist({ ...receipt, productId: "diamond_pack_1" }));
        await assert.rejects(persist({ ...receipt, source: "client" }));
        assert.equal(calls, 0);
    });
});
