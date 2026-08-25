import { createHash } from "node:crypto";

export const PAYMENT_LEDGER_SCHEMA_VERSION = 1;
export const PAYMENT_LEDGER_MAX_CHECKPOINTS = 32;
export const PAYMENT_LEDGER_MAX_STEP_JOURNAL_ENTRIES = 32;
export const PAYMENT_LEDGER_MAX_AUDIT_ENTRIES = 64;
export const PAYMENT_LEDGER_MAX_REVERSALS = 32;

export const PAYMENT_TRANSACTION_STATES = Object.freeze([
    "Pending",
    "Processing",
    "Completed",
    "Failed",
    "Quarantined",
    "DuplicatePaid",
    "RefundRequired",
    "ManualReview"
]);

export const PAYMENT_REVERSAL_TYPES = Object.freeze([
    "refund",
    "order_canceled",
    "chargeback"
]);

export const PAYMENT_REVERSAL_STATUSES = Object.freeze([
    "PendingReview",
    "UnderReview",
    "ResolvedNoClawback",
    "Failed"
]);

const transitionTargets = Object.freeze({
    Pending: new Set(["Processing", "Failed", "Quarantined", "DuplicatePaid", "ManualReview"]),
    Processing: new Set([
        "Processing",
        "Pending",
        "Completed",
        "Failed",
        "Quarantined",
        "DuplicatePaid",
        "ManualReview"
    ]),
    Failed: new Set(["Processing", "Quarantined", "ManualReview"]),
    Quarantined: new Set(["ManualReview"]),
    DuplicatePaid: new Set(["RefundRequired", "ManualReview"]),
    RefundRequired: new Set(["ManualReview"]),
    ManualReview: new Set([]),
    Completed: new Set([])
});

const reversalTransitionTargets = Object.freeze({
    PendingReview: new Set(["UnderReview", "ResolvedNoClawback", "Failed"]),
    UnderReview: new Set(["ResolvedNoClawback", "Failed"]),
    Failed: new Set(["UnderReview"]),
    ResolvedNoClawback: new Set([])
});

const REQUIRED_STORE_METHODS = Object.freeze([
    "insertTransaction",
    "getTransaction",
    "mutateTransaction",
    "queryTransactions",
    "scanTransactions",
    "insertReversal",
    "getReversal",
    "mutateReversal",
    "queryReversals",
    "scanReversals",
    "acquireResourceLease",
    "renewResourceLease",
    "releaseResourceLease",
    "ping"
]);

export class PaymentLedgerError extends Error {
    constructor(code, message, details = undefined) {
        super(message);
        this.name = "PaymentLedgerError";
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

function fail(code, message, details) {
    throw new PaymentLedgerError(code, message, details);
}

function canonicalToken(value, name, maximumLength = 255) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_ARGUMENT", `${name} must be a canonical non-empty string.`);
    }
    return value;
}

function canonicalOptionalToken(value, name, maximumLength = 255) {
    return value === null || value === undefined
        ? null
        : canonicalToken(value, name, maximumLength);
}

function canonicalOptionalText(value, name, maximumLength = 1000) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_ARGUMENT", `${name} must be bounded single-line text.`);
    }
    return value;
}

function canonicalProvider(value) {
    const provider = canonicalToken(value, "provider", 40).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(provider)) {
        fail("INVALID_ARGUMENT", "provider contains unsupported characters.");
    }
    return provider;
}

function canonicalCurrency(value) {
    const currency = canonicalToken(value, "currency", 3);
    if (!/^[A-Z]{3}$/u.test(currency)) {
        fail("INVALID_ARGUMENT", "currency must be an uppercase ISO-4217 code.");
    }
    return currency;
}

function canonicalMinorUnits(value, name = "amountMinor") {
    if (!Number.isSafeInteger(value) || value <= 0) {
        fail("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
    }
    return value;
}

function canonicalMilliseconds(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        fail("INVALID_ARGUMENT", `${name} must be a non-negative Unix millisecond value.`);
    }
    return value;
}

function canonicalPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        fail("INVALID_ARGUMENT", `${name} must be a positive safe integer.`);
    }
    return value;
}

function canonicalPlanHash(value) {
    const planHash = canonicalToken(value, "planHash", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(planHash)) {
        fail("INVALID_ARGUMENT", "planHash must be a SHA-256 hexadecimal digest.");
    }
    return planHash;
}

function canonicalEnvironment(value) {
    const environment = canonicalToken(value, "environment", 20).toLowerCase();
    if (!["test", "sandbox", "production"].includes(environment)) {
        fail("INVALID_ARGUMENT", "environment must be test, sandbox, or production.");
    }
    return environment;
}

function canonicalState(value) {
    if (!PAYMENT_TRANSACTION_STATES.includes(value)) {
        fail("INVALID_ARGUMENT", "Unsupported payment transaction state.");
    }
    return value;
}

function canonicalReversalType(value) {
    if (!PAYMENT_REVERSAL_TYPES.includes(value)) {
        fail("INVALID_ARGUMENT", "Unsupported payment reversal type.");
    }
    return value;
}

function canonicalReversalStatus(value) {
    if (!PAYMENT_REVERSAL_STATUSES.includes(value)) {
        fail("INVALID_ARGUMENT", "Unsupported payment reversal status.");
    }
    return value;
}

function canonicalError(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
        fail("INVALID_ARGUMENT", "lastError must be a bounded non-empty string or null.");
    }
    return value.replace(/[\r\n\t]+/gu, " ");
}

function jsonValue(value, name, maximumBytes = 8192) {
    let serialized;
    try {
        serialized = JSON.stringify(value ?? null);
    } catch {
        fail("INVALID_ARGUMENT", `${name} must be JSON serializable.`);
    }
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
        fail("INVALID_ARGUMENT", `${name} exceeds its serialized size limit.`);
    }
    return JSON.parse(serialized);
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function digest(value) {
    return createHash("sha256")
        .update(JSON.stringify(stableValue(value)), "utf8")
        .digest("hex");
}

function clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
}

function freezeResult(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value)) freezeResult(child);
        Object.freeze(value);
    }
    return value;
}

function canonicalAudit({ actor = "system", action, reason = null, details = null }, atUnixMs) {
    return {
        actor: canonicalToken(actor, "audit actor", 160),
        action: canonicalToken(action, "audit action", 100),
        reason: canonicalOptionalText(reason, "audit reason", 500),
        details: jsonValue(details, "audit details", 4096),
        atUnixMs: canonicalMilliseconds(atUnixMs, "audit timestamp")
    };
}

function identity(input) {
    return {
        provider: canonicalProvider(input?.provider),
        providerTransactionId: canonicalToken(
            input?.providerTransactionId,
            "providerTransactionId",
            255
        )
    };
}

function mutationResult(result) {
    if (!result || typeof result.status !== "string") {
        fail("STORE_PROTOCOL_ERROR", "Payment ledger store returned an invalid result.");
    }
    switch (result.status) {
        case "ok":
        case "created":
        case "existing":
        case "already_present":
        case "acquired":
        case "renewed":
        case "released":
        case "busy":
            return freezeResult(clone(result));
        case "missing":
            fail("NOT_FOUND", "Payment ledger record was not found.");
            break;
        case "conflict":
            fail("IMMUTABLE_CONFLICT", "Payment ledger immutable identity conflicts.");
            break;
        case "version_conflict":
            fail("VERSION_CONFLICT", "Payment ledger version precondition failed.", {
                currentVersion: result.currentVersion
            });
            break;
        case "lease_conflict":
            fail("LEASE_LOST", "Payment ledger lease is absent, expired, or owned by another worker.");
            break;
        case "invalid_state":
            fail("INVALID_STATE", "Payment ledger state transition is not allowed.", {
                currentState: result.currentState
            });
            break;
        case "checkpoint_conflict":
            fail("CHECKPOINT_CONFLICT", "Payment checkpoint conflicts with immutable prior evidence.");
            break;
        case "capacity_exceeded":
            fail("CAPACITY_EXCEEDED", "Payment ledger bounded evidence capacity was exceeded.");
            break;
        case "amount_exceeded":
            fail("REVERSAL_AMOUNT_EXCEEDED", "Cumulative reversal amount exceeds the original payment.");
            break;
        case "currency_conflict":
            fail("REVERSAL_CURRENCY_CONFLICT", "Reversal currency differs from the original payment.");
            break;
        default:
            fail("STORE_PROTOCOL_ERROR", `Unsupported payment ledger store status: ${result.status}`);
    }
}

