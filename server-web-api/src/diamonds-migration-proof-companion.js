import { readConfiguredDiamondsCanaryPlayFabId } from "./diamonds-canary-identity.js";
import {
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    DIAMONDS_TARGET_ADAPTER_VERSION
} from "./progressive-financial-domain-migration.js";
import {
    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME
} from "./server-economy-poc-playfab-snapshot-store.js";
import {
    serverEconomyPocClone,
    serverEconomyPocDigest,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";
import { validateServerEconomyPocHighValueProviderProof } from "./server-economy-poc-provider-proof.js";

export const DIAMONDS_MIGRATION_PROOF_OBJECT_NAME = "SeabyssDiamondsMigrationProofV1";
export const DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID = readConfiguredDiamondsCanaryPlayFabId();
export const DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION = 1;
export const DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION = 2;
export const DIAMONDS_MIGRATION_PROOF_MAX_UTF8_BYTES = 1024;
// Retained only to validate bounded legacy V1 histories already persisted.
export const DIAMONDS_MIGRATION_MAX_APPLIED_OPERATIONS = 256;

const COMMON_PROOF_FIELDS = Object.freeze([
    "adapterVersion",
    "appliedAt",
    "domain",
    "fencingEpoch",
    "legacyValue",
    "migrationVersion",
    "operationId",
    "planHash",
    "playFabId",
    "resultHash",
    "scannerHash",
    "schemaVersion",
    "state",
    "targetDigest",
    "targetOnlyOperationCount",
    "targetRevision",
    "targetValue",
    "titleId"
]);

const V1_PROOF_FIELDS = Object.freeze([...COMMON_PROOF_FIELDS, "appliedTargetOperations"].sort());
const V2_PROOF_FIELDS = Object.freeze([
    ...COMMON_PROOF_FIELDS,
    "latestTargetOperation",
    "operationsChainHash"
].sort());

const APPLIED_OPERATION_FIELDS = Object.freeze([
    "delta",
    "operationHash",
    "operationId",
    "resultingRevision",
    "resultingValue"
]);

const LATEST_OPERATION_FIELDS = Object.freeze(["d", "h"]);

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
    return plain(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function sha256(value, name) {
    const selected = serverEconomyPocId(value, name, 255);
    if (!/^[a-f0-9]{64}$/u.test(selected)) throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", `${name} is not SHA-256.`);
    return selected;
}

function canonicalUtc(value, name) {
    const selected = serverEconomyPocId(value, name, 64);
    const parsed = new Date(selected);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== selected) {
        throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", `${name} is not canonical UTC.`);
    }
    return selected;
}

function coded(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function proofResultBasis(proof, snapshot) {
    const withoutResultHash = Object.fromEntries(
        Object.entries(proof).filter(([key]) => key !== "resultHash")
    );
    return Object.freeze({
        proof: withoutResultHash,
        target: {
            playFabId: snapshot.playFabId,
            diamonds: snapshot.diamonds,
            revision: snapshot.revision,
            fencingEpoch: snapshot.fencingEpoch
        }
    });
}

export function diamondsMigrationProofResultHash(proof, snapshot) {
    validateServerEconomyPocSnapshot(snapshot, proof?.playFabId);
    return serverEconomyPocDigest(proofResultBasis(proof, snapshot));
}

export function diamondsMigrationProofUtf8Bytes(proof) {
    return new TextEncoder().encode(JSON.stringify(proof)).byteLength;
}

function ensureV2ProviderSize(proof) {
    const bytes = diamondsMigrationProofUtf8Bytes(proof);
    if (bytes > DIAMONDS_MIGRATION_PROOF_MAX_UTF8_BYTES) {
        throw coded(
            "DIAMONDS_MIGRATION_PROOF_TOO_LARGE",
            "Compact Diamonds migration proof exceeds the PlayFab Entity Object limit.",
            {
                bytes,
                maximumBytes: DIAMONDS_MIGRATION_PROOF_MAX_UTF8_BYTES,
                providerRequestAttempted: false,
                retryable: false
            }
        );
    }
    return proof;
}

function validateAppliedOperations(value) {
    if (!Array.isArray(value) || value.length > DIAMONDS_MIGRATION_MAX_APPLIED_OPERATIONS) {
        throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds Target operation history is invalid.");
    }
    const ids = new Set();
    return value.map((entry) => {
        if (!exactKeys(entry, APPLIED_OPERATION_FIELDS)) {
            throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds Target operation proof has an invalid schema.");
        }
        const operationId = serverEconomyPocId(entry.operationId, "proof operationId", 200);
        const operationHash = sha256(entry.operationHash, "proof operationHash");
        if (!Number.isSafeInteger(entry.delta) || entry.delta === 0) {
            throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds Target operation delta is invalid.");
        }
        const delta = entry.delta;
        const resultingRevision = serverEconomyPocNonNegative(entry.resultingRevision, "proof resultingRevision");
        const resultingValue = serverEconomyPocNonNegative(entry.resultingValue, "proof resultingValue");
        if (ids.has(operationId)) {
            throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds Target operation proof contains a duplicate operationId.");
        }
        ids.add(operationId);
        return Object.freeze({ operationId, operationHash, delta, resultingRevision, resultingValue });
    });
}

function validateLatestTargetOperation(value) {
    if (value === null) return null;
    if (!exactKeys(value, LATEST_OPERATION_FIELDS) ||
        !Number.isSafeInteger(value.d) || value.d === 0) {
        throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Latest Diamonds Target operation is invalid.");
    }
    return Object.freeze({
        h: sha256(value.h, "latest operationHash"),
        d: value.d
    });
}

function operationsChainSeed(proof) {
    return serverEconomyPocDigest({
        schemaVersion: DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION,
        titleId: proof.titleId,
        playFabId: proof.playFabId,
        domain: proof.domain,
        migrationVersion: proof.migrationVersion,
        legacyValue: proof.legacyValue,
        planHash: proof.planHash,
        scannerHash: proof.scannerHash,
        adapterVersion: proof.adapterVersion,
        appliedAt: proof.appliedAt,
        operationId: proof.operationId
    });
}

function appendOperationsChain(previousHash, operation) {
    return serverEconomyPocDigest({
        previousHash: sha256(previousHash, "operationsChainHash"),
        operation: {
            operationId: serverEconomyPocId(operation.operationId, "proof operationId", 200),
            operationHash: sha256(operation.operationHash, "proof operationHash"),
            delta: operation.delta,
            resultingRevision: operation.resultingRevision,
            resultingValue: operation.resultingValue
        }
    });
}

function compactOperationState(proof) {
    if (proof.schemaVersion === DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION) {
        return {
            targetOnlyOperationCount: proof.targetOnlyOperationCount,
            operationsChainHash: proof.operationsChainHash,
            latestTargetOperation: proof.latestTargetOperation
        };
    }
    let operationsChainHash = operationsChainSeed(proof);
    for (const operation of proof.appliedTargetOperations) {
        operationsChainHash = appendOperationsChain(operationsChainHash, operation);
    }
    const latest = proof.appliedTargetOperations.at(-1) ?? null;
    return {
        targetOnlyOperationCount: proof.targetOnlyOperationCount,
        operationsChainHash,
        latestTargetOperation: latest === null ? null : Object.freeze({
            h: latest.operationHash,
            d: latest.delta
        })
    };
}

export function validateDiamondsMigrationProof(value, {
    playFabId = DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
    titleId = DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    targetSnapshot = null
} = {}) {
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    const title = serverEconomyPocId(titleId, "titleId", 64);
    const legacy = value?.schemaVersion === DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION;
    const current = value?.schemaVersion === DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION;
    const expectedFields = legacy ? V1_PROOF_FIELDS : V2_PROOF_FIELDS;
    if ((!legacy && !current) || !exactKeys(value, expectedFields) ||
        value.state !== "Completed" || value.domain !== "Diamonds" || value.playFabId !== player ||
        value.titleId !== title || value.migrationVersion !== DIAMONDS_PROGRESSIVE_MIGRATION_VERSION ||
        value.adapterVersion !== DIAMONDS_TARGET_ADAPTER_VERSION) {
        throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds migration proof has an invalid identity or schema.");
    }
    const legacyValue = serverEconomyPocNonNegative(value.legacyValue, "proof legacyValue");
    const targetValue = serverEconomyPocNonNegative(value.targetValue, "proof targetValue");
    const targetRevision = serverEconomyPocNonNegative(value.targetRevision, "proof targetRevision");
    const fencingEpoch = serverEconomyPocNonNegative(value.fencingEpoch, "proof fencingEpoch");
    if (fencingEpoch === 0) throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds proof fencing epoch must be positive.");
    const operationId = serverEconomyPocId(value.operationId, "proof migration operationId", 200);
    const planHash = sha256(value.planHash, "proof planHash");
    const scannerHash = sha256(value.scannerHash, "proof scannerHash");
    const targetDigest = sha256(value.targetDigest, "proof targetDigest");
    const resultHash = sha256(value.resultHash, "proof resultHash");
    const appliedAt = canonicalUtc(value.appliedAt, "proof appliedAt");
    const targetOnlyOperationCount = serverEconomyPocNonNegative(
        value.targetOnlyOperationCount,
        "proof targetOnlyOperationCount"
    );
    if (targetDigest !== serverEconomyPocDigest(targetValue)) {
        throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Diamonds migration proof counters or digest are invalid.");
    }
    const common = {
        schemaVersion: value.schemaVersion,
        state: "Completed",
        titleId: title,
        playFabId: player,
        domain: "Diamonds",
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        legacyValue,
        targetValue,
        targetRevision,
        planHash,
        scannerHash,
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        appliedAt,
        fencingEpoch,
        operationId,
        targetDigest,
        targetOnlyOperationCount
    };
    let proof;
    if (legacy) {
        const appliedTargetOperations = validateAppliedOperations(value.appliedTargetOperations);
        if (targetOnlyOperationCount !== appliedTargetOperations.length) {
            throw coded("DIAMONDS_MIGRATION_PROOF_INVALID", "Legacy Diamonds proof history count is invalid.");
        }
        proof = { ...common, appliedTargetOperations, resultHash };
    } else {
        const operationsChainHash = sha256(value.operationsChainHash, "operationsChainHash");
        const latestTargetOperation = validateLatestTargetOperation(value.latestTargetOperation);
        if ((targetOnlyOperationCount === 0) !== (latestTargetOperation === null) ||
            targetOnlyOperationCount === 0 && operationsChainHash !== operationsChainSeed(common)) {
            throw coded("DIAMONDS_MIGRATION_PROOF_INVALID",
                "Compact Diamonds proof counter or latest operation is invalid.");
        }
        proof = { ...common, operationsChainHash, latestTargetOperation, resultHash };
        ensureV2ProviderSize(proof);
    }
    if (targetSnapshot !== null) {
        validateServerEconomyPocSnapshot(targetSnapshot, player);
        if (targetSnapshot.diamonds !== targetValue || targetSnapshot.revision !== targetRevision ||
            targetSnapshot.fencingEpoch !== fencingEpoch ||
            diamondsMigrationProofResultHash(proof, targetSnapshot) !== resultHash) {
            throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Diamonds proof does not match the exact Target readback.");
        }
    }
    return serverEconomyPocReadonly(proof);
}

export function createInitialDiamondsMigrationProof({
    plan,
    scannerHash,
    appliedAt,
    fencingEpoch,
    targetSnapshot
} = {}) {
    if (!plain(plan) || plan.domain !== "Diamonds" || plan.titleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID ||
        plan.playFabId !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID || plan.proposedTarget !== plan.legacyValue) {
        throw coded("DIAMONDS_MIGRATION_PLAN_INVALID", "Diamonds migration proof requires the exact certified Sandbox plan.");
    }
    validateServerEconomyPocSnapshot(targetSnapshot, plan.playFabId);
    const basis = {
        schemaVersion: DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION,
        state: "Completed",
        titleId: plan.titleId,
        playFabId: plan.playFabId,
        domain: "Diamonds",
        migrationVersion: plan.migrationVersion,
        legacyValue: plan.legacyValue,
        targetValue: targetSnapshot.diamonds,
        targetRevision: targetSnapshot.revision,
        planHash: plan.planHash,
        scannerHash: sha256(scannerHash, "scannerHash"),
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        appliedAt: canonicalUtc(appliedAt, "appliedAt"),
        fencingEpoch: targetSnapshot.fencingEpoch,
        operationId: plan.operationId,
        targetDigest: serverEconomyPocDigest(targetSnapshot.diamonds),
        targetOnlyOperationCount: 0,
        operationsChainHash: null,
        latestTargetOperation: null
    };
    basis.operationsChainHash = operationsChainSeed(basis);
    const proof = { ...basis, resultHash: diamondsMigrationProofResultHash(basis, targetSnapshot) };
    return validateDiamondsMigrationProof(proof, { targetSnapshot });
}

export function advanceDiamondsMigrationProof({
    currentProof,
    currentSnapshot,
    nextSnapshot,
    operationProof = null,
    currentOperationProof = null
} = {}) {
    const proof = validateDiamondsMigrationProof(currentProof, { targetSnapshot: currentSnapshot });
    validateServerEconomyPocSnapshot(nextSnapshot, proof.playFabId);
    if (nextSnapshot.revision !== currentSnapshot.revision + 1 ||
        nextSnapshot.fencingEpoch < currentSnapshot.fencingEpoch) {
        throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Target snapshot advance is not monotonic.");
    }
    const diamondsChanged = nextSnapshot.diamonds !== currentSnapshot.diamonds;
    const compact = compactOperationState(proof);
    if (diamondsChanged) {
        const providerProof = validateServerEconomyPocHighValueProviderProof(operationProof, proof.playFabId);
        const currentProviderProof = currentOperationProof === null
            ? null
            : validateServerEconomyPocHighValueProviderProof(currentOperationProof, proof.playFabId);
        const legacyExisting = proof.schemaVersion === DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION
            ? proof.appliedTargetOperations.find((entry) => entry.operationId === providerProof.operationId)
            : null;
        if (legacyExisting) {
            if (legacyExisting.operationHash !== providerProof.immutableHash) {
                throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Target operationId was replayed with another immutable hash.");
            }
            throw coded("DIAMONDS_CANARY_OPERATION_REPLAY_CONFLICT", "A completed Target operation reached provider CAS twice.");
        }
        if (currentProviderProof?.operationId === providerProof.operationId) {
            if (currentProviderProof.immutableHash !== providerProof.immutableHash) {
                throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Target operationId was replayed with another immutable hash.");
            }
            throw coded("DIAMONDS_CANARY_OPERATION_REPLAY_CONFLICT", "A completed Target operation reached provider CAS twice.");
        }
        const appliedOperation = Object.freeze({
            operationId: providerProof.operationId,
            operationHash: providerProof.immutableHash,
            delta: nextSnapshot.diamonds - currentSnapshot.diamonds,
            resultingRevision: nextSnapshot.revision,
            resultingValue: nextSnapshot.diamonds
        });
        compact.targetOnlyOperationCount += 1;
        compact.operationsChainHash = appendOperationsChain(compact.operationsChainHash, appliedOperation);
        compact.latestTargetOperation = Object.freeze({
            h: appliedOperation.operationHash,
            d: appliedOperation.delta
        });
    }
    const basis = {
        schemaVersion: DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION,
        state: proof.state,
        titleId: proof.titleId,
        playFabId: proof.playFabId,
        domain: proof.domain,
        migrationVersion: proof.migrationVersion,
        legacyValue: proof.legacyValue,
        targetValue: nextSnapshot.diamonds,
        targetRevision: nextSnapshot.revision,
        planHash: proof.planHash,
        scannerHash: proof.scannerHash,
        adapterVersion: proof.adapterVersion,
        appliedAt: proof.appliedAt,
        fencingEpoch: nextSnapshot.fencingEpoch,
        operationId: proof.operationId,
        targetDigest: serverEconomyPocDigest(nextSnapshot.diamonds),
        targetOnlyOperationCount: compact.targetOnlyOperationCount,
        operationsChainHash: compact.operationsChainHash,
        latestTargetOperation: compact.latestTargetOperation
    };
    const nextProof = { ...basis, resultHash: diamondsMigrationProofResultHash(basis, nextSnapshot) };
    return validateDiamondsMigrationProof(nextProof, { targetSnapshot: nextSnapshot });
}

function versionConflict(message) {
    const error = coded("EntityProfileVersionMismatch", message);
    error.providerErrorCode = 1352;
    error.retryable = true;
    return error;
}

function objectData(result, objectName) {
    return result?.Objects?.[objectName]?.DataObject ?? null;
}

/**
 * Companion for the already-certified snapshotStore/operationInbox/WAL engine.
 * It does not apply an economic mutation. It only appends the migration proof
 * to the exact SetObjects CAS which the canonical engine is already issuing.
 */
export function createDiamondsMigrationProofAwarePlayFabClient({
    client,
    titleId,
    canaryPlayFabIds = [DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID]
} = {}) {
    for (const method of ["getUserAccountInfo", "getUserInventory", "getUserInternalData", "getEntityToken", "getObjects", "setObjects"]) {
        if (typeof client?.[method] !== "function") throw new TypeError(`PlayFab client.${method} is required.`);
    }
    if (titleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID ||
        !Array.isArray(canaryPlayFabIds) || canaryPlayFabIds.length !== 1 ||
        canaryPlayFabIds[0] !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID) {
        throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID", "Proof-aware PlayFab client requires the one certified Sandbox canary.");
    }
    const playerByEntity = new Map();
    let lastPreparedProofWrite = null;

    async function getUserAccountInfo(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const result = await client.getUserAccountInfo(player);
        if (result?.UserInfo?.PlayFabId !== player) {
            throw coded("DIAMONDS_TARGET_IDENTITY_MISMATCH", "PlayFab resolved another legacy identity.");
        }
        const entityId = serverEconomyPocId(
            result?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
            "TitlePlayerAccount.Id",
            160
        );
        playerByEntity.set(entityId, player);
        return result;
    }

    async function setObjects(entity, entityToken, expectedProfileVersion, objects) {
        const player = playerByEntity.get(entity?.Id);
        const stateWrite = Array.isArray(objects)
            ? objects.find((entry) => entry?.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME)
            : null;
        if (player !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID || !stateWrite) {
            return client.setObjects(entity, entityToken, expectedProfileVersion, objects);
        }
        const currentObjects = await client.getObjects(entity, entityToken);
        if (currentObjects?.ProfileVersion !== expectedProfileVersion) {
            throw versionConflict("Diamonds proof companion observed a stale PlayFab ProfileVersion.");
        }
        const currentSnapshot = objectData(currentObjects, SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
        const currentProof = objectData(currentObjects, DIAMONDS_MIGRATION_PROOF_OBJECT_NAME);
        const currentOperationProof = objectData(
            currentObjects, SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME);
        const explicitMigrationProof = objects.find((entry) =>
            entry?.ObjectName === DIAMONDS_MIGRATION_PROOF_OBJECT_NAME)?.DataObject ?? null;
        if (currentProof === null) {
            if (explicitMigrationProof === null) {
                throw coded("DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED", "Canary Target write refused before migration proof.");
            }
            validateDiamondsMigrationProof(explicitMigrationProof, { targetSnapshot: stateWrite.DataObject });
            return client.setObjects(entity, entityToken, expectedProfileVersion, objects);
        }
        validateServerEconomyPocSnapshot(currentSnapshot, player);
        validateServerEconomyPocSnapshot(stateWrite.DataObject, player);
        const operationProof = objects.find((entry) =>
            entry?.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME)?.DataObject ?? null;
        const nextProof = advanceDiamondsMigrationProof({
            currentProof,
            currentSnapshot,
            nextSnapshot: stateWrite.DataObject,
            operationProof,
            currentOperationProof
        });
        const augmented = objects.filter((entry) => entry?.ObjectName !== DIAMONDS_MIGRATION_PROOF_OBJECT_NAME);
        augmented.push({
            ObjectName: DIAMONDS_MIGRATION_PROOF_OBJECT_NAME,
            DataObject: serverEconomyPocClone(nextProof)
        });
        lastPreparedProofWrite = Object.freeze({
            operationId: operationProof?.operationId ?? null,
            operationHash: operationProof?.immutableHash ?? null,
            schemaVersion: nextProof.schemaVersion,
            bytes: diamondsMigrationProofUtf8Bytes(nextProof),
            maximumBytes: DIAMONDS_MIGRATION_PROOF_MAX_UTF8_BYTES,
            providerRequestAttempted: false,
            providerWriteCompleted: false,
            reconciledAfterAmbiguousResponse: false
        });
        let result;
        try {
            lastPreparedProofWrite = Object.freeze({
                ...lastPreparedProofWrite,
                providerRequestAttempted: true
            });
            result = await client.setObjects(entity, entityToken, expectedProfileVersion, augmented);
            lastPreparedProofWrite = Object.freeze({
                ...lastPreparedProofWrite,
                providerWriteCompleted: true
            });
        } catch (error) {
            const recovered = await client.getObjects(entity, entityToken).catch(() => null);
            const recoveredState = objectData(recovered, SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
            const recoveredProof = objectData(recovered, DIAMONDS_MIGRATION_PROOF_OBJECT_NAME);
            const allWritesApplied = recovered && augmented.every((entry) =>
                JSON.stringify(objectData(recovered, entry.ObjectName)) === JSON.stringify(entry.DataObject));
            if (allWritesApplied) {
                lastPreparedProofWrite = Object.freeze({
                    ...lastPreparedProofWrite,
                    providerWriteCompleted: true,
                    reconciledAfterAmbiguousResponse: true
                });
                return Object.freeze({ ProfileVersion: recovered.ProfileVersion, recovered: true });
            }
            const recoveredOperationProofValue = objectData(
                recovered, SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME);
            const expectedOperation = operationProof === null
                ? null
                : validateServerEconomyPocHighValueProviderProof(operationProof, player);
            let recoveredOperation = null;
            let malformedRecoveredOperation = false;
            if (recoveredOperationProofValue !== null) {
                try {
                    recoveredOperation = validateServerEconomyPocHighValueProviderProof(
                        recoveredOperationProofValue, player);
                } catch {
                    malformedRecoveredOperation = true;
                }
            }
            const sameOperationId = expectedOperation !== null &&
                recoveredOperation?.operationId === expectedOperation.operationId;
            const conflictingOperation = malformedRecoveredOperation || sameOperationId &&
                recoveredOperation.immutableHash !== expectedOperation.immutableHash;
            const exactOperationWithoutExactAtomicWrite = sameOperationId &&
                recoveredOperation.immutableHash === expectedOperation.immutableHash;
            const stateAppliedWithoutExactProof = recoveredState &&
                JSON.stringify(recoveredState) === JSON.stringify(stateWrite.DataObject);
            if (conflictingOperation || exactOperationWithoutExactAtomicWrite ||
                stateAppliedWithoutExactProof) {
                const proofError = coded(
                    "DIAMONDS_MIGRATION_PROOF_MISMATCH",
                    "Ambiguous Target write readback contains a conflicting or incomplete exact proof."
                );
                proofError.providerReconciliationClassification = "PROOF_MISMATCH";
                proofError.cause = error;
                throw proofError;
            }
            throw error;
        }
        const verified = await client.getObjects(entity, entityToken);
        if (JSON.stringify(objectData(verified, SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME)) !== JSON.stringify(stateWrite.DataObject) ||
            JSON.stringify(objectData(verified, DIAMONDS_MIGRATION_PROOF_OBJECT_NAME)) !== JSON.stringify(nextProof)) {
            throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Atomic Target state/proof readback failed.");
        }
        return result;
    }

    async function readProof(playFabId) {
        const account = await getUserAccountInfo(playFabId);
        const entity = {
            Id: account.UserInfo.TitleInfo.TitlePlayerAccount.Id,
            Type: "title_player_account"
        };
        const token = await client.getEntityToken();
        const objects = await client.getObjects(entity, token.EntityToken);
        const snapshot = objectData(objects, SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
        const proof = objectData(objects, DIAMONDS_MIGRATION_PROOF_OBJECT_NAME);
        const highValueProofValue = objectData(objects, SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME);
        const highValueProof = highValueProofValue === null
            ? null
            : validateServerEconomyPocHighValueProviderProof(highValueProofValue, playFabId);
        if (!snapshot || !proof) {
            throw coded("DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED", "Diamonds Canary migration proof is absent.");
        }
        return Object.freeze({
            snapshot: serverEconomyPocReadonly(snapshot),
            proof: validateDiamondsMigrationProof(proof, { targetSnapshot: snapshot }),
            highValueProof,
            profileVersion: serverEconomyPocNonNegative(objects.ProfileVersion ?? 0, "ProfileVersion")
        });
    }

    async function verifyTrustedOperation({ playFabId, operationId, operationHash, delta = null } = {}) {
        const readback = await readProof(playFabId);
        const id = serverEconomyPocId(operationId, "operationId", 200);
        const hash = sha256(operationHash, "operationHash");
        let operation = null;
        if (readback.proof.schemaVersion === DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION) {
            operation = readback.proof.appliedTargetOperations.find((entry) => entry.operationId === id);
        } else if (readback.highValueProof?.operationId === id) {
            if (readback.highValueProof.immutableHash !== hash) {
                throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH",
                    "Trusted operationId exists with another immutable hash.");
            }
            const latest = readback.proof.latestTargetOperation;
            if (!latest || latest.h !== hash ||
                readback.highValueProof.sequence !== readback.snapshot.highValueAppliedThroughSequence ||
                delta !== null && latest.d !== delta) {
                throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH",
                    "Current provider proof does not match the compact migration proof.");
            }
            operation = Object.freeze({
                operationId: id,
                operationHash: hash,
                delta: latest.d,
                resultingRevision: readback.snapshot.revision,
                resultingValue: readback.snapshot.diamonds
            });
        }
        if (!operation) return Object.freeze({
            verified: false,
            reason: "missing",
            playFabId,
            operationId: id,
            operationHash: hash,
            ...readback
        });
        if (operation.operationHash !== hash) {
            throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH", "Trusted operationId exists with another immutable hash.");
        }
        if (delta !== null && operation.delta !== delta) {
            throw coded("DIAMONDS_MIGRATION_PROOF_MISMATCH",
                "Trusted operation proof has another immutable delta.");
        }
        return Object.freeze({
            verified: true,
            reason: "applied",
            playFabId,
            operationId: id,
            operationHash: hash,
            delta: operation.delta,
            balance: readback.snapshot.diamonds,
            revision: readback.snapshot.revision,
            fencingEpoch: readback.snapshot.fencingEpoch,
            targetOnlyOperationCount: readback.proof.targetOnlyOperationCount,
            operation,
            ...readback
        });
    }

    return Object.freeze({
        getUserAccountInfo,
        getUserInventory: (...args) => client.getUserInventory(...args),
        getUserInternalData: (...args) => client.getUserInternalData(...args),
        getEntityToken: (...args) => client.getEntityToken(...args),
        getObjects: (...args) => client.getObjects(...args),
        setObjects,
        readDiamondsMigrationProof: readProof,
        verifyTrustedOperation,
        proofWriteDiagnostics: () => lastPreparedProofWrite === null
            ? null : serverEconomyPocReadonly(lastPreparedProofWrite),
        capabilities: Object.freeze({
            atomicStateAndMigrationProof: true,
            atomicStateProofCas: true,
            migrationProof: true,
            fencing: true,
            canonicalRuntimeCompanion: true,
            boundedOperationProofs: true,
            exactCanaryAllowlist: true
        })
    });
}
