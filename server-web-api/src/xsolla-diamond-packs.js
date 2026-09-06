export const XSOLLA_DIAMOND_CURRENCY_SKU = "seabyss_diamonds";
export const XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID = Object.freeze({
    seabyss_diamond_pack_1: "diamond_pack_1",
    seabyss_diamond_pack_2: "diamond_pack_2",
    seabyss_diamond_pack_3: "diamond_pack_3",
    seabyss_diamond_pack_4: "diamond_pack_4",
    seabyss_diamond_pack_5: "diamond_pack_5"
});

function asStrictSku(value) {
    if (typeof value !== "string" || !value || value !== value.trim() || value.length > 255) {
        return null;
    }
    return value;
}

function mappedPack(item, requireBundleType) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
    }
    const xsollaSku = asStrictSku(item.sku);
    const productId = xsollaSku && Object.hasOwn(
        XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID,
        xsollaSku
    )
        ? XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID[xsollaSku]
        : null;
    if (!productId || (requireBundleType && item.type !== "bundle")) {
        return null;
    }
    return Object.freeze({
        productId,
        xsollaSku,
        productType: "diamond_pack"
    });
}

function resolveLegacyPayment(payload) {
    const lineitems = payload?.purchase?.order?.lineitems;
    if (!Array.isArray(lineitems) || lineitems.length !== 1) {
        return null;
    }
    return mappedPack(lineitems[0], false);
}

function isOfficialCurrencyContentItem(item) {
    return item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        asStrictSku(item.sku) === XSOLLA_DIAMOND_CURRENCY_SKU &&
        item.type === "virtual_currency";
}

function resolveCombinedOrder(payload) {
    const items = payload?.items;
    if (!Array.isArray(items) || items.length === 0) {
        return null;
    }

    let resolved = null;
    for (const item of items) {
        const pack = mappedPack(item, true);
        if (pack) {
            if (resolved) {
                return null;
            }
            resolved = pack;
            continue;
        }
        if (!isOfficialCurrencyContentItem(item)) {
            return null;
        }
    }
    return resolved;
}

export function hasXsollaDiamondItemContainer(payload, notificationType) {
    if (notificationType === "payment") {
        return Object.prototype.hasOwnProperty.call(payload?.purchase?.order || {}, "lineitems");
    }
    if (notificationType === "order_paid") {
        return Object.prototype.hasOwnProperty.call(payload || {}, "items");
    }
    return false;
}

export function resolveXsollaDiamondPack(payload, notificationType) {
    if (notificationType === "payment") {
        return resolveLegacyPayment(payload);
    }
    if (notificationType === "order_paid") {
        return resolveCombinedOrder(payload);
    }
    return null;
}
