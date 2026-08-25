import { createPlayFabFinancialProfileClient } from "./playfab-financial-profile-store.js";
import {
    PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
    validateFinancialAuthority
} from "./financial-authority-v2.js";

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function serialize(value) {
    const json = JSON.stringify(value);
    if (typeof json !== "string" || /(?:NaN|Infinity)/u.test(json)) {
        throw new TypeError("Financial authority must be strict JSON.");
    }
    return json;
}

function isVersionConflict(error) {
    const providerCode = error?.providerErrorCode ?? error?.errorCode ??
        (Number.isSafeInteger(error?.code) ? error.code : null);
    return error?.code === "EntityProfileVersionMismatch" ||
        error?.code === "ConcurrentEditError" || error?.providerError === "EntityProfileVersionMismatch" ||
        error?.providerError === "ConcurrentEditError" || providerCode === 1352 || providerCode === 1133;
}

function coded(code, message, retryable = false, cause = null) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    if (cause) error.cause = cause;
    return error;
}

function requireMonotonicSet(current, next, name) {
    const nextValues = new Set(next);
    if (current.some((value) => !nextValues.has(value))) {
        throw new TypeError(`FinancialAuthorityV2 ${name} cannot remove durable evidence.`);
    }
}

function requireMonotonicAuthority(current, next) {
    for (const name of [
        "appliedOperations",
        "appliedTransactionIds",
        "paidDestinationMarkerIds",
        "paidShipDesignIds",
        "ownedStarterSkus"
    ]) {
        requireMonotonicSet(current[name], next[name], name);
    }
    if (serialize(current.migration) !== serialize(next.migration)) {
        throw new TypeError("FinancialAuthorityV2 migration proof is immutable.");
    }
    const currentExpiry = current.premium.expiresAtUtcIso8601 === null
        ? null
        : Date.parse(current.premium.expiresAtUtcIso8601);
    const nextExpiry = next.premium.expiresAtUtcIso8601 === null
        ? null
        : Date.parse(next.premium.expiresAtUtcIso8601);
    if (currentExpiry !== null && (nextExpiry === null || nextExpiry < currentExpiry)) {
        throw new TypeError("FinancialAuthorityV2 Premium expiration cannot decrease.");
    }
    if (currentExpiry !== null && nextExpiry === currentExpiry &&
        next.premium.tier < current.premium.tier) {
        throw new TypeError("FinancialAuthorityV2 Premium tier cannot decrease at the same expiration.");
    }
}

