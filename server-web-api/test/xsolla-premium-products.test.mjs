import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER,
    XSOLLA_STANDALONE_PREMIUM_DURATION_DAYS,
    resolveXsollaPremiumProduct,
    resolveXsollaStandalonePremiumPeriod
} from "../src/xsolla-premium-products.js";
import { createXsollaPremiumEventProcessor } from "../src/xsolla-premium-processor.js";

const playFabId = "4DF88C225D91FE06";
const products = Object.freeze([
    ["seabyss_premium_bronze", "bronze"],
    ["seabyss_premium_silver", "silver"],
    ["seabyss_premium_gold", "gold"]
]);
const fixedNow = new Date("2026-08-18T15:20:30.000Z");

function payment({
    sku = products[0][0],
    transactionId = "2117100001",
    quantity = 1,
    includeQuantity = true,
    dryRun,
    lineitems
} = {}) {
    const item = { sku };
    if (includeQuantity) {
        item.quantity = quantity;
    }
    const transaction = { id: transactionId };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    return {
        notification_type: "payment",
        transaction,
        purchase: { order: { lineitems: lineitems || [item] } }
    };
}

function createHarness(options = {}) {
    const premiumProducts = [];
    const validated = [];
    const processor = createXsollaPremiumEventProcessor({
        premiumPlanId: "321178",
        premiumPlanExternalId: "NZSorpSt",
        allowSandboxGrants: options.allowSandboxGrants === true,
        sandboxTestPlayFabIds: options.sandboxTestPlayFabIds || [],
        enableStandalonePremiumProducts: options.enableStandalonePremiumProducts === true,
        now: () => new Date(fixedNow.getTime()),
        async validateUser(value) {
            validated.push(value);
            return true;
        },
        async persistPremiumProductReceipt(receipt) {
            premiumProducts.push(receipt);
        },
        async persistStarterPackReceipt() {
            throw new Error("unexpected Starter persistence");
        },
        async persistDiamondPackReceipt() {
            throw new Error("unexpected Diamond persistence");
        },
        async persistPremiumEntitlement() {
            throw new Error("unexpected legacy Premium persistence");
        }
    });
    return { processor, premiumProducts, validated };
}

async function process(harness, payload) {
    return harness.processor({ payload, notificationType: "payment", userId: playFabId });
}

describe("Xsolla standalone Premium product mapping", () => {
    test("uses only the three exact official SKU tiers", () => {
        assert.deepEqual({ ...XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER }, {
            seabyss_premium_bronze: "bronze",
            seabyss_premium_silver: "silver",
            seabyss_premium_gold: "gold"
        });
        assert.equal(Object.isFrozen(XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER), true);
        for (const [xsollaSku, premiumTier] of products) {
            assert.deepEqual(resolveXsollaPremiumProduct(payment({ sku: xsollaSku }), "payment"), {
                productId: "premium",
                xsollaSku,
                productType: "premium",
                premiumTier
            });
        }
    });

    test("uses a backend-authoritative exact 30-day period", () => {
        assert.equal(XSOLLA_STANDALONE_PREMIUM_DURATION_DAYS, 30);
        assert.deepEqual(resolveXsollaStandalonePremiumPeriod(
            () => new Date(fixedNow.getTime())
        ), {
            activatedAtUtc: "2026-08-18T15:20:30.000Z",
            expiresAtUtc: "2026-09-17T15:20:30.000Z"
        });
        assert.throws(() => resolveXsollaStandalonePremiumPeriod(() => new Date("invalid")));
    });

    test("rejects nonnumeric-one quantity, padding, multiplicity, and inherited SKU", () => {
        const inherited = Object.create({ sku: products[0][0] });
        inherited.quantity = 1;
        const invalid = [
            payment({ quantity: "1" }),
            payment({ quantity: 2 }),
            payment({ sku: " seabyss_premium_bronze" }),
            payment({ sku: "seabyss_premium_bronze " }),
            payment({ sku: "constructor" }),
            payment({ sku: "wrong_sku" }),
            payment({ lineitems: [
                { sku: products[0][0], quantity: 1 },
                { sku: products[1][0], quantity: 1 }
            ] }),
            payment({ lineitems: [inherited] })
        ];
        for (const payload of invalid) {
            assert.equal(resolveXsollaPremiumProduct(payload, "payment"), null);
        }
        assert.ok(resolveXsollaPremiumProduct(payment({ includeQuantity: false }), "payment"));
        assert.equal(resolveXsollaPremiumProduct(payment(), "order_paid"), null);
    });
});

describe("Xsolla standalone Premium processor", () => {
    test("stays disabled by default", async () => {
        const harness = createHarness();
        assert.equal(
            await process(harness, payment()),
            "ignored_unrecognized_product"
        );
        assert.deepEqual(harness.validated, []);
        assert.deepEqual(harness.premiumProducts, []);
    });

    test("persists each tier with fixed server fields and no payload authority", async () => {
        for (let index = 0; index < products.length; index += 1) {
            const [xsollaSku, premiumTier] = products[index];
            const transactionId = String(2117100100 + index);
            const harness = createHarness({
                enableStandalonePremiumProducts: true
            });
            const payload = payment({ sku: xsollaSku, transactionId });
            payload.duration = 999999;
            payload.purchase.order.lineitems[0].duration = 999999;
            payload.purchase.order.lineitems[0].reward = { premiumDays: 999999 };

            assert.equal(await process(harness, payload), "premium_product_granted");
            assert.deepEqual(harness.validated, [playFabId]);
            assert.deepEqual(harness.premiumProducts, [{
                playFabId,
                transactionId,
                productId: "premium",
                xsollaSku,
                productType: "premium",
                premiumTier,
                activatedAtUtc: "2026-08-18T15:20:30.000Z",
                expiresAtUtc: "2026-09-17T15:20:30.000Z",
                source: "xsolla_production"
            }]);
            assert.equal(Object.hasOwn(harness.premiumProducts[0], "duration"), false);
            assert.equal(Object.hasOwn(harness.premiumProducts[0], "quantity"), false);
            assert.equal(Object.hasOwn(harness.premiumProducts[0], "reward"), false);
        }
    });

    test("allows sandbox only for the explicit PlayFab allowlist", async () => {
        const accepted = createHarness({
            enableStandalonePremiumProducts: true,
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: [playFabId]
        });
        assert.equal(
            await process(accepted, payment({ sku: products[2][0], dryRun: 1 })),
            "premium_product_sandbox_granted"
        );
        assert.equal(accepted.premiumProducts[0].source, "xsolla_sandbox");

        const rejected = createHarness({
            enableStandalonePremiumProducts: true,
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: ["OTHER_PLAYER"]
        });
        assert.equal(await process(rejected, payment({ dryRun: 1 })), "ignored_dry_run");
        assert.deepEqual(rejected.validated, []);
        assert.deepEqual(rejected.premiumProducts, []);
    });
});
