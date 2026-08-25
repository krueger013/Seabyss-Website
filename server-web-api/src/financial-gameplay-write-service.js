import { createHash, randomUUID } from "node:crypto";

const MAXIMUM_OPERATIONS = 50;
const MAXIMUM_CONTEXT_BYTES = 8192;
const MAXIMUM_CONTEXT_DEPTH = 6;
const MAXIMUM_CONTEXT_KEYS = 128;
const PLAYER_LEASE_TYPE = "financial_gameplay_player";
const PROHIBITED_CLIENT_KEYS = new Set([
    "playfabid", "operationid", "operations", "operation", "deltas", "delta",
    "balances", "balance", "mapping", "mappings", "resourceid", "amount",
    "cost", "costs", "price", "prices", "etag", "fencingtoken", "reason",
    "beforequantities", "afterquantities", "providerevidence", "authority"
]);

export class FinancialGameplayWriteError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "FinancialGameplayWriteError";
        this.code = code;
        this.statusCode = options.statusCode || 500;
        this.retryable = options.retryable === true;
        this.ambiguous = options.ambiguous === true;
        this.retryAfterMilliseconds = Number.isSafeInteger(options.retryAfterMilliseconds) &&
            options.retryAfterMilliseconds >= 0 && options.retryAfterMilliseconds <= 86_400_000
            ? options.retryAfterMilliseconds : null;
    }
}

function fail(code, message, options) {
    throw new FinancialGameplayWriteError(code, message, options);
}

function token(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_REQUEST", `${name} is invalid.`, { statusCode: 400 });
    }
    return value;
}

function plain(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function contextValue(value, depth = 0, counter = { keys: 0 }) {
    if (depth > MAXIMUM_CONTEXT_DEPTH) fail("INVALID_CONTEXT", "context is too deep.", { statusCode: 400 });
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
        if (value.length > 1000 || /[\u0000-\u001f\u007f]/u.test(value)) {
            fail("INVALID_CONTEXT", "context contains invalid text.", { statusCode: 400 });
        }
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) fail("INVALID_CONTEXT", "context numbers must be safe integers.", { statusCode: 400 });
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length > 50) fail("INVALID_CONTEXT", "context array is too large.", { statusCode: 400 });
        return value.map((entry) => contextValue(entry, depth + 1, counter));
    }
    if (!plain(value)) fail("INVALID_CONTEXT", "context must be JSON data.", { statusCode: 400 });
    const result = {};
    for (const key of Object.keys(value).sort()) {
        counter.keys += 1;
        if (counter.keys > MAXIMUM_CONTEXT_KEYS || key.length === 0 || key.length > 80 ||
            /[\u0000-\u001f\u007f]/u.test(key) || PROHIBITED_CLIENT_KEYS.has(key.toLowerCase())) {
            fail("FORBIDDEN_CLIENT_ECONOMY_INPUT", "Client economic state or mapping input is forbidden.", { statusCode: 400 });
        }
        result[key] = contextValue(value[key], depth + 1, counter);
    }
    return result;
}

function validateClientRequest(request) {
    if (!plain(request)) fail("INVALID_REQUEST", "JSON request object is required.", { statusCode: 400 });
    for (const key of Object.keys(request)) {
        if (!new Set(["actionId", "eventId", "context"]).has(key) ||
            PROHIBITED_CLIENT_KEYS.has(key.toLowerCase())) {
            fail("FORBIDDEN_CLIENT_ECONOMY_INPUT", "Client economic state or mapping input is forbidden.", { statusCode: 400 });
        }
    }
    const actionId = token(request.actionId, "actionId", 160);
    const eventId = token(request.eventId, "eventId", 160);
    const context = contextValue(request.context ?? {});
    if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAXIMUM_CONTEXT_BYTES) {
        fail("INVALID_CONTEXT", "context is too large.", { statusCode: 400 });
    }
    return Object.freeze({ actionId, eventId, context: Object.freeze(context) });
}

function validateIdentity(identity) {
    if (!plain(identity) || identity.authenticated !== true ||
        identity.authenticationType !== "PlayFabSessionTicket") {
        fail("AUTHENTICATION_REQUIRED", "Authenticated PlayFab session identity is required.", { statusCode: 401 });
    }
    return token(identity.playFabId, "authenticated legacy PlayFabId", 160);
}

