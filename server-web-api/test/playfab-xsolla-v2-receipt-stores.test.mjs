import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createPlayFabXsollaStarterReceiptV2Store,
    getXsollaStarterReceiptV2Key,
    serializeXsollaStarterReceiptV2
} from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import {
    createPlayFabXsollaDiamondReceiptV2Store,
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";

const playFabId = "4DF88C225D91FE06";

function response(payload) {
    return {
        ok: true,
        async json() { return payload; }
    };
}

function createPlayFabMock() {
    const data = new Map();
    const calls = [];
    let updates = 0;
    return {
        data,
        calls,
        get updates() { return updates; },
        async fetchImpl(url, options) {
            const body = JSON.parse(options.body);
            calls.push({ url, options, body });
            if (url.endsWith("/Server/UpdateUserInternalData")) {
                updates += 1;
                for (const [key, value] of Object.entries(body.Data)) data.set(key, value);
                return response({ code: 200, data: { DataVersion: updates } });
            }
            const selected = {};
            for (const key of body.Keys) {
                if (data.has(key)) selected[key] = { Value: data.get(key) };
            }
            return response({ code: 200, data: { Data: selected } });
        }
    };
}

function starterReceipt(overrides = {}) {
    const rewardPlan = getStarterRewardPlan("seabyss_starter_pack_1");
    return {
        playFabId,
        transactionId: "800001",
        provider: "xsolla",
        providerTransactionId: "800001",
        userId: playFabId,
        createdAtUtc: "2026-08-22T00:00:00.000Z",
        environment: "sandbox",
        notificationType: "order_paid",
        orderId: "700001",
        productId: "starter_pack_1",
        xsollaSku: "seabyss_starter_pack_1",
        productType: "starter_pack",
        source: "xsolla_sandbox",
        productPlanVersion: 1,
        rewardPlanVersion: rewardPlan.planVersion,
        rewardPlanHash: rewardPlan.rewardPlanHash,
        rewards: rewardPlan.rewards,
        currency: "USD",
        unitAmountMinor: 399,
        quantity: 1,
        totalAmountMinor: 399,
        promotionPolicy: "disabled",
        ...overrides
    };
}

function diamondReceipt(overrides = {}) {
    return {
        playFabId,
        transactionId: "800002",
        provider: "xsolla",
        providerTransactionId: "800002",
        userId: playFabId,
        createdAtUtc: "2026-08-22T00:00:00.000Z",
        environment: "production",
        notificationType: "payment",
        orderId: null,
        productId: "diamond_pack_2",
        xsollaSku: "seabyss_diamond_pack_2",
        productType: "diamond_pack",
        source: "xsolla_production",
        productPlanVersion: 1,
        currency: "USD",
        unitAmountMinor: 399,
        quantity: 1,
        totalAmountMinor: 399,
        promotionPolicy: "disabled",
        ...overrides
    };
}

describe("immutable Xsolla v2 receipt stores", () => {
    test("serializes Starter xss2 with the exact immutable economic and reward snapshot", () => {
        const receipt = starterReceipt();
        assert.match(getXsollaStarterReceiptV2Key(receipt.transactionId), /^xss2_/);
        const parsed = JSON.parse(serializeXsollaStarterReceiptV2(receipt));
        assert.equal(parsed.schemaVersion, 2);
        assert.equal(parsed.transactionId, "800001");
        assert.equal(parsed.orderId, "700001");
        assert.equal(parsed.provider, "xsolla");
        assert.equal(parsed.providerTransactionId, "800001");
        assert.equal(parsed.userId, playFabId);
        assert.equal(parsed.createdAtUtc, "2026-08-22T00:00:00.000Z");
        assert.equal(parsed.environment, "sandbox");
        assert.equal(parsed.productPlanVersion, 1);
        assert.equal(parsed.rewardPlanVersion, 1);
        assert.equal(parsed.rewardPlanHash, receipt.rewardPlanHash);
        assert.deepEqual(parsed.rewards, receipt.rewards);
        assert.deepEqual({
            currency: parsed.currency,
            unitAmountMinor: parsed.unitAmountMinor,
            quantity: parsed.quantity,
            totalAmountMinor: parsed.totalAmountMinor,
            promotionPolicy: parsed.promotionPolicy
        }, {
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        });
    });

    test("dual-writes xss2 and immutable xss1 compatibility in one update", async () => {
        const mock = createPlayFabMock();
        const persist = createPlayFabXsollaStarterReceiptV2Store({
            titleId: "local-title",
            secretKey: "local-secret",
            fetchImpl: mock.fetchImpl
        });
        const result = await persist(starterReceipt());
        assert.equal(result.existing, false);
        assert.match(result.key, /^xss2_/);
        assert.match(result.legacyKey, /^xss1_/);
        assert.equal(mock.updates, 1);
        const update = mock.calls.find((call) =>
            call.url.endsWith("/Server/UpdateUserInternalData")
        );
        assert.deepEqual(Object.keys(update.body.Data).sort(), [
            result.key,
            result.legacyKey
        ].sort());
        assert.deepEqual(JSON.parse(result.legacyValue), {
            schemaVersion: 1,
            transactionId: "800001",
            productId: "starter_pack_1",
            xsollaSku: "seabyss_starter_pack_1",
            productType: "starter_pack",
            source: "xsolla_sandbox"
        });

        const replay = await persist(starterReceipt());
        assert.equal(replay.existing, true);
        assert.equal(mock.updates, 1);
        await assert.rejects(
            persist(starterReceipt({ orderId: "700002" })),
            /Immutable Xsolla Starter v2 receipt conflict/
        );
        assert.equal(mock.updates, 1);
    });

    test("fails Starter v2 closed on changed plan, price, or reward snapshot", () => {
        const receipt = starterReceipt();
        for (const change of [
            { productPlanVersion: 2 },
            { currency: "EUR" },
            { unitAmountMinor: 398 },
            { quantity: 0 },
            { totalAmountMinor: 0 },
            { promotionPolicy: "approved" },
            { rewardPlanVersion: 2 },
            { rewardPlanHash: "0".repeat(64) },
            { rewards: receipt.rewards.slice(1) },
            { orderId: "9223372036854775808" }
        ]) {
            assert.throws(() => serializeXsollaStarterReceiptV2({ ...receipt, ...change }));
        }
    });

    test("serializes and dual-writes immutable Diamond xsd2 plus xsd1", async () => {
        const receipt = diamondReceipt();
        assert.match(getXsollaDiamondReceiptV2Key(receipt.transactionId), /^xsd2_/);
        const parsed = JSON.parse(serializeXsollaDiamondReceiptV2(receipt));
        assert.deepEqual(parsed, {
            schemaVersion: 2,
            transactionId: "800002",
            notificationType: "payment",
            orderId: null,
            provider: "xsolla",
            providerTransactionId: "800002",
            userId: playFabId,
            createdAtUtc: "2026-08-22T00:00:00.000Z",
            environment: "production",
            productId: "diamond_pack_2",
            xsollaSku: "seabyss_diamond_pack_2",
            productType: "diamond_pack",
            source: "xsolla_production",
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        });

        const mock = createPlayFabMock();
        const persist = createPlayFabXsollaDiamondReceiptV2Store({
            titleId: "local-title",
            secretKey: "local-secret",
            fetchImpl: mock.fetchImpl
        });
        const result = await persist(receipt);
        assert.equal(mock.updates, 1);
        assert.match(result.key, /^xsd2_/);
        assert.match(result.legacyKey, /^xsd1_/);
        assert.deepEqual(JSON.parse(result.legacyValue), {
            schemaVersion: 1,
            transactionId: "800002",
            productId: "diamond_pack_2",
            xsollaSku: "seabyss_diamond_pack_2",
            productType: "diamond_pack",
            source: "xsolla_production"
        });
        assert.equal((await persist(receipt)).existing, true);
        assert.equal(mock.updates, 1);
        await assert.rejects(
            persist(diamondReceipt({ notificationType: "order_paid", orderId: "700003" })),
            /Immutable Xsolla Diamond v2 receipt conflict/
        );
        assert.equal(mock.updates, 1);
    });

    test("fails Diamond v2 closed on changed economic contract before PlayFab", async () => {
        let calls = 0;
        const persist = createPlayFabXsollaDiamondReceiptV2Store({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl() { calls += 1; throw new Error("must not run"); }
        });
        for (const change of [
            { playFabId: " bad" },
            { productPlanVersion: 99 },
            { productPlanVersion: undefined },
            { unitAmountMinor: 0 },
            { totalAmountMinor: 398 },
            { currency: "CAD" },
            { quantity: 2 },
            { promotionPolicy: "disabled_with_coupon" }
        ]) {
            await assert.rejects(persist(diamondReceipt(change)));
        }
        assert.equal(calls, 0);
    });
});
