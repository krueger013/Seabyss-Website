import test from "node:test";
import assert from "node:assert/strict";

test("historical xsd1 replay preserves exact old bytes; new receipts pin current version", async () => {
    const { createPlayFabXsollaDiamondReceiptStore, serializeXsollaDiamondReceipt, getXsollaDiamondReceiptKey } =
        await import("../src/playfab-xsolla-diamond-receipt-store.js");
    for (const n of [1, 2, 3, 4, 5]) {
        const receipt = { playFabId: "LOCAL-ONLY", transactionId: "95000000" + n,
            productId: "diamond_pack_" + n, xsollaSku: "seabyss_diamond_pack_" + n,
            productType: "diamond_pack", source: "xsolla_sandbox" };
        const key = getXsollaDiamondReceiptKey(receipt.transactionId);
        let value = n <= 3 ? serializeXsollaDiamondReceipt(receipt) : undefined;
        const oldValue = value;
        let writes = 0;
        const persist = createPlayFabXsollaDiamondReceiptStore({
            titleId: "local-test", secretKey: "local-placeholder",
            async fetchImpl(url, options) {
                const body = JSON.parse(options.body);
                if (url.endsWith("/UpdateUserInternalData")) { value = body.Data[key]; writes++; }
                return { ok: true, async json() { return { code: 200, data: {
                    Data: value === undefined ? {} : { [key]: { Value: value } }
                } }; } };
            }
        });
        await persist(receipt);
        await persist(receipt);
        if (n <= 3) {
            assert.equal(value, oldValue);
            assert.equal(writes, 0);
            await assert.rejects(persist({ ...receipt, productPlanVersion: 2 }), /conflict/);
        } else {
            assert.equal(JSON.parse(value).productPlanVersion, 2);
            assert.equal(writes, 1);
            assert.throws(() => serializeXsollaDiamondReceipt(receipt));
        }
    }
});

import { getXsollaProductPlan, getXsollaDiamondRewardQuantity } from "../src/xsolla-product-plan-registry.js";
import {
    createValidatedServerEconomyPocReceiptProjectionForTests,
    mapValidatedXsollaReceiptToServerEconomyPocOperation
} from "../src/server-economy-poc-receipt-mapper.js";

