import { createHash } from "node:crypto";
import { XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID } from "./xsolla-diamond-packs.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

export const XSOLLA_DIAMOND_RECEIPT_KEY_PREFIX = "xsd1_";
export const XSOLLA_DIAMOND_RECEIPT_SCHEMA_VERSION = 1;
const maximumInt64 = 9223372036854775807n;

function isCanonicalString(value, maximumLength = 160) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= maximumLength &&
        value === value.trim();
}

function isCanonicalTransactionId(value) {
    if (!isCanonicalString(value) || !/^[1-9][0-9]*$/.test(value)) {
        return false;
    }
    try {
        return BigInt(value) <= maximumInt64;
    } catch {
        return false;
    }
}

export function getXsollaDiamondReceiptKey(transactionId) {
    if (!isCanonicalTransactionId(transactionId)) {
        throw new TypeError("Xsolla transaction ID must be a canonical positive integer string.");
    }
    return XSOLLA_DIAMOND_RECEIPT_KEY_PREFIX + createHash("sha256")
        .update(transactionId, "utf8")
        .digest("base64url");
}

export function serializeXsollaDiamondReceipt({
    transactionId,
    productId,
    xsollaSku,
    productType,
    source,
    productPlanVersion
} = {}) {
    getXsollaDiamondReceiptKey(transactionId);
    if (!isCanonicalString(productId) || !isCanonicalString(xsollaSku, 255)) {
        throw new TypeError("Xsolla Diamond receipt identifiers are invalid.");
    }
    if (!Object.hasOwn(XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID, xsollaSku) ||
        XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID[xsollaSku] !== productId) {
        throw new TypeError("Xsolla Diamond receipt mapping is invalid.");
    }
    if (productType !== "diamond_pack") {
        throw new TypeError("Xsolla Diamond receipt product type is invalid.");
    }
    if (source !== "xsolla_sandbox" && source !== "xsolla_production") {
        throw new TypeError("Xsolla Diamond receipt source is invalid.");
    }
    // Unversioned historical xsd1 remains byte-compatible. New receipts carry
    // the immutable plan version; old clients reject rather than misgrant it.
    if (productPlanVersion !== undefined && productPlanVersion !== 1 &&
        (!Number.isSafeInteger(productPlanVersion) ||
         getXsollaProductPlan(xsollaSku, productPlanVersion).productType !== "diamond_pack")) {
        throw new TypeError("Invalid Diamond receipt plan version.");
    }
    if ((productPlanVersion === undefined || productPlanVersion === 1) &&
        !["diamond_pack_1", "diamond_pack_2", "diamond_pack_3"].includes(productId)) {
        throw new TypeError("New Diamond pack requires an explicit current plan version.");
    }
    return JSON.stringify({
        schemaVersion: XSOLLA_DIAMOND_RECEIPT_SCHEMA_VERSION,
        transactionId,
        productId,
        xsollaSku,
        productType,
        source,
        ...(productPlanVersion > 1 ? { productPlanVersion } : {})
    });
}

export function createPlayFabXsollaDiamondReceiptStore({
    titleId,
    secretKey,
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch
} = {}) {
    const configured = isCanonicalString(titleId) &&
        isCanonicalString(secretKey, 4096) &&
        typeof fetchImpl === "function";

    async function postServerApi(endpoint, body) {
        const response = await fetchImpl(`https://${titleId}.playfabapi.com/Server/${endpoint}`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                "Content-Type": "application/json",
                "X-SecretKey": secretKey
            },
            body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200) {
            throw new Error(`PlayFab ${endpoint} failed.`);
        }
        return payload;
    }

    return async function persistXsollaDiamondReceipt(receipt) {
        if (!configured) {
            throw new Error("PlayFab Xsolla Diamond receipt persistence is not configured.");
        }
        if (!isCanonicalString(receipt?.playFabId)) {
            throw new TypeError("A canonical Master PlayFabId is required.");
        }

        const key = getXsollaDiamondReceiptKey(receipt.transactionId);
        const value = serializeXsollaDiamondReceipt({ ...receipt,
            productPlanVersion: receipt.productPlanVersion ?? getXsollaProductPlan(receipt.xsollaSku).planVersion });
        const before = await postServerApi("GetUserInternalData", {
            PlayFabId: receipt.playFabId, Keys: [key]
        });
        const existing = before?.data?.Data?.[key]?.Value;
        if (existing !== undefined) {
            let prior;
            try { prior = JSON.parse(existing); } catch { throw new Error("Invalid historical Diamond receipt."); }
            const identityMatches = ["transactionId", "productId", "xsollaSku", "productType", "source"]
                .every((field) => prior[field] === receipt[field]);
            if (!identityMatches || serializeXsollaDiamondReceipt(prior) !== existing ||
                (receipt.productPlanVersion !== undefined &&
                 (prior.productPlanVersion ?? 1) !== receipt.productPlanVersion)) {
                throw new Error("Immutable Xsolla Diamond receipt conflict.");
            }
            return Object.freeze({ key, value: existing, existing: true });
        }
        await postServerApi("UpdateUserInternalData", {
            PlayFabId: receipt.playFabId,
            Data: { [key]: value }
        });
        const readback = await postServerApi("GetUserInternalData", {
            PlayFabId: receipt.playFabId,
            Keys: [key]
        });
        if (readback?.data?.Data?.[key]?.Value !== value) {
            throw new Error("PlayFab Xsolla Diamond receipt readback mismatch.");
        }
        return Object.freeze({ key, value });
    };
}
