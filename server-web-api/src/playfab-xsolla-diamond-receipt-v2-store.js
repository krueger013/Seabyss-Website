import { createHash } from "node:crypto";
import {
    getXsollaDiamondReceiptKey,
    serializeXsollaDiamondReceipt
} from "./playfab-xsolla-diamond-receipt-store.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

export const XSOLLA_DIAMOND_RECEIPT_V2_KEY_PREFIX = "xsd2_";
export const XSOLLA_DIAMOND_RECEIPT_V2_SCHEMA_VERSION = 2;

function canonicalString(value, maximumLength = 160) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim()
        ? value
        : null;
}

function canonicalTransactionId(value) {
    const normalized = canonicalString(value);
    if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) return null;
    try {
        return BigInt(normalized) <= 9223372036854775807n ? normalized : null;
    } catch {
        return null;
    }
}

function canonicalOrderId(value) {
    return value === null ? null : canonicalTransactionId(value);
}

function canonicalUtcTimestamp(value) {
    if (!canonicalString(value, 64) || !value.endsWith("Z")) return null;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return null;
    try {
        return new Date(milliseconds).toISOString() === value ? value : null;
    } catch {
        return null;
    }
}

export function getXsollaDiamondReceiptV2Key(transactionId) {
    const transaction = canonicalTransactionId(transactionId);
    if (!transaction) {
        throw new TypeError("Xsolla transaction ID must be a canonical positive int64.");
    }
    return XSOLLA_DIAMOND_RECEIPT_V2_KEY_PREFIX + createHash("sha256")
        .update(transaction, "utf8")
        .digest("base64url");
}

export function serializeXsollaDiamondReceiptV2(receipt = {}) {
    const {
        transactionId,
        provider,
        providerTransactionId,
        userId,
        createdAtUtc,
        environment,
        notificationType,
        orderId = null,
        productId,
        xsollaSku,
        productType,
        source,
        productPlanVersion,
        currency,
        unitAmountMinor,
        quantity,
        totalAmountMinor,
        promotionPolicy
    } = receipt;
    getXsollaDiamondReceiptV2Key(transactionId);
    serializeXsollaDiamondReceipt(receipt);
    const normalizedOrderId = canonicalOrderId(orderId);
    const expectedEnvironment = source === "xsolla_sandbox" ? "sandbox" :
        source === "xsolla_production" ? "production" : null;
    if (provider !== "xsolla" || providerTransactionId !== transactionId ||
        userId !== receipt.playFabId || !canonicalString(userId) ||
        !canonicalUtcTimestamp(createdAtUtc) || environment !== expectedEnvironment ||
        (notificationType !== "payment" && notificationType !== "order_paid") ||
        (orderId !== null && !normalizedOrderId) ||
        (notificationType === "order_paid" && !normalizedOrderId)) {
        throw new TypeError("Xsolla Diamond v2 provider identity is invalid.");
    }
    let productPlan;
    try {
        productPlan = getXsollaProductPlan(xsollaSku, productPlanVersion);
    } catch {
        throw new TypeError("Xsolla Diamond v2 plan version is invalid.");
    }
    if (productPlan.productId !== productId || productPlan.productType !== productType ||
        productPlan.purchasePolicy !== "repeatable" ||
        currency !== productPlan.currency ||
        unitAmountMinor !== productPlan.unitAmountMinor || quantity !== 1 ||
        totalAmountMinor !== productPlan.unitAmountMinor || promotionPolicy !== "disabled") {
        throw new TypeError("Xsolla Diamond v2 immutable contract is invalid.");
    }
    return JSON.stringify({
        schemaVersion: XSOLLA_DIAMOND_RECEIPT_V2_SCHEMA_VERSION,
        transactionId,
        notificationType,
        orderId: normalizedOrderId,
        provider,
        providerTransactionId,
        userId,
        createdAtUtc,
        environment,
        productId,
        xsollaSku,
        productType,
        source,
        productPlanVersion,
        currency,
        unitAmountMinor,
        quantity,
        totalAmountMinor,
        promotionPolicy
    });
}

export function createPlayFabXsollaDiamondReceiptV2Store({
    titleId,
    secretKey,
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch
} = {}) {
    const configured = canonicalString(titleId) && canonicalString(secretKey, 4096) &&
        Number.isInteger(timeoutMs) && timeoutMs > 0 && typeof fetchImpl === "function";

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

    async function read(playFabId, keys) {
        const response = await postServerApi("GetUserInternalData", {
            PlayFabId: playFabId,
            Keys: keys
        });
        const result = new Map();
        for (const key of keys) {
            const entry = response?.data?.Data?.[key];
            if (entry === undefined) result.set(key, null);
            else if (entry && typeof entry.Value === "string") result.set(key, entry.Value);
            else throw new Error("PlayFab Xsolla Diamond receipt readback is malformed.");
        }
        return result;
    }

    return async function persistXsollaDiamondReceiptV2(receipt) {
        if (!configured) {
            throw new Error("PlayFab Xsolla Diamond v2 persistence is not configured.");
        }
        if (!canonicalString(receipt?.playFabId)) {
            throw new TypeError("A canonical legacy PlayFabId is required.");
        }
        const key = getXsollaDiamondReceiptV2Key(receipt.transactionId);
        const value = serializeXsollaDiamondReceiptV2(receipt);
        const legacyKey = getXsollaDiamondReceiptKey(receipt.transactionId);
        const legacyValue = serializeXsollaDiamondReceipt(receipt);
        const keys = [key, legacyKey];
        const existing = await read(receipt.playFabId, keys);
        if (existing.get(key) !== null && existing.get(key) !== value) {
            throw new Error("Immutable Xsolla Diamond v2 receipt conflict.");
        }
        if (existing.get(legacyKey) !== null && existing.get(legacyKey) !== legacyValue) {
            throw new Error("Immutable Xsolla Diamond legacy receipt conflict.");
        }
        const data = {};
        if (existing.get(key) === null) data[key] = value;
        if (existing.get(legacyKey) === null) data[legacyKey] = legacyValue;
        if (Object.keys(data).length > 0) {
            await postServerApi("UpdateUserInternalData", {
                PlayFabId: receipt.playFabId,
                Data: data
            });
            const readback = await read(receipt.playFabId, keys);
            if (readback.get(key) !== value || readback.get(legacyKey) !== legacyValue) {
                throw new Error("PlayFab Xsolla Diamond v2 receipt readback mismatch.");
            }
        }
        return Object.freeze({
            key,
            value,
            legacyKey,
            legacyValue,
            existing: Object.keys(data).length === 0
        });
    };
}
