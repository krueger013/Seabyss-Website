import { createHash } from "node:crypto";
import { createPlayFabFinancialProfileClient } from "./playfab-financial-profile-store.js";
import {
    createServerEconomyPocInitialSnapshot,
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";
import {
    sameServerEconomyPocHighValueProviderProof,
    validateServerEconomyPocHighValueProviderProof
} from "./server-economy-poc-provider-proof.js";
import {
    sameServerEconomyPocAmmoBatchProof,
    validateServerEconomyPocAmmoBatchProof
} from "./server-economy-poc-ammo-proof.js";


export const SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME = "SeabyssEconomyStateV1";
export const SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME = "SeabyssEconomyFenceV1";
export const SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME = "SeabyssEconomyProofV1";
export const SERVER_ECONOMY_POC_PLAYFAB_AMMO_PROOF_OBJECT_NAME = "SeabyssEconomyAmmoProofV1";

const FENCE_FIELDS = Object.freeze([
    "activatedAtUnixMs",
    "fencingEpoch",
    "leaseTokenDigest",
    "playFabId",
    "schemaVersion"
]);

function serialize(value) {
    const json = JSON.stringify(value);
    if (typeof json !== "string" || /(?:NaN|Infinity)/u.test(json)) {
        throw new TypeError("Server economy POC value must be strict JSON.");
    }
    return json;
}

function versionConflict(error) {
    const providerCode = error?.providerErrorCode ?? error?.errorCode ??
        (Number.isSafeInteger(error?.code) ? error.code : null);
    return error?.code === "EntityProfileVersionMismatch" ||
        error?.code === "ConcurrentEditError" || error?.providerError === "EntityProfileVersionMismatch" ||
        error?.providerError === "ConcurrentEditError" || providerCode === 1352 || providerCode === 1133;
}

function maximumBytes(snapshot, maximumObjectBytes) {
    if (new TextEncoder().encode(serialize(snapshot)).byteLength > maximumObjectBytes) {
        serverEconomyPocFail("POC_PLAYFAB_OBJECT_TOO_LARGE", "Server economy POC snapshot exceeds its PlayFab object limit.");
    }
}

function monotonic(current, next, fencingEpoch) {
    if (next.revision !== current.revision + 1 || next.fencingEpoch !== fencingEpoch ||
        next.fencingEpoch < current.fencingEpoch ||
        next.highValueAppliedThroughSequence < current.highValueAppliedThroughSequence ||
        next.ammoAppliedThroughSequence < current.ammoAppliedThroughSequence) {
        serverEconomyPocFail("POC_SNAPSHOT_CAS_INVALID", "PlayFab snapshot violates revision, sequence, or fencing monotonicity.");
    }
    const currentExpiry = current.premium.expiresAtUnixMs;
    const nextExpiry = next.premium.expiresAtUnixMs;
    if (currentExpiry !== null && (nextExpiry === null || nextExpiry < currentExpiry)) {
        serverEconomyPocFail("POC_SNAPSHOT_CAS_INVALID", "Premium expiration cannot decrease.");
    }
}

function digestLeaseToken(token) {
    return createHash("sha256").update(serverEconomyPocId(token, "leaseToken", 255), "utf8").digest("hex");
}

function validateFence(value, playFabId) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(FENCE_FIELDS)) {
        serverEconomyPocFail("POC_PLAYFAB_FENCE_CORRUPT", "PlayFab provider fence has an invalid schema.");
    }
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    if (value.schemaVersion !== 1 || value.playFabId !== player ||
        !Number.isSafeInteger(value.fencingEpoch) || value.fencingEpoch <= 0 ||
        typeof value.leaseTokenDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.leaseTokenDigest) ||
        !Number.isSafeInteger(value.activatedAtUnixMs) || value.activatedAtUnixMs < 0) {
        serverEconomyPocFail("POC_PLAYFAB_FENCE_CORRUPT", "PlayFab provider fence is malformed or belongs to another player.");
    }
    return serverEconomyPocReadonly(value);
}

function sameFence(fence, fencingEpoch, leaseTokenDigest) {
    return fence?.fencingEpoch === fencingEpoch && fence?.leaseTokenDigest === leaseTokenDigest;
}

