function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function receiptId(value) {
    const key = canonical(value, "receiptId", 255);
    if (!key.startsWith("xss2_") && !key.startsWith("xsd2_")) {
        throw new TypeError("Only immutable xss2_/xsd2_ receipt keys may be read.");
    }
    return key;
}

export function createPlayFabXsollaV2ReceiptReader({
    titleId,
    secretKey,
    timeoutMilliseconds = 8_000,
    fetchImpl = globalThis.fetch
} = {}) {
    const title = canonical(titleId, "titleId", 64);
    const secret = canonical(secretKey, "secretKey", 4096);
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0 ||
        typeof fetchImpl !== "function") {
        throw new TypeError("PlayFab Xsolla v2 receipt reader is not configured.");
    }
    const endpoint = `https://${title}.playfabapi.com/Server/GetUserInternalData`;

    return async function loadXsollaV2Receipt({ playFabId, receiptId: rawReceiptId } = {}) {
        const player = canonical(playFabId, "playFabId", 160);
        const key = receiptId(rawReceiptId);
        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(timeoutMilliseconds),
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secret
                },
                body: JSON.stringify({ PlayFabId: player, Keys: [key] })
            });
        } catch (error) {
            if (error?.name === "TimeoutError" || error?.name === "AbortError") {
                error.code = "PLAYFAB_TIMEOUT";
                error.retryable = true;
            }
            throw error;
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200) {
            const error = new Error("PlayFab immutable receipt read failed.");
            error.code = payload?.error || payload?.errorCode || `HTTP_${response.status}`;
            error.status = response.status;
            error.retryable = response.status === 429 || response.status >= 500;
            const retryAfter = response.headers?.get?.("retry-after");
            if (typeof retryAfter === "string" && /^\d+$/u.test(retryAfter)) {
                error.retryAfterMilliseconds = Number(retryAfter) * 1000;
            }
            throw error;
        }
        const data = payload?.data?.Data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("PlayFab immutable receipt response is malformed.");
        }
        const entry = data[key];
        if (entry === undefined) return null;
        if (!entry || typeof entry.Value !== "string" || entry.Value.length === 0) {
            throw new Error("PlayFab immutable receipt value is malformed.");
        }
        return Object.freeze({ key, value: entry.Value });
    };
}
