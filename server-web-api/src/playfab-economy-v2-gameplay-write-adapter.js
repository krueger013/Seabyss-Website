import { createHash } from "node:crypto";
import {
    createPlayFabEconomyV2Client,
    PlayFabEconomyV2GrantError,
    PLAYFAB_ECONOMY_V2_IDEMPOTENCY_RETENTION_DAYS
} from "./playfab-economy-v2-grant-adapter.js";

const MAXIMUM_OPERATIONS = 50;
const MAXIMUM_FUTURE_SKEW_MILLISECONDS = 5 * 60_000;
const IDEMPOTENCY_RETENTION_MILLISECONDS =
    PLAYFAB_ECONOMY_V2_IDEMPOTENCY_RETENTION_DAYS * 86_400_000;

function fail(code, message, options = {}) {
    throw new PlayFabEconomyV2GrantError(code, message, options);
}

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_ARGUMENT", `${name} is invalid.`);
    }
    return value;
}

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        fail("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
    }
    return value;
}

function strictUtc(value, name, nowMilliseconds) {
    if (typeof value !== "string" || !value.endsWith("Z")) {
        fail("INVALID_ARGUMENT", `${name} is invalid.`);
    }
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        fail("INVALID_ARGUMENT", `${name} is invalid.`);
    }
    const age = nowMilliseconds() - milliseconds;
    if (age < -MAXIMUM_FUTURE_SKEW_MILLISECONDS ||
        age >= IDEMPOTENCY_RETENTION_MILLISECONDS) {
        fail(
            "IDEMPOTENCY_WINDOW_INVALID",
            "Gameplay mutation is outside the PlayFab idempotency retention window."
        );
    }
    return Object.freeze({
        createdAtUnixMs: milliseconds,
        expiresAtUnixMs: milliseconds + IDEMPOTENCY_RETENTION_MILLISECONDS
    });
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value) {
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function validateRegistry(registry) {
    if (!registry || !Array.isArray(registry.quantityIds) ||
        typeof registry.descriptor !== "function" || registry.quantityIds.length === 0) {
        throw new TypeError("Exhaustive gameplay financial registry is required.");
    }
    const ids = new Set();
    const targets = new Set();
    for (const resourceId of registry.quantityIds) {
        canonical(resourceId, "resourceId", 255);
        if (ids.has(resourceId)) throw new TypeError("Gameplay registry contains duplicate IDs.");
        ids.add(resourceId);
        const descriptor = registry.descriptor(resourceId);
        const mapping = descriptor?.economy;
        if (descriptor?.semantic !== "quantity" ||
            (mapping?.kind !== "currency" && mapping?.kind !== "inventory")) {
            throw new TypeError(`Gameplay Economy mapping is absent:${resourceId}`);
        }
        canonical(mapping.itemId, `${resourceId}.itemId`, 255);
        canonical(mapping.stackId, `${resourceId}.stackId`, 255);
        const target = JSON.stringify([mapping.itemId, mapping.stackId]);
        if (targets.has(target)) throw new TypeError("Gameplay Economy mappings are not unique.");
        targets.add(target);
    }
}

function providerOperations(operations, registry) {
    if (!Array.isArray(operations) || operations.length === 0 ||
        operations.length > MAXIMUM_OPERATIONS) {
        fail("INVALID_OPERATION_PLAN", "Gameplay mutation must contain 1 to 50 operations.");
    }
    const seen = new Set();
    return operations.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            fail("INVALID_OPERATION_PLAN", "Gameplay mutation entry is invalid.");
        }
        const resourceId = canonical(entry.resourceId, "resourceId", 255);
        if (!Number.isSafeInteger(entry.delta) || entry.delta === 0 ||
            entry.delta === Number.MIN_SAFE_INTEGER) {
            fail("INVALID_OPERATION_PLAN", "Gameplay mutation delta is invalid.");
        }
        if (seen.has(resourceId)) {
            fail("INVALID_OPERATION_PLAN", "Duplicate gameplay resource IDs are forbidden.");
        }
        seen.add(resourceId);
        let descriptor;
        try {
            descriptor = registry.descriptor(resourceId);
        } catch {
            fail("CATALOG_MAPPING_MISSING", `Unknown gameplay financial resource:${resourceId}`);
        }
        if (descriptor?.semantic !== "quantity" || !descriptor.economy) {
            fail("CATALOG_MAPPING_MISSING", `No Economy v2 quantity mapping exists for ${resourceId}.`);
        }
        const item = Object.freeze({
            Id: descriptor.economy.itemId,
            StackId: descriptor.economy.stackId
        });
        const amount = Math.abs(entry.delta);
        return entry.delta > 0
            ? Object.freeze({ Add: Object.freeze({ Item: item, Amount: amount }) })
            : Object.freeze({ Subtract: Object.freeze({ Item: item, Amount: amount }) });
    });
}