function validateRegistry(registry) {
    if (!registry || !Array.isArray(registry.quantityIds) || registry.quantityIds.length === 0 ||
        typeof registry.descriptor !== "function") {
        throw new TypeError("Exhaustive canonical gameplay registry is required.");
    }
    const ids = new Set();
    for (const resourceId of registry.quantityIds) {
        if (ids.has(resourceId)) throw new TypeError("Canonical gameplay registry contains duplicates.");
        ids.add(resourceId);
        const descriptor = registry.descriptor(resourceId);
        if (descriptor?.semantic !== "quantity" || !descriptor.economy?.itemId ||
            !descriptor.economy?.stackId) {
            throw new TypeError(`Canonical gameplay mapping is missing:${resourceId}`);
        }
    }
    return ids;
}

function validateIntent(intent, request, registryIds) {
    if (!plain(intent) || intent.authorized !== true ||
        intent.serverAuthority !== "financial_gameplay_v2" ||
        intent.actionId !== request.actionId || intent.eventId !== request.eventId) {
        fail("ACTION_NOT_AUTHORIZED", "Server authority did not authorize this gameplay event.", { statusCode: 403 });
    }
    const reason = token(intent.reason, "server reason", 160);
    if (!Array.isArray(intent.operations) || intent.operations.length === 0 ||
        intent.operations.length > MAXIMUM_OPERATIONS) {
        fail("INVALID_SERVER_PLAN", "Server financial plan must contain 1 to 50 operations.");
    }
    const seen = new Set();
    const operations = intent.operations.map((entry) => {
        if (!plain(entry)) fail("INVALID_SERVER_PLAN", "Server financial operation is invalid.");
        const resourceId = token(entry.resourceId, "server resourceId", 255);
        if (!registryIds.has(resourceId)) fail("INVALID_SERVER_PLAN", `Unknown canonical resource:${resourceId}`);
        if (!Number.isSafeInteger(entry.delta) || entry.delta === 0) {
            fail("INVALID_SERVER_PLAN", "Server financial delta must be a non-zero safe integer.");
        }
        if (seen.has(resourceId)) fail("INVALID_SERVER_PLAN", "Server plan contains duplicate resources.");
        seen.add(resourceId);
        return Object.freeze({ resourceId, delta: entry.delta });
    });
    return Object.freeze({ reason, operations: Object.freeze(operations) });
}

function operationId(playFabId, eventId, actionId) {
    return `fgw1_${createHash("sha256")
        .update(`${playFabId}\u0000${eventId}\u0000${actionId}`, "utf8")
        .digest("hex")}`;
}

function quantities(snapshot, registryIds) {
    if (!plain(snapshot) || snapshot.authorityV2?.migrated !== true ||
        typeof snapshot.economyV2Etag !== "string" || snapshot.economyV2Etag.length === 0 ||
        !plain(snapshot.economyV2Quantities)) {
        fail("FINANCIAL_AUTHORITY_NOT_MIGRATED", "Economy v2 authority is not ready for gameplay writes.", { statusCode: 409 });
    }
    const result = {};
    for (const resourceId of registryIds) {
        const value = snapshot.economyV2Quantities[resourceId];
        if (!Number.isSafeInteger(value) || value < 0) {
            fail("FINANCIAL_SNAPSHOT_INVALID", `Invalid canonical quantity:${resourceId}`, { retryable: true });
        }
        result[resourceId] = value;
    }
    return Object.freeze({ etag: snapshot.economyV2Etag, values: Object.freeze(result) });
}

function expectedQuantities(before, operations) {
    const after = { ...before };
    for (const operation of operations) {
        const result = after[operation.resourceId] + operation.delta;
        if (!Number.isSafeInteger(result)) fail("BALANCE_OVERFLOW", "Financial quantity overflow.", { statusCode: 409 });
        if (result < 0) fail("INSUFFICIENT_BALANCE", `Insufficient ${operation.resourceId}.`, { statusCode: 409 });
        after[operation.resourceId] = result;
    }
    return Object.freeze(after);
}

function exactSnapshot(actual, expected, registryIds, providerEtag) {
    if (actual.etag !== providerEtag) return false;
    for (const resourceId of registryIds) {
        if (actual.values[resourceId] !== expected[resourceId]) return false;
    }
    return true;
}

