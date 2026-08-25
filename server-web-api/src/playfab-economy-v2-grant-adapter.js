export const PLAYFAB_ECONOMY_V2_IDEMPOTENCY_RETENTION_DAYS = 14;
const RETENTION_MILLISECONDS = PLAYFAB_ECONOMY_V2_IDEMPOTENCY_RETENTION_DAYS * 86_400_000;
const MAXIMUM_FUTURE_SKEW_MILLISECONDS = 5 * 60_000;
const MAXIMUM_OPERATIONS = 50;

export class PlayFabEconomyV2GrantError extends Error {
    constructor(code, message, { retryable = false, ambiguous = false,
        retryAfterMilliseconds = null, providerCode = null } = {}) {
        super(message);
        this.name = "PlayFabEconomyV2GrantError";
        this.code = code;
        this.retryable = retryable;
        this.ambiguous = ambiguous;
        this.retryAfterMilliseconds = retryAfterMilliseconds;
        this.providerCode = providerCode;
    }
}

function fail(code, message, options) {
    throw new PlayFabEconomyV2GrantError(code, message, options);
}
function canonicalString(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_ARGUMENT", `${name} is invalid.`);
    }
    return value;
}
function optionalCanonicalString(value, name, maximumLength = 320) {
    if (value === null || value === undefined) return null;
    return canonicalString(value, name, maximumLength);
}
function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
    return value;
}
function parseUtc(value, name) {
    if (typeof value !== "string" || !value.endsWith("Z")) fail("INVALID_ARGUMENT", `${name} is invalid.`);
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        fail("INVALID_ARGUMENT", `${name} is invalid.`);
    }
    return milliseconds;
}
function safeRetryAfter(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), 3_600_000);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 3_600_000)) : null;
}
function providerError(payload) {
    const value = payload?.error;
    return typeof value === "string" && value.length <= 160 ? value : null;
}

export function createPlayFabEconomyV2Client({
    titleId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 8000
} = {}) {
    canonicalString(titleId, "titleId", 64);
    canonicalString(secretKey, "secretKey", 4096);
    if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0 || timeoutMilliseconds > 30_000) {
        throw new TypeError("PlayFab Economy v2 client is not configured.");
    }
    const baseUrl = `https://${titleId}.playfabapi.com`;

    async function post(path, body, headerName, credential, mutation = false) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
        let response;
        try {
            response = await fetchImpl(`${baseUrl}${path}`, {
                method: "POST",
                redirect: "error",
                signal: controller.signal,
                headers: { "Content-Type": "application/json", [headerName]: credential },
                body: JSON.stringify(body)
            });
        } catch (error) {
            if (mutation) {
                throw new PlayFabEconomyV2GrantError(
                    "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
                    "PlayFab Economy v2 mutation outcome is ambiguous; retry only with the identical IdempotencyId and body.",
                    { retryable: true, ambiguous: true }
                );
            }
            throw new PlayFabEconomyV2GrantError(
                "PLAYFAB_UNAVAILABLE",
                "PlayFab control request is unavailable.",
                { retryable: true, providerCode: error?.name || null }
            );
        } finally {
            clearTimeout(timeout);
        }
        let payload = null;
        let payloadReadable = true;
        try { payload = await response.json(); } catch { payloadReadable = false; }
        if (response.status === 429) {
            throw new PlayFabEconomyV2GrantError("PLAYFAB_THROTTLED", "PlayFab throttled the request.", {
                retryable: true,
                retryAfterMilliseconds: safeRetryAfter(response.headers?.get?.("retry-after")),
                providerCode: providerError(payload)
            });
        }
        if (mutation && (!payloadReadable || response.status === 408 || response.status >= 500 ||
            (response.ok && (payload?.code !== 200 || !payload.data)))) {
            throw new PlayFabEconomyV2GrantError(
                "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
                "PlayFab Economy v2 mutation outcome is ambiguous; retry only with the identical IdempotencyId and body.",
                { retryable: true, ambiguous: true, providerCode: providerError(payload) }
            );
        }
        if (!response.ok || payload?.code !== 200 || !payload.data) {
            throw new PlayFabEconomyV2GrantError(
                mutation ? "PLAYFAB_ECONOMY_REJECTED" : "PLAYFAB_CONTROL_REJECTED",
                mutation ? "PlayFab Economy v2 rejected the mutation." : "PlayFab rejected the control request.",
                { retryable: response.status >= 500, providerCode: providerError(payload) }
            );
        }
        return payload.data;
    }

    return Object.freeze({
        getUserAccountInfo(playFabId) {
            return post("/Server/GetUserAccountInfo", { PlayFabId: playFabId }, "X-SecretKey", secretKey);
        },
        getEntityToken() {
            return post("/Authentication/GetEntityToken", {
                Entity: { Id: titleId, Type: "title" }
            }, "X-SecretKey", secretKey);
        },
        executeInventoryOperations(entityToken, request) {
            return post("/Inventory/ExecuteInventoryOperations", request,
                "X-EntityToken", entityToken, true);
        }
    });
}

