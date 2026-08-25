import { createHash } from "node:crypto";
import { XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID } from "./xsolla-starter-packs.js";

export const XSOLLA_STARTER_RECEIPT_KEY_PREFIX = "xss1_";
export const XSOLLA_STARTER_RECEIPT_SCHEMA_VERSION = 1;
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

export function getXsollaStarterReceiptKey(transactionId) {
    if (!isCanonicalTransactionId(transactionId)) {
        throw new TypeError("Xsolla transaction ID must be a canonical positive integer string.");
    }
    return XSOLLA_STARTER_RECEIPT_KEY_PREFIX + createHash("sha256")
        .update(transactionId, "utf8")
        .digest("base64url");
}

export function serializeXsollaStarterReceipt({
    transactionId,
    productId,
    xsollaSku,
    productType,
    source
} = {}) {
    getXsollaStarterReceiptKey(transactionId);
    if (!isCanonicalString(productId) || !isCanonicalString(xsollaSku, 255)) {
        throw new TypeError("Xsolla Starter receipt identifiers are invalid.");
    }
    if (!Object.hasOwn(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID, xsollaSku) ||
        XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID[xsollaSku] !== productId) {
        throw new TypeError("Xsolla Starter receipt mapping is invalid.");
    }
    if (productType !== "starter_pack") {
        throw new TypeError("Xsolla Starter receipt product type is invalid.");
    }
    if (source !== "xsolla_sandbox" && source !== "xsolla_production") {
        throw new TypeError("Xsolla Starter receipt source is invalid.");
    }
    return JSON.stringify({
        schemaVersion: XSOLLA_STARTER_RECEIPT_SCHEMA_VERSION,
        transactionId,
        productId,
        xsollaSku,
        productType,
        source
    });
}

export function createPlayFabXsollaStarterReceiptStore({
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

    async function readReceipt(playFabId, key) {
        const readback = await postServerApi("GetUserInternalData", {
            PlayFabId: playFabId,
            Keys: [key]
        });
        const entry = readback?.data?.Data?.[key];
        if (entry === undefined) {
            return null;
        }
        if (!entry || typeof entry.Value !== "string") {
            throw new Error("PlayFab Xsolla Starter receipt readback is malformed.");
        }
        return entry.Value;
    }

    return async function persistXsollaStarterReceipt(receipt) {
        if (!configured) {
            throw new Error("PlayFab Xsolla Starter receipt persistence is not configured.");
        }
        if (!isCanonicalString(receipt?.playFabId)) {
            throw new TypeError("A canonical Master PlayFabId is required.");
        }

        const key = getXsollaStarterReceiptKey(receipt.transactionId);
        const value = serializeXsollaStarterReceipt(receipt);
        const existing = await readReceipt(receipt.playFabId, key);
        if (existing !== null) {
            if (existing !== value) {
                throw new Error("Immutable Xsolla Starter receipt conflict.");
            }
            return Object.freeze({ key, value: existing, existing: true });
        }

        await postServerApi("UpdateUserInternalData", {
            PlayFabId: receipt.playFabId,
            Data: { [key]: value }
        });
        if (await readReceipt(receipt.playFabId, key) !== value) {
            throw new Error("PlayFab Xsolla Starter receipt readback mismatch.");
        }
        return Object.freeze({ key, value, existing: false });
    };
}