function validateEvidence(result, operationId) {
    if (!result || typeof result !== "object" || result.IdempotencyId !== operationId ||
        typeof result.ETag !== "string" || result.ETag.length === 0 || result.ETag.length > 1024 ||
        !Array.isArray(result.TransactionIds) || result.TransactionIds.length === 0 ||
        result.TransactionIds.some((id) => typeof id !== "string" || id.length === 0 ||
            id.length > 320 || id !== id.trim())) {
        fail(
            "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
            "PlayFab Economy v2 returned invalid gameplay mutation evidence.",
            { retryable: true, ambiguous: true }
        );
    }
    if (new Set(result.TransactionIds).size !== result.TransactionIds.length) {
        fail(
            "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
            "PlayFab Economy v2 returned duplicate gameplay transaction evidence.",
            { retryable: true, ambiguous: true }
        );
    }
    return Object.freeze({
        etag: result.ETag,
        transactionIds: Object.freeze([...result.TransactionIds])
    });
}

export function createPlayFabEconomyV2GameplayWriteAdapter({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMilliseconds,
    registry,
    collectionId = "default",
    nowMilliseconds = () => Date.now()
} = {}) {
    validateRegistry(registry);
    const playFab = client || createPlayFabEconomyV2Client({
        titleId,
        secretKey,
        fetchImpl,
        timeoutMilliseconds
    });
    for (const method of ["getUserAccountInfo", "getEntityToken", "executeInventoryOperations"]) {
        if (typeof playFab?.[method] !== "function") {
            throw new TypeError(`PlayFab Economy gameplay client.${method} is required.`);
        }
    }
    if (typeof nowMilliseconds !== "function") throw new TypeError("Adapter clock is required.");
    const normalizedCollectionId = canonical(collectionId, "collectionId", 255);

    async function resolvePlayerEntity(playFabId) {
        canonical(playFabId, "legacy PlayFabId", 160);
        const account = await playFab.getUserAccountInfo(playFabId);
        if (account?.UserInfo?.PlayFabId !== playFabId) {
            fail("PLAYFAB_IDENTITY_MISMATCH", "PlayFab returned another legacy identity.");
        }
        return Object.freeze({
            Id: canonical(
                account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
                "TitlePlayerAccount.Id",
                160
            ),
            Type: "title_player_account"
        });
    }

    async function mutate({
        playFabId,
        operationId,
        eventId,
        reason,
        idempotencyCreatedAtUtc,
        fencingToken,
        operations
    } = {}) {
        canonical(playFabId, "legacy PlayFabId", 160);
        canonical(operationId, "operationId", 160);
        canonical(eventId, "eventId", 160);
        canonical(reason, "reason", 160);
        positiveInteger(fencingToken, "fencingToken");
        const retention = strictUtc(idempotencyCreatedAtUtc, "idempotencyCreatedAtUtc", nowMilliseconds);
        const plannedOperations = providerOperations(operations, registry);
        const entity = await resolvePlayerEntity(playFabId);
        const tokenResult = await playFab.getEntityToken();
        const entityToken = canonical(tokenResult?.EntityToken, "EntityToken", 8192);
        const request = Object.freeze({
            Entity: entity,
            CollectionId: normalizedCollectionId,
            IdempotencyId: operationId,
            CustomTags: Object.freeze({
                authority: "seabyss_gameplay_v2",
                operationId,
                eventId,
                fencingToken: String(fencingToken),
                reasonHash: fingerprint(reason)
            }),
            Operations: Object.freeze(plannedOperations)
        });
        const requestHash = fingerprint(request);
        const result = await playFab.executeInventoryOperations(entityToken, request);
        const evidence = validateEvidence(result, operationId);
        return Object.freeze({
            status: "confirmed",
            playFabId,
            operationId,
            eventId,
            fencingToken,
            collectionId: normalizedCollectionId,
            idempotencyCreatedAtUnixMs: retention.createdAtUnixMs,
            idempotencyExpiresAtUnixMs: retention.expiresAtUnixMs,
            requestHash,
            operationCount: plannedOperations.length,
            transactionIds: evidence.transactionIds,
            etag: evidence.etag
        });
    }

    async function verify(request) {
        const evidence = await mutate(request);
        return Object.freeze({
            ...evidence,
            status: "verified",
            verificationMethod: "idempotent_execute_inventory_operations_replay"
        });
    }

    function health() {
        return Object.freeze({
            healthy: true,
            configured: true,
            collectionId: normalizedCollectionId,
            registrySize: registry.quantityIds.length,
            maximumOperations: MAXIMUM_OPERATIONS,
            idempotencyRetentionDays: PLAYFAB_ECONOMY_V2_IDEMPOTENCY_RETENTION_DAYS
        });
    }

    return Object.freeze({ mutate, verify, resolvePlayerEntity, health });
}