function normalizeMappings(catalogMappings) {
    const entries = catalogMappings instanceof Map
        ? [...catalogMappings.entries()]
        : (catalogMappings && typeof catalogMappings === "object" && !Array.isArray(catalogMappings)
            ? Object.entries(catalogMappings) : null);
    if (!entries) throw new TypeError("catalogMappings must be a Map or plain object.");
    const normalized = new Map();
    const targetOwners = new Map();
    for (const [rewardId, mapping] of entries) {
        canonicalString(rewardId, "rewardId", 255);
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) ||
            (mapping.kind !== "currency" && mapping.kind !== "inventory")) {
            throw new TypeError(`Catalog mapping ${rewardId} is invalid.`);
        }
        const itemId = canonicalString(mapping.itemId, "catalog itemId", 255);
        const stackId = optionalCanonicalString(mapping.stackId, "stackId", 255) || "default";
        const expectedKind = rewardId === "diamonds" ? "currency" : "inventory";
        if (mapping.kind !== expectedKind) {
            throw new TypeError(`Catalog mapping ${rewardId} must use kind=${expectedKind}.`);
        }
        const targetKey = JSON.stringify([itemId, stackId]);
        const existingOwner = targetOwners.get(targetKey);
        if (existingOwner !== undefined && existingOwner !== rewardId) {
            throw new TypeError(
                `Catalog mappings ${existingOwner} and ${rewardId} target the same itemId/stackId.`
            );
        }
        targetOwners.set(targetKey, rewardId);
        normalized.set(rewardId, Object.freeze({ kind: mapping.kind, itemId, stackId }));
    }
    return normalized;
}

function buildOperations(rewards, mappings) {
    if (!Array.isArray(rewards) || rewards.length === 0 || rewards.length > MAXIMUM_OPERATIONS) {
        fail("INVALID_REWARD_PLAN", "Economy v2 reward operations must contain between 1 and 50 entries.");
    }
    const seen = new Set();
    return rewards.map((reward) => {
        if (!reward || typeof reward !== "object" || Array.isArray(reward)) {
            fail("INVALID_REWARD_PLAN", "Economy v2 reward entry is invalid.");
        }
        const rewardId = canonicalString(reward.rewardId, "rewardId", 255);
        const quantity = positiveInteger(reward.quantity, "reward quantity");
        if (seen.has(rewardId)) fail("INVALID_REWARD_PLAN", "Duplicate quantitative reward IDs are forbidden.");
        seen.add(rewardId);
        const mapping = mappings.get(rewardId);
        if (!mapping) {
            fail("CATALOG_MAPPING_MISSING", `No published Economy v2 mapping exists for ${rewardId}.`);
        }
        return Object.freeze({
            Add: Object.freeze({
                Item: Object.freeze({ Id: mapping.itemId, StackId: mapping.stackId }),
                Amount: quantity
            })
        });
    });
}

function validateRetention(createdAtUtc, nowMilliseconds) {
    const created = parseUtc(createdAtUtc, "idempotencyCreatedAtUtc");
    const now = nowMilliseconds();
    if (!Number.isSafeInteger(now) || now < 0) fail("INVALID_CLOCK", "Adapter clock is invalid.");
    const age = now - created;
    if (age < -MAXIMUM_FUTURE_SKEW_MILLISECONDS) {
        fail("IDEMPOTENCY_WINDOW_INVALID", "Idempotency creation time is too far in the future.");
    }
    if (age >= RETENTION_MILLISECONDS) {
        fail("IDEMPOTENCY_WINDOW_EXPIRED",
            "PlayFab Economy v2 idempotency retention expired; automatic mutation is forbidden.");
    }
    return Object.freeze({ createdAtUnixMs: created, expiresAtUnixMs: created + RETENTION_MILLISECONDS });
}

