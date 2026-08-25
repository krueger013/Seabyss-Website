const OBJECT_NAME = "SeabyssFinancialProfileV1";
const LEGACY_KEY = "profile_v1";
const ENVELOPE_SCHEMA_VERSION = 1;
const PLAYER_PROFILE_SCHEMA_VERSION = 12;
const MAX_RATE_LIMIT_ATTEMPTS = 5;
const MAX_RATE_LIMIT_DELAY_MILLISECONDS = 30_000;
const RATE_LIMIT_BACKOFF_BASE_MILLISECONDS = 250;

function requireString(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f\s]/.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function requireInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function rejectNonFiniteNumbers(value, seen = new Set()) {
    if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("JSON data contains a non-finite number.");
    }
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) throw new TypeError("JSON data contains a cycle.");
    seen.add(value);
    for (const child of Object.values(value)) rejectNonFiniteNumbers(child, seen);
    seen.delete(value);
}

function serialize(value, name) {
    rejectNonFiniteNumbers(value);
    let json;
    try {
        json = JSON.stringify(value);
    } catch {
        throw new TypeError(`${name} must be JSON serializable.`);
    }
    if (json === undefined || /(?:NaN|Infinity)/.test(json)) {
        throw new TypeError(`${name} must be JSON serializable.`);
    }
    return json;
}

function validateProfile(profile, playFabId) {
    if (!isPlainObject(profile) || profile.schemaVersion !== PLAYER_PROFILE_SCHEMA_VERSION ||
        profile.playerAccountId !== playFabId) {
        throw new TypeError("PlayerProfileData schema or account identity is invalid.");
    }
    serialize(profile, "PlayerProfileData");
    return profile;
}

function validateEnvelope(value, playFabId, maximumAppliedOperations) {
    if (!isPlainObject(value) || value.schemaVersion !== ENVELOPE_SCHEMA_VERSION ||
        value.legacyPlayFabId !== playFabId || !Array.isArray(value.appliedOperations) ||
        value.appliedOperations.length > maximumAppliedOperations) {
        throw new TypeError("Financial profile envelope is invalid.");
    }
    requireInteger(value.lastFencingToken, "lastFencingToken");
    const seen = new Set();
    for (const operationId of value.appliedOperations) {
        requireString(operationId, "operationId");
        if (seen.has(operationId)) throw new TypeError("Financial operation history is invalid.");
        seen.add(operationId);
    }
    validateProfile(value.playerProfile, playFabId);
    return value;
}

function byteLength(value) {
    return new TextEncoder().encode(serialize(value, "financial profile")).byteLength;
}

function createPlayFabError(body, status, retryAfterHeader = null) {
    const error = new Error(`PlayFab request failed (${status}).`);
    error.code = body?.error || body?.errorCode || `HTTP_${status}`;
    error.providerError = typeof body?.error === "string" ? body.error : null;
    error.providerErrorCode = Number.isSafeInteger(body?.errorCode) ? body.errorCode : null;
    error.status = status;
    error.retryable = status === 429 || status >= 500;
    if (typeof retryAfterHeader === "string" && retryAfterHeader.length > 0) {
        if (/^\d{1,8}$/u.test(retryAfterHeader)) {
            const milliseconds = Number(retryAfterHeader) * 1000;
            if (Number.isSafeInteger(milliseconds) &&
                milliseconds >= 0 && milliseconds <= MAX_RATE_LIMIT_DELAY_MILLISECONDS) {
                error.retryAfterMilliseconds = milliseconds;
            } else {
                error.rateLimitRetryRefused = true;
            }
        } else {
            error.rateLimitRetryRefused = true;
        }
    }
    return error;
}

function isExplicitDataUpdateRateLimit(error) {
    return error?.status === 429 &&
        (error?.providerError === "DataUpdateRateExceeded" || error?.providerErrorCode === 1287);
}

function hasRateLimitSignal(error) {
    return error?.status === 429 ||
        error?.providerError === "DataUpdateRateExceeded" || error?.providerErrorCode === 1287;
}

function rateLimitDelay(error, retryNumber, random) {
    const randomValue = random();
    if (typeof randomValue !== "number" || !Number.isFinite(randomValue) ||
        randomValue < 0 || randomValue >= 1) {
        throw new TypeError("random() must return a finite value in [0, 1).");
    }
    const exponential = Math.min(
        MAX_RATE_LIMIT_DELAY_MILLISECONDS,
        RATE_LIMIT_BACKOFF_BASE_MILLISECONDS * (2 ** (retryNumber - 1))
    );
    const jittered = Math.min(
        MAX_RATE_LIMIT_DELAY_MILLISECONDS,
        exponential + Math.floor(exponential * randomValue)
    );
    return Math.max(error?.retryAfterMilliseconds || 0, jittered);
}

