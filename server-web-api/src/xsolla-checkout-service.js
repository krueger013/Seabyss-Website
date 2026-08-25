import { randomUUID } from "node:crypto";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

const allowedRequestFields = Object.freeze(new Set(["sku"]));

function canonicalIdentifier(value, maximumLength = 255) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

function sessionPlayFabId(session) {
    if (!session || typeof session !== "object" || Array.isArray(session) ||
        !Object.hasOwn(session, "player") || !session.player ||
        typeof session.player !== "object" || Array.isArray(session.player) ||
        !Object.hasOwn(session.player, "playFabId")) {
        return null;
    }
    return canonicalIdentifier(session.player.playFabId, 160);
}

function strictRequest(request) {
    if (!request || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).some((key) => !allowedRequestFields.has(key))) {
        return null;
    }
    const sku = canonicalIdentifier(request.sku);
    return sku ? { sku } : null;
}

function configuredSkuSet(values) {
    if (!Array.isArray(values)) {
        return new Set();
    }
    const result = new Set();
    for (const value of values) {
        const sku = canonicalIdentifier(value);
        if (!sku) {
            throw new TypeError("Checkout SKU allowlist contains an invalid value.");
        }
        getXsollaProductPlan(sku);
        result.add(sku);
    }
    return result;
}

function providerResult(value, mode) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const token = canonicalIdentifier(value.token, 8192);
    if (!token) {
        return null;
    }
    if (value.checkoutUrl !== undefined && value.checkoutUrl !== null) {
        if (typeof value.checkoutUrl !== "string" ||
            value.checkoutUrl !== value.checkoutUrl.trim() ||
            value.checkoutUrl.length > 4096) {
            return null;
        }
        try {
            const parsed = new URL(value.checkoutUrl);
            const expectedHost = mode === "sandbox"
                ? "sandbox-secure.xsolla.com"
                : "secure.xsolla.com";
            if (parsed.protocol !== "https:" || parsed.hostname !== expectedHost ||
                parsed.port !== "" || parsed.username !== "" || parsed.password !== "" ||
                parsed.hash !== "" || parsed.pathname !== "/paystation4/" ||
                parsed.searchParams.get("token") !== token ||
                [...parsed.searchParams.keys()].some((key) => key !== "token")) {
                return null;
            }
        } catch {
            return null;
        }
    }
    return Object.freeze({
        token,
        ...(value.checkoutUrl ? { checkoutUrl: value.checkoutUrl } : {})
    });
}

export class XsollaCheckoutError extends Error {
    constructor(code, message, publicStatus = 400) {
        super(message);
        this.name = "XsollaCheckoutError";
        this.code = code;
        this.publicStatus = publicStatus;
    }
}