export function createPlayFabFinancialAuthorityStore({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMs,
    maximumObjectBytes = 64 * 1024,
    maximumAppliedOperations = 4096,
    maximumAppliedTransactions = 4096
} = {}) {
    const playFab = client || createPlayFabFinancialProfileClient({
        titleId,
        secretKey,
        fetchImpl,
        timeoutMs
    });
    for (const method of ["getUserAccountInfo", "getEntityToken", "getObjects", "setObjects"]) {
        if (typeof playFab?.[method] !== "function") throw new TypeError(`PlayFab client.${method} is required.`);
    }
    for (const [name, value] of [
        ["maximumObjectBytes", maximumObjectBytes],
        ["maximumAppliedOperations", maximumAppliedOperations],
        ["maximumAppliedTransactions", maximumAppliedTransactions]
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} is invalid.`);
    }

    async function context(playFabId) {
        canonical(playFabId, "playFabId", 128);
        const account = await playFab.getUserAccountInfo(playFabId);
        if (account?.UserInfo?.PlayFabId !== undefined && account.UserInfo.PlayFabId !== playFabId) {
            throw coded("PLAYFAB_IDENTITY_MISMATCH", "PlayFab returned another legacy account.");
        }
        const entityId = canonical(
            account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
            "TitlePlayerAccount.Id",
            128
        );
        const tokenResult = await playFab.getEntityToken();
        const token = canonical(tokenResult?.EntityToken, "EntityToken", 8192);
        return { entity: { Id: entityId, Type: "title_player_account" }, token };
    }

    function objectFrom(result) {
        return result?.Objects?.[PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME]?.DataObject ?? null;
    }

    function validate(value, playFabId) {
        return validateFinancialAuthority(value, playFabId, {
            maximumAppliedOperations,
            maximumAppliedTransactions
        });
    }

    function ensureSize(authority) {
        if (new TextEncoder().encode(serialize(authority)).byteLength > maximumObjectBytes) {
            throw new RangeError("FinancialAuthorityV2 exceeds the configured PlayFab object limit.");
        }
    }

    async function readWithContext(playFabId, ctx) {
        const result = await playFab.getObjects(ctx.entity, ctx.token);
        const objectVersion = nonNegativeInteger(result?.ProfileVersion ?? 0, "ProfileVersion");
        const object = objectFrom(result);
        if (object === null) {
            return { migrated: false, objectVersion, authority: null, financialRevision: 0 };
        }
        const authority = validate(object, playFabId);
        return {
            migrated: true,
            objectVersion,
            financialRevision: authority.financialRevision,
            authority: structuredClone(authority)
        };
    }

    async function read(playFabId) {
        const ctx = await context(playFabId);
        return readWithContext(playFabId, ctx);
    }

    async function initialize({ playFabId, expectedObjectVersion, authority }) {
        canonical(playFabId, "playFabId", 128);
        nonNegativeInteger(expectedObjectVersion, "expectedObjectVersion");
        validate(authority, playFabId);
        if (authority.financialRevision !== 1 || authority.appliedOperations.length !== 0 ||
            authority.lastFencingToken !== 0) {
            throw new TypeError("Initial FinancialAuthorityV2 proof is invalid.");
        }
        ensureSize(authority);
        const ctx = await context(playFabId);
        const current = await readWithContext(playFabId, ctx);
        if (current.migrated) return { applied: false, reason: "already_migrated", ...current };
        if (current.objectVersion !== expectedObjectVersion) {
            return { applied: false, reason: "version_conflict", ...current };
        }
        try {
            const write = await playFab.setObjects(ctx.entity, ctx.token, expectedObjectVersion, [{
                ObjectName: PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
                DataObject: structuredClone(authority)
            }]);
            return {
                applied: true,
                reason: "migrated",
                migrated: true,
                objectVersion: nonNegativeInteger(write?.ProfileVersion, "ProfileVersion"),
                financialRevision: authority.financialRevision,
                authority: structuredClone(authority)
            };
        } catch (error) {
            if (isVersionConflict(error)) return { applied: false, reason: "version_conflict", ...(await readWithContext(playFabId, ctx)) };
            const recovered = await readWithContext(playFabId, ctx).catch(() => null);
            if (recovered?.migrated && serialize(recovered.authority) === serialize(authority)) {
                return { applied: false, reason: "already_migrated", ...recovered };
            }
            throw coded(
                "AMBIGUOUS_PROVIDER_RESULT",
                "FinancialAuthorityV2 initialization result is ambiguous.",
                true,
                error
            );
        }
    }

    async function compareAndSet({
        playFabId,
        expectedObjectVersion,
        expectedFinancialRevision,
        authority,
        operationId,
        fencingToken
    }) {
        canonical(playFabId, "playFabId", 128);
        canonical(operationId, "operationId");
        nonNegativeInteger(expectedObjectVersion, "expectedObjectVersion");
        nonNegativeInteger(expectedFinancialRevision, "expectedFinancialRevision");
        nonNegativeInteger(fencingToken, "fencingToken");
        validate(authority, playFabId);
        ensureSize(authority);
        const ctx = await context(playFabId);
        const current = await readWithContext(playFabId, ctx);
        if (!current.migrated) throw coded("FINANCIAL_AUTHORITY_NOT_MIGRATED", "Player has no FinancialAuthorityV2 migration proof.");
        if (current.authority.appliedOperations.includes(operationId)) {
            return { applied: false, reason: "already_applied", ...current };
        }
        if (fencingToken === 0 || fencingToken <= current.authority.lastFencingToken) {
            return { applied: false, reason: "stale_fencing", ...current };
        }
        if (current.objectVersion !== expectedObjectVersion ||
            current.financialRevision !== expectedFinancialRevision) {
            return { applied: false, reason: "version_conflict", ...current };
        }
        requireMonotonicAuthority(current.authority, authority);
        if (authority.financialRevision !== current.financialRevision + 1 ||
            authority.lastFencingToken !== fencingToken ||
            !authority.appliedOperations.includes(operationId)) {
            throw new TypeError("FinancialAuthorityV2 mutation proof is inconsistent.");
        }
        try {
            const write = await playFab.setObjects(ctx.entity, ctx.token, expectedObjectVersion, [{
                ObjectName: PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
                DataObject: structuredClone(authority)
            }]);
            const verified = await readWithContext(playFabId, ctx);
            if (!verified.migrated || !verified.authority.appliedOperations.includes(operationId) ||
                serialize(verified.authority) !== serialize(authority)) {
                throw coded("FINANCIAL_AUTHORITY_VERIFY_FAILED", "FinancialAuthorityV2 write verification failed.");
            }
            return {
                applied: true,
                reason: "applied",
                ...verified,
                objectVersion: nonNegativeInteger(write?.ProfileVersion, "ProfileVersion")
            };
        } catch (error) {
            if (isVersionConflict(error)) return { applied: false, reason: "version_conflict", ...(await readWithContext(playFabId, ctx)) };
            const recovered = await readWithContext(playFabId, ctx).catch(() => null);
            if (recovered?.authority?.appliedOperations?.includes(operationId) &&
                serialize(recovered.authority) === serialize(authority)) {
                return { applied: false, reason: "already_applied", ...recovered };
            }
            if (error?.code === "FINANCIAL_AUTHORITY_VERIFY_FAILED") throw error;
            throw coded(
                "AMBIGUOUS_PROVIDER_RESULT",
                "FinancialAuthorityV2 mutation result is ambiguous.",
                true,
                error
            );
        }
    }

    async function probe() {
        const token = await playFab.getEntityToken();
        canonical(token?.EntityToken, "EntityToken", 8192);
        return true;
    }

    return Object.freeze({
        read,
        initialize,
        compareAndSet,
        probe,
        objectName: PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
        authorityVersion: "financial_v2"
    });
}
