const MAXIMUM_MINOR_UNITS = Number.MAX_SAFE_INTEGER;

function hasOwn(container, key) {
    return Boolean(container) && Object.prototype.hasOwnProperty.call(container, key);
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function asStrictCurrency(value) {
    return typeof value === "string" && /^[A-Z]{3}$/.test(value)
        ? value
        : null;
}

export function parseXsollaMinorUnits(value) {
    if (typeof value !== "string" && typeof value !== "number") {
        return null;
    }
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
        return null;
    }

    const text = typeof value === "number" ? String(value) : value;
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(text)) {
        return null;
    }
    const [whole, fraction = ""] = text.split(".");
    try {
        const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
        if (minor > BigInt(MAXIMUM_MINOR_UNITS)) {
            return null;
        }
        return Number(minor);
    } catch {
        return null;
    }
}

function monetaryValue(container, label) {
    if (!isPlainObject(container) || !hasOwn(container, "amount") ||
        !hasOwn(container, "currency")) {
        throw new XsollaEconomicContractError(
            "MISSING_MONETARY_VALUE",
            `${label} must contain an exact amount and currency.`
        );
    }
    const amountMinor = parseXsollaMinorUnits(container.amount);
    const currency = asStrictCurrency(container.currency);
    if (amountMinor === null || !currency) {
        throw new XsollaEconomicContractError(
            "INVALID_MONETARY_VALUE",
            `${label} has a non-canonical amount or currency.`
        );
    }
    return Object.freeze({ amountMinor, currency });
}

function directMonetaryValue(container, label) {
    if (!isPlainObject(container) || !hasOwn(container, "amount") ||
        !hasOwn(container, "currency")) {
        throw new XsollaEconomicContractError(
            "MISSING_MONETARY_VALUE",
            `${label} must contain an exact amount and currency.`
        );
    }
    return monetaryValue({ amount: container.amount, currency: container.currency }, label);
}

function containsPromotion(container) {
    if (!isPlainObject(container)) {
        return false;
    }
    for (const key of [
        "promotion", "promotions", "discount", "discounts", "coupon",
        "coupon_code", "promo_code"
    ]) {
        if (!hasOwn(container, key)) {
            continue;
        }
        const value = container[key];
        if (value === null || value === undefined || value === "" ||
            (Array.isArray(value) && value.length === 0)) {
            continue;
        }
        return true;
    }
    return false;
}

function assertPromotionsDisabled(payload, item, plan) {
    if (plan?.promotionPolicy?.mode !== "disabled") {
        throw new XsollaEconomicContractError(
            "UNSUPPORTED_PROMOTION_POLICY",
            "Only an explicitly disabled promotion policy is supported."
        );
    }
    const containers = [
        payload,
        payload?.order,
        payload?.purchase,
        payload?.purchase?.order,
        payload?.purchase?.checkout,
        item,
        item?.price
    ];
    if (containers.some(containsPromotion)) {
        throw new XsollaEconomicContractError(
            "PROMOTION_NOT_ALLOWED",
            "Promotions and discounts are disabled for this product plan."
        );
    }
}

function findExactItem(items, sku) {
    if (!Array.isArray(items)) {
        throw new XsollaEconomicContractError(
            "MISSING_ITEMS",
            "The paid order has no canonical item collection."
        );
    }
    const matching = items.filter((item) =>
        isPlainObject(item) && hasOwn(item, "sku") && item.sku === sku
    );
    if (matching.length !== 1) {
        throw new XsollaEconomicContractError(
            "AMBIGUOUS_ITEM",
            "The paid order must contain exactly one matching product item."
        );
    }
    return matching[0];
}

function assertExactQuantity(item) {
    if (!hasOwn(item, "quantity") || item.quantity !== 1) {
        throw new XsollaEconomicContractError(
            "INVALID_QUANTITY",
            "The paid product quantity must be numeric one."
        );
    }
}

function assertExpectedMoney(value, plan, label) {
    if (value.currency !== plan.currency || value.amountMinor !== plan.unitAmountMinor) {
        throw new XsollaEconomicContractError(
            "PRICE_MISMATCH",
            `${label} does not match the versioned product plan.`
        );
    }
}

function asCanonicalOrderId(value) {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        return null;
    }
    try {
        return BigInt(value) <= 9223372036854775807n ? value : null;
    } catch {
        return null;
    }
}

export class XsollaEconomicContractError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "XsollaEconomicContractError";
        this.code = code;
    }
}

export function validateXsollaEconomicContract({
    payload,
    notificationType,
    product,
    productPlan
} = {}) {
    if (!isPlainObject(payload) || !isPlainObject(product) || !isPlainObject(productPlan) ||
        product.xsollaSku !== productPlan.sku ||
        product.productId !== productPlan.productId ||
        product.productType !== productPlan.productType ||
        productPlan.minorUnitScale !== 2 ||
        !Number.isSafeInteger(productPlan.unitAmountMinor) ||
        productPlan.unitAmountMinor <= 0 ||
        !asStrictCurrency(productPlan.currency)) {
        throw new XsollaEconomicContractError(
            "INVALID_PRODUCT_PLAN",
            "The versioned product plan is missing or inconsistent."
        );
    }

    let item;
    let orderMoney;
    let orderId = null;
    if (notificationType === "order_paid") {
        item = findExactItem(payload.items, product.xsollaSku);
        assertExactQuantity(item);
        orderMoney = directMonetaryValue(payload.order, "order");
        orderId = asCanonicalOrderId(payload.order?.id);
        if (!orderId) {
            throw new XsollaEconomicContractError(
                "INVALID_ORDER_ID",
                "The paid order ID is not a canonical positive int64."
            );
        }
    } else if (notificationType === "payment") {
        item = findExactItem(payload?.purchase?.order?.lineitems, product.xsollaSku);
        assertExactQuantity(item);
        orderMoney = monetaryValue(payload?.purchase?.total, "purchase total");
        if (hasOwn(payload?.purchase?.order, "id")) {
            orderId = asCanonicalOrderId(payload.purchase.order.id);
            if (!orderId) {
                throw new XsollaEconomicContractError(
                    "INVALID_ORDER_ID",
                    "The payment order ID is not a canonical positive int64."
                );
            }
        }
    } else {
        throw new XsollaEconomicContractError(
            "UNSUPPORTED_NOTIFICATION",
            "Economic validation supports payment and order_paid only."
        );
    }

    assertPromotionsDisabled(payload, item, productPlan);
    const itemMoney = monetaryValue(item.price, "product item price");
    assertExpectedMoney(orderMoney, productPlan, "Order total");
    assertExpectedMoney(itemMoney, productPlan, "Product item price");

    return Object.freeze({
        productPlanVersion: productPlan.planVersion,
        notificationType,
        orderId,
        currency: productPlan.currency,
        unitAmountMinor: productPlan.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: productPlan.unitAmountMinor,
        promotionPolicy: "disabled"
    });
}