export function createXsollaCheckoutService({
    enabled = false,
    allowSandbox = false,
    mode = "sandbox",
    allowProduction = false,
    allowedSkus = [],
    reservationStore = null,
    hasOwnedProduct = null,
    readPurchaseState = null,
    familyGates = {},
    createProviderToken = null,
    createReservationId = randomUUID,
    resolveProductPlan = getXsollaProductPlan
} = {}) {
    const globalEnabled = enabled === true;
    const sandboxEnabled = allowSandbox === true;
    const productionEnabled = allowProduction === true;
    const checkoutMode = mode === "sandbox" || mode === "production" ? mode : null;
    const skuAllowlist = configuredSkuSet(allowedSkus);
    if (!checkoutMode || typeof createReservationId !== "function" ||
        typeof resolveProductPlan !== "function") {
        throw new TypeError("Checkout service dependencies are invalid.");
    }

    const enabledFamilies = Object.freeze({
        starter_pack: familyGates?.starter_pack === true,
        diamond_pack: familyGates?.diamond_pack === true,
        premium: familyGates?.premium === true,
        doubler: familyGates?.doubler === true
    });

    return async function prepareXsollaCheckout({ session, request } = {}) {
        if (!globalEnabled) {
            throw new XsollaCheckoutError(
                "CHECKOUT_DISABLED",
                "Xsolla checkout is disabled.",
                503
            );
        }
        const playFabId = sessionPlayFabId(session);
        if (!playFabId) {
            throw new XsollaCheckoutError(
                "AUTHENTICATION_REQUIRED",
                "An authenticated server session is required.",
                401
            );
        }
        const input = strictRequest(request);
        if (!input) {
            throw new XsollaCheckoutError(
                "INVALID_CHECKOUT_REQUEST",
                "Checkout accepts only an exact SKU."
            );
        }
        if ((checkoutMode === "sandbox" && !sandboxEnabled) ||
            (checkoutMode === "production" && !productionEnabled)) {
            throw new XsollaCheckoutError(
                "CHECKOUT_MODE_DISABLED",
                "The requested checkout mode is disabled.",
                503
            );
        }
        if (!skuAllowlist.has(input.sku)) {
            throw new XsollaCheckoutError(
                "SKU_NOT_ALLOWED",
                "The requested SKU is not enabled for checkout."
            );
        }

        let plan;
        try {
            plan = resolveProductPlan(input.sku);
        } catch {
            throw new XsollaCheckoutError(
                "PRODUCT_PLAN_UNAVAILABLE",
                "The requested product plan is unavailable.",
                503
            );
        }
        if (!plan || plan.sku !== input.sku || plan.quantity !== undefined ||
            !Number.isSafeInteger(plan.unitAmountMinor) || plan.unitAmountMinor <= 0 ||
            plan.currency !== "USD" || plan.promotionPolicy?.mode !== "disabled" ||
            plan.catalogEnabled !== true || !Array.isArray(plan.allowedEnvironments) ||
            !plan.allowedEnvironments.includes(checkoutMode)) {
            throw new XsollaCheckoutError(
                "PRODUCT_PLAN_UNAVAILABLE",
                "The requested product plan is invalid.",
                503
            );
        }
        if (enabledFamilies[plan.productType] !== true) {
            throw new XsollaCheckoutError(
                "PRODUCT_FAMILY_DISABLED",
                "The requested product family is disabled.",
                503
            );
        }
        if (typeof createProviderToken !== "function") {
            throw new XsollaCheckoutError(
                "CHECKOUT_PROVIDER_UNAVAILABLE",
                "Checkout provider is unavailable.",
                503
            );
        }

        const checkoutAttemptId = canonicalIdentifier(createReservationId(), 160);
        if (!checkoutAttemptId) {
            throw new XsollaCheckoutError(
                "RESERVATION_UNAVAILABLE",
                "A checkout attempt identifier could not be created.",
                503
            );
        }
        let reservationId = null;
        if (plan.purchasePolicy === "one_time") {
            if (!reservationStore || typeof reservationStore.reserve !== "function" ||
                typeof reservationStore.release !== "function" ||
                (typeof readPurchaseState !== "function" &&
                    typeof hasOwnedProduct !== "function")) {
                throw new XsollaCheckoutError(
                    "OWNERSHIP_CHECK_UNAVAILABLE",
                    "One-time purchase checks are unavailable.",
                    503
                );
            }
            const purchaseIdentity = {
                playFabId,
                productId: plan.productId,
                xsollaSku: plan.sku
            };
            let purchaseState;
            if (typeof readPurchaseState === "function") {
                const stateResult = await readPurchaseState(purchaseIdentity);
                purchaseState = stateResult?.state;
            } else {
                const owned = await hasOwnedProduct(purchaseIdentity);
                purchaseState = owned === true
                    ? "owned"
                    : owned === false ? "available" : null;
            }
            if (purchaseState === "paid_pending") {
                throw new XsollaCheckoutError(
                    "PURCHASE_ALREADY_PENDING",
                    "This one-time product already has a paid transaction pending.",
                    409
                );
            }
            const owned = purchaseState === "owned";
            if (owned !== true && owned !== false) {
                throw new XsollaCheckoutError(
                    "OWNERSHIP_CHECK_UNAVAILABLE",
                    "One-time purchase checks are unavailable.",
                    503
                );
            }
            if (owned) {
                throw new XsollaCheckoutError(
                    "PRODUCT_ALREADY_OWNED",
                    "This one-time product is already owned.",
                    409
                );
            }
            reservationId = checkoutAttemptId;
            const reservation = await reservationStore.reserve({
                playFabId,
                xsollaSku: plan.sku,
                reservationId
            });
            if (reservation?.status === "owned") {
                throw new XsollaCheckoutError(
                    "PRODUCT_ALREADY_OWNED",
                    "This one-time product is already owned.",
                    409
                );
            }
            if (reservation?.status !== "reserved" || reservation.existing === true) {
                throw new XsollaCheckoutError(
                    "PURCHASE_ALREADY_PENDING",
                    "A checkout for this one-time product is already pending.",
                    409
                );
            }
        } else if (plan.purchasePolicy !== "repeatable") {
            throw new XsollaCheckoutError(
                "PRODUCT_PLAN_UNAVAILABLE",
                "The requested product purchase policy is invalid.",
                503
            );
        }

        const providerRequest = Object.freeze({
            identity: Object.freeze({ playFabId }),
            item: Object.freeze({ sku: plan.sku, quantity: 1 }),
            economicContract: Object.freeze({
                productPlanVersion: plan.planVersion,
                currency: plan.currency,
                unitAmountMinor: plan.unitAmountMinor,
                totalAmountMinor: plan.unitAmountMinor,
                promotionPolicy: "disabled"
            }),
            customParameters: Object.freeze({
                seabyss_checkout_id: checkoutAttemptId,
                ...(reservationId
                    ? { seabyss_reservation_id: reservationId }
                    : {}),
                seabyss_product_plan_version: String(plan.planVersion)
            })
        });

        try {
            const checkout = providerResult(await createProviderToken(providerRequest), checkoutMode);
            if (!checkout) {
                throw new Error("Checkout provider returned an invalid token response.");
            }
            return Object.freeze({
                playFabId,
                productId: plan.productId,
                xsollaSku: plan.sku,
                mode: checkoutMode,
                reservationId: reservationId || checkoutAttemptId,
                productPlanVersion: plan.planVersion,
                currency: plan.currency,
                totalAmountMinor: plan.unitAmountMinor,
                checkout
            });
        } catch (error) {
            if (reservationId) {
                try {
                    await reservationStore.release({
                        playFabId,
                        xsollaSku: plan.sku,
                        reservationId
                    });
                } catch {
                    // The pending reservation expires automatically; never hide the provider failure.
                }
            }
            throw new XsollaCheckoutError(
                "CHECKOUT_PROVIDER_UNAVAILABLE",
                "Checkout provider is unavailable.",
                503
            );
        }
    };
}
