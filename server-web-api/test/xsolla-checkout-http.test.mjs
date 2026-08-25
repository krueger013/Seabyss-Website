import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createXsollaCheckoutHttpHandler } from "../src/xsolla-checkout-http.js";
import { XsollaCheckoutError } from "../src/xsolla-checkout-service.js";

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; }
    };
}

function request({ ticket = "ticket", ip = "127.0.0.1", body = { sku: "sku" } } = {}) {
    return {
        body,
        ip,
        socket: { remoteAddress: ip },
        get(name) { return name.toLowerCase() === "x-playfab-sessionticket" ? ticket : undefined; }
    };
}

function handler(overrides = {}) {
    return createXsollaCheckoutHttpHandler({
        authenticateSessionTicket: async () => ({ playFabId: "ABC123" }),
        rateLimiter: { consume: async () => ({ allowed: true }) },
        prepareCheckout: async ({ session, request: intent }) => ({
            xsollaSku: intent.sku,
            mode: "sandbox",
            reservationId: "reservation-1",
            checkout: { checkoutUrl: "https://sandbox-secure.xsolla.com/paystation4/?token=safe" },
            session
        }),
        logger: { info() {}, warn() {}, error() {} },
        ...overrides
    });
}

describe("Xsolla checkout HTTP boundary", () => {
    test("derives identity from the ticket and returns only URL plus attempt id", async () => {
        let observed;
        const execute = handler({
            prepareCheckout: async (input) => {
                observed = input;
                return {
                    xsollaSku: input.request.sku,
                    mode: "sandbox",
                    reservationId: "attempt-1",
                    checkout: { checkoutUrl: "https://sandbox-secure.xsolla.com/paystation4/?token=safe" }
                };
            }
        });
        const res = responseRecorder();
        await execute(request({ body: { sku: "seabyss_starter_pack_1" } }), res);
        assert.equal(res.statusCode, 201);
        assert.deepEqual(res.body, {
            checkoutUrl: "https://sandbox-secure.xsolla.com/paystation4/?token=safe",
            reservationId: "attempt-1"
        });
        assert.deepEqual(observed, {
            session: { player: { playFabId: "ABC123" } },
            request: { sku: "seabyss_starter_pack_1" }
        });
        assert.equal(JSON.stringify(res.body).includes("ABC123"), false);
        assert.equal(JSON.stringify(res.body).includes("token\":\"safe"), false);
    });

    test("rejects a missing or invalid PlayFab ticket before checkout", async () => {
        let called = false;
        const execute = handler({
            authenticateSessionTicket: async () => null,
            prepareCheckout: async () => { called = true; }
        });
        const res = responseRecorder();
        await execute(request({ ticket: undefined }), res);
        assert.equal(res.statusCode, 401);
        assert.equal(called, false);
    });

    test("fails closed when PlayFab authentication is unavailable", async () => {
        const execute = handler({
            authenticateSessionTicket: async () => { throw new Error("secret upstream detail"); }
        });
        const res = responseRecorder();
        await execute(request(), res);
        assert.equal(res.statusCode, 503);
        assert.equal(JSON.stringify(res.body).includes("secret"), false);
    });

    test("rate limits by authenticated identity and IP before preparing checkout", async () => {
        let identity;
        let called = false;
        const execute = handler({
            rateLimiter: {
                consume: async (value) => {
                    identity = value;
                    return { allowed: false, reason: "user", retryAfterSeconds: 17 };
                }
            },
            prepareCheckout: async () => { called = true; }
        });
        const res = responseRecorder();
        await execute(request({ ip: "192.0.2.8" }), res);
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers["Retry-After"], "17");
        assert.deepEqual(identity, { playFabId: "ABC123", ip: "192.0.2.8" });
        assert.equal(called, false);
    });

    test("maps ownership and gate denials to sanitized responses", async () => {
        for (const error of [
            new XsollaCheckoutError("PRODUCT_ALREADY_OWNED", "private", 409),
            new XsollaCheckoutError("CHECKOUT_DISABLED", "private", 503)
        ]) {
            const execute = handler({ prepareCheckout: async () => { throw error; } });
            const res = responseRecorder();
            await execute(request(), res);
            assert.equal(res.statusCode, error.publicStatus);
            assert.equal(JSON.stringify(res.body).includes("private"), false);
        }
    });

    test("never exposes unexpected provider failures", async () => {
        const execute = handler({
            prepareCheckout: async () => { throw new Error("api-key-and-ticket"); }
        });
        const res = responseRecorder();
        await execute(request(), res);
        assert.equal(res.statusCode, 503);
        assert.equal(JSON.stringify(res.body).includes("api-key"), false);
    });
});