const historicalHashes = [
    "6bc951222b7fe43432d5268b504a7322a9bf2910c0e5ce0ac6474c79c60b5d01",
    "52f0808b9b84cf0f8b59cfaffa4181efce8aa63a45aa302d93a059c1468aaef5",
    "a688bc970768c3a822d92e281f0b4724fe5448271a60abba59942c06da039668"
];
for (const [n, oldAmount, amount, price] of [[1, 500, 1000, 199], [2, 1200, 2500, 399], [3, 3000, 5000, 699]]) {
    const sku = `seabyss_diamond_pack_${n}`;
    test(`Diamond ${n}: current amount and approved price bound into immutable plan, v1 preserved`, () => {
        const current = getXsollaProductPlan(sku);
        const old = getXsollaProductPlan(sku, 1);
        assert.equal(current.planVersion, 2);
        assert.equal(current.diamondQuantity, amount);
        assert.equal(current.unitAmountMinor, price);
        assert.equal(current.currency, "USD");
        assert.equal(getXsollaDiamondRewardQuantity(sku), amount);
        assert.equal(getXsollaDiamondRewardQuantity(sku, 1), oldAmount);
        assert.equal(old.planHash, historicalHashes[n - 1]);
        assert.notEqual(current.planHash, old.planHash);
        assert.throws(() => getXsollaDiamondRewardQuantity(sku, 99));
    });
    test(`Diamond ${n}: trusted current projection exact, deterministic, no caller economics or stale plan`, () => {
        const input = createValidatedServerEconomyPocReceiptProjectionForTests({
            playFabId: "LOCAL-DIAMOND-TEST", providerTransactionId: `93000000${n}`,
            sku, effectiveAtUnixMs: 1800000000000, productPlanVersion: 2
        });
        const projected = mapValidatedXsollaReceiptToServerEconomyPocOperation(input);
        assert.equal(projected.diamonds, amount);
        assert.deepEqual(mapValidatedXsollaReceiptToServerEconomyPocOperation(input), projected);
        for (const changes of [{ diamonds: 999999 }, { quantity: 2 }, { amountMinor: 1 },
            { currency: "EUR" }, { productPlanVersion: 1 }, { productPlanVersion: undefined },
            { productPlanHash: "0".repeat(64) }]) {
            assert.throws(() => mapValidatedXsollaReceiptToServerEconomyPocOperation({ ...input, ...changes }));
        }
        const historical = createValidatedServerEconomyPocReceiptProjectionForTests({
            playFabId: "LOCAL-DIAMOND-TEST", providerTransactionId: `94000000${n}`,
            sku, effectiveAtUnixMs: 1800000000000, productPlanVersion: 1
        });
        assert.equal(mapValidatedXsollaReceiptToServerEconomyPocOperation(historical).diamonds, oldAmount);
    });
}
for (const [n, amount, price] of [[4, 8000, 999], [5, 20000, 1899]]) {
    const sku = `seabyss_diamond_pack_${n}`;
    test(`Diamond ${n}: new current plan has approved quantity and price, no invented v1`, () => {
        const plan = getXsollaProductPlan(sku);
        assert.equal(plan.planVersion, 2);
        assert.equal(plan.diamondQuantity, amount);
        assert.equal(plan.unitAmountMinor, price);
        assert.equal(plan.currency, "USD");
        assert.equal(getXsollaDiamondRewardQuantity(sku, 2), amount);
        assert.throws(() => getXsollaProductPlan(sku, 1));
    });
    test(`Diamond ${n}: trusted projection exact and deterministic, rejects caller economics`, () => {
        const input = createValidatedServerEconomyPocReceiptProjectionForTests({
            playFabId: "LOCAL-DIAMOND-TEST", providerTransactionId: `93000000${n}`,
            sku, effectiveAtUnixMs: 1800000000000, productPlanVersion: 2
        });
        const projected = mapValidatedXsollaReceiptToServerEconomyPocOperation(input);
        assert.equal(projected.diamonds, amount);
        assert.deepEqual(mapValidatedXsollaReceiptToServerEconomyPocOperation(input), projected);
        for (const changes of [{ diamonds: 999999 }, { quantity: 2 }, { amountMinor: 1 },
            { currency: "EUR" }, { productPlanVersion: 1 }, { productPlanVersion: undefined },
            { productPlanHash: "0".repeat(64) }]) {
            assert.throws(() => mapValidatedXsollaReceiptToServerEconomyPocOperation({ ...input, ...changes }));
        }
    });
}
test("other product plans retain exact original versions and hashes", () => {
    for (const [sku, hash] of [
        ["seabyss_starter_pack_1", "d529377aa873878763998ff3fe0f192fb2e53c019afdc38a79288e92a047e2e1"],
        ["seabyss_starter_pack_2", "2a52f13f09a51dca57c15d408dd51287abdb135c8e50029d6db696a9ec58d65d"],
        ["seabyss_starter_pack_3", "8be7cca18835509218527bc8f42a63e7977d936d437b6cd9810e6951fb3a0032"],
        ["seabyss_premium_bronze", "dc11ae30b457a7dd5f4f2d2b82331017c24c22e29336deca95076723e38a6aa3"],
        ["seabyss_premium_silver", "15560a196317587fc17e8ee28cf2e4d56e19f507f3e13f244702dcecfb352794"],
        ["seabyss_premium_gold", "b1b03f6918fab74b51a6ea28e0549908899c210850e884a65412b6f6233aa6a6"]
    ]) {
        const current = getXsollaProductPlan(sku);
        assert.equal(current.planVersion, 1);
        assert.equal(current.planHash, hash);
        assert.throws(() => getXsollaDiamondRewardQuantity(sku));
    }
});