function validatePagination({ cursor = "0", limit = 50 } = {}) {
    const offset = typeof cursor === "number" ? cursor : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) ||
        limit < 1 || limit > 200) {
        fail("INVALID_ARGUMENT", "Payment ledger pagination is invalid.");
    }
    return { cursor: String(offset), limit };
}

function transactionRecord(input, nowUnixMs) {
    const key = identity(input);
    const state = input?.state === undefined ? "Pending" : canonicalState(input.state);
    if (state !== "Pending" && state !== "Quarantined" && state !== "DuplicatePaid") {
        fail("INVALID_ARGUMENT", "New financial transactions must start in a reviewable state.");
    }
    const createdAtUnixMs = input?.createdAtUnixMs === undefined
        ? nowUnixMs
        : canonicalMilliseconds(input.createdAtUnixMs, "createdAtUnixMs");
    const immutable = {
        schemaVersion: PAYMENT_LEDGER_SCHEMA_VERSION,
        ...key,
        orderId: canonicalOptionalToken(input?.orderId, "orderId"),
        receiptId: canonicalOptionalToken(input?.receiptId, "receiptId"),
        playFabId: canonicalToken(input?.playFabId, "playFabId", 160),
        sku: canonicalToken(input?.sku, "sku", 255),
        planVersion: canonicalPositiveInteger(input?.planVersion, "planVersion"),
        planHash: canonicalPlanHash(input?.planHash),
        amountMinor: canonicalMinorUnits(input?.amountMinor),
        currency: canonicalCurrency(input?.currency),
        environment: canonicalEnvironment(input?.environment),
        createdAtUnixMs
    };
    const audit = canonicalAudit({
        actor: input?.createdBy || "system",
        action: "transaction_created",
        reason: input?.creationReason || null,
        details: { state }
    }, createdAtUnixMs);
    return {
        immutable,
        record: {
            ...immutable,
            state,
            updatedAtUnixMs: createdAtUnixMs,
            checkpoints: {},
            stepJournal: {},
            retryCount: 0,
            lastError: null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAtUnixMs: null,
            leaseEpoch: 0,
            reversalStatus: "None",
            reversalIds: [],
            reversedAmountMinor: 0,
            audit: [audit],
            version: 1
        }
    };
}

