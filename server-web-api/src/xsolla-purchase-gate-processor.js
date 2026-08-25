import { resolveXsollaDiamondPack } from "./xsolla-diamond-packs.js";
import { resolveXsollaPremiumProduct } from "./xsolla-premium-products.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";
import { resolveXsollaStarterPack } from "./xsolla-starter-packs.js";

const reversalNotifications = new Set([
    "refund",
    "partial_refund",
    "order_canceled",
    "dispute"
]);

function configuredSkuSet(values) {
    if (!Array.isArray(values)) throw new TypeError("Payment SKU allowlist is invalid.");
    const result = new Set();
    for (const value of values) {
        if (typeof value !== "string" || !/^[a-z0-9_]{1,255}$/u.test(value)) {
            throw new TypeError("Payment SKU allowlist contains an invalid value.");
        }
        getXsollaProductPlan(value);
        result.add(value);
    }
    return result;
}

function resolveKnownProduct(payload, notificationType) {
    const candidates = [
        resolveXsollaStarterPack(payload, notificationType),
        resolveXsollaDiamondPack(payload, notificationType),
        resolveXsollaPremiumProduct(payload, notificationType)
    ].filter(Boolean);
    if (candidates.length > 1) {
        throw new XsollaPurchaseGateError(
            "AMBIGUOUS_PRODUCT",
            "The paid event maps to multiple products."
        );
    }
    return candidates[0] || null;
}

export class XsollaPurchaseGateError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "XsollaPurchaseGateError";
        this.code = code;
    }
}

export function createXsollaPurchaseGateProcessor({
    globalEnabled = false,
    familyGates = {},
    allowedSkus = [],
    hardenedEnabled = false,
    hardenedProcessor = null,
    legacyProcessor = null,
    reversalProcessor = null,
    resolveProductPlan = getXsollaProductPlan
} = {}) {
    const allowed = configuredSkuSet(allowedSkus);
    const families = Object.freeze({
        starter_pack: familyGates?.starter_pack === true,
        diamond_pack: familyGates?.diamond_pack === true,
        premium: familyGates?.premium === true,
        doubler: familyGates?.doubler === true
    });
    if (typeof resolveProductPlan !== "function") {
        throw new TypeError("Payment product-plan resolver is invalid.");
    }

    return async function processGatedXsollaEvent(event = {}) {
        const notificationType = event.notificationType;
        if (reversalNotifications.has(notificationType)) {
            if (typeof reversalProcessor !== "function") {
                throw new XsollaPurchaseGateError(
                    "REVERSAL_PROCESSOR_UNAVAILABLE",
                    "Financial reversal processing is unavailable."
                );
            }
            return reversalProcessor(event);
        }
        if (notificationType !== "payment" && notificationType !== "order_paid") {
            return typeof legacyProcessor === "function"
                ? legacyProcessor(event)
                : "validated_no_grant";
        }
        if (globalEnabled !== true) {
            throw new XsollaPurchaseGateError(
                "PURCHASES_GLOBAL_DISABLED",
                "Payment fulfillment is globally disabled."
            );
        }

        const product = resolveKnownProduct(event.payload, notificationType);
        if (!product) {
            if (hardenedEnabled) {
                throw new XsollaPurchaseGateError(
                    "UNRECOGNIZED_PAID_PRODUCT",
                    "The paid product is not in the hardened catalog."
                );
            }
            if (typeof legacyProcessor !== "function") {
                throw new XsollaPurchaseGateError(
                    "LEGACY_PROCESSOR_UNAVAILABLE",
                    "Legacy payment processing is unavailable."
                );
            }
            return legacyProcessor(event);
        }
        if (families[product.productType] !== true) {
            throw new XsollaPurchaseGateError(
                "PRODUCT_FAMILY_DISABLED",
                "The paid product family is disabled."
            );
        }
        if (!allowed.has(product.xsollaSku)) {
            throw new XsollaPurchaseGateError(
                "PRODUCT_DISABLED",
                "The paid SKU is not enabled."
            );
        }

        let plan;
        try {
            plan = resolveProductPlan(product.xsollaSku);
        } catch {
            throw new XsollaPurchaseGateError(
                "PRODUCT_PLAN_UNAVAILABLE",
                "The paid product plan is unavailable."
            );
        }
        if (!plan || plan.sku !== product.xsollaSku || plan.catalogEnabled === false) {
            throw new XsollaPurchaseGateError(
                "PRODUCT_DISABLED",
                "The paid product is disabled in the versioned catalog."
            );
        }
        const processor = hardenedEnabled ? hardenedProcessor : legacyProcessor;
        if (typeof processor !== "function") {
            throw new XsollaPurchaseGateError(
                "PAYMENT_PROCESSOR_UNAVAILABLE",
                "Payment processing is unavailable."
            );
        }
        return processor(event);
    };
}
