import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    buildXsollaCheckoutUrl,
    createXsollaAdminPaymentTokenProvider,
    XsollaPaymentTokenProviderError
} from "../src/xsolla-admin-payment-token-provider.js";

const playFabId = "46789223F9CB1BB9";
const sku = "seabyss_starter_pack_1";

function providerRequest(overrides = {}) {
    return {
        identity: { playFabId },
        item: { sku, quantity: 1 },
        economicContract: {
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        },
        customParameters: {
            seabyss_product_plan_version: "1",
            seabyss_reservation_id: "reservation-local-1"
        },
        ...overrides
    };
}

function successResponse(token = "token.local_123", orderId = 706956443) {
    return new Response(JSON.stringify({ token, order_id: orderId }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
    });
}

describe("Xsolla admin payment-token provider", () => {
    test("authors exact sandbox project, identity, SKU, quantity and currency server-side", async () => {
        const calls = [];
        const apiKey = "temporary-api-key-local";
        const createToken = createXsollaAdminPaymentTokenProvider({
            projectId: "310966",
            apiKey,
            mode: "sandbox",
            createExternalId: () => "checkout-local-1",
            async fetchImpl(url, init) {
                calls.push({ url, init });
                return successResponse();
            }
        });

        const result = await createToken(providerRequest());
        assert.deepEqual(result, {
            token: "token.local_123",
            orderId: "706956443",
            externalId: "checkout-local-1",
            checkoutUrl:
                "https://sandbox-secure.xsolla.com/paystation4/?token=token.local_123"
        });
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            "https://store.xsolla.com/api/v3/project/310966/admin/payment/token"
        );
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.redirect, "error");
        assert.equal(
            calls[0].init.headers.Authorization,
            "Basic " + Buffer.from(`310966:${apiKey}`, "utf8").toString("base64")
        );
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            user: { id: { value: playFabId } },
            purchase: { items: [{ sku, quantity: 1 }] },
            settings: {
                currency: "USD",
                external_id: "checkout-local-1",
                sandbox: true
            },
            custom_parameters: {
                seabyss_product_plan_version: "1",
                seabyss_reservation_id: "reservation-local-1"
            }
        });
    });

    test("uses only the exact production Pay Station host when server mode is production", async () => {
        const createToken = createXsollaAdminPaymentTokenProvider({
            projectId: 310966,
            apiKey: "temporary-api-key-local",
            mode: "production",
            createExternalId: () => "checkout-local-2",
            async fetchImpl(_url, init) {
                assert.equal(JSON.parse(init.body).settings.sandbox, false);
                return successResponse("production-token", "706956444");
            }
        });
        const result = await createToken(providerRequest());
        assert.equal(
            result.checkoutUrl,
            "https://secure.xsolla.com/paystation4/?token=production-token"
        );
        assert.equal(new URL(result.checkoutUrl).hostname, "secure.xsolla.com");
        assert.equal(
            buildXsollaCheckoutUrl("sandbox", "sandbox-token"),
            "https://sandbox-secure.xsolla.com/paystation4/?token=sandbox-token"
        );
    });

    test("rejects client-authored mode, identity, price, quantity and custom fields before network", async () => {
        let calls = 0;
        const createToken = createXsollaAdminPaymentTokenProvider({
            projectId: "310966",
            apiKey: "temporary-api-key-local",
            mode: "sandbox",
            async fetchImpl() { calls += 1; }
        });
        const cases = [
            { ...providerRequest(), mode: "production" },
            providerRequest({ identity: { playFabId, claimedPlayFabId: "ATTACKER" } }),
            providerRequest({ item: { sku, quantity: 2 } }),
            providerRequest({
                economicContract: {
                    ...providerRequest().economicContract,
                    currency: "EUR"
                }
            }),
            providerRequest({
                economicContract: {
                    ...providerRequest().economicContract,
                    totalAmountMinor: 1
                }
            }),
            providerRequest({ customParameters: { redirect_url: "https://evil.example" } }),
            { ...providerRequest(), externalId: "client-order" }
        ];
        for (const request of cases) {
            await assert.rejects(createToken(request), TypeError);
        }
        assert.equal(calls, 0);
    });

    test("fails closed with sanitized errors on configuration, upstream and oversized responses", async () => {
        const apiKey = "temporary-api-key-must-not-leak";
        const unconfigured = createXsollaAdminPaymentTokenProvider();
        await assert.rejects(unconfigured(providerRequest()), XsollaPaymentTokenProviderError);

        const cases = [
            async () => { throw new Error(`provider leaked ${apiKey}`); },
            async () => new Response(JSON.stringify({ error: apiKey }), { status: 401 }),
            async () => new Response("x".repeat(2048), { status: 201 }),
            async () => new Response(JSON.stringify({ token: "only-token" }), { status: 201 })
        ];
        for (const fetchImpl of cases) {
            const createToken = createXsollaAdminPaymentTokenProvider({
                projectId: "310966",
                apiKey,
                mode: "sandbox",
                maximumResponseBytes: 1024,
                createExternalId: () => "checkout-local-3",
                fetchImpl
            });
            await assert.rejects(
                createToken(providerRequest()),
                (error) => error instanceof XsollaPaymentTokenProviderError &&
                    error.code === "XSOLLA_PAYMENT_TOKEN_UNAVAILABLE" &&
                    !error.message.includes(apiKey)
            );
        }
    });

    test("rejects malformed configured modes and checkout tokens", async () => {
        const badMode = createXsollaAdminPaymentTokenProvider({
            projectId: "310966",
            apiKey: "temporary-api-key-local",
            mode: "client-selected"
        });
        await assert.rejects(badMode(providerRequest()), XsollaPaymentTokenProviderError);
        assert.throws(() => buildXsollaCheckoutUrl("sandbox", " token"), TypeError);
        assert.throws(() => buildXsollaCheckoutUrl("other", "token"), TypeError);
    });
});
