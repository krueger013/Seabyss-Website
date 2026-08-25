import { createHash } from "node:crypto";
import { XsollaCheckoutError } from "./xsolla-checkout-service.js";

function noOp() {}

function publicError(res, status, code, message, retryAfterSeconds = null) {
    if (retryAfterSeconds !== null) {
        res.set("Retry-After", String(retryAfterSeconds));
    }
    res.status(status).json({ error: { code, message } });
}
function identifierHash(value) {
    return typeof value === "string" && value
        ? createHash("sha256").update(value, "utf8").digest("hex")
        : null;
}

function requestIp(req) {
    const value = typeof req.ip === "string"
        ? req.ip
        : req.socket?.remoteAddress;
    return typeof value === "string" ? value : null;
}

export function createXsollaCheckoutHttpHandler({
    authenticateSessionTicket,
    rateLimiter,
    prepareCheckout,
    logger = { info: noOp, warn: noOp, error: noOp }
} = {}) {
    if (typeof authenticateSessionTicket !== "function" ||
        !rateLimiter || typeof rateLimiter.consume !== "function" ||
        typeof prepareCheckout !== "function") {
        throw new TypeError("Xsolla checkout HTTP handler is not configured.");
    }

    return async function xsollaCheckoutHttpHandler(req, res) {
        const sessionTicket = req.get("x-playfab-sessionticket");
        let identity;
        try {
            identity = await authenticateSessionTicket(sessionTicket);
        } catch {
            logger.error?.({ event: "checkout_denied", reason: "authentication_unavailable" });
            publicError(res, 503, "CHECKOUT_UNAVAILABLE", "Purchases are temporarily unavailable.");
            return;
        }
        if (!identity?.playFabId) {
            logger.warn?.({ event: "checkout_denied", reason: "invalid_session" });
            publicError(res, 401, "AUTHENTICATION_REQUIRED", "A valid PlayFab session is required.");
            return;
        }

        let rate;
        try {
            rate = await rateLimiter.consume({
                playFabId: identity.playFabId,
                ip: requestIp(req)
            });
        } catch {
            logger.error?.({
                event: "checkout_denied",
                reason: "rate_limit_unavailable",
                userIdHash: identifierHash(identity.playFabId)
            });
            publicError(res, 503, "CHECKOUT_UNAVAILABLE", "Purchases are temporarily unavailable.");
            return;
        }
        if (rate?.allowed !== true) {
            const retryAfter = Number.isSafeInteger(rate?.retryAfterSeconds) &&
                rate.retryAfterSeconds > 0 ? rate.retryAfterSeconds : 60;
            logger.warn?.({
                event: "checkout_denied",
                reason: "rate_limited",
                userIdHash: identifierHash(identity.playFabId),
                rateLimitScope: rate?.reason || "unknown"
            });
            publicError(res, 429, "CHECKOUT_RATE_LIMITED", "Too many checkout attempts.", retryAfter);
            return;
        }

        try {
            const result = await prepareCheckout({
                session: { player: { playFabId: identity.playFabId } },
                request: req.body
            });
            const checkoutUrl = result?.checkout?.checkoutUrl;
            const reservationId = result?.reservationId;
            if (typeof checkoutUrl !== "string" || !checkoutUrl ||
                typeof reservationId !== "string" || !reservationId) {
                throw new Error("Checkout service returned an incomplete result.");
            }
            logger.info?.({
                event: "checkout_created",
                userIdHash: identifierHash(identity.playFabId),
                sku: result.xsollaSku,
                mode: result.mode,
                reservationIdHash: identifierHash(reservationId)
            });
            res.status(201).json({ checkoutUrl, reservationId });
        } catch (error) {
            if (error instanceof XsollaCheckoutError) {
                logger.warn?.({
                    event: "checkout_denied",
                    reason: error.code,
                    userIdHash: identifierHash(identity.playFabId)
                });
                publicError(
                    res,
                    error.publicStatus,
                    error.code,
                    error.publicStatus === 401
                        ? "A valid PlayFab session is required."
                        : error.publicStatus === 409
                            ? "This product is already owned or pending."
                            : error.publicStatus === 429
                                ? "Too many checkout attempts."
                                : "Purchases are temporarily unavailable."
                );
                return;
            }
            logger.error?.({
                event: "checkout_denied",
                reason: "internal_error",
                userIdHash: identifierHash(identity.playFabId)
            });
            publicError(res, 503, "CHECKOUT_UNAVAILABLE", "Purchases are temporarily unavailable.");
        }
    };
}
