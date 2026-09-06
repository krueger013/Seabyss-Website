import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    parseXsollaMinorUnits,
    validateXsollaEconomicContract,
    XsollaEconomicContractError
} from "../src/xsolla-economic-contract.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import { resolveXsollaStarterPack } from "../src/xsolla-starter-packs.js";
import { resolveXsollaDiamondPack } from "../src/xsolla-diamond-packs.js";

function starterOrderPaid() {
    return {
        notification_type: "order_paid",
        order: {
            id: "700001",
            mode: "default",
            status: "paid",
            currency_type: "real",
            amount: "3.99",
            currency: "USD"
        },
        billing: { notification_type: "payment", transaction: { id: "800001" } },
        items: [{
            sku: "seabyss_starter_pack_1",
            type: "virtual_good",
            is_pre_order: false,
            quantity: 1,
            price: { amount: "3.99", currency: "USD" }
        }]
    };
}

function legacyDiamondPayment() {
    return {
        notification_type: "payment",
        transaction: { id: "800002" },
        purchase: {
            total: { amount: 1.99, currency: "USD" },
            order: {
                id: 700002,
                lineitems: [{
                    sku: "seabyss_diamond_pack_1",
                    quantity: 1,
                    price: { amount: 1.99, currency: "USD" }
                }]
            }
        }
    };
}

function validate(payload, notificationType, product) {
    return validateXsollaEconomicContract({
        payload,
        notificationType,
        product,
        productPlan: getXsollaProductPlan(product.xsollaSku)
    });
}

describe("Xsolla economic contract", () => {
    test("parses canonical two-decimal money into safe minor units", () => {
        assert.equal(parseXsollaMinorUnits("0"), 0);
        assert.equal(parseXsollaMinorUnits("3.9"), 390);
        assert.equal(parseXsollaMinorUnits("3.99"), 399);
        assert.equal(parseXsollaMinorUnits(10.99), 1099);
        for (const invalid of [
            -1, "-1", "+1", "01", "1.000", " 1.00", "1e2", NaN,
            Infinity, {}, null, "999999999999999999999999.99"
        ]) {
            assert.equal(parseXsollaMinorUnits(invalid), null, String(invalid));
        }
    });

    test("accepts exact Starter order_paid and legacy Diamond payment contracts", () => {
        const starterPayload = starterOrderPaid();
        const starter = resolveXsollaStarterPack(starterPayload, "order_paid");
        assert.deepEqual(validate(starterPayload, "order_paid", starter), {
            productPlanVersion: 1,
            notificationType: "order_paid",
            orderId: "700001",
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        });

        const diamondPayload = legacyDiamondPayment();
        const diamond = resolveXsollaDiamondPack(diamondPayload, "payment");
        assert.deepEqual(validate(diamondPayload, "payment", diamond), {
            productPlanVersion: 2,
            notificationType: "payment",
            orderId: "700002",
            currency: "USD",
            unitAmountMinor: 199,
            quantity: 1,
            totalAmountMinor: 199,
            promotionPolicy: "disabled"
        });
    });

    test("rejects negative, zero, absurd, wrong-currency, and mismatched prices", () => {
        const scenarios = [
            (value) => {
                value.order.amount = "-3.99";
                value.items[0].price.amount = "-3.99";
            },
            (value) => {
                value.order.amount = "0.00";
                value.items[0].price.amount = "0.00";
            },
            (value) => {
                value.order.amount = "999999999999999999999999.99";
                value.items[0].price.amount = "999999999999999999999999.99";
            },
            (value) => {
                value.order.currency = "EUR";
                value.items[0].price.currency = "EUR";
            },
            (value) => { value.items[0].price.amount = "0.01"; }
        ];
        for (const mutate of scenarios) {
            const payload = starterOrderPaid();
            mutate(payload);
            const product = resolveXsollaStarterPack(payload, "order_paid");
            assert.throws(
                () => validate(payload, "order_paid", product),
                XsollaEconomicContractError
            );
        }
    });

    test("requires numeric quantity one and rejects every promotion signal", () => {
        for (const quantity of [undefined, 0, 2, "1", true]) {
            const payload = starterOrderPaid();
            if (quantity === undefined) delete payload.items[0].quantity;
            else payload.items[0].quantity = quantity;
            const product = {
                productId: "starter_pack_1",
                xsollaSku: "seabyss_starter_pack_1",
                productType: "starter_pack"
            };
            assert.throws(() => validate(payload, "order_paid", product), /quantity/i);
        }

        for (const promotion of [
            { promotions: [{ id: "sale" }] },
            { discount: { amount: "1.00" } },
            { promo_code: "SALE" }
        ]) {
            const payload = starterOrderPaid();
            Object.assign(payload.order, promotion);
            const product = resolveXsollaStarterPack(payload, "order_paid");
            assert.throws(() => validate(payload, "order_paid", product), /promotion/i);
        }
    });

    test("rejects missing totals, item price, order identity, and conflicting plan identity", () => {
        const mutations = [
            (value) => { delete value.order.amount; },
            (value) => { delete value.items[0].price; },
            (value) => { value.order.id = "001"; }
        ];
        for (const mutate of mutations) {
            const payload = starterOrderPaid();
            mutate(payload);
            const product = resolveXsollaStarterPack(payload, "order_paid") || {
                productId: "starter_pack_1",
                xsollaSku: "seabyss_starter_pack_1",
                productType: "starter_pack"
            };
            assert.throws(() => validate(payload, "order_paid", product));
        }
        const payload = starterOrderPaid();
        assert.throws(() => validate(payload, "order_paid", {
            productId: "starter_pack_2",
            xsollaSku: "seabyss_starter_pack_1",
            productType: "starter_pack"
        }), /plan/i);
    });
});