function staleFence(message = "PlayFab provider fence is absent, stale, or owned by another worker.") {
    serverEconomyPocFail("POC_STALE_WRITER", message, { retryable: true, statusCode: 409 });
}

export const PLAYFAB_CAS_RECONCILIATION_APPLIED = "APPLIED";
export const PLAYFAB_CAS_RECONCILIATION_NOT_APPLIED = "NOT_APPLIED";
export const PLAYFAB_CAS_RECONCILIATION_PROOF_MISMATCH = "PROOF_MISMATCH";
export const PLAYFAB_CAS_RECONCILIATION_UNKNOWN = "UNKNOWN";

function sameOptionalProviderProof(left, right, compare) {
    if (left === null || left === undefined || right === null || right === undefined) {
        return (left === null || left === undefined) && (right === null || right === undefined);
    }
    return compare(left, right);
}

/**
 * Classifies an ambiguous provider result from complete before/after evidence.
 * NOT_APPLIED is intentionally strict: even an unrelated entity ProfileVersion,
 * fence, snapshot or proof change keeps the outcome UNKNOWN.
 */
export function classifyServerEconomyPocPlayFabCasReadback({
    current,
    latest,
    nextSnapshot,
    verifiedProof = null,
    verifiedAmmoProof = null
} = {}) {
    if (!current?.exists || !latest?.exists || !nextSnapshot) {
        return PLAYFAB_CAS_RECONCILIATION_UNKNOWN;
    }
    const snapshotApplied = serialize(latest.snapshot) === serialize(nextSnapshot);
    const highValueProofExpected = verifiedProof
        ? sameServerEconomyPocHighValueProviderProof(latest.highValueProof, verifiedProof)
        : false;
    const ammoProofExpected = verifiedAmmoProof
        ? sameServerEconomyPocAmmoBatchProof(latest.ammoProof, verifiedAmmoProof)
        : false;
    const highValueProofUnchanged = sameOptionalProviderProof(
        latest.highValueProof,
        current.highValueProof,
        sameServerEconomyPocHighValueProviderProof
    );
    const ammoProofUnchanged = sameOptionalProviderProof(
        latest.ammoProof,
        current.ammoProof,
        sameServerEconomyPocAmmoBatchProof
    );
    const highValueProofApplied = verifiedProof
        ? highValueProofExpected
        : highValueProofUnchanged;
    const ammoProofApplied = verifiedAmmoProof
        ? ammoProofExpected
        : ammoProofUnchanged;
    if (snapshotApplied && highValueProofApplied && ammoProofApplied) {
        return PLAYFAB_CAS_RECONCILIATION_APPLIED;
    }

    const highValueProofConflicted = verifiedProof
        ? !highValueProofExpected && !highValueProofUnchanged
        : !highValueProofUnchanged;
    const ammoProofConflicted = verifiedAmmoProof
        ? !ammoProofExpected && !ammoProofUnchanged
        : !ammoProofUnchanged;
    if (highValueProofConflicted || ammoProofConflicted ||
        snapshotApplied && (!highValueProofApplied || !ammoProofApplied)) {
        return PLAYFAB_CAS_RECONCILIATION_PROOF_MISMATCH;
    }

    // Expected ProfileVersion equality proves that no object in this atomic
    // Entity SetObjects call (including migration markers/result hashes) changed.
    const providerUnchanged = latest.objectVersion === current.objectVersion &&
        serialize(latest.snapshot) === serialize(current.snapshot) &&
        serialize(latest.fence) === serialize(current.fence) &&
        highValueProofUnchanged && ammoProofUnchanged;
    return providerUnchanged
        ? PLAYFAB_CAS_RECONCILIATION_NOT_APPLIED
        : PLAYFAB_CAS_RECONCILIATION_UNKNOWN;
}

function notApplied(cause, operation, latest) {
    const error = new Error(`PlayFab snapshot ${operation} was proven not applied.`);
    error.code = "POC_PLAYFAB_NOT_APPLIED";
    error.retryable = true;
    error.classification = PLAYFAB_CAS_RECONCILIATION_NOT_APPLIED;
    error.providerObjectVersion = latest.objectVersion;
    error.businessRevision = latest.snapshot.revision;
    for (const field of [
        "providerError", "providerErrorCode", "status", "retryAfterMilliseconds",
        "rateLimitRetryExhausted", "rateLimitRetryRefused", "attempts"
    ]) {
        if (cause?.[field] !== undefined) error[field] = cause[field];
    }
    error.cause = cause;
    return error;
}