function response(record, replayed) {
    return Object.freeze({
        status: replayed ? "already_completed" : "completed",
        operationId: record.operationId,
        eventId: record.eventId,
        actionId: record.actionId,
        deltas: Object.freeze(record.operations.map((entry) => Object.freeze({ ...entry })))
    });
}

function normalizeError(error) {
    if (error instanceof FinancialGameplayWriteError) return error;
    const code = typeof error?.code === "string" ? error.code : "FINANCIAL_WRITE_FAILED";
    return new FinancialGameplayWriteError(code, "Financial gameplay write failed.", {
        statusCode: error?.statusCode || 503,
        retryable: error?.retryable === true || error?.ambiguous === true,
        ambiguous: error?.ambiguous === true,
        retryAfterMilliseconds: error?.retryAfterMilliseconds
    });
}

export function createFinancialGameplayWriteService({
    registry,
    resolveIntent,
    reader,
    economy,
    journal,
    leases,
    workerId = `gameplay-write-${randomUUID()}`,
    leaseTtlMilliseconds = 15_000,
    tokenFactory = () => randomUUID(),
    hooks = {}
} = {}) {
    const registryIds = validateRegistry(registry);
    if (typeof resolveIntent !== "function" || typeof reader?.readFinancialV2 !== "function" ||
        typeof economy?.mutate !== "function" || typeof journal?.begin !== "function" ||
        typeof journal?.claim !== "function" || typeof journal?.prepare !== "function" ||
        typeof journal?.recordProviderApplied !== "function" || typeof journal?.complete !== "function" ||
        typeof journal?.manualReview !== "function" || typeof leases?.acquireResourceLease !== "function" ||
        typeof leases?.renewResourceLease !== "function" || typeof leases?.releaseResourceLease !== "function" ||
        typeof tokenFactory !== "function") {
        throw new TypeError("Financial gameplay write dependencies are incomplete.");
    }
    token(workerId, "workerId", 160);
    if (!Number.isSafeInteger(leaseTtlMilliseconds) || leaseTtlMilliseconds < 1000) {
        throw new TypeError("Gameplay player lease TTL is invalid.");
    }

    async function renewed(playFabId, leaseToken) {
        let result;
        try {
            result = await leases.renewResourceLease({
                resourceType: PLAYER_LEASE_TYPE,
                resourceId: playFabId,
                token: leaseToken,
                ttlMilliseconds: leaseTtlMilliseconds
            });
        } catch (error) {
            if (error?.code === "LEASE_LOST" || error?.code === "PLAYER_LEASE_LOST") {
                fail("PLAYER_LEASE_LOST", "Gameplay financial player lease was lost.", { statusCode: 409, retryable: true });
            }
            throw error;
        }
        if (result?.status !== "renewed") {
            fail("PLAYER_LEASE_LOST", "Gameplay financial player lease was lost.", { statusCode: 409, retryable: true });
        }
        return result.lease;
    }

    async function execute({ identity, request } = {}) {
        const playFabId = validateIdentity(identity);
        const clientRequest = validateClientRequest(request);
        const resolved = await resolveIntent({
            playFabId,
            actionId: clientRequest.actionId,
            eventId: clientRequest.eventId,
            context: structuredClone(clientRequest.context)
        });
        const intent = validateIntent(resolved, clientRequest, registryIds);
        const operation = operationId(playFabId, clientRequest.eventId, clientRequest.actionId);
        const requestHash = digest({
            playFabId,
            operationId: operation,
            actionId: clientRequest.actionId,
            eventId: clientRequest.eventId,
            reason: intent.reason,
            operations: intent.operations,
            context: clientRequest.context
        });
        let record = await journal.begin({
            playFabId,
            operationId: operation,
            actionId: clientRequest.actionId,
            eventId: clientRequest.eventId,
            reason: intent.reason,
            operations: intent.operations,
            requestHash
        });
        if (record.state === "Completed") return response(record, true);
        if (record.state === "ManualReview") {
            fail("MANUAL_REVIEW", "Financial gameplay operation requires manual review.", { statusCode: 409 });
        }

        const leaseToken = token(tokenFactory(), "lease token", 255);
        const acquired = await leases.acquireResourceLease({
            resourceType: PLAYER_LEASE_TYPE,
            resourceId: playFabId,
            owner: workerId,
            token: leaseToken,
            ttlMilliseconds: leaseTtlMilliseconds
        });
        if (acquired?.status !== "acquired" || !Number.isSafeInteger(acquired?.lease?.epoch)) {
            fail("PLAYER_LEASE_BUSY", "Another financial operation owns this player.", { statusCode: 409, retryable: true });
        }
        const fencingEpoch = acquired.lease.epoch;
        let providerStarted = false;
        try {
            record = await journal.claim({ playFabId, operationId: operation, leaseToken, fencingEpoch });
            if (record.state === "Completed") return response(record, true);
            if (record.state === "ManualReview") fail("MANUAL_REVIEW", "Financial gameplay operation requires manual review.", { statusCode: 409 });
            if (record.state === "ProviderApplied") {
                const completed = await journal.complete({
                    playFabId, operationId: operation, leaseToken, fencingEpoch,
                    result: { confirmedAtUnixMs: Date.now(), providerEvidence: record.providerEvidence }
                });
                return response(completed, false);
            }

            if (record.expectedEtag === null) {
                const before = quantities(await reader.readFinancialV2(playFabId), registryIds);
                expectedQuantities(before.values, record.operations);
                record = await journal.prepare({
                    playFabId,
                    operationId: operation,
                    leaseToken,
                    fencingEpoch,
                    expectedEtag: before.etag,
                    beforeQuantities: before.values
                });
            }
            const expected = expectedQuantities(record.beforeQuantities, record.operations);
            await renewed(playFabId, leaseToken);
            if (typeof hooks.beforeProvider === "function") {
                await hooks.beforeProvider({ playFabId, operationId: operation, fencingEpoch });
            }
            await renewed(playFabId, leaseToken);
            providerStarted = true;
            const evidence = await economy.mutate({
                playFabId,
                operationId: operation,
                eventId: record.eventId,
                reason: record.reason,
                idempotencyCreatedAtUtc: record.idempotencyCreatedAtUtc,
                fencingToken: fencingEpoch,
                operations: record.operations
            });
            if (typeof hooks.afterProvider === "function") {
                await hooks.afterProvider({ playFabId, operationId: operation, fencingEpoch, evidence });
            }
            const observed = quantities(await reader.readFinancialV2(playFabId), registryIds);
            if (!exactSnapshot(observed, expected, registryIds, evidence.etag)) {
                await renewed(playFabId, leaseToken);
                await journal.manualReview({
                    playFabId, operationId: operation, leaseToken, fencingEpoch,
                    reason: "provider_reconciliation_mismatch"
                });
                fail("PROVIDER_RECONCILIATION_MISMATCH", "Provider result requires manual review.", { statusCode: 409 });
            }
            await renewed(playFabId, leaseToken);
            record = await journal.recordProviderApplied({
                playFabId,
                operationId: operation,
                leaseToken,
                fencingEpoch,
                providerEvidence: evidence,
                afterQuantities: observed.values
            });
            const completed = await journal.complete({
                playFabId,
                operationId: operation,
                leaseToken,
                fencingEpoch,
                result: { confirmedAtUnixMs: Date.now(), providerEvidence: evidence }
            });
            return response(completed, false);
        } catch (rawError) {
            const error = normalizeError(rawError);
            if (providerStarted && !error.retryable && !error.ambiguous &&
                !["MANUAL_REVIEW", "PROVIDER_RECONCILIATION_MISMATCH", "PLAYER_LEASE_LOST", "STALE_FENCING_EPOCH"].includes(error.code)) {
                try {
                    await renewed(playFabId, leaseToken);
                    await journal.manualReview({
                        playFabId, operationId: operation, leaseToken, fencingEpoch,
                        reason: `provider_failure_${error.code}`.slice(0, 1000)
                    });
                } catch {
                    // A lost/stale lease must never be bypassed merely to record diagnostics.
                }
            }
            throw error;
        } finally {
            try {
                await leases.releaseResourceLease({
                    resourceType: PLAYER_LEASE_TYPE,
                    resourceId: playFabId,
                    token: leaseToken
                });
            } catch {
                // TTL guarantees eventual release; request outcome must not be changed here.
            }
        }
    }

    return Object.freeze({ execute });
}
