import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createXsollaCheckoutService,
    XsollaCheckoutError
} from "../src/xsolla-checkout-service.js";
import {
    createMemoryXsollaStarterReservationStore
} from "../src/xsolla-starter-reservation-store.js";

const playFabId = "4DF88C225D91FE06";
const starterSku = "seabyss_starter_pack_1";
const diamondSku = "seabyss_diamond_pack_1";
const session = Object.freeze({ player: Object.freeze({ playFabId }) });

function expectCode(code) {
    return (error) => error instanceof XsollaCheckoutError && error.code === code;
}

describe("authenticated Xsolla checkout service", () => {
    test("is disabled by default and never calls a provider", async () => {
        let providerCalls = 0;
        const checkout = createXsollaCheckoutService({
            async createProviderToken() { providerCalls += 1; }
        });
        await assert.rejects(
            checkout({ session, request: { sku: starterSku } }),
            expectCode("CHECKOUT_DISABLED")
        );
        assert.equal(providerCalls, 0);
    });

    test("derives identity only from an authenticated server session", async () => {
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [diamondSku],
            familyGates: { diamond_pack: true },
            async createProviderToken() { return { token: "local-token" }; }
        });
        await assert.rejects(
            checkout({ request: { sku: diamondSku } }),
            expectCode("AUTHENTICATION_REQUIRED")
        );
        for (const request of [
            { sku: diamondSku, playFabId: "ATTACKER" },
            { sku: diamondSku, price: "0.01" },
            { sku: diamondSku, quantity: 2 },
            { sku: diamondSku, mode: "production" }
        ]) {
            await assert.rejects(checkout({ session, request }), expectCode(
                "INVALID_CHECKOUT_REQUEST"
            ));
        }
    });

    test("requires a server-controlled mode gate and exact SKU allowlist", async () => {
        const modeDisabled = createXsollaCheckoutService({
            enabled: true,
            allowedSkus: [diamondSku],
            familyGates: { diamond_pack: true },
            async createProviderToken() { return { token: "local-token" }; }
        });
        await assert.rejects(
            modeDisabled({ session, request: { sku: diamondSku } }),
            expectCode("CHECKOUT_MODE_DISABLED")
        );

        const skuDisabled = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [],
            familyGates: { diamond_pack: true },
            async createProviderToken() { return { token: "local-token" }; }
        });
        await assert.rejects(
            skuDisabled({ session, request: { sku: diamondSku } }),
            expectCode("SKU_NOT_ALLOWED")
        );
    });

    test("authors exact Starter identity, quantity, price and reservation server-side", async () => {
        const providerRequests = [];
        const reservationStore = createMemoryXsollaStarterReservationStore();
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [starterSku],
            reservationStore,
            familyGates: { starter_pack: true },
            async hasOwnedProduct(input) {
                assert.deepEqual(input, {
                    playFabId,
                    productId: "starter_pack_1",
                    xsollaSku: starterSku
                });
                return false;
            },
            createReservationId: () => "reservation-local-1",
            async createProviderToken(request) {
                providerRequests.push(request);
                return {
                    token: "local-token",
                    checkoutUrl: "https://sandbox-secure.xsolla.com/paystation4/?token=local-token"
                };
            }
        });

        const result = await checkout({
            session,
            request: { sku: starterSku }
        });
        assert.equal(result.playFabId, playFabId);
        assert.equal(result.reservationId, "reservation-local-1");
        assert.equal(result.totalAmountMinor, 399);
        assert.equal(result.currency, "USD");
        assert.equal(providerRequests.length, 1);
        assert.deepEqual(providerRequests[0].identity, { playFabId });
        assert.deepEqual(providerRequests[0].item, { sku: starterSku, quantity: 1 });
        assert.deepEqual(providerRequests[0].economicContract, {
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        });
        assert.deepEqual(providerRequests[0].customParameters, {
            seabyss_checkout_id: "reservation-local-1",
            seabyss_reservation_id: "reservation-local-1",
            seabyss_product_plan_version: "1"
        });
    });

    test("rejects owned Starters before reservation or provider", async () => {
        let providerCalls = 0;
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [starterSku],
            reservationStore: createMemoryXsollaStarterReservationStore(),
            familyGates: { starter_pack: true },
            async hasOwnedProduct() { return true; },
            async createProviderToken() { providerCalls += 1; }
        });
        await assert.rejects(
            checkout({ session, request: { sku: starterSku } }),
            expectCode("PRODUCT_ALREADY_OWNED")
        );
        assert.equal(providerCalls, 0);
    });

    test("admits one concurrent Starter checkout and releases on provider failure", async () => {
        const reservationStore = createMemoryXsollaStarterReservationStore();
        let providerCalls = 0;
        let failProvider = false;
        let reservationCounter = 0;
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [starterSku],
            reservationStore,
            familyGates: { starter_pack: true },
            async hasOwnedProduct() { return false; },
            createReservationId: () => `reservation-${++reservationCounter}`,
            async createProviderToken() {
                providerCalls += 1;
                if (failProvider) throw new Error("local provider failure");
                return { token: "local-token" };
            }
        });
        const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
            checkout({ session, request: { sku: starterSku } })
        ));
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected" &&
            result.reason?.code === "PURCHASE_ALREADY_PENDING").length, 7);
        assert.equal(providerCalls, 1);

        const secondStore = createMemoryXsollaStarterReservationStore();
        failProvider = true;
        const retryable = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [starterSku],
            reservationStore: secondStore,
            familyGates: { starter_pack: true },
            async hasOwnedProduct() { return false; },
            createReservationId: () => `retry-${++reservationCounter}`,
            async createProviderToken() {
                if (failProvider) throw new Error("local provider failure");
                return { token: "local-token" };
            }
        });
        await assert.rejects(
            retryable({ session, request: { sku: starterSku } }),
            expectCode("CHECKOUT_PROVIDER_UNAVAILABLE")
        );
        assert.equal(await secondStore.read({ playFabId, xsollaSku: starterSku }), null);
        failProvider = false;
        await assert.doesNotReject(
            retryable({ session, request: { sku: starterSku } })
        );
    });

    test("keeps repeatable Diamond checkout free of Starter ownership state", async () => {
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowProduction: true,
            mode: "production",
            allowedSkus: [diamondSku],
            familyGates: { diamond_pack: true },
            createReservationId: () => "diamond-attempt-1",
            async createProviderToken(request) {
                assert.deepEqual(request.customParameters, {
                    seabyss_checkout_id: "diamond-attempt-1",
                    seabyss_product_plan_version: "1"
                });
                assert.equal(Object.hasOwn(request, "mode"), false);
                return {
                    token: "local-token",
                    checkoutUrl: "https://secure.xsolla.com/paystation4/?token=local-token"
                };
            }
        });
        const result = await checkout({
            session,
            request: { sku: diamondSku }
        });
        assert.equal(result.reservationId, "diamond-attempt-1");
        assert.equal(result.totalAmountMinor, 199);
    });

    test("fails closed when the product family gate is omitted or disabled", async () => {
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [diamondSku],
            async createProviderToken() { throw new Error("must not run"); }
        });
        await assert.rejects(
            checkout({ session, request: { sku: diamondSku } }),
            expectCode("PRODUCT_FAMILY_DISABLED")
        );
    });

    test("distinguishes a paid-pending Starter before creating a reservation", async () => {
        let providerCalls = 0;
        const checkout = createXsollaCheckoutService({
            enabled: true,
            allowSandbox: true,
            allowedSkus: [starterSku],
            familyGates: { starter_pack: true },
            reservationStore: createMemoryXsollaStarterReservationStore(),
            async readPurchaseState() { return { state: "paid_pending" }; },
            async createProviderToken() { providerCalls += 1; }
        });
        await assert.rejects(
            checkout({ session, request: { sku: starterSku } }),
            expectCode("PURCHASE_ALREADY_PENDING")
        );
        assert.equal(providerCalls, 0);
    });
});
