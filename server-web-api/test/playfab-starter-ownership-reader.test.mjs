import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createPlayFabStarterOwnershipReader,
    PlayFabStarterOwnershipError,
    STARTER_PURCHASE_STATES
} from "../src/playfab-starter-ownership-reader.js";
import { getXsollaStarterReceiptKey } from "../src/playfab-xsolla-starter-receipt-store.js";
import { getXsollaStarterReceiptV2Key } from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";

const playFabId = "46789223F9CB1BB9";
const sku = "seabyss_starter_pack_1";
const productId = "starter_pack_1";

function profile(overrides = {}) {
    return {
        schemaVersion: 12,
        durableEconomyTransactions: [],
        pendingXsollaStarterPackReceipts: [],
        ...overrides
    };
}

function xss1Receipt({
    transactionId = "706956443",
    receiptSku = sku,
    receiptProductId = productId
} = {}) {
    return {
        schemaVersion: 1,
        transactionId,
        productId: receiptProductId,
        xsollaSku: receiptSku,
        productType: "starter_pack",
        source: "xsolla_production"
    };
}

function xss2Receipt(transactionId = "706956444") {
    const productPlan = getXsollaProductPlan(sku);
    const rewardPlan = getStarterRewardPlan(sku);
    return {
        schemaVersion: 2,
        transactionId,
        notificationType: "payment",
        orderId: null,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: playFabId,
        createdAtUtc: "2026-08-22T12:00:00.000Z",
        environment: "production",
        productId,
        xsollaSku: sku,
        productType: "starter_pack",
        source: "xsolla_production",
        productPlanVersion: productPlan.planVersion,
        rewardPlanVersion: rewardPlan.planVersion,
        rewardPlanHash: rewardPlan.rewardPlanHash,
        rewards: rewardPlan.rewards,
        currency: productPlan.currency,
        unitAmountMinor: productPlan.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: productPlan.unitAmountMinor,
        promotionPolicy: "disabled"
    };
}

function playFabResponse(data) {
    const records = {};
    for (const [key, value] of Object.entries(data)) {
        records[key] = { Value: typeof value === "string" ? value : JSON.stringify(value) };
    }
    return new Response(JSON.stringify({ code: 200, data: { Data: records } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
    });
}

function createReader(data, capture = null, options = {}) {
    return createPlayFabStarterOwnershipReader({
        titleId: "142853",
        secretKey: "playfab-secret-local",
        async fetchImpl(url, init) {
            if (capture) capture.push({ url, init });
            return playFabResponse(data);
        },
        ...options
    });
}

describe("PlayFab Starter one-time ownership reader", () => {
    test("returns owned only from a completed authoritative durable transaction", async () => {
        const calls = [];
        const read = createReader({
            profile_v1: profile({
                durableEconomyTransactions: [{
                    transactionId: "durable-local-1",
                    operation: "XsollaStarterPack",
                    operationKey: productId,
                    state: "Completed"
                }]
            })
        }, calls);
        assert.deepEqual(await read({ playFabId, xsollaSku: sku }), {
            state: STARTER_PURCHASE_STATES.OWNED,
            playFabId,
            productId,
            xsollaSku: sku
        });
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            "https://142853.playfabapi.com/Server/GetUserInternalData"
        );
        assert.deepEqual(JSON.parse(calls[0].init.body), { PlayFabId: playFabId });
        assert.equal(Object.hasOwn(JSON.parse(calls[0].init.body), "Keys"), false);
    });

    test("returns paid_pending for nonterminal profile work and pending profile receipts", async () => {
        const durable = createReader({
            profile_v1: profile({
                durableEconomyTransactions: [{
                    transactionId: "durable-local-2",
                    operation: "XsollaStarterPack",
                    operationKey: productId,
                    state: "ProfileGranted"
                }]
            })
        });
        assert.equal(
            (await durable({ playFabId, xsollaSku: sku })).state,
            STARTER_PURCHASE_STATES.PAID_PENDING
        );

        const pending = createReader({
            profile_v1: profile({ pendingXsollaStarterPackReceipts: [xss1Receipt()] })
        });
        assert.equal(
            (await pending({ playFabId, xsollaSku: sku })).state,
            STARTER_PURCHASE_STATES.PAID_PENDING
        );
    });

    test("recognizes both immutable xss1 and xss2 receipts as paid_pending", async () => {
        const first = xss1Receipt();
        const xss1Read = createReader({
            profile_v1: profile(),
            [getXsollaStarterReceiptKey(first.transactionId)]: first
        });
        assert.equal(
            (await xss1Read({ playFabId, xsollaSku: sku })).state,
            STARTER_PURCHASE_STATES.PAID_PENDING
        );

        const second = xss2Receipt();
        const xss2Read = createReader({
            profile_v1: profile(),
            [getXsollaStarterReceiptV2Key(second.transactionId)]: second
        });
        assert.equal(
            (await xss2Read({ playFabId, xsollaSku: sku })).state,
            STARTER_PURCHASE_STATES.PAID_PENDING
        );
    });

    test("returns available only after a complete, unambiguous negative read", async () => {
        const other = xss1Receipt({
            transactionId: "706956445",
            receiptSku: "seabyss_starter_pack_2",
            receiptProductId: "starter_pack_2"
        });
        const read = createReader({
            profile_v1: profile(),
            [getXsollaStarterReceiptKey(other.transactionId)]: other
        });
        assert.equal(
            (await read({ playFabId, xsollaSku: sku })).state,
            STARTER_PURCHASE_STATES.AVAILABLE
        );
    });

    test("fails closed for malformed, mismatched or missing ownership evidence", async () => {
        const receipt = xss1Receipt();
        const cases = [
            {},
            { profile_v1: { schemaVersion: 12 } },
            {
                profile_v1: profile(),
                xss1_wrong_digest: receipt
            },
            {
                profile_v1: profile({
                    durableEconomyTransactions: [{
                        transactionId: "durable-local-3",
                        operation: "XsollaStarterPack",
                        operationKey: productId,
                        state: "MadeUpState"
                    }]
                })
            },
            {
                profile_v1: profile({
                    pendingXsollaStarterPackReceipts: [{ ...receipt, source: "client" }]
                })
            }
        ];
        for (const data of cases) {
            const read = createReader(data);
            await assert.rejects(
                read({ playFabId, xsollaSku: sku }),
                PlayFabStarterOwnershipError
            );
        }
    });

    test("rejects invalid identity, unconfigured access, transport and oversized snapshots", async () => {
        const read = createReader({ profile_v1: profile() });
        await assert.rejects(
            read({ playFabId: " fake player ", xsollaSku: sku }),
            TypeError
        );
        await assert.rejects(
            read({ playFabId, xsollaSku: "seabyss_starter_pack_fake" }),
            TypeError
        );

        const unconfigured = createPlayFabStarterOwnershipReader();
        await assert.rejects(
            unconfigured({ playFabId, xsollaSku: sku }),
            PlayFabStarterOwnershipError
        );

        const transport = createPlayFabStarterOwnershipReader({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            async fetchImpl() { throw new Error("private upstream detail"); }
        });
        await assert.rejects(
            transport({ playFabId, xsollaSku: sku }),
            (error) => error instanceof PlayFabStarterOwnershipError &&
                !error.message.includes("private upstream detail")
        );

        const oversized = createPlayFabStarterOwnershipReader({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            maximumResponseBytes: 1024,
            async fetchImpl() {
                return new Response("x".repeat(2048), { status: 200 });
            }
        });
        await assert.rejects(
            oversized({ playFabId, xsollaSku: sku }),
            PlayFabStarterOwnershipError
        );
    });
});
