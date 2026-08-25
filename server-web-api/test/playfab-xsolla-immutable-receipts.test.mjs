import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { createPlayFabXsollaStarterReceiptStore } from
    "../src/playfab-xsolla-starter-receipt-store.js";
import { createPlayFabXsollaPremiumProductReceiptStore } from
    "../src/playfab-xsolla-premium-product-receipt-store.js";
import {
    createMemoryXsollaEventStore,
    createXsollaWebhookHandler
} from "../src/xsolla-webhook.js";
import { createXsollaPremiumEventProcessor } from "../src/xsolla-premium-processor.js";

function response(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        async json() { return payload; }
    };
}

function playFabHarness() {
    const values = new Map();
    const calls = [];
    let updates = 0;
    return {
        values,
        calls,
        get updates() { return updates; },
        async fetchImpl(url, options) {
            const body = JSON.parse(options.body);
            const endpoint = url.split("/").at(-1);
            calls.push({ endpoint, body });
            if (endpoint === "UpdateUserInternalData") {
                updates += 1;
                for (const [key, value] of Object.entries(body.Data || {})) {
                    values.set(key, value);
                }
                return response(200, { code: 200, data: { DataVersion: updates } });
            }
            if (endpoint === "GetUserInternalData") {
                const data = {};
                for (const key of body.Keys || []) {
                    if (values.has(key)) data[key] = { Value: values.get(key) };
                }
                return response(200, { code: 200, data: { Data: data } });
            }
            return response(404, { code: 404 });
        }
    };
}

const playFabId = "4DF88C225D91FE06";
const starterReceipt = Object.freeze({
    playFabId,
    transactionId: "2118100001",
    productId: "starter_pack_1",
    xsollaSku: "seabyss_starter_pack_1",
    productType: "starter_pack",
    source: "xsolla_sandbox"
});
const premiumReceipt = Object.freeze({
    playFabId,
    transactionId: "2118100002",
    productId: "premium",
    xsollaSku: "seabyss_premium_gold",
    productType: "premium",
    premiumTier: "gold",
    activatedAtUtc: "2026-08-18T12:00:00.000Z",
    expiresAtUtc: "2026-09-17T12:00:00.000Z",
    source: "xsolla_sandbox"
});

describe("immutable PlayFab Xsolla receipts", () => {
    test("xss1 reads first, never overwrites, and rejects a conflicting product", async () => {
        const mock = playFabHarness();
        const persist = createPlayFabXsollaStarterReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            fetchImpl: mock.fetchImpl
        });
        const first = await persist(starterReceipt);
        assert.equal(first.existing, false);
        assert.deepEqual(mock.calls.map((call) => call.endpoint), [
            "GetUserInternalData",
            "UpdateUserInternalData",
            "GetUserInternalData"
        ]);
        const replay = await persist(starterReceipt);
        assert.equal(replay.existing, true);
        assert.equal(mock.updates, 1);

        await assert.rejects(persist({
            ...starterReceipt,
            productId: "starter_pack_2",
            xsollaSku: "seabyss_starter_pack_2"
        }), /conflict/i);
        assert.equal(mock.updates, 1);
        assert.equal(mock.values.get(first.key), first.value);
    });

    test("xsp2 adopts existing timestamps only for the same immutable identity", async () => {
        const mock = playFabHarness();
        const persist = createPlayFabXsollaPremiumProductReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            fetchImpl: mock.fetchImpl
        });
        const first = await persist(premiumReceipt);
        assert.equal(first.existing, false);
        const delayedRetry = await persist({
            ...premiumReceipt,
            activatedAtUtc: "2026-08-18T12:05:00.000Z",
            expiresAtUtc: "2026-09-17T12:05:00.000Z"
        });
        assert.equal(delayedRetry.existing, true);
        assert.equal(delayedRetry.value, first.value);
        assert.equal(mock.updates, 1);

        await assert.rejects(persist({
            ...premiumReceipt,
            xsollaSku: "seabyss_premium_silver",
            premiumTier: "silver"
        }), /conflict/i);
        assert.equal(mock.updates, 1);
    });

    test("completion failure then delayed xsp2 retry reuses the first receipt", async () => {
        const mock = playFabHarness();
        const persistPremiumProductReceipt = createPlayFabXsollaPremiumProductReceiptStore({
            titleId: "local-title",
            secretKey: "local-secret",
            fetchImpl: mock.fetchImpl
        });
        const baseStore = createMemoryXsollaEventStore();
        let failFirstCompletion = true;
        const eventStore = {
            ...baseStore,
            async complete(...args) {
                if (failFirstCompletion) {
                    failFirstCompletion = false;
                    return false;
                }
                return baseStore.complete(...args);
            }
        };
        let serverNow = new Date("2026-08-18T12:00:00.000Z");
        const processor = createXsollaPremiumEventProcessor({
            premiumPlanId: "321178",
            premiumPlanExternalId: "NZSorpSt",
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: [playFabId],
            enableStandalonePremiumProducts: true,
            now: () => new Date(serverNow.getTime()),
            validateUser: async () => true,
            persistPremiumProductReceipt,
            persistPremiumEntitlement: async () => { throw new Error("unexpected legacy"); },
            persistDiamondPackReceipt: async () => { throw new Error("unexpected diamond"); },
            persistStarterPackReceipt: async () => { throw new Error("unexpected starter"); }
        });
        const secret = "retry-test-secret";
        const handler = createXsollaWebhookHandler({
            webhookSecret: secret,
            projectId: "310966",
            eventStore,
            processEvent: processor,
            logger: { info() {}, warn() {}, error() {} }
        });
        const payload = {
            notification_type: "payment",
            settings: { project_id: 310966 },
            user: { id: playFabId },
            transaction: { id: premiumReceipt.transactionId, dry_run: 1 },
            purchase: {
                order: { lineitems: [{ sku: "seabyss_premium_gold", quantity: 1 }] }
            }
        };

        async function invoke() {
            const rawBody = Buffer.from(JSON.stringify(payload));
            const signature = createHash("sha1")
                .update(rawBody)
                .update(secret, "utf8")
                .digest("hex");
            const result = {
                statusCode: 0,
                jsonBody: null,
                status(value) { this.statusCode = value; return this; },
                json(value) { this.jsonBody = value; return this; },
                end() { return this; }
            };
            await handler({
                body: rawBody,
                get: () => `Signature ${signature}`
            }, result);
            return result;
        }

        assert.equal((await invoke()).statusCode, 500);
        serverNow = new Date("2026-08-18T12:05:00.000Z");
        assert.equal((await invoke()).statusCode, 204);
        assert.equal(mock.updates, 1);
        const stored = JSON.parse([...mock.values.values()][0]);
        assert.equal(stored.activatedAtUtc, "2026-08-18T12:00:00.000Z");
        assert.equal(stored.expiresAtUtc, "2026-09-17T12:00:00.000Z");
    });
});
