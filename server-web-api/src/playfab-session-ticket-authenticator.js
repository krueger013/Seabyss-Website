import { createHash } from "node:crypto";

const invalidSessionErrors = new Set([
    "InvalidParams",
    "InvalidSessionTicket",
    "SessionTicketExpired"
]);

function canonicalConfigurationString(value, maximumLength = 4096) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() &&
        !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : null;
}

function canonicalSessionTicket(value) {
    return typeof value === "string" && value.length >= 16 &&
        value.length <= 4096 && value === value.trim() &&
        /^[\x21-\x7e]+$/.test(value)
        ? value
        : null;
}

function canonicalPlayFabId(value) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= 160 && value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

function canonicalEntityValue(value, maximumLength = 160) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() &&
        !/[\s\u0000-\u001f\u007f]/u.test(value)
        ? value
        : null;
}

async function readBoundedJson(response, maximumBytes) {
    const contentLength = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
        throw new Error("PlayFab authentication response is too large.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
        throw new Error("PlayFab authentication response is too large.");
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error("PlayFab authentication response is malformed.");
    }
}

export class PlayFabSessionAuthenticationError extends Error {
    constructor(message = "PlayFab session authentication is unavailable.") {
        super(message);
        this.name = "PlayFabSessionAuthenticationError";
        this.code = "PLAYFAB_SESSION_AUTHENTICATION_UNAVAILABLE";
    }
}

/**
 * Authenticates a client session ticket with the PlayFab Server API and returns
 * the legacy PlayFabId and, when PlayFab supplied it, the corresponding
 * TitlePlayerAccount entity identity. Invalid or expired tickets return null;
 * configuration, transport, and malformed-response failures throw.
 */
export function createPlayFabSessionTicketAuthenticator({
    titleId,
    secretKey,
    timeoutMs = 8000,
    maximumResponseBytes = 64 * 1024,
    fetchImpl = globalThis.fetch
} = {}) {
    const configuredTitleId = canonicalConfigurationString(titleId, 160);
    const configuredSecretKey = canonicalConfigurationString(secretKey);
    const configured = configuredTitleId && configuredSecretKey &&
        Number.isInteger(timeoutMs) && timeoutMs > 0 &&
        Number.isInteger(maximumResponseBytes) && maximumResponseBytes >= 1024 &&
        typeof fetchImpl === "function";

    return async function authenticatePlayFabSessionTicket(sessionTicket) {
        const ticket = canonicalSessionTicket(sessionTicket);
        if (!ticket) return null;
        if (!configured) throw new PlayFabSessionAuthenticationError();

        let response;
        let payload;
        try {
            response = await fetchImpl(
                `https://${configuredTitleId}.playfabapi.com/Server/AuthenticateSessionTicket`,
                {
                    method: "POST",
                    redirect: "error",
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        "Content-Type": "application/json",
                        "X-SecretKey": configuredSecretKey
                    },
                    body: JSON.stringify({ SessionTicket: ticket })
                }
            );
            payload = await readBoundedJson(response, maximumResponseBytes);
        } catch {
            throw new PlayFabSessionAuthenticationError();
        }

        if (!response.ok || payload?.code !== 200) {
            if (response.status === 400 && invalidSessionErrors.has(payload?.error)) return null;
            throw new PlayFabSessionAuthenticationError();
        }
        if (payload?.data?.IsSessionTicketExpired === true) return null;
        if (payload?.data?.IsSessionTicketExpired !== false) {
            throw new PlayFabSessionAuthenticationError();
        }
        const playFabId = canonicalPlayFabId(payload?.data?.UserInfo?.PlayFabId);
        if (!playFabId) throw new PlayFabSessionAuthenticationError();

        const titlePlayerAccount = payload?.data?.UserInfo?.TitleInfo?.TitlePlayerAccount;
        const titlePlayerAccountId = canonicalEntityValue(titlePlayerAccount?.Id);
        const titlePlayerAccountType = canonicalEntityValue(titlePlayerAccount?.Type, 80);
        if (titlePlayerAccount !== undefined &&
            (!titlePlayerAccountId || !titlePlayerAccountType)) {
            throw new PlayFabSessionAuthenticationError();
        }
        return Object.freeze({
            playFabId,
            ...(titlePlayerAccountId ? {
                titlePlayerAccountId,
                entity: Object.freeze({ id: titlePlayerAccountId, type: titlePlayerAccountType })
            } : {})
        });
    };
}

export function financialSessionTicketDigest(sessionTicket) {
    const ticket = canonicalSessionTicket(sessionTicket);
    if (!ticket) return null;
    return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export function createCachedPlayFabSessionTicketAuthenticator({
    authenticate,
    ttlMilliseconds = 5_000,
    maximumEntries = 2_000,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (typeof authenticate !== "function" || typeof nowMilliseconds !== "function" ||
        !Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 250 || ttlMilliseconds > 60_000 ||
        !Number.isSafeInteger(maximumEntries) || maximumEntries <= 0 || maximumEntries > 100_000) {
        throw new TypeError("PlayFab session authentication cache configuration is invalid.");
    }
    const cache = new Map();
    const pending = new Map();
    const counters = { hit: 0, miss: 0, invalid: 0, upstreamFailure: 0 };

    function trim(now) {
        for (const [key, entry] of cache) {
            if (entry.expiresAtUnixMs <= now) cache.delete(key);
        }
        while (cache.size >= maximumEntries) cache.delete(cache.keys().next().value);
    }

    async function authenticateCached(sessionTicket) {
        const digest = financialSessionTicketDigest(sessionTicket);
        if (!digest) {
            counters.invalid += 1;
            return null;
        }
        const now = nowMilliseconds();
        const cached = cache.get(digest);
        if (cached && cached.expiresAtUnixMs > now) {
            counters.hit += 1;
            cache.delete(digest);
            cache.set(digest, cached);
            return cached.identity;
        }
        if (pending.has(digest)) {
            counters.hit += 1;
            return pending.get(digest);
        }
        counters.miss += 1;
        const request = Promise.resolve()
            .then(() => authenticate(sessionTicket))
            .then((identity) => {
                if (!identity) {
                    counters.invalid += 1;
                    return null;
                }
                trim(nowMilliseconds());
                const immutableIdentity = Object.freeze({
                    ...identity,
                    ...(identity.entity ? { entity: Object.freeze({ ...identity.entity }) } : {})
                });
                cache.set(digest, {
                    identity: immutableIdentity,
                    expiresAtUnixMs: nowMilliseconds() + ttlMilliseconds
                });
                return immutableIdentity;
            })
            .catch((error) => {
                counters.upstreamFailure += 1;
                throw error;
            })
            .finally(() => pending.delete(digest));
        pending.set(digest, request);
        return request;
    }

    return Object.freeze({
        authenticate: authenticateCached,
        diagnostics() {
            trim(nowMilliseconds());
            return Object.freeze({
                cacheEntryCount: cache.size,
                inFlightCount: pending.size,
                hitCount: counters.hit,
                missCount: counters.miss,
                invalidCount: counters.invalid,
                upstreamFailureCount: counters.upstreamFailure,
                storesRawTickets: false
            });
        },
        clear() { cache.clear(); },
        keyMaterial: "sha256_ticket_digest_only"
    });
}
