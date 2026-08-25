import { createHash } from "node:crypto";
import { XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID } from "./xsolla-starter-packs.js";

export const XSOLLA_RECONCILIATION_CASE_KEY_PREFIX = "xsr1_";
export const XSOLLA_RECONCILIATION_CASE_SCHEMA_VERSION = 1;
const supportedReasons = Object.freeze(new Set([
    "duplicate_paid",
    "pending_conflict",
    "reservation_missing"
]));

function canonicalString(value, maximumLength = 160) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

function canonicalTransactionId(value) {
    const normalized = canonicalString(value);
    if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) {
        return null;
    }
    try {
        return BigInt(normalized) <= 9223372036854775807n ? normalized : null;
    } catch {
        return null;
    }
}

function canonicalOrderId(value) {
    return value === null ? null : canonicalTransactionId(value);
}

export function getXsollaReconciliationCaseKey(transactionId) {
    const transaction = canonicalTransactionId(transactionId);
    if (!transaction) {
        throw new TypeError("Xsolla transaction ID must be a canonical positive int64.");
    }
    return XSOLLA_RECONCILIATION_CASE_KEY_PREFIX + createHash("sha256")
        .update(transaction, "utf8")
        .digest("base64url");
}

export function serializeXsollaReconciliationCase({
    transactionId,
    orderId = null,
    productId,
    xsollaSku,
    source,
    reason,
    reservationId = null,
    productPlanVersion,
    currency,
    unitAmountMinor,
    quantity,
    totalAmountMinor,
    promotionPolicy
} = {}) {
    getXsollaReconciliationCaseKey(transactionId);
    const normalizedOrderId = canonicalOrderId(orderId);
    if (orderId !== null && !normalizedOrderId) {
        throw new TypeError("Xsolla reconciliation order ID is invalid.");
    }
    if (!canonicalString(productId) || !canonicalString(xsollaSku, 255) ||
        !Object.hasOwn(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID, xsollaSku) ||
        XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID[xsollaSku] !== productId ||
        (source !== "xsolla_sandbox" && source !== "xsolla_production") ||
        !supportedReasons.has(reason) ||
        (reservationId !== null && !canonicalString(reservationId)) ||
        !Number.isSafeInteger(productPlanVersion) || productPlanVersion <= 0 ||
        currency !== "USD" || !Number.isSafeInteger(unitAmountMinor) ||
        unitAmountMinor <= 0 || quantity !== 1 ||
        totalAmountMinor !== unitAmountMinor || promotionPolicy !== "disabled") {
        throw new TypeError("Xsolla reconciliation case contract is invalid.");
    }
    return JSON.stringify({
        schemaVersion: XSOLLA_RECONCILIATION_CASE_SCHEMA_VERSION,
        status: "open",
        transactionId,
        orderId: normalizedOrderId,
        productId,
        xsollaSku,
        source,
        reason,
        reservationId,
        productPlanVersion,
        currency,
        unitAmountMinor,
        quantity,
        totalAmountMinor,
        promotionPolicy
    });
}

export function createPlayFabXsollaReconciliationCaseStore({
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

    async function read(playFabId, key) {
        const response = await postServerApi("GetUserInternalData", {
            PlayFabId: playFabId,
            Keys: [key]
        });
        const entry = response?.data?.Data?.[key];
        if (entry === undefined) {
            return null;
        }
        if (!entry || typeof entry.Value !== "string") {
            throw new Error("PlayFab Xsolla reconciliation case is malformed.");
        }
        return entry.Value;
    }

    return async function persistXsollaReconciliationCase(record) {
        if (!configured) {
            throw new Error("PlayFab Xsolla reconciliation persistence is not configured.");
        }
        if (!canonicalString(record?.playFabId)) {
            throw new TypeError("A canonical legacy PlayFabId is required.");
        }
        const key = getXsollaReconciliationCaseKey(record.transactionId);
        const value = serializeXsollaReconciliationCase(record);
        const existing = await read(record.playFabId, key);
        if (existing !== null) {
            if (existing !== value) {
                throw new Error("Immutable Xsolla reconciliation case conflict.");
            }
            return Object.freeze({ key, value: existing, existing: true });
        }
        await postServerApi("UpdateUserInternalData", {
            PlayFabId: record.playFabId,
            Data: { [key]: value }
        });
        if (await read(record.playFabId, key) !== value) {
            throw new Error("PlayFab Xsolla reconciliation case readback mismatch.");
        }
        return Object.freeze({ key, value, existing: false });
    };
}
