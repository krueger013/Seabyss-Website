export const XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID = Object.freeze({
    seabyss_starter_pack_1: "starter_pack_1",
    seabyss_starter_pack_2: "starter_pack_2",
    seabyss_starter_pack_3: "starter_pack_3"
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

function mappedStarterPack(item) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Object.prototype.hasOwnProperty.call(item, "sku")) {
        return null;
    }

    const xsollaSku = asStrictSku(item.sku);
    if (!xsollaSku ||
        !Object.hasOwn(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID, xsollaSku)) {
        return null;
    }

    return Object.freeze({
        productId: XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID[xsollaSku],
        xsollaSku,
        productType: "starter_pack"
    });
}

function resolveLegacyPayment(payload) {
    const lineitems = payload?.purchase?.order?.lineitems;
    if (!Array.isArray(lineitems) || lineitems.length !== 1) {
        return null;
    }

    const item = lineitems[0];
    if (!hasExactPackageQuantity(item)) {
        return null;
    }
    return mappedStarterPack(item);
}

function resolveCombinedOrder(payload) {
    if (payload?.order?.status !== "paid" ||
        payload?.order?.currency_type !== "real" ||
        payload?.billing?.notification_type !== "payment") {
        return null;
    }
    const items = payload?.items;
    if (!Array.isArray(items) || items.length !== 1) {
        return null;
    }

    const item = items[0];
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Object.prototype.hasOwnProperty.call(item, "type") ||
        item.type !== "virtual_good" ||
        !Object.prototype.hasOwnProperty.call(item, "is_pre_order") ||
        item.is_pre_order !== false ||
        !Object.prototype.hasOwnProperty.call(item, "quantity") ||
        item.quantity !== 1) {
        return null;
    }
    return mappedStarterPack(item);
}

export function resolveXsollaStarterPack(payload, notificationType) {
    if (notificationType === "payment") {
        return resolveLegacyPayment(payload);
    }
    if (notificationType === "order_paid") {
        return resolveCombinedOrder(payload);
    }
    return null;
}
