import { createHash } from "node:crypto";

export const XSOLLA_PREMIUM_ENTITLEMENT_KEY_PREFIX = "xsp1_";
export const XSOLLA_PREMIUM_GRANT_METADATA_KEY_PREFIX = "xspm1_";

function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

function isCanonicalUtcIso8601(value) {
    if (!isNonEmptyString(value)) {
        return false;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function getXsollaPremiumEntitlementKey(transactionId) {
    if (!isNonEmptyString(transactionId) || transactionId !== transactionId.trim()) {
        throw new TypeError("Xsolla transaction ID must be a canonical non-empty string.");
    }
    return XSOLLA_PREMIUM_ENTITLEMENT_KEY_PREFIX + createHash("sha256")
        .update(transactionId, "utf8")
        .digest("base64url");
}

export function getXsollaPremiumGrantMetadataKey(transactionId) {
    if (!isNonEmptyString(transactionId) || transactionId !== transactionId.trim()) {
        throw new TypeError("Xsolla transaction ID must be a canonical non-empty string.");
    }
    return XSOLLA_PREMIUM_GRANT_METADATA_KEY_PREFIX + createHash("sha256")
        .update(transactionId, "utf8")
        .digest("base64url");
}

export function serializeXsollaPremiumEntitlement({ transactionId, activatedAtUtcIso8601, expiresAtUtcIso8601 }) {
    if (!isNonEmptyString(transactionId) || transactionId !== transactionId.trim()) {
        throw new TypeError("Xsolla transaction ID must be a canonical non-empty string.");
    }
    if (!isCanonicalUtcIso8601(activatedAtUtcIso8601) || !isCanonicalUtcIso8601(expiresAtUtcIso8601)) {
        throw new TypeError("Premium entitlement timestamps must be canonical UTC ISO-8601 strings.");
    }
    if (new Date(expiresAtUtcIso8601).getTime() <= new Date(activatedAtUtcIso8601).getTime()) {
        throw new TypeError("Premium entitlement expiration must be after activation.");
    }
    return JSON.stringify({ schemaVersion: 1, transactionId, activatedAtUtcIso8601, expiresAtUtcIso8601 });
}

export function serializeXsollaPremiumGrantMetadata({ transactionId, grantSource }) {
    if (!isNonEmptyString(transactionId) || transactionId !== transactionId.trim()) {
        throw new TypeError("Xsolla transaction ID must be a canonical non-empty string.");
    }
    if (grantSource !== "xsolla_sandbox") {
        throw new TypeError("Xsolla Premium grant metadata source is invalid.");
    }
    return JSON.stringify({ schemaVersion: 1, transactionId, grantSource });
}

export function createPlayFabPremiumEntitlementStore({
    titleId,
    secretKey,
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch
} = {}) {
    const configured = isNonEmptyString(titleId) && isNonEmptyString(secretKey) && typeof fetchImpl === "function";

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

    return async function persistXsollaPremiumEntitlement({
        playFabId,
        transactionId,
        activatedAtUtcIso8601,
        expiresAtUtcIso8601,
        grantSource = null
    }) {
        if (!configured) {
            throw new Error("PlayFab Premium entitlement persistence is not configured.");
        }
        if (!isNonEmptyString(playFabId) || playFabId !== playFabId.trim() || playFabId.length > 160) {
            throw new TypeError("A canonical Master PlayFabId is required.");
        }

        const key = getXsollaPremiumEntitlementKey(transactionId);
        const value = serializeXsollaPremiumEntitlement({
            transactionId,
            activatedAtUtcIso8601,
            expiresAtUtcIso8601
        });
        const data = { [key]: value };
        let metadataKey = null;
        let metadataValue = null;
        if (grantSource !== null && grantSource !== undefined) {
            metadataKey = getXsollaPremiumGrantMetadataKey(transactionId);
            metadataValue = serializeXsollaPremiumGrantMetadata({ transactionId, grantSource });
            data[metadataKey] = metadataValue;
        }
        await postServerApi("UpdateUserInternalData", {
            PlayFabId: playFabId,
            Data: data
        });
        const readback = await postServerApi("GetUserInternalData", {
            PlayFabId: playFabId,
            Keys: Object.keys(data)
        });
        if (
            readback?.data?.Data?.[key]?.Value !== value ||
            (metadataKey && readback?.data?.Data?.[metadataKey]?.Value !== metadataValue)
        ) {
            throw new Error("PlayFab Premium entitlement readback mismatch.");
        }
        return Object.freeze({ key, value, metadataKey, metadataValue });
    };
}