function validateResponse(result, idempotencyId) {
    if (!result || typeof result !== "object" || result.IdempotencyId !== idempotencyId ||
        typeof result.ETag !== "string" || result.ETag.length === 0 || result.ETag.length > 1024 ||
        !Array.isArray(result.TransactionIds) || result.TransactionIds.length === 0 ||
        result.TransactionIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 320)) {
        fail("PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
            "PlayFab Economy v2 returned invalid mutation evidence; retry only with the identical IdempotencyId and body.",
            { retryable: true, ambiguous: true });
    }
    if (new Set(result.TransactionIds).size !== result.TransactionIds.length) {
        fail("PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
            "PlayFab Economy v2 returned duplicate mutation evidence; retry only with the identical IdempotencyId and body.",
            { retryable: true, ambiguous: true });
    }
    return Object.freeze({ transactionIds: Object.freeze([...result.TransactionIds]), etag: result.ETag });
}

export function createPlayFabEconomyV2GrantAdapter({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMilliseconds,
    catalogMappings = {},
    collectionId = "default",
    nowMilliseconds = () => Date.now()
} = {}) {
    const playFab = client || createPlayFabEconomyV2Client({
        titleId, secretKey, fetchImpl, timeoutMilliseconds
    });
    if (!playFab || typeof playFab.getUserAccountInfo !== "function" ||
        typeof playFab.getEntityToken !== "function" ||
        typeof playFab.executeInventoryOperations !== "function" ||
        typeof nowMilliseconds !== "function") {
        throw new TypeError("PlayFab Economy v2 grant adapter is not configured.");
    }
    const mappings = normalizeMappings(catalogMappings);
    const normalizedCollectionId = canonicalString(collectionId, "collectionId", 255);

    async function resolvePlayerEntity(playFabId) {
        canonicalString(playFabId, "legacy PlayFabId", 160);
        const account = await playFab.getUserAccountInfo(playFabId);
        if (account?.UserInfo?.PlayFabId !== undefined && account.UserInfo.PlayFabId !== playFabId) {
            fail("PLAYFAB_IDENTITY_MISMATCH", "PlayFab account lookup returned another legacy identity.");
        }
        const entityId = account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id;
        canonicalString(entityId, "TitlePlayerAccount.Id", 160);
        return Object.freeze({ Id: entityId, Type: "title_player_account" });
    }

    async function grant({
        playFabId,
        operationId,
        idempotencyCreatedAtUtc,
        rewards,
        etag = null
    } = {}) {
        canonicalString(playFabId, "legacy PlayFabId", 160);
        canonicalString(operationId, "operationId", 160);
        const retention = validateRetention(idempotencyCreatedAtUtc, nowMilliseconds);
        const operations = buildOperations(rewards, mappings);
        const expectedEtag = optionalCanonicalString(etag, "ETag", 1024);
        const entity = await resolvePlayerEntity(playFabId);
        const tokenResult = await playFab.getEntityToken();
        const entityToken = canonicalString(tokenResult?.EntityToken, "EntityToken", 8192);
        const request = {
            Entity: entity,
            CollectionId: normalizedCollectionId,
            IdempotencyId: operationId,
            CustomTags: { operationId, authority: "seabyss_payment_worker" },
            Operations: operations
        };
        if (expectedEtag !== null) request.ETag = expectedEtag;
        const result = await playFab.executeInventoryOperations(entityToken, request);
        const evidence = validateResponse(result, operationId);
        return Object.freeze({
            status: "confirmed",
            playFabId,
            entity,
            collectionId: normalizedCollectionId,
            operationId,
            idempotencyId: operationId,
            idempotencyCreatedAtUnixMs: retention.createdAtUnixMs,
            idempotencyExpiresAtUnixMs: retention.expiresAtUnixMs,
            operationCount: operations.length,
            transactionIds: evidence.transactionIds,
            etag: evidence.etag
        });
    }

    async function verify(request) {
        const evidence = await grant(request);
        return Object.freeze({
            ...evidence,
            status: "verified",
            verificationMethod: "idempotent_execute_inventory_operations_replay"
        });
    }

    async function probe() {
        const token = await playFab.getEntityToken();
        canonicalString(token?.EntityToken, "EntityToken", 8192);
        return Object.freeze({ ok: true, component: "playfab_economy_v2" });
    }
    function health() {
        return Object.freeze({ healthy: true, configured: true, catalogMappingCount: mappings.size,
            collectionId: normalizedCollectionId,
            idempotencyRetentionDays: PLAYFAB_ECONOMY_V2_IDEMPOTENCY_RETENTION_DAYS });
    }
    return Object.freeze({ grant, verify, probe, health, resolvePlayerEntity });
}