export function createPlayFabFinancialProfileClient({
    titleId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random,
    maxRateLimitRetries = 4
}) {
    requireString(titleId, "titleId", 64);
    requireString(secretKey, "secretKey", 1024);
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required.");
    if (typeof sleep !== "function") throw new TypeError("sleep is required.");
    if (typeof random !== "function") throw new TypeError("random is required.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs is invalid.");
    if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0 ||
        maxRateLimitRetries >= MAX_RATE_LIMIT_ATTEMPTS) {
        throw new TypeError("maxRateLimitRetries is invalid.");
    }
    const baseUrl = `https://${titleId}.playfabapi.com`;

    async function postAttempt(path, serializedBody, headerName, credential) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`${baseUrl}${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", [headerName]: credential },
                body: serializedBody,
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload?.code !== 200) {
                throw createPlayFabError(
                    payload,
                    response.status,
                    response.headers?.get?.("retry-after") || null
                );
            }
            return payload.data;
        } catch (error) {
            if (error?.name === "AbortError") {
                error.code = "PLAYFAB_TIMEOUT";
                error.retryable = true;
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async function post(path, body, headerName, credential) {
        const serializedBody = JSON.stringify(body);
        const maximumAttempts = Math.min(MAX_RATE_LIMIT_ATTEMPTS, maxRateLimitRetries + 1);
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            try {
                return await postAttempt(path, serializedBody, headerName, credential);
            } catch (error) {
                if (!isExplicitDataUpdateRateLimit(error) || error?.rateLimitRetryRefused === true) {
                    if (hasRateLimitSignal(error)) error.rateLimitRetryRefused = true;
                    throw error;
                }
                if (attempt >= maximumAttempts) {
                    error.rateLimitRetryExhausted = true;
                    error.attempts = attempt;
                    throw error;
                }
                await sleep(rateLimitDelay(error, attempt, random));
            }
        }
        throw new Error("PlayFab rate-limit retry loop ended unexpectedly.");
    }

    return Object.freeze({
        getUserAccountInfo(playFabId) {
            return post("/Server/GetUserAccountInfo", { PlayFabId: playFabId }, "X-SecretKey", secretKey);
        },
        getUserInternalData(playFabId) {
            return post("/Server/GetUserInternalData", { PlayFabId: playFabId, Keys: [LEGACY_KEY] }, "X-SecretKey", secretKey);
        },
        getUserInventory(playFabId) {
            return post("/Server/GetUserInventory", { PlayFabId: playFabId }, "X-SecretKey", secretKey);
        },
        getEntityToken() {
            return post("/Authentication/GetEntityToken", {
                Entity: { Id: titleId, Type: "title" }
            }, "X-SecretKey", secretKey);
        },
        getObjects(entity, entityToken) {
            return post("/Object/GetObjects", { Entity: entity }, "X-EntityToken", entityToken);
        },
        setObjects(entity, entityToken, expectedProfileVersion, objects) {
            return post("/Object/SetObjects", {
                Entity: entity,
                ExpectedProfileVersion: expectedProfileVersion,
                Objects: objects
            }, "X-EntityToken", entityToken);
        }
    });
}

function isVersionConflict(error) {
    const providerCode = error?.providerErrorCode ?? error?.errorCode ??
        (Number.isSafeInteger(error?.code) ? error.code : null);
    return error?.code === "EntityProfileVersionMismatch" ||
        error?.code === "ConcurrentEditError" || error?.providerError === "EntityProfileVersionMismatch" ||
        error?.providerError === "ConcurrentEditError" || providerCode === 1352 || providerCode === 1133;
}

export function createPlayFabFinancialProfileStore({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMs,
    sleep,
    random,
    maxRateLimitRetries,
    maximumObjectBytes = 64 * 1024,
    maximumAppliedOperations = 1024
}) {
    const playFab = client || createPlayFabFinancialProfileClient({
        titleId, secretKey, fetchImpl, timeoutMs, sleep, random, maxRateLimitRetries
    });
    for (const method of ["getUserAccountInfo", "getUserInternalData", "getEntityToken", "getObjects", "setObjects"]) {
        if (typeof playFab?.[method] !== "function") throw new TypeError(`PlayFab client.${method} is required.`);
    }
    requireInteger(maximumObjectBytes, "maximumObjectBytes");
    requireInteger(maximumAppliedOperations, "maximumAppliedOperations");
    if (maximumObjectBytes === 0 || maximumAppliedOperations === 0) throw new TypeError("Store limits must be positive.");

    async function context(playFabId) {
        requireString(playFabId, "playFabId", 128);
        const account = await playFab.getUserAccountInfo(playFabId);
        if (account?.UserInfo?.PlayFabId !== undefined && account.UserInfo.PlayFabId !== playFabId) {
            throw new Error("PlayFab account lookup returned a different legacy PlayFabId.");
        }
        const entityId = account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id;
        requireString(entityId, "TitlePlayerAccount.Id", 128);
        const tokenResult = await playFab.getEntityToken();
        requireString(tokenResult?.EntityToken, "EntityToken", 8192);
        return { entity: { Id: entityId, Type: "title_player_account" }, token: tokenResult.EntityToken };
    }

    function objectFrom(result) {
        return result?.Objects?.[OBJECT_NAME]?.DataObject ?? null;
    }

    async function readCurrent(playFabId, ctx) {
        const result = await playFab.getObjects(ctx.entity, ctx.token);
        const version = requireInteger(result?.ProfileVersion ?? 0, "ProfileVersion");
        const found = objectFrom(result);
        if (found !== null) return { version, envelope: validateEnvelope(found, playFabId, maximumAppliedOperations) };

        const legacy = await playFab.getUserInternalData(playFabId);
        const raw = legacy?.Data?.[LEGACY_KEY]?.Value;
        if (typeof raw !== "string" || raw.length === 0) {
            throw new Error("Financial profile migration failed: profile_v1 is absent.");
        }
        let profile;
        try { profile = JSON.parse(raw); } catch { throw new Error("Financial profile migration failed: profile_v1 is invalid JSON."); }
        validateProfile(profile, playFabId);
        const envelope = {
            schemaVersion: ENVELOPE_SCHEMA_VERSION,
            legacyPlayFabId: playFabId,
            lastFencingToken: 0,
            appliedOperations: [],
            playerProfile: profile
        };
        if (byteLength(envelope) > maximumObjectBytes) throw new RangeError("Financial profile exceeds the configured object size limit.");
        try {
            const write = await playFab.setObjects(ctx.entity, ctx.token, version, [{ ObjectName: OBJECT_NAME, DataObject: envelope }]);
            return { version: requireInteger(write?.ProfileVersion, "ProfileVersion"), envelope };
        } catch (error) {
            if (!isVersionConflict(error)) throw error;
            const raced = await playFab.getObjects(ctx.entity, ctx.token);
            const racedEnvelope = objectFrom(raced);
            if (racedEnvelope === null) throw error;
            return {
                version: requireInteger(raced.ProfileVersion, "ProfileVersion"),
                envelope: validateEnvelope(racedEnvelope, playFabId, maximumAppliedOperations)
            };
        }
    }

    async function read(playFabId) {
        const ctx = await context(playFabId);
        const current = await readCurrent(playFabId, ctx);
        return { version: current.version, profile: structuredClone(current.envelope.playerProfile) };
    }

    async function compareAndSet({ playFabId, expectedVersion, profile, operationId, fencingToken }) {
        requireString(playFabId, "playFabId", 128);
        requireInteger(expectedVersion, "expectedVersion");
        requireString(operationId, "operationId");
        requireInteger(fencingToken, "fencingToken");
        validateProfile(profile, playFabId);
        const ctx = await context(playFabId);
        let current = await readCurrent(playFabId, ctx);
        if (current.envelope.appliedOperations.includes(operationId)) {
            return { applied: false, reason: "already_applied", version: current.version };
        }
        if (fencingToken === 0 || fencingToken <= current.envelope.lastFencingToken) {
            return { applied: false, reason: "stale_fencing", version: current.version };
        }
        if (current.version !== expectedVersion) {
            return { applied: false, reason: "version_conflict", version: current.version };
        }
        if (current.envelope.appliedOperations.length >= maximumAppliedOperations) {
            throw new RangeError("Financial operation history limit reached.");
        }
        const next = {
            ...current.envelope,
            lastFencingToken: Math.max(current.envelope.lastFencingToken, fencingToken),
            appliedOperations: [...current.envelope.appliedOperations, operationId],
            playerProfile: structuredClone(profile)
        };
        if (byteLength(next) > maximumObjectBytes) throw new RangeError("Financial profile exceeds the configured object size limit.");
        let write;
        try {
            write = await playFab.setObjects(ctx.entity, ctx.token, expectedVersion, [{ ObjectName: OBJECT_NAME, DataObject: next }]);
        } catch (error) {
            if (isVersionConflict(error)) return { applied: false, reason: "version_conflict", version: expectedVersion };
            const recovered = await playFab.getObjects(ctx.entity, ctx.token).catch(() => null);
            const recoveredObject = objectFrom(recovered);
            if (recoveredObject) {
                const envelope = validateEnvelope(recoveredObject, playFabId, maximumAppliedOperations);
                if (envelope.appliedOperations.includes(operationId) &&
                    serialize(envelope.playerProfile, "profile") === serialize(profile, "profile")) {
                    return { applied: false, reason: "already_applied", version: recovered.ProfileVersion };
                }
            }
            const ambiguous = new Error("PlayFab financial profile mutation result is ambiguous.");
            ambiguous.code = "AMBIGUOUS_PROVIDER_RESULT";
            ambiguous.retryable = true;
            ambiguous.cause = error;
            throw ambiguous;
        }
        const version = requireInteger(write?.ProfileVersion, "ProfileVersion");
        const verified = await playFab.getObjects(ctx.entity, ctx.token);
        const verifiedEnvelope = validateEnvelope(objectFrom(verified), playFabId, maximumAppliedOperations);
        if (!verifiedEnvelope.appliedOperations.includes(operationId) ||
            serialize(verifiedEnvelope.playerProfile, "profile") !== serialize(profile, "profile")) {
            throw new Error("Financial profile write verification failed.");
        }
        return { applied: true, reason: "applied", version };
    }

    async function probe() {
        const token = await playFab.getEntityToken();
        requireString(token?.EntityToken, "EntityToken", 8192);
        return true;
    }

    return Object.freeze({ read, compareAndSet, probe, objectName: OBJECT_NAME });
}