export function createPaymentLedger({ store, nowMilliseconds = () => Date.now() } = {}) {
    if (!store || REQUIRED_STORE_METHODS.some((method) => typeof store[method] !== "function") ||
        typeof nowMilliseconds !== "function") {
        throw new TypeError("Payment ledger store and clock are required.");
    }

    const now = () => canonicalMilliseconds(nowMilliseconds(), "ledger clock");

    async function createTransaction(input) {
        const built = transactionRecord(input, now());
        const immutableHashMaterial = { ...built.immutable };
        if (input?.createdAtUnixMs === undefined) delete immutableHashMaterial.createdAtUnixMs;
        const result = mutationResult(await store.insertTransaction({
            record: built.record,
            immutableHash: digest(immutableHashMaterial)
        }));
        return result;
    }

    async function getTransaction(input) {
        const key = identity(input);
        const record = await store.getTransaction(key);
        return record ? freezeResult(clone(record)) : null;
    }

    async function requireTransaction(input) {
        const record = await getTransaction(input);
        if (!record) fail("NOT_FOUND", "Payment transaction was not found.");
        return record;
    }

    async function lookup(query, pagination = {}) {
        const page = validatePagination(pagination);
        const provider = query?.provider === undefined ? null : canonicalProvider(query.provider);
        if (query?.providerTransactionId !== undefined) {
            if (!provider) fail("INVALID_ARGUMENT", "provider is required with providerTransactionId.");
            const record = await getTransaction({
                provider,
                providerTransactionId: query.providerTransactionId
            });
            return freezeResult({ items: record ? [record] : [], nextCursor: null });
        }
        const candidates = [
            ["orderId", query?.orderId],
            ["receiptId", query?.receiptId],
            ["playFabId", query?.playFabId],
            ["sku", query?.sku]
        ].filter(([, value]) => value !== undefined);
        if (candidates.length !== 1) {
            fail("INVALID_ARGUMENT", "Exactly one indexed payment lookup field is required.");
        }
        const [index, rawValue] = candidates[0];
        const value = canonicalToken(rawValue, index, index === "playFabId" ? 160 : 255);
        const result = await store.queryTransactions({ index, value, provider, ...page });
        return freezeResult(clone(result));
    }

    async function transition(input, {
        toState,
        expectedVersion = null,
        leaseToken = null,
        actor = "system",
        reason = null,
        details = null,
        lastError = null,
        incrementRetry = false
    } = {}) {
        const key = identity(input);
        const target = canonicalState(toState);
        const allowedFrom = Object.entries(transitionTargets)
            .filter(([, targets]) => targets.has(target))
            .map(([state]) => state);
        if (allowedFrom.length === 0) {
            fail("INVALID_STATE", `No transaction may transition to ${target}.`);
        }
        if (expectedVersion !== null) canonicalPositiveInteger(expectedVersion, "expectedVersion");
        if (typeof incrementRetry !== "boolean") {
            fail("INVALID_ARGUMENT", "incrementRetry must be boolean.");
        }
        const atUnixMs = now();
        const audit = canonicalAudit({
            actor,
            action: `transition_${target.toLowerCase()}`,
            reason,
            details
        }, atUnixMs);
        return mutationResult(await store.mutateTransaction({
            ...key,
            expectedVersion,
            leaseToken: canonicalOptionalToken(leaseToken, "leaseToken", 255),
            atUnixMs,
            command: {
                type: "transition",
                toState: target,
                allowedFrom,
                lastError: canonicalError(lastError),
                incrementRetry,
                audit
            }
        }));
    }

    async function recordCheckpoint(input, {
        name,
        operationId,
        result = null,
        leaseToken,
        expectedVersion = null,
        actor = "worker",
        requireAppliedStep = false
    } = {}) {
        const key = identity(input);
        const checkpointName = canonicalToken(name, "checkpoint name", 80);
        if (!/^[a-z0-9][a-z0-9_.-]*$/u.test(checkpointName)) {
            fail("INVALID_ARGUMENT", "checkpoint name contains unsupported characters.");
        }
        const operation = canonicalToken(operationId, "operationId", 320);
        const stableResult = jsonValue(result, "checkpoint result");
        const atUnixMs = now();
        if (expectedVersion !== null) canonicalPositiveInteger(expectedVersion, "expectedVersion");
        if (typeof requireAppliedStep !== "boolean") {
            fail("INVALID_ARGUMENT", "requireAppliedStep must be boolean.");
        }
        const token = canonicalToken(leaseToken, "leaseToken", 255);
        return mutationResult(await store.mutateTransaction({
            ...key,
            expectedVersion,
            leaseToken: token,
            atUnixMs,
            command: {
                type: "checkpoint",
                name: checkpointName,
                checkpoint: {
                    operationId: operation,
                    resultHash: digest(stableResult),
                    result: stableResult,
                    completedAtUnixMs: atUnixMs
                },
                requireAppliedStep,
                audit: canonicalAudit({
                    actor,
                    action: "checkpoint_completed",
                    details: { name: checkpointName, operationId: operation }
                }, atUnixMs),
                maximumCheckpoints: PAYMENT_LEDGER_MAX_CHECKPOINTS
            }
        }));
    }

    async function beginStep(input, {
        name,
        operationId,
        reward = null,
        expectedState = null,
        transactionLeaseEpoch,
        playerLeaseEpoch,
        leaseToken,
        expectedVersion = null,
        actor = "worker"
    } = {}) {
        const key = identity(input);
        const stepName = canonicalToken(name, "step name", 80);
        if (!/^[a-z0-9][a-z0-9_.-]*$/u.test(stepName)) {
            fail("INVALID_ARGUMENT", "step name contains unsupported characters.");
        }
        const operation = canonicalToken(operationId, "operationId", 320);
        const transactionEpoch = canonicalPositiveInteger(
            transactionLeaseEpoch,
            "transactionLeaseEpoch"
        );
        const playerEpoch = canonicalPositiveInteger(playerLeaseEpoch, "playerLeaseEpoch");
        const stableReward = jsonValue(reward, "step reward", 4096);
        const stableExpectedState = jsonValue(expectedState, "step expected state", 4096);
        const atUnixMs = now();
        if (expectedVersion !== null) canonicalPositiveInteger(expectedVersion, "expectedVersion");
        const token = canonicalToken(leaseToken, "leaseToken", 255);
        return mutationResult(await store.mutateTransaction({
            ...key,
            expectedVersion,
            leaseToken: token,
            atUnixMs,
            command: {
                type: "begin_step",
                name: stepName,
                step: {
                    operationId: operation,
                    status: "StepPending",
                    reward: stableReward,
                    expectedState: stableExpectedState,
                    transactionLeaseEpoch: transactionEpoch,
                    playerLeaseEpoch: playerEpoch,
                    createdAtUnixMs: atUnixMs,
                    updatedAtUnixMs: atUnixMs,
                    result: null,
                    resultHash: null
                },
                audit: canonicalAudit({
                    actor,
                    action: "step_pending",
                    details: {
                        name: stepName,
                        operationId: operation,
                        transactionLeaseEpoch: transactionEpoch,
                        playerLeaseEpoch: playerEpoch
                    }
                }, atUnixMs),
                maximumSteps: PAYMENT_LEDGER_MAX_STEP_JOURNAL_ENTRIES
            }
        }));
    }

    async function recordStepApplied(input, {
        name,
        operationId,
        result = null,
        leaseToken,
        expectedVersion = null,
        actor = "worker"
    } = {}) {
        const key = identity(input);
        const stepName = canonicalToken(name, "step name", 80);
        if (!/^[a-z0-9][a-z0-9_.-]*$/u.test(stepName)) {
            fail("INVALID_ARGUMENT", "step name contains unsupported characters.");
        }
        const operation = canonicalToken(operationId, "operationId", 320);
        const stableResult = jsonValue(result, "step result");
        const atUnixMs = now();
        if (expectedVersion !== null) canonicalPositiveInteger(expectedVersion, "expectedVersion");
        const token = canonicalToken(leaseToken, "leaseToken", 255);
        return mutationResult(await store.mutateTransaction({
            ...key,
            expectedVersion,
            leaseToken: token,
            atUnixMs,
            command: {
                type: "apply_step",
                name: stepName,
                operationId: operation,
                result: stableResult,
                resultHash: digest(stableResult),
                audit: canonicalAudit({
                    actor,
                    action: "step_applied",
                    details: { name: stepName, operationId: operation }
                }, atUnixMs)
            }
        }));
    }

    async function appendAudit(input, entry, { expectedVersion = null } = {}) {
        const key = identity(input);
        if (expectedVersion !== null) canonicalPositiveInteger(expectedVersion, "expectedVersion");
        const atUnixMs = now();
        return mutationResult(await store.mutateTransaction({
            ...key,
            expectedVersion,
            leaseToken: null,
            atUnixMs,
            command: {
                type: "append_audit",
                audit: canonicalAudit(entry, atUnixMs),
                maximumAuditEntries: PAYMENT_LEDGER_MAX_AUDIT_ENTRIES
            }
        }));
    }

    async function acquireLease(input, {
        owner,
        token,
        ttlMilliseconds
    } = {}) {
        const key = identity(input);
        const atUnixMs = now();
        return mutationResult(await store.mutateTransaction({
            ...key,
            atUnixMs,
            expectedVersion: null,
            leaseToken: null,
            command: {
                type: "acquire_lease",
                owner: canonicalToken(owner, "lease owner", 160),
                token: canonicalToken(token, "lease token", 255),
                ttlMilliseconds: canonicalPositiveInteger(ttlMilliseconds, "lease TTL"),
                allowedFrom: ["Pending", "Processing", "Failed"]
            }
        }));
    }

    async function renewLease(input, { token, ttlMilliseconds } = {}) {
        const key = identity(input);
        const atUnixMs = now();
        return mutationResult(await store.mutateTransaction({
            ...key,
            atUnixMs,
            expectedVersion: null,
            leaseToken: canonicalToken(token, "lease token", 255),
            command: {
                type: "renew_lease",
                ttlMilliseconds: canonicalPositiveInteger(ttlMilliseconds, "lease TTL")
            }
        }));
    }

    async function releaseLease(input, { token } = {}) {
        const key = identity(input);
        return mutationResult(await store.mutateTransaction({
            ...key,
            atUnixMs: now(),
            expectedVersion: null,
            leaseToken: canonicalToken(token, "lease token", 255),
            command: { type: "release_lease" }
        }));
    }

    async function acquireResourceLease({ resourceType, resourceId, owner, token, ttlMilliseconds }) {
        return mutationResult(await store.acquireResourceLease({
            resourceType: canonicalToken(resourceType, "resourceType", 40),
            resourceId: canonicalToken(resourceId, "resourceId", 255),
            owner: canonicalToken(owner, "resource lease owner", 160),
            token: canonicalToken(token, "resource lease token", 255),
            ttlMilliseconds: canonicalPositiveInteger(ttlMilliseconds, "resource lease TTL"),
            atUnixMs: now()
        }));
    }

    async function renewResourceLease({ resourceType, resourceId, token, ttlMilliseconds }) {
        return mutationResult(await store.renewResourceLease({
            resourceType: canonicalToken(resourceType, "resourceType", 40),
            resourceId: canonicalToken(resourceId, "resourceId", 255),
            token: canonicalToken(token, "resource lease token", 255),
            ttlMilliseconds: canonicalPositiveInteger(ttlMilliseconds, "resource lease TTL"),
            atUnixMs: now()
        }));
    }

    async function releaseResourceLease({ resourceType, resourceId, token }) {
        return mutationResult(await store.releaseResourceLease({
            resourceType: canonicalToken(resourceType, "resourceType", 40),
            resourceId: canonicalToken(resourceId, "resourceId", 255),
            token: canonicalToken(token, "resource lease token", 255),
            atUnixMs: now()
        }));
    }

    async function createReversal(input) {
        const key = identity(input);
        const original = await requireTransaction(key);
        const atUnixMs = input?.createdAtUnixMs === undefined
            ? now()
            : canonicalMilliseconds(input.createdAtUnixMs, "reversal createdAtUnixMs");
        const immutable = {
            schemaVersion: PAYMENT_LEDGER_SCHEMA_VERSION,
            ...key,
            reversalEventId: canonicalToken(input?.reversalEventId, "reversalEventId", 255),
            type: canonicalReversalType(input?.type),
            amountMinor: canonicalMinorUnits(input?.amountMinor, "reversal amountMinor"),
            currency: canonicalCurrency(input?.currency),
            occurredAtUnixMs: input?.occurredAtUnixMs === undefined
                ? atUnixMs
                : canonicalMilliseconds(input.occurredAtUnixMs, "occurredAtUnixMs"),
            reason: canonicalOptionalText(input?.reason, "reversal reason", 1000),
            playFabId: original.playFabId,
            sku: original.sku
        };
        const record = {
            ...immutable,
            status: "PendingReview",
            supportAction: canonicalOptionalToken(
                input?.supportAction || "flag_account_financial_review",
                "supportAction",
                255
            ),
            entitlementAction: canonicalOptionalToken(
                input?.entitlementAction || "manual_review_no_automatic_clawback",
                "entitlementAction",
                255
            ),
            createdAtUnixMs: atUnixMs,
            updatedAtUnixMs: atUnixMs,
            audit: [canonicalAudit({
                actor: input?.createdBy || "system",
                action: "reversal_recorded",
                reason: immutable.reason,
                details: { type: immutable.type }
            }, atUnixMs)],
            version: 1
        };
        const immutableHashMaterial = { ...immutable };
        if (input?.occurredAtUnixMs === undefined) delete immutableHashMaterial.occurredAtUnixMs;
        return mutationResult(await store.insertReversal({
            record,
            immutableHash: digest(immutableHashMaterial),
            maximumReversals: PAYMENT_LEDGER_MAX_REVERSALS
        }));
    }

    async function getReversal({ provider, reversalEventId }) {
        const record = await store.getReversal({
            provider: canonicalProvider(provider),
            reversalEventId: canonicalToken(reversalEventId, "reversalEventId", 255)
        });
        return record ? freezeResult(clone(record)) : null;
    }

    async function transitionReversal(input, {
        toStatus,
        expectedVersion = null,
        actor,
        reason = null,
        details = null
    } = {}) {
        const provider = canonicalProvider(input?.provider);
        const reversalEventId = canonicalToken(input?.reversalEventId, "reversalEventId", 255);
        const target = canonicalReversalStatus(toStatus);
        const allowedFrom = Object.entries(reversalTransitionTargets)
            .filter(([, targets]) => targets.has(target))
            .map(([status]) => status);
        if (allowedFrom.length === 0) {
            fail("INVALID_STATE", `No reversal may transition to ${target}.`);
        }
        if (expectedVersion !== null) canonicalPositiveInteger(expectedVersion, "expectedVersion");
        const atUnixMs = now();
        return mutationResult(await store.mutateReversal({
            provider,
            reversalEventId,
            expectedVersion,
            atUnixMs,
            command: {
                type: "transition",
                toStatus: target,
                allowedFrom,
                audit: canonicalAudit({
                    actor: canonicalToken(actor, "reversal audit actor", 160),
                    action: `reversal_${target.toLowerCase()}`,
                    reason,
                    details
                }, atUnixMs)
            }
        }));
    }

    async function lookupReversals(query, pagination = {}) {
        const page = validatePagination(pagination);
        const candidates = [
            ["originalTransaction", query?.providerTransactionId],
            ["playFabId", query?.playFabId],
            ["type", query?.type],
            ["status", query?.status]
        ].filter(([, value]) => value !== undefined);
        if (candidates.length !== 1) {
            fail("INVALID_ARGUMENT", "Exactly one indexed reversal lookup field is required.");
        }
        const [index, rawValue] = candidates[0];
        let value;
        if (index === "type") value = canonicalReversalType(rawValue);
        else if (index === "status") value = canonicalReversalStatus(rawValue);
        else value = canonicalToken(rawValue, index, 255);
        const provider = query?.provider === undefined ? null : canonicalProvider(query.provider);
        const result = await store.queryReversals({ index, value, provider, ...page });
        return freezeResult(clone(result));
    }

    async function scanTransactions(pagination = {}) {
        return freezeResult(clone(await store.scanTransactions(validatePagination(pagination))));
    }

    async function scanReversals(pagination = {}) {
        return freezeResult(clone(await store.scanReversals(validatePagination(pagination))));
    }

    async function ping() {
        const result = await store.ping();
        if (result !== true) fail("STORE_UNAVAILABLE", "Payment ledger store probe failed.");
        return true;
    }

    return Object.freeze({
        createTransaction,
        getTransaction,
        requireTransaction,
        lookup,
        transition,
        beginStep,
        recordStepApplied,
        recordCheckpoint,
        appendAudit,
        acquireLease,
        renewLease,
        releaseLease,
        acquireResourceLease,
        renewResourceLease,
        releaseResourceLease,
        createReversal,
        getReversal,
        transitionReversal,
        lookupReversals,
        scanTransactions,
        scanReversals,
        ping
    });
}
