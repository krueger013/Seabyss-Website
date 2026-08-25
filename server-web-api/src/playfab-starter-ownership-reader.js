import {
    getXsollaStarterReceiptKey,
    serializeXsollaStarterReceipt
} from "./playfab-xsolla-starter-receipt-store.js";
import {
    getXsollaStarterReceiptV2Key,
    serializeXsollaStarterReceiptV2
} from "./playfab-xsolla-starter-receipt-v2-store.js";
import { XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID } from "./xsolla-starter-packs.js";

export const STARTER_PURCHASE_STATES = Object.freeze({
    OWNED: "owned",
    PAID_PENDING: "paid_pending",
    AVAILABLE: "available"
});

const profileKey = "profile_v1";
const durableOperation = "XsollaStarterPack";
const knownDurableStates = new Set([
    "Pending",
    "CurrencyDebited",
    "CurrencyGranted",
    "ProfileGranted",
    "CompensationRequired",
    "Completed",
    "Failed",
    "Quarantined"
]);
const xss1Fields = new Set([
    "schemaVersion",
    "transactionId",
    "productId",
    "xsollaSku",
    "productType",
    "source"
]);
const xss2Fields = new Set([
    "schemaVersion",
    "transactionId",
    "notificationType",
    "orderId",
    "provider",
    "providerTransactionId",
    "userId",
    "createdAtUtc",
    "environment",
    "productId",
    "xsollaSku",
    "productType",
    "source",
    "productPlanVersion",
    "rewardPlanVersion",
    "rewardPlanHash",
    "rewards",
    "currency",
    "unitAmountMinor",
    "quantity",
    "totalAmountMinor",
    "promotionPolicy"
]);

function canonicalString(value, maximumLength = 4096) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() &&
        !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : null;
}

function canonicalPlayFabId(value) {
    return canonicalString(value, 160) && !/\s/.test(value) ? value : null;
}

function exactObjectFields(value, expected) {
    return value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === expected.size &&
        Object.keys(value).every((key) => expected.has(key));
}

function parseStrictJson(rawValue, maximumBytes, description) {
    if (typeof rawValue !== "string" ||
        Buffer.byteLength(rawValue, "utf8") > maximumBytes) {
        throw new Error(`${description} is missing or too large.`);
    }
    try {
        const parsed = JSON.parse(rawValue);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error();
        }
        return parsed;
    } catch {
        throw new Error(`${description} is malformed.`);
    }
}

async function readBoundedJson(response, maximumBytes) {
    const contentLength = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
        throw new Error("PlayFab InternalData response is too large.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
        throw new Error("PlayFab InternalData response is too large.");
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error("PlayFab InternalData response is malformed.");
    }
}

function readDataValue(data, key) {
    const record = data[key];
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        typeof record.Value !== "string") {
        throw new Error(`PlayFab InternalData ${key} record is malformed.`);
    }
    return record.Value;
}

function validateStarterIdentity(receipt) {
    return Object.hasOwn(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID, receipt?.xsollaSku) &&
        XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID[receipt.xsollaSku] === receipt.productId &&
        receipt.productType === "starter_pack";
}

function parseXss1(key, rawValue, maximumReceiptBytes) {
    const receipt = parseStrictJson(rawValue, maximumReceiptBytes, "Starter xss1 receipt");
    if (!exactObjectFields(receipt, xss1Fields) || receipt.schemaVersion !== 1 ||
        !validateStarterIdentity(receipt)) {
        throw new Error("Starter xss1 receipt is invalid.");
    }
    try {
        serializeXsollaStarterReceipt(receipt);
        if (getXsollaStarterReceiptKey(receipt.transactionId) !== key) {
            throw new Error();
        }
    } catch {
        throw new Error("Starter xss1 receipt is invalid.");
    }
    return receipt;
}

function parseXss2(key, rawValue, maximumReceiptBytes, expectedPlayFabId) {
    const receipt = parseStrictJson(rawValue, maximumReceiptBytes, "Starter xss2 receipt");
    if (!exactObjectFields(receipt, xss2Fields) || receipt.schemaVersion !== 2 ||
        !validateStarterIdentity(receipt) || receipt.userId !== expectedPlayFabId) {
        throw new Error("Starter xss2 receipt is invalid.");
    }
    try {
        serializeXsollaStarterReceiptV2({ ...receipt, playFabId: receipt.userId });
        if (getXsollaStarterReceiptV2Key(receipt.transactionId) !== key) {
            throw new Error();
        }
    } catch {
        throw new Error("Starter xss2 receipt is invalid.");
    }
    return receipt;
}

