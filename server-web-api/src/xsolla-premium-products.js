export const XSOLLA_STANDALONE_PREMIUM_DURATION_DAYS = 30;
export const XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER = Object.freeze({
    seabyss_premium_bronze: "bronze",
    seabyss_premium_silver: "silver",
    seabyss_premium_gold: "gold"
});

function asStrictSku(value) {
    if (typeof value !== "string" || !value || value !== value.trim() || value.length > 255) {
        return null;
    }
    return value;
}

function hasExactPackageQuantity(item) {
    return !Object.prototype.hasOwnProperty.call(item || {}, "quantity") ||
        item.quantity === 1;
}

export function resolveXsollaPremiumProduct(payload, notificationType) {
    if (notificationType !== "payment") {
        return null;
    }

    const lineitems = payload?.purchase?.order?.lineitems;
    if (!Array.isArray(lineitems) || lineitems.length !== 1) {
        return null;
    }

    const item = lineitems[0];
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Object.prototype.hasOwnProperty.call(item, "sku") ||
        !hasExactPackageQuantity(item)) {
        return null;
    }

    const xsollaSku = asStrictSku(item.sku);
    if (!xsollaSku || !Object.hasOwn(XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER, xsollaSku)) {
        return null;
    }

    return Object.freeze({
        productId: "premium",
        xsollaSku,
        productType: "premium",
        premiumTier: XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER[xsollaSku]
    });
}

export function resolveXsollaStandalonePremiumPeriod(now = () => new Date()) {
    const activatedAtUtc = now();
    if (!(activatedAtUtc instanceof Date) || !Number.isFinite(activatedAtUtc.getTime())) {
        throw new Error("Standalone Premium processor server clock is unavailable.");
    }

    const expiresAtUtc = new Date(activatedAtUtc.getTime());
    expiresAtUtc.setUTCDate(
        expiresAtUtc.getUTCDate() + XSOLLA_STANDALONE_PREMIUM_DURATION_DAYS
    );
    return Object.freeze({
        activatedAtUtc: activatedAtUtc.toISOString(),
        expiresAtUtc: expiresAtUtc.toISOString()
    });
}
