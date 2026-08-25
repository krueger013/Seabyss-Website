const accountNotFoundErrorCode = 1001;
const invalidParamsErrorCode = 1000;
const invalidUserErrors = new Set(["AccountNotFound", "InvalidParams"]);
const invalidUserErrorCodes = new Set([accountNotFoundErrorCode, invalidParamsErrorCode]);

function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}

export function createPlayFabUserValidator({
    titleId,
    secretKey,
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch
} = {}) {
    const configured = isNonEmptyString(titleId) &&
        isNonEmptyString(secretKey) &&
        typeof fetchImpl === "function";

    return async function validatePlayFabUser(playFabId) {
        if (!isNonEmptyString(playFabId) || playFabId !== playFabId.trim() || playFabId.length > 160) {
            return false;
        }
        if (!configured) {
            throw new Error("PlayFab user validation is not configured.");
        }

        const response = await fetchImpl(
            `https://${titleId}.playfabapi.com/Server/GetUserAccountInfo`,
            {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(timeoutMs),
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({ PlayFabId: playFabId })
            }
        );
        const payload = await response.json().catch(() => null);

        if (response.ok && payload?.code === 200) {
            if (payload?.data?.UserInfo?.PlayFabId === playFabId) {
                return true;
            }
            throw new Error("PlayFab user validation returned an unexpected account.");
        }

        if (response.status === 400 && (
            invalidUserErrors.has(payload?.error) ||
            invalidUserErrorCodes.has(payload?.errorCode)
        )) {
            return false;
        }

        throw new Error("PlayFab user validation is unavailable.");
    };
}
