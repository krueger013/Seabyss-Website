import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlayFabXsollaV2ReceiptReader } from "../src/playfab-xsolla-v2-receipt-reader.js";

const receiptId = `xss2_${"a".repeat(43)}`;

test("receipt reader loads only the requested immutable key without exposing its secret", async () => {
    const calls = [];
    const receipt = JSON.stringify({ schemaVersion: 2, transactionId: "1" });
    const load = createPlayFabXsollaV2ReceiptReader({
        titleId: "142853",
        secretKey: "server-secret",
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                status: 200,
                json: async () => ({ code: 200, data: { Data: { [receiptId]: { Value: receipt } } } })
            };
        }
    });
    const loaded = await load({ playFabId: "46789223F9CB1BB9", receiptId });
    assert.deepEqual(loaded, { key: receiptId, value: receipt });
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        PlayFabId: "46789223F9CB1BB9",
        Keys: [receiptId]
    });
    assert.equal(calls[0].options.headers["X-SecretKey"], "server-secret");
    assert.doesNotMatch(calls[0].url + calls[0].options.body, /server-secret/u);
});

test("receipt reader returns null for an absent receipt and rejects legacy keys", async () => {
    const load = createPlayFabXsollaV2ReceiptReader({
        titleId: "142853",
        secretKey: "server-secret",
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ code: 200, data: { Data: {} } })
        })
    });
    assert.equal(await load({ playFabId: "46789223F9CB1BB9", receiptId }), null);
    await assert.rejects(
        load({ playFabId: "46789223F9CB1BB9", receiptId: "xss1_legacy" }),
        /xss2_\/xsd2_/u
    );
});

test("receipt reader marks 429 as retryable and preserves Retry-After", async () => {
    const load = createPlayFabXsollaV2ReceiptReader({
        titleId: "142853",
        secretKey: "server-secret",
        fetchImpl: async () => ({
            ok: false,
            status: 429,
            headers: { get: () => "3" },
            json: async () => ({ code: 429, error: "APIRequestsLimitExceeded" })
        })
    });
    await assert.rejects(load({ playFabId: "46789223F9CB1BB9", receiptId }), (error) => {
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterMilliseconds, 3000);
        return true;
    });
});
