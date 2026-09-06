import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    XSOLLA_PRODUCT_PLAN_VERSION,
    getXsollaProductPlan,
    listXsollaProductPlans
} from "../src/xsolla-product-plan-registry.js";

const expectedPlans = Object.freeze([
    ["seabyss_starter_pack_1", "starter_pack_1", "starter_pack", "virtual_good", "one_time", false, 399, true, null],
    ["seabyss_starter_pack_2", "starter_pack_2", "starter_pack", "virtual_good", "one_time", false, 699, true, null],
    ["seabyss_starter_pack_3", "starter_pack_3", "starter_pack", "virtual_good", "one_time", false, 1099, true, null],
    ["seabyss_diamond_pack_1", "diamond_pack_1", "diamond_pack", "bundle", "repeatable", true, 199, true, null],
    ["seabyss_diamond_pack_2", "diamond_pack_2", "diamond_pack", "bundle", "repeatable", true, 399, true, null],
    ["seabyss_diamond_pack_3", "diamond_pack_3", "diamond_pack", "bundle", "repeatable", true, 699, true, null],
    ["seabyss_premium_bronze", "premium", "premium", "virtual_good", "repeatable", true, 199, false, 30],
    ["seabyss_premium_silver", "premium", "premium", "virtual_good", "repeatable", true, 399, false, 30],
    ["seabyss_premium_gold", "premium", "premium", "virtual_good", "repeatable", true, 799, false, 30],
    ["seabyss_diamond_pack_4", "diamond_pack_4", "diamond_pack", "bundle", "repeatable", true, 999, true, null],
    ["seabyss_diamond_pack_5", "diamond_pack_5", "diamond_pack", "bundle", "repeatable", true, 1899, true, null]
]);


function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(",")}}`;
    }
    return JSON.stringify(value);
}
describe("versioned Xsolla ProductPlan registry", () => {
    test("pins the exact catalog to USD integer minor units", () => {
        assert.equal(XSOLLA_PRODUCT_PLAN_VERSION, 1);
        const plans = listXsollaProductPlans();
        assert.equal(plans.length, expectedPlans.length);

        assert.deepEqual(plans.map((plan) => [
            plan.sku,
            plan.productId,
            plan.productType,
            plan.catalogItemType,
            plan.purchasePolicy,
            plan.repeatable,
            plan.unitAmountMinor,
            plan.catalogEnabled,
            plan.entitlementDurationDays ?? null
        ]), expectedPlans);

        for (const plan of plans) {
            assert.equal(plan.schemaVersion, 1);
            assert.equal(plan.planVersion, plan.productType === "diamond_pack" ? 2 : 1);
            assert.equal(plan.currency, "USD");
            assert.equal(plan.minorUnitScale, 2);
            assert.equal(Number.isSafeInteger(plan.unitAmountMinor), true);
            assert.deepEqual(plan.allowedEnvironments, ["sandbox", "production"]);
            assert.match(plan.planHash, /^[a-f0-9]{64}$/);
            const { planHash, ...hashMaterial } = plan;
            assert.equal(
                planHash,
                createHash("sha256")
                    .update(canonicalJson(hashMaterial), "utf8")
                    .digest("hex")
            );
            assert.deepEqual(plan.promotionPolicy, {
                mode: "disabled",
                discountsAllowed: false,
                couponsAllowed: false,
                priceOverridesAllowed: false,
                approvedSnapshotId: null
            });
        }

        assert.deepEqual(
            plans.filter((plan) => plan.productType !== "premium")
                .map((plan) => [plan.sku, plan.catalogEnabled]),
            expectedPlans.filter((p) => p[2] !== "premium").map(([sku]) => [sku, true])
        );
        assert.equal(plans.filter((plan) => plan.productType === "premium")
            .every((plan) => plan.catalogEnabled === false), true);
    });

    test("looks up only an exact canonical SKU at the exact version", () => {
        for (const [sku] of expectedPlans) {
            const current = getXsollaProductPlan(sku);
            assert.equal(current, getXsollaProductPlan(sku, current.planVersion));
        }
        for (const sku of [
            "",
            " seabyss_starter_pack_1",
            "seabyss_starter_pack_1 ",
            "SEABYSS_STARTER_PACK_1",
            "seabyss_starter_pack_4",
            "constructor",
            "toString",
            null,
            undefined,
            1,
            new String("seabyss_starter_pack_1")
        ]) {
            assert.throws(() => getXsollaProductPlan(sku), RangeError);
        }
        for (const version of [0, 2, -1, "1", 1n, null, {}, []]) {
            assert.throws(
                () => getXsollaProductPlan("seabyss_starter_pack_1", version),
                RangeError
            );
            assert.throws(() => listXsollaProductPlans(version), RangeError);
        }
    });

    test("does not expose mutable registry state", () => {
        const plans = listXsollaProductPlans();
        const starter = getXsollaProductPlan("seabyss_starter_pack_1");
        assert.equal(Object.isFrozen(plans), true);
        assert.equal(Object.isFrozen(starter), true);
        assert.equal(Object.isFrozen(starter.promotionPolicy), true);
        assert.equal(Object.isFrozen(starter.allowedEnvironments), true);

        assert.throws(() => plans.push(starter), TypeError);
        assert.throws(() => { starter.unitAmountMinor = 1; }, TypeError);
        assert.throws(() => { starter.promotionPolicy.mode = "enabled"; }, TypeError);
        assert.throws(() => starter.allowedEnvironments.push("development"), TypeError);
        assert.equal(getXsollaProductPlan(starter.sku).unitAmountMinor, 399);
        assert.equal(getXsollaProductPlan(starter.sku).promotionPolicy.mode, "disabled");
    });
});
