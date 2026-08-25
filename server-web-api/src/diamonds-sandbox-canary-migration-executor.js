import { createHash, randomUUID } from "node:crypto";

import {
    assertProgressiveFinancialDomainMigrationPlanFresh,
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    DIAMONDS_TARGET_ADAPTER_VERSION
} from "./progressive-financial-domain-migration.js";
import { createPlayFabFinancialProfileClient } from "./playfab-financial-profile-store.js";
import {
    createServerEconomyPocInitialSnapshot,
    serverEconomyPocClone,
    serverEconomyPocDigest,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";
import {
    SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME
} from "./server-economy-poc-playfab-snapshot-store.js";
import {
    createInitialDiamondsMigrationProof,
    DIAMONDS_MIGRATION_PROOF_OBJECT_NAME,
    DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
    validateDiamondsMigrationProof
} from "./diamonds-migration-proof-companion.js";

const PRODUCTION_TITLE_ID = "142853";
const DEFAULT_LEASE_TTL_MILLISECONDS = 30_000;

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coded(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function sha256(value, name) {
    const selected = serverEconomyPocId(value, name, 255);
    if (!/^[a-f0-9]{64}$/u.test(selected)) throw new TypeError(`${name} must be SHA-256.`);
    return selected;
}

function stableEqual(left, right) {
    return serverEconomyPocDigest(left) === serverEconomyPocDigest(right);
}

function assertMigrationProofMatchesPlan(proof, plan) {
    if (proof.titleId !== plan.titleId || proof.playFabId !== plan.playFabId ||
        proof.domain !== plan.domain || proof.migrationVersion !== plan.migrationVersion ||
        proof.legacyValue !== plan.legacyValue || proof.targetValue !== plan.proposedTarget ||
        proof.planHash !== plan.planHash || proof.operationId !== plan.operationId) {
        throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH",
            "Migration replay payload differs from the complete durable proof.");
    }
    return proof;
}

function objectData(result, name) {
    return result?.Objects?.[name]?.DataObject ?? null;
}

function isVersionConflict(error) {
    const providerCode = error?.providerErrorCode ?? error?.errorCode ??
        (Number.isSafeInteger(error?.code) ? error.code : null);
    return error?.code === "EntityProfileVersionMismatch" ||
        error?.code === "ConcurrentEditError" || providerCode === 1352 || providerCode === 1133;
}

function leaseTokenDigest(token) {
    return createHash("sha256").update(serverEconomyPocId(token, "leaseToken", 255), "utf8").digest("hex");
}

function validateFence(value, playFabId) {
    if (value === null) return null;
    const expectedKeys = "activatedAtUnixMs,fencingEpoch,leaseTokenDigest,playFabId,schemaVersion";
    if (!plain(value) || Object.keys(value).sort().join(",") !== expectedKeys || value.schemaVersion !== 1 ||
        value.playFabId !== playFabId || !Number.isSafeInteger(value.fencingEpoch) || value.fencingEpoch <= 0 ||
        typeof value.leaseTokenDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.leaseTokenDigest) ||
        !Number.isSafeInteger(value.activatedAtUnixMs) || value.activatedAtUnixMs < 0) {
        throw coded("DIAMONDS_MIGRATION_FENCE_INVALID", "Existing PlayFab financial fence is corrupt.");
    }
    return serverEconomyPocReadonly(value);
}

function createFence(playFabId, leaseToken, fencingEpoch, nowUnixMs) {
    return serverEconomyPocReadonly({
        schemaVersion: 1,
        playFabId,
        fencingEpoch,
        leaseTokenDigest: leaseTokenDigest(leaseToken),
        activatedAtUnixMs: nowUnixMs
    });
}

function assertFenceCanAdvance(currentFence, currentSnapshot, nextFence) {
    if (currentFence?.fencingEpoch > nextFence.fencingEpoch ||
        currentFence?.fencingEpoch === nextFence.fencingEpoch &&
            currentFence.leaseTokenDigest !== nextFence.leaseTokenDigest ||
        currentSnapshot?.fencingEpoch > nextFence.fencingEpoch) {
        throw coded("POC_STALE_WRITER", "A newer PlayFab/Redis fencing epoch already owns Diamonds.", {
            retryable: true,
            statusCode: 409
        });
    }
}

