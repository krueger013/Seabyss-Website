import { createHash } from "node:crypto";
import {
    XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER,
    XSOLLA_STANDALONE_PREMIUM_DURATION_DAYS
} from "./xsolla-premium-products.js";

export const XSOLLA_PREMIUM_PRODUCT_RECEIPT_KEY_PREFIX = "xsp2_";
export const XSOLLA_PREMIUM_PRODUCT_RECEIPT_SCHEMA_VERSION = 2;
const maximumInt64 = 9223372036854775807n;
const standaloneDurationMilliseconds =
    XSOLLA_STANDALONE_PREMIUM_DURATION_DAYS * 24 * 60 * 60 * 1000;

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

function parseCanonicalUtc(value) {
    if (!isCanonicalString(value)) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
        ? parsed
        : null;
}

export function getXsollaPremiumProductReceiptKey(transactionId) {
    if (!isCanonicalTransactionId(transactionId)) {
        throw new TypeError("Xsolla transaction ID must be a canonical positive integer string.");
    }
    return XSOLLA_PREMIUM_PRODUCT_RECEIPT_KEY_PREFIX + createHash("sha256")
        .update(transactionId, "utf8")
        .digest("base64url");
}

export function serializeXsollaPremiumProductReceipt({
    transactionId,
    productId,
    xsollaSku,
    productType,
    premiumTier,
    activatedAtUtc,
    expiresAtUtc,
    source
} = {}) {
    getXsollaPremiumProductReceiptKey(transactionId);
    if (productId !== "premium" || productType !== "premium" ||
        !isCanonicalString(xsollaSku, 255) ||
        !Object.hasOwn(XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER, xsollaSku) ||
        XSOLLA_PREMIUM_PRODUCT_SKU_TO_TIER[xsollaSku] !== premiumTier) {
        throw new TypeError("Xsolla standalone Premium receipt mapping is invalid.");
    }

    const activated = parseCanonicalUtc(activatedAtUtc);
    const expires = parseCanonicalUtc(expiresAtUtc);
    if (!activated || !expires ||
        expires.getTime() - activated.getTime() !== standaloneDurationMilliseconds) {
        throw new TypeError("Standalone Premium receipt period must be exactly 30 days.");
    }
    if (source !== "xsolla_sandbox" && source !== "xsolla_production") {
        throw new TypeError("Xsolla standalone Premium receipt source is invalid.");
    }

    return JSON.stringify({
        schemaVersion: XSOLLA_PREMIUM_PRODUCT_RECEIPT_SCHEMA_VERSION,
        transactionId,
        productId,
        xsollaSku,
        productType,
        premiumTier,
        activatedAtUtc,
        expiresAtUtc,
        source
    });
}

function samePremiumIdentity(existingValue, requestedReceipt) {
    let existing;
    try {
        existing = JSON.parse(existingValue);
    } catch {
        return false;
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing) ||
        Object.keys(existing).length !== 9) {
        return false;
    }
    try {
        if (serializeXsollaPremiumProductReceipt(existing) !== existingValue) {
            return false;
        }
    } catch {
        return false;
    }
    return existing.transactionId === requestedReceipt.transactionId &&
        existing.productId === requestedReceipt.productId &&
        existing.xsollaSku === requestedReceipt.xsollaSku &&
        existing.productType === requestedReceipt.productType &&
        existing.premiumTier === requestedReceipt.premiumTier &&
        existing.source === requestedReceipt.source;
}

export function createPlayFabXsollaPremiumProductReceiptStore({
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
            throw new Error("PlayFab standalone Premium receipt readback is malformed.");
        }
        return entry.Value;
    }

    return async function persistXsollaPremiumProductReceipt(receipt) {
        if (!configured) {
            throw new Error("PlayFab standalone Premium receipt persistence is not configured.");
        }
        if (!isCanonicalString(receipt?.playFabId)) {
            throw new TypeError("A canonical Master PlayFabId is required.");
        }

        const key = getXsollaPremiumProductReceiptKey(receipt.transactionId);
        const requestedValue = serializeXsollaPremiumProductReceipt(receipt);
        const existing = await readReceipt(receipt.playFabId, key);
        if (existing !== null) {
            if (!samePremiumIdentity(existing, receipt)) {
                throw new Error("Immutable standalone Premium receipt conflict.");
            }
            return Object.freeze({ key, value: existing, existing: true });
        }

        await postServerApi("UpdateUserInternalData", {
            PlayFabId: receipt.playFabId,
            Data: { [key]: requestedValue }
        });
        if (await readReceipt(receipt.playFabId, key) !== requestedValue) {
            throw new Error("PlayFab standalone Premium receipt readback mismatch.");
        }
        return Object.freeze({ key, value: requestedValue, existing: false });
    };
}