function profileState(profile, productId, xsollaSku) {
    if (!Array.isArray(profile.durableEconomyTransactions) ||
        !Array.isArray(profile.pendingXsollaStarterPackReceipts)) {
        throw new Error("Starter ownership fields are absent from profile_v1.");
    }

    let paidPending = false;
    for (const transaction of profile.durableEconomyTransactions) {
        if (!transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
            transaction.operation !== durableOperation) {
            continue;
        }
        if (!Object.values(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID)
            .includes(transaction.operationKey) ||
            !knownDurableStates.has(transaction.state) ||
            !canonicalString(transaction.transactionId, 160)) {
            throw new Error("Starter durable transaction is malformed.");
        }
        if (transaction.operationKey !== productId) {
            continue;
        }
        if (transaction.state === "Completed") {
            return STARTER_PURCHASE_STATES.OWNED;
        }
        paidPending = true;
    }

    for (const receipt of profile.pendingXsollaStarterPackReceipts) {
        if (!exactObjectFields(receipt, xss1Fields) || receipt.schemaVersion !== 1 ||
            !validateStarterIdentity(receipt)) {
            throw new Error("Pending Starter receipt in profile_v1 is malformed.");
        }
        try {
            serializeXsollaStarterReceipt(receipt);
        } catch {
            throw new Error("Pending Starter receipt in profile_v1 is malformed.");
        }
        if (receipt.productId === productId && receipt.xsollaSku === xsollaSku) {
            paidPending = true;
        }
    }
    return paidPending
        ? STARTER_PURCHASE_STATES.PAID_PENDING
        : STARTER_PURCHASE_STATES.AVAILABLE;
}

export class PlayFabStarterOwnershipError extends Error {
    constructor(message = "Starter ownership state is unavailable.") {
        super(message);
        this.name = "PlayFabStarterOwnershipError";
        this.code = "STARTER_OWNERSHIP_UNAVAILABLE";
    }
}

/**
 * Reads the complete PlayFab InternalData snapshot because xss1/xss2 receipt
 * keys are hashed and cannot be queried by prefix. Any ambiguous or malformed
 * ownership evidence fails closed instead of making a one-time SKU available.
 */
export function createPlayFabStarterOwnershipReader({
    titleId,
    secretKey,
    timeoutMs = 8000,
    maximumResponseBytes = 2 * 1024 * 1024,
    maximumProfileBytes = 1024 * 1024,
    maximumReceiptBytes = 64 * 1024,
    maximumReceiptCount = 256,
    fetchImpl = globalThis.fetch
} = {}) {
    const configuredTitleId = canonicalString(titleId, 160);
    const configuredSecretKey = canonicalString(secretKey);
    const configured = configuredTitleId && configuredSecretKey &&
        Number.isInteger(timeoutMs) && timeoutMs > 0 &&
        Number.isInteger(maximumResponseBytes) && maximumResponseBytes >= 1024 &&
        Number.isInteger(maximumProfileBytes) && maximumProfileBytes >= 1024 &&
        Number.isInteger(maximumReceiptBytes) && maximumReceiptBytes >= 256 &&
        Number.isInteger(maximumReceiptCount) && maximumReceiptCount > 0 &&
        typeof fetchImpl === "function";

    return async function readStarterPurchaseState({ playFabId, xsollaSku } = {}) {
        const player = canonicalPlayFabId(playFabId);
        if (!player || !Object.hasOwn(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID, xsollaSku)) {
            throw new TypeError("A legacy PlayFabId and exact Starter SKU are required.");
        }
        if (!configured) {
            throw new PlayFabStarterOwnershipError();
        }

        let response;
        let payload;
        try {
            response = await fetchImpl(
                `https://${configuredTitleId}.playfabapi.com/Server/GetUserInternalData`,
                {
                    method: "POST",
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        "Content-Type": "application/json",
                        "X-SecretKey": configuredSecretKey
                    },
                    body: JSON.stringify({ PlayFabId: player })
                }
            );
            payload = await readBoundedJson(response, maximumResponseBytes);
        } catch {
            throw new PlayFabStarterOwnershipError();
        }
        if (!response.ok || payload?.code !== 200 ||
            !payload?.data?.Data || typeof payload.data.Data !== "object" ||
            Array.isArray(payload.data.Data)) {
            throw new PlayFabStarterOwnershipError();
        }

        try {
            const data = payload.data.Data;
            if (!Object.hasOwn(data, profileKey)) {
                throw new Error("profile_v1 is missing.");
            }
            const profile = parseStrictJson(
                readDataValue(data, profileKey),
                maximumProfileBytes,
                "profile_v1"
            );
            const productId = XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID[xsollaSku];
            let state = profileState(profile, productId, xsollaSku);
            let receiptCount = 0;

            for (const [key, record] of Object.entries(data)) {
                let receipt = null;
                if (key.startsWith("xss1_")) {
                    receipt = parseXss1(key, readDataValue(data, key), maximumReceiptBytes);
                } else if (key.startsWith("xss2_")) {
                    receipt = parseXss2(
                        key,
                        readDataValue(data, key),
                        maximumReceiptBytes,
                        player
                    );
                } else {
                    continue;
                }
                receiptCount += 1;
                if (receiptCount > maximumReceiptCount) {
                    throw new Error("Starter receipt collection is too large.");
                }
                if (state !== STARTER_PURCHASE_STATES.OWNED &&
                    receipt.productId === productId && receipt.xsollaSku === xsollaSku) {
                    state = STARTER_PURCHASE_STATES.PAID_PENDING;
                }
            }

            return Object.freeze({ state, playFabId: player, productId, xsollaSku });
        } catch {
            throw new PlayFabStarterOwnershipError();
        }
    };
}