/** Atomic PlayFab store used only by the one-shot migration apply harness. */
export function createPlayFabDiamondsSandboxMigrationStore({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMs = 8_000,
    assertPlayerFence,
    nowMilliseconds = () => Date.now()
} = {}) {
    const selectedTitle = serverEconomyPocId(titleId, "titleId", 64);
    if (selectedTitle !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID || selectedTitle === PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_SANDBOX_TITLE_MISMATCH", "Diamonds migration store requires isolated Sandbox 1D0C16.");
    }
    const playFab = client || createPlayFabFinancialProfileClient({
        titleId: selectedTitle,
        secretKey,
        fetchImpl,
        timeoutMs
    });
    for (const method of ["getUserAccountInfo", "getUserInventory", "getEntityToken", "getObjects", "setObjects"]) {
        if (typeof playFab?.[method] !== "function") throw new TypeError(`PlayFab client.${method} is required.`);
    }
    if (typeof assertPlayerFence !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Diamonds migration store requires the certified player fence and clock.");
    }

    async function context(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        if (player !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID) {
            throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID", "Diamonds migration store refused a non-canary player.");
        }
        const [account, tokenResult] = await Promise.all([
            playFab.getUserAccountInfo(player),
            playFab.getEntityToken()
        ]);
        if (account?.UserInfo?.PlayFabId !== player) {
            throw coded("DIAMONDS_TARGET_IDENTITY_MISMATCH", "PlayFab resolved another legacy identity.");
        }
        if (tokenResult?.Entity &&
            (tokenResult.Entity.Id !== selectedTitle || tokenResult.Entity.Type !== "title")) {
            throw coded("DIAMONDS_SANDBOX_TITLE_MISMATCH", "PlayFab returned an EntityToken for another Title.");
        }
        return Object.freeze({
            playFabId: player,
            entity: Object.freeze({
                Id: serverEconomyPocId(
                    account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
                    "TitlePlayerAccount.Id",
                    160
                ),
                Type: "title_player_account"
            }),
            entityToken: serverEconomyPocId(tokenResult?.EntityToken, "EntityToken", 8192)
        });
    }

    async function readWithContext(ctx) {
        const [inventory, objects] = await Promise.all([
            playFab.getUserInventory(ctx.playFabId),
            playFab.getObjects(ctx.entity, ctx.entityToken)
        ]);
        const legacyValue = serverEconomyPocNonNegative(inventory?.VirtualCurrency?.DM ?? 0, "Legacy DM");
        const targetObject = objectData(objects, SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
        if (targetObject !== null) validateServerEconomyPocSnapshot(targetObject, ctx.playFabId);
        const migrationProof = objectData(objects, DIAMONDS_MIGRATION_PROOF_OBJECT_NAME);
        if (migrationProof !== null) {
            if (targetObject === null) {
                throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Migration proof exists without Target state.");
            }
            validateDiamondsMigrationProof(migrationProof, { targetSnapshot: targetObject });
        }
        const targetValue = serverEconomyPocNonNegative(targetObject?.diamonds ?? 0, "Target Diamonds");
        const targetRevision = serverEconomyPocNonNegative(targetObject?.revision ?? 0, "Target revision");
        const providerProfileVersion = serverEconomyPocNonNegative(objects?.ProfileVersion ?? 0, "ProfileVersion");
        const providerState = {
            titleId: selectedTitle,
            playFabId: ctx.playFabId,
            entityId: ctx.entity.Id,
            legacyValue,
            targetValue,
            targetRevision,
            providerProfileVersion,
            targetObject,
            migrationProof
        };
        return serverEconomyPocReadonly({
            ...providerState,
            providerStateDigest: serverEconomyPocDigest(providerState),
            fence: validateFence(objectData(objects, SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME), ctx.playFabId)
        });
    }

    async function readObservation(playFabId) {
        const ctx = await context(playFabId);
        return readWithContext(ctx);
    }

    async function applyMigrationAtomic({
        plan,
        leaseToken,
        fencingEpoch,
        scannerHash,
        adapterVersion = DIAMONDS_TARGET_ADAPTER_VERSION
    } = {}) {
        if (!plain(plan) || plan.domain !== "Diamonds" || plan.status !== "ready" ||
            plan.titleId !== selectedTitle || plan.playFabId !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID ||
            plan.migrationVersion !== DIAMONDS_PROGRESSIVE_MIGRATION_VERSION ||
            plan.proposedTarget !== plan.legacyValue || adapterVersion !== DIAMONDS_TARGET_ADAPTER_VERSION) {
            throw coded("DIAMONDS_MIGRATION_PLAN_INVALID", "Atomic apply requires the exact ready Diamonds plan.");
        }
        const token = serverEconomyPocId(leaseToken, "leaseToken", 255);
        const epoch = serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
        const scanner = sha256(scannerHash, "scannerHash");
        await assertPlayerFence({ playFabId: plan.playFabId, token, epoch });
        const ctx = await context(plan.playFabId);
        const current = await readWithContext(ctx);
        if (current.migrationProof !== null) {
            const proof = validateDiamondsMigrationProof(current.migrationProof, {
                targetSnapshot: current.targetObject
            });
            assertMigrationProofMatchesPlan(proof, plan);
            return serverEconomyPocReadonly({
                status: "already_migrated",
                alreadyApplied: true,
                providerWriteCount: 0,
                proof,
                observation: current
            });
        }
        if (current.providerProfileVersion !== plan.expectedProviderProfileVersion ||
            current.providerStateDigest !== plan.providerStateDigest ||
            current.legacyValue !== plan.legacyValue || current.targetValue !== plan.targetValue ||
            current.targetRevision !== plan.expectedTargetRevision) {
            throw coded("DOMAIN_MIGRATION_PLAN_STALE", "PlayFab or Legacy state changed after the certified dry-run.");
        }
        const nowUnixMs = serverEconomyPocNonNegative(nowMilliseconds(), "migration clock");
        const currentSnapshot = current.targetObject || createServerEconomyPocInitialSnapshot(plan.playFabId, nowUnixMs);
        if (currentSnapshot.fencingEpoch > epoch) {
            throw coded("POC_STALE_WRITER", "Target snapshot already has a newer fencing epoch.", { retryable: true });
        }
        const nextSnapshot = serverEconomyPocClone({
            ...currentSnapshot,
            revision: currentSnapshot.revision + 1,
            fencingEpoch: epoch,
            diamonds: plan.proposedTarget,
            updatedAtUnixMs: nowUnixMs
        });
        validateServerEconomyPocSnapshot(nextSnapshot, plan.playFabId);
        const proof = createInitialDiamondsMigrationProof({
            plan,
            scannerHash: scanner,
            appliedAt: new Date(nowUnixMs).toISOString(),
            fencingEpoch: epoch,
            targetSnapshot: nextSnapshot
        });
        const fence = createFence(plan.playFabId, token, epoch, nowUnixMs);
        assertFenceCanAdvance(current.fence, current.targetObject, fence);
        await assertPlayerFence({ playFabId: plan.playFabId, token, epoch });
        const writes = [
            { ObjectName: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME, DataObject: nextSnapshot },
            { ObjectName: DIAMONDS_MIGRATION_PROOF_OBJECT_NAME, DataObject: serverEconomyPocClone(proof) },
            { ObjectName: SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME, DataObject: serverEconomyPocClone(fence) }
        ];
        let recovered = false;
        try {
            await playFab.setObjects(ctx.entity, ctx.entityToken, current.providerProfileVersion, writes);
        } catch (error) {
            const latest = await readWithContext(ctx).catch(() => null);
            if (latest?.targetObject && latest?.migrationProof &&
                stableEqual(latest.targetObject, nextSnapshot) && stableEqual(latest.migrationProof, proof) &&
                stableEqual(latest.fence, fence)) {
                recovered = true;
            } else if (isVersionConflict(error)) {
                throw coded("DOMAIN_MIGRATION_PLAN_STALE", "Diamonds migration CAS lost to another ProfileVersion.", {
                    cause: error
                });
            } else {
                throw coded("DIAMONDS_MIGRATION_PROVIDER_AMBIGUOUS", "Diamonds migration SetObjects result is ambiguous.", {
                    retryable: true,
                    cause: error
                });
            }
        }
        const verified = await readWithContext(ctx);
        if (!verified.targetObject || !verified.migrationProof ||
            !stableEqual(verified.targetObject, nextSnapshot) || !stableEqual(verified.migrationProof, proof) ||
            !stableEqual(verified.fence, fence) || verified.targetValue !== plan.proposedTarget) {
            throw coded("DIAMONDS_MIGRATION_READBACK_CONFLICT", "State and migration proof did not read back atomically.");
        }
        return serverEconomyPocReadonly({
            status: recovered ? "reconciled" : "completed",
            alreadyApplied: recovered,
            providerWriteCount: recovered ? 0 : 1,
            proof: verified.migrationProof,
            observation: verified
        });
    }

    async function verifyProof(playFabId) {
        const observation = await readObservation(playFabId);
        if (!observation.targetObject || !observation.migrationProof) {
            return Object.freeze({ verified: false, reason: "missing", observation });
        }
        return Object.freeze({
            verified: true,
            proof: validateDiamondsMigrationProof(observation.migrationProof, {
                targetSnapshot: observation.targetObject
            }),
            observation
        });
    }

    return Object.freeze({
        readObservation,
        applyMigrationAtomic,
        verifyProof,
        objectNames: Object.freeze({
            state: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
            proof: DIAMONDS_MIGRATION_PROOF_OBJECT_NAME,
            fence: SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME
        }),
        capabilities: Object.freeze({
            exactReplacement: true,
            atomicStateProofFenceCas: true,
            readbackVerified: true,
            sandboxOnly: true
        })
    });
}

function readinessEvidence(value, plan) {
    const certificate = value?.certificate || value;
    const health = certificate?.healthChecks || {};
    const scannerForbidden = certificate?.scannerForbidden ??
        certificate?.healthInput?.legacyAccess?.forbiddenDirectAccess;
    const scannerHash = certificate?.scannerHash ?? certificate?.scannerBaselineDigest;
    const adapterVersion = certificate?.adapterVersion;
    const dryRunPlanHash = certificate?.dryRunPlanHash;
    const allHealth = [
        "casSupported", "identityVerified", "playFabHealthy", "redisHealthy",
        "rollbackAvailable", "scannerZeroForbidden", "snapshotReadHealthy",
        "targetAdapterComposed", "targetHealthy", "zeroPendingPayment"
    ].every((name) => health[name] === true);
    if (value?.valid !== true || scannerForbidden !== 0 ||
        sha256(scannerHash, "scannerHash") !== scannerHash ||
        adapterVersion !== DIAMONDS_TARGET_ADAPTER_VERSION || dryRunPlanHash !== plan.planHash || !allHealth) {
        throw coded("DIAMONDS_MIGRATION_READINESS_INVALID", "Diamonds readiness certificate/health is not valid for this plan.");
    }
    return Object.freeze({ scannerHash, adapterVersion });
}

export function createDiamondsSandboxCanaryMigrationExecutor({
    enabled = false,
    providerWritesEnabled = false,
    titleId = DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    canaryPlayFabIds = [],
    playerLeases,
    migrationStore,
    verifyReadiness,
    owner = "diamonds-sandbox-canary-migration",
    leaseTtlMilliseconds = DEFAULT_LEASE_TTL_MILLISECONDS,
    tokenFactory = randomUUID
} = {}) {
    if (typeof enabled !== "boolean" || typeof providerWritesEnabled !== "boolean") {
        throw new TypeError("Diamonds migration gates are invalid.");
    }
    if (enabled || providerWritesEnabled) {
        if (titleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID || titleId === PRODUCTION_TITLE_ID ||
            !Array.isArray(canaryPlayFabIds) || canaryPlayFabIds.length !== 1 ||
            canaryPlayFabIds[0] !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID) {
            throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID", "Migration executor requires the one exact Sandbox canary.");
        }
        for (const method of ["acquire", "assertCurrent", "release"]) {
            if (typeof playerLeases?.[method] !== "function") throw new TypeError(`playerLeases.${method} is required.`);
        }
        for (const method of ["readObservation", "applyMigrationAtomic", "verifyProof"]) {
            if (typeof migrationStore?.[method] !== "function") throw new TypeError(`migrationStore.${method} is required.`);
        }
        if (typeof verifyReadiness !== "function" || typeof tokenFactory !== "function") {
            throw new TypeError("Diamonds migration readiness verifier and token factory are required.");
        }
        serverEconomyPocId(owner, "migration owner", 160);
        const ttl = serverEconomyPocPositive(leaseTtlMilliseconds, "leaseTtlMilliseconds");
        if (ttl < 1_000 || ttl > 300_000) throw new TypeError("Diamonds migration lease TTL is unsafe.");
    }

    async function execute({ plan, approvedPlanHash } = {}) {
        if (!enabled || !providerWritesEnabled) {
            throw coded("DIAMONDS_MIGRATION_DISABLED", "Diamonds Sandbox migration apply is disabled.");
        }
        if (!plain(plan) || plan.status !== "ready" || plan.readOnly !== true ||
            plan.domain !== "Diamonds" || plan.titleId !== titleId ||
            plan.playFabId !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID ||
            plan.migrationVersion !== DIAMONDS_PROGRESSIVE_MIGRATION_VERSION) {
            throw coded("DIAMONDS_MIGRATION_PLAN_INVALID", "A ready certified Diamonds Sandbox plan is required.");
        }
        if (sha256(approvedPlanHash, "approvedPlanHash") !== plan.planHash) {
            throw coded("DOMAIN_MIGRATION_PLAN_HASH_MISMATCH", "Approved planHash differs from the certified plan.");
        }
        const token = serverEconomyPocId(tokenFactory(), "migration lease token", 255);
        const acquired = await playerLeases.acquire({
            playFabId: plan.playFabId,
            owner,
            token,
            ttlMilliseconds: leaseTtlMilliseconds
        });
        if (acquired?.status !== "acquired") {
            throw coded("DIAMONDS_MIGRATION_PLAYER_BUSY", "Another financial worker owns the canary.", {
                retryable: true
            });
        }
        const epoch = serverEconomyPocPositive(acquired.lease?.epoch, "fencingEpoch");
        try {
            await playerLeases.assertCurrent({ playFabId: plan.playFabId, token, epoch });
            const current = await migrationStore.readObservation(plan.playFabId);
            if (current.migrationProof !== null) {
                const proof = validateDiamondsMigrationProof(current.migrationProof, {
                    targetSnapshot: current.targetObject
                });
                assertMigrationProofMatchesPlan(proof, plan);
                return serverEconomyPocReadonly({
                    status: "already_migrated",
                    providerWriteCount: 0,
                    proof,
                    observation: current,
                    fencingEpoch: epoch
                });
            }
            assertProgressiveFinancialDomainMigrationPlanFresh({
                plan,
                currentObservation: current
            });
            const readiness = readinessEvidence(await verifyReadiness({ plan, currentObservation: current }), plan);
            await playerLeases.assertCurrent({ playFabId: plan.playFabId, token, epoch });
            const result = await migrationStore.applyMigrationAtomic({
                plan,
                leaseToken: token,
                fencingEpoch: epoch,
                scannerHash: readiness.scannerHash,
                adapterVersion: readiness.adapterVersion
            });
            const verified = await migrationStore.verifyProof(plan.playFabId);
            if (verified.verified !== true || verified.proof.planHash !== plan.planHash ||
                verified.observation.targetValue !== plan.proposedTarget) {
                throw coded("DIAMONDS_MIGRATION_READBACK_CONFLICT", "Final migration proof verification failed.");
            }
            return serverEconomyPocReadonly({ ...result, fencingEpoch: epoch, finalVerification: verified });
        } finally {
            await playerLeases.release({ playFabId: plan.playFabId, token, epoch });
        }
    }

    return Object.freeze({
        enabled,
        providerWritesEnabled,
        execute,
        health() {
            return Object.freeze({
                enabled,
                providerWritesEnabled,
                ready: enabled && providerWritesEnabled,
                titleId,
                canaryPlayFabIds: Object.freeze([...canaryPlayFabIds])
            });
        }
    });
}