function ambiguous(cause, operation) {
    const error = new Error(`PlayFab snapshot ${operation} result is ambiguous.`);
    error.code = "POC_PLAYFAB_AMBIGUOUS_RESULT";
    error.retryable = false;
    error.manualReview = true;
    error.classification = PLAYFAB_CAS_RECONCILIATION_UNKNOWN;
    error.cause = cause;
    return error;
}

export function createServerEconomyPocPlayFabSnapshotStore({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMs,
    maximumObjectBytes = 32 * 1024,
    maximumFenceActivationAttempts = 5,
    assertPlayerFence,
    nowMilliseconds = () => Date.now()
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
    if (!Number.isSafeInteger(maximumObjectBytes) || maximumObjectBytes < 1024 ||
        !Number.isSafeInteger(maximumFenceActivationAttempts) || maximumFenceActivationAttempts < 1 ||
        maximumFenceActivationAttempts > 20 || typeof assertPlayerFence !== "function" ||
        typeof nowMilliseconds !== "function") {
        throw new TypeError("PlayFab server economy POC requires a fence authority, clocks, and valid bounds.");
    }

    async function assertExternalFence(playFabId, leaseToken, fencingEpoch) {
        await assertPlayerFence({
            playFabId,
            token: leaseToken,
            epoch: fencingEpoch
        });
    }

    async function context(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const account = await playFab.getUserAccountInfo(player);
        if (account?.UserInfo?.PlayFabId !== player) {
            serverEconomyPocFail("POC_PLAYFAB_IDENTITY_MISMATCH", "PlayFab resolved another legacy player identity.");
        }
        const entityId = serverEconomyPocId(
            account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
            "TitlePlayerAccount.Id",
            160
        );
        const tokenResult = await playFab.getEntityToken();
        const entityToken = serverEconomyPocId(tokenResult?.EntityToken, "EntityToken", 8192);
        return Object.freeze({
            player,
            entity: Object.freeze({ Id: entityId, Type: "title_player_account" }),
            entityToken
        });
    }

    function objectData(result, objectName) {
        return result?.Objects?.[objectName]?.DataObject ?? null;
    }

    async function readWithContext(ctx) {
        const result = await playFab.getObjects(ctx.entity, ctx.entityToken);
        const objectVersion = serverEconomyPocNonNegative(result?.ProfileVersion ?? 0, "ProfileVersion");
        const value = objectData(result, SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
        const fence = validateFence(
            objectData(result, SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME),
            ctx.player
        );
        const proofValue = objectData(result, SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME);
        const highValueProof = proofValue === null
            ? null
            : validateServerEconomyPocHighValueProviderProof(proofValue, ctx.player);
        const ammoProofValue = objectData(result, SERVER_ECONOMY_POC_PLAYFAB_AMMO_PROOF_OBJECT_NAME);
        const ammoProof = ammoProofValue === null
            ? null
            : validateServerEconomyPocAmmoBatchProof(ammoProofValue, ctx.player);
        if (value === null) {
            if (highValueProof || ammoProof) {
                serverEconomyPocFail("POC_PROVIDER_PROOF_CORRUPT", "Provider proof exists without an economy snapshot.");
            }
            return Object.freeze({
                exists: false, objectVersion, snapshot: null, fence, highValueProof: null, ammoProof: null
            });
        }
        validateServerEconomyPocSnapshot(value, ctx.player);
        return serverEconomyPocReadonly({ exists: true, objectVersion, snapshot: value, fence, highValueProof, ammoProof });
    }

    async function readWithMetadata(playFabId) {
        return readWithContext(await context(playFabId));
    }

    async function read(playFabId) {
        const value = await readWithMetadata(playFabId);
        if (!value.exists) {
            serverEconomyPocFail(
                "POC_PLAYFAB_SNAPSHOT_NOT_INITIALIZED",
                "Server economy POC snapshot requires explicit initialization."
            );
        }
        return value.snapshot;
    }

    async function initialize({ playFabId, expectedObjectVersion, initializedAtUnixMs = 0 } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const expectedVersion = serverEconomyPocNonNegative(expectedObjectVersion, "expectedObjectVersion");
        const initial = createServerEconomyPocInitialSnapshot(
            player,
            serverEconomyPocNonNegative(initializedAtUnixMs, "initializedAtUnixMs")
        );
        maximumBytes(initial, maximumObjectBytes);
        const ctx = await context(player);
        const current = await readWithContext(ctx);
        if (current.exists) return serverEconomyPocReadonly({ status: "already_initialized", ...current });
        if (current.objectVersion !== expectedVersion) {
            return serverEconomyPocReadonly({ status: "version_conflict", ...current });
        }
        try {
            await playFab.setObjects(ctx.entity, ctx.entityToken, expectedVersion, [{
                ObjectName: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
                DataObject: serverEconomyPocClone(initial)
            }]);
            const verified = await readWithContext(ctx);
            if (!verified.exists || serialize(verified.snapshot) !== serialize(initial)) {
                serverEconomyPocFail("POC_PLAYFAB_VERIFY_FAILED", "Explicit snapshot initialization did not verify.");
            }
            return serverEconomyPocReadonly({ status: "initialized", ...verified });
        } catch (error) {
            if (versionConflict(error)) {
                return serverEconomyPocReadonly({ status: "version_conflict", ...(await readWithContext(ctx)) });
            }
            const recovered = await readWithContext(ctx).catch(() => null);
            if (recovered?.exists && serialize(recovered.snapshot) === serialize(initial)) {
                return serverEconomyPocReadonly({ status: "initialized_recovered", ...recovered });
            }
            if (error?.code === "POC_PLAYFAB_VERIFY_FAILED") throw error;
            throw ambiguous(error, "initialization");
        }
    }

    async function activateFence({ playFabId, leaseToken, fencingEpoch } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const token = serverEconomyPocId(leaseToken, "leaseToken", 255);
        const epoch = serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
        const leaseTokenDigest = digestLeaseToken(token);

        for (let attempt = 1; attempt <= maximumFenceActivationAttempts; attempt += 1) {
            await assertExternalFence(player, token, epoch);
            const ctx = await context(player);
            const current = await readWithContext(ctx);
            if (!current.exists) {
                serverEconomyPocFail(
                    "POC_PLAYFAB_SNAPSHOT_NOT_INITIALIZED",
                    "Provider fence cannot activate before explicit snapshot initialization."
                );
            }
            if (current.fence?.fencingEpoch > epoch) staleFence("A newer PlayFab provider fence is already active.");
            if (current.fence?.fencingEpoch === epoch && !sameFence(current.fence, epoch, leaseTokenDigest)) {
                staleFence("The PlayFab provider fence epoch is owned by another lease token.");
            }
            if (sameFence(current.fence, epoch, leaseTokenDigest)) {
                await assertExternalFence(player, token, epoch);
                return serverEconomyPocReadonly({
                    status: "active",
                    objectVersion: current.objectVersion,
                    fence: current.fence
                });
            }

            const intended = Object.freeze({
                schemaVersion: 1,
                playFabId: player,
                fencingEpoch: epoch,
                leaseTokenDigest,
                activatedAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "fence activation clock")
            });
            await assertExternalFence(player, token, epoch);
            try {
                await playFab.setObjects(ctx.entity, ctx.entityToken, current.objectVersion, [{
                    ObjectName: SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
                    DataObject: serverEconomyPocClone(intended)
                }]);
                const verified = await readWithContext(ctx);
                if (!sameFence(verified.fence, epoch, leaseTokenDigest)) {
                    serverEconomyPocFail("POC_PLAYFAB_VERIFY_FAILED", "Provider fence activation did not verify.");
                }
                await assertExternalFence(player, token, epoch);
                return serverEconomyPocReadonly({
                    status: "activated",
                    objectVersion: verified.objectVersion,
                    fence: verified.fence
                });
            } catch (error) {
                if (versionConflict(error)) continue;
                const recovered = await readWithContext(ctx).catch(() => null);
                if (sameFence(recovered?.fence, epoch, leaseTokenDigest)) {
                    await assertExternalFence(player, token, epoch);
                    return serverEconomyPocReadonly({
                        status: "activated_recovered",
                        objectVersion: recovered.objectVersion,
                        fence: recovered.fence
                    });
                }
                if (recovered?.fence?.fencingEpoch > epoch) staleFence("A newer provider fence won activation.");
                if (error?.code === "POC_PLAYFAB_VERIFY_FAILED") throw error;
                throw ambiguous(error, "provider fence activation");
            }
        }
        serverEconomyPocFail(
            "POC_PLAYFAB_FENCE_ACTIVATION_CONFLICT",
            "Provider fence activation exhausted bounded profile-version retries.",
            { retryable: true, statusCode: 409 }
        );
    }

    async function assertActiveFence({ playFabId, leaseToken, fencingEpoch } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const token = serverEconomyPocId(leaseToken, "leaseToken", 255);
        const epoch = serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
        const leaseTokenDigest = digestLeaseToken(token);
        await assertExternalFence(player, token, epoch);
        const current = await readWithMetadata(player);
        if (!current.exists || !sameFence(current.fence, epoch, leaseTokenDigest)) staleFence();
        await assertExternalFence(player, token, epoch);
        return serverEconomyPocReadonly({
            status: "active",
            objectVersion: current.objectVersion,
            fence: current.fence
        });
    }

    async function compareAndSet({
        playFabId,
        expectedRevision,
        leaseToken,
        fencingEpoch,
        nextSnapshot,
        operationProof = null,
        ammoProof = null
    } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const revision = serverEconomyPocNonNegative(expectedRevision, "expectedRevision");
        const token = serverEconomyPocId(leaseToken, "leaseToken", 255);
        const epoch = serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
        const leaseTokenDigest = digestLeaseToken(token);
        validateServerEconomyPocSnapshot(nextSnapshot, player);
        maximumBytes(nextSnapshot, maximumObjectBytes);

        await assertExternalFence(player, token, epoch);
        const ctx = await context(player);
        const current = await readWithContext(ctx);
        if (!current.exists) {
            serverEconomyPocFail("POC_PLAYFAB_SNAPSHOT_NOT_INITIALIZED", "Snapshot CAS cannot implicitly initialize a player.");
        }
        if (!sameFence(current.fence, epoch, leaseTokenDigest)) staleFence();
        if (current.snapshot.revision !== revision) {
            return serverEconomyPocReadonly({ status: "version_conflict", snapshot: current.snapshot });
        }
        monotonic(current.snapshot, nextSnapshot, epoch);

        const highValueAdvance = nextSnapshot.highValueAppliedThroughSequence -
            current.snapshot.highValueAppliedThroughSequence;
        let verifiedProof = null;
        if (highValueAdvance !== 0) {
            if (highValueAdvance !== 1 || operationProof === null) {
                serverEconomyPocFail("POC_PROVIDER_PROOF_REQUIRED", "High-value PlayFab CAS requires one exact provider proof.");
            }
            verifiedProof = validateServerEconomyPocHighValueProviderProof(operationProof, player);
            if (verifiedProof.sequence !== nextSnapshot.highValueAppliedThroughSequence) {
                serverEconomyPocFail("POC_PROVIDER_PROOF_MISMATCH", "Provider proof sequence differs from the high-value cursor.");
            }
            maximumBytes(verifiedProof, maximumObjectBytes);
        } else if (operationProof !== null) {
            serverEconomyPocFail("POC_PROVIDER_PROOF_MISMATCH", "Ammo-only PlayFab CAS cannot attach a high-value proof.");
        }

        const ammoAdvance = nextSnapshot.ammoAppliedThroughSequence -
            current.snapshot.ammoAppliedThroughSequence;
        let verifiedAmmoProof = null;
        if (ammoAdvance !== 0) {
            if (highValueAdvance !== 0 || ammoProof === null) {
                serverEconomyPocFail("POC_AMMO_PROOF_REQUIRED", "Ammo PlayFab CAS requires one exact provider batch proof.");
            }
            verifiedAmmoProof = validateServerEconomyPocAmmoBatchProof(ammoProof, player);
            if (verifiedAmmoProof.firstSequence !== current.snapshot.ammoAppliedThroughSequence + 1 ||
                verifiedAmmoProof.throughSequence !== nextSnapshot.ammoAppliedThroughSequence ||
                verifiedAmmoProof.eventCount !== ammoAdvance) {
                serverEconomyPocFail(
                    "POC_AMMO_PROOF_MISMATCH",
                    "Ammo provider proof range differs from the PlayFab snapshot cursor advance."
                );
            }
            maximumBytes(verifiedAmmoProof, maximumObjectBytes);
        } else if (ammoProof !== null) {
            serverEconomyPocFail(
                "POC_AMMO_PROOF_MISMATCH",
                "Non-ammo PlayFab CAS cannot attach an ammo provider proof."
            );
        }

        const writes = [{
            ObjectName: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
            DataObject: serverEconomyPocClone(nextSnapshot)
        }];
        if (verifiedProof) {
            writes.push({
                ObjectName: SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME,
                DataObject: serverEconomyPocClone(verifiedProof)
            });
        }
        if (verifiedAmmoProof) {
            writes.push({
                ObjectName: SERVER_ECONOMY_POC_PLAYFAB_AMMO_PROOF_OBJECT_NAME,
                DataObject: serverEconomyPocClone(verifiedAmmoProof)
            });
        }
        await assertExternalFence(player, token, epoch);

        try {
            await playFab.setObjects(ctx.entity, ctx.entityToken, current.objectVersion, writes);
            const verified = await readWithContext(ctx);
            if (!verified.exists || serialize(verified.snapshot) !== serialize(nextSnapshot) ||
                verifiedProof && !sameServerEconomyPocHighValueProviderProof(verified.highValueProof, verifiedProof) ||
                verifiedAmmoProof && !sameServerEconomyPocAmmoBatchProof(verified.ammoProof, verifiedAmmoProof)) {
                serverEconomyPocFail("POC_PLAYFAB_VERIFY_FAILED", "PlayFab snapshot/proof CAS readback differs from the intended state.");
            }
            return serverEconomyPocReadonly({
                status: "updated",
                snapshot: verified.snapshot,
                handoffAfterWrite: !sameFence(verified.fence, epoch, leaseTokenDigest)
            });
        } catch (error) {
            if (error?.providerRequestAttempted === false) throw error;
            const latest = await readWithContext(ctx).catch(() => null);
            if (error?.providerReconciliationClassification ===
                PLAYFAB_CAS_RECONCILIATION_PROOF_MISMATCH) throw error;
            const classification = classifyServerEconomyPocPlayFabCasReadback({
                current,
                latest,
                nextSnapshot,
                verifiedProof,
                verifiedAmmoProof
            });
            if (classification === PLAYFAB_CAS_RECONCILIATION_APPLIED) {
                return serverEconomyPocReadonly({
                    status: "updated",
                    snapshot: latest.snapshot,
                    recovered: true,
                    handoffAfterWrite: !sameFence(latest.fence, epoch, leaseTokenDigest)
                });
            }
            if (latest?.fence && !sameFence(latest.fence, epoch, leaseTokenDigest)) staleFence();
            if (versionConflict(error)) {
                if (!latest?.exists) {
                    throw ambiguous(error, "CAS conflict readback");
                }
                return serverEconomyPocReadonly({ status: "version_conflict", snapshot: latest.snapshot });
            }
            if (classification === PLAYFAB_CAS_RECONCILIATION_PROOF_MISMATCH) {
                serverEconomyPocFail("POC_PROVIDER_PROOF_MISMATCH", "Snapshot changed without its exact provider proof(s).");
            }
            if (error?.code === "POC_PLAYFAB_VERIFY_FAILED") throw error;
            if (classification === PLAYFAB_CAS_RECONCILIATION_NOT_APPLIED) {
                throw notApplied(error, "CAS", latest);
            }
            throw ambiguous(error, "CAS");
        }
    }

    async function readAmmoBatchProof(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const current = await readWithMetadata(player);
        return current.ammoProof;
    }

    async function verifyHighValueOperationProof({ playFabId, proof } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const expected = validateServerEconomyPocHighValueProviderProof(proof, player);
        const current = await readWithMetadata(player);
        return serverEconomyPocReadonly({
            verified: sameServerEconomyPocHighValueProviderProof(current.highValueProof, expected),
            proof: current.highValueProof
        });
    }

    async function probe() {
        const token = await playFab.getEntityToken();
        serverEconomyPocId(token?.EntityToken, "EntityToken", 8192);
        return true;
    }

    return Object.freeze({
        read,
        readWithMetadata,
        initialize,
        activateFence,
        assertActiveFence,
        compareAndSet,
        verifyHighValueOperationProof,
        readAmmoBatchProof,
        probe,
        objectName: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
        fenceObjectName: SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
        proofObjectName: SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME,
        ammoProofObjectName: SERVER_ECONOMY_POC_PLAYFAB_AMMO_PROOF_OBJECT_NAME,
        durable: true,
        provider: "playfab_entity_objects",
        expectedProfileVersionCas: true,
        explicitInitializationOnly: true,
        providerLinearizedFenceRequired: true,
        redisLeaseIsCandidateOnly: true,
        atomicHighValueProof: true,
        atomicAmmoProof: true
    });
}

export function createServerEconomyPocPlayFabFencedPlayerLeases({
    candidateLeases,
    snapshotStore,
    maximumProviderFenceAcquireAttempts = 5
} = {}) {
    for (const method of ["acquire", "renew", "release"]) {
        if (typeof candidateLeases?.[method] !== "function") {
            throw new TypeError(`candidateLeases.${method} is required.`);
        }
    }
    for (const method of ["readWithMetadata", "activateFence", "assertActiveFence"]) {
        if (typeof snapshotStore?.[method] !== "function") {
            throw new TypeError(`snapshotStore.${method} is required.`);
        }
    }

    if (!Number.isSafeInteger(maximumProviderFenceAcquireAttempts) ||
        maximumProviderFenceAcquireAttempts < 1 || maximumProviderFenceAcquireAttempts > 20) {
        throw new TypeError("Provider-fenced lease acquisition retry bound is invalid.");
    }

    async function providerFenceEpoch(playFabId) {
        const current = await snapshotStore.readWithMetadata(playFabId);
        const epoch = current?.fence?.fencingEpoch ?? 0;
        return serverEconomyPocNonNegative(epoch, "provider fencing epoch");
    }

    async function activate(result) {
        if (result?.status !== "acquired" && result?.status !== "renewed") return result;
        const lease = result.lease;
        try {
            const providerFence = await snapshotStore.activateFence({
                playFabId: lease.playFabId,
                leaseToken: lease.token,
                fencingEpoch: lease.epoch
            });
            return serverEconomyPocReadonly({
                ...result,
                lease: {
                    ...serverEconomyPocClone(lease),
                    providerFenceStatus: providerFence.status,
                    providerFenceObjectVersion: providerFence.objectVersion
                }
            });
        } catch (error) {
            await candidateLeases.release({
                playFabId: lease.playFabId,
                token: lease.token,
                epoch: lease.epoch
            }).catch(() => {});
            throw error;
        }
    }

    async function acquire(input) {
        let minimumEpochExclusive = await providerFenceEpoch(input?.playFabId);
        for (let attempt = 1; attempt <= maximumProviderFenceAcquireAttempts; attempt += 1) {
            const candidate = await candidateLeases.acquire({
                ...input,
                minimumEpochExclusive
            });
            if (candidate?.status !== "acquired") return candidate;
            try {
                return await activate(candidate);
            } catch (error) {
                if (error?.code !== "POC_STALE_WRITER" ||
                    attempt === maximumProviderFenceAcquireAttempts) {
                    throw error;
                }
                // activate() has already released this candidate. Re-read the
                // durable provider fence and require the next Redis epoch to be
                // strictly greater than both observations. The floor only ever
                // advances, so recovery cannot resurrect an old writer.
                minimumEpochExclusive = Math.max(
                    minimumEpochExclusive,
                    candidate.lease.epoch,
                    await providerFenceEpoch(input?.playFabId)
                );
            }
        }
        serverEconomyPocFail(
            "POC_PLAYFAB_FENCE_ACTIVATION_CONFLICT",
            "Provider-fenced lease acquisition exhausted its bounded retries.",
            { retryable: true, statusCode: 409 }
        );
    }

    async function renew(input) {
        return activate(await candidateLeases.renew(input));
    }

    return Object.freeze({
        acquire,
        renew,
        release: (input) => candidateLeases.release(input),
        inspect: typeof candidateLeases.inspect === "function"
            ? (playFabId) => candidateLeases.inspect(playFabId)
            : undefined,
        candidateLeases,
        providerLinearized: true,
        redisLeaseIsCandidateOnly: true,
        providerFenceEpochFloor: true,
        maximumProviderFenceAcquireAttempts
    });
}
