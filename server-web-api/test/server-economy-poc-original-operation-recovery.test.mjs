import test from "node:test";
import assert from "node:assert/strict";

import {
    CANARY02_SPEND10_RECOVERY_CONTRACT,
    createCanary02Spend10RecoveredOperationPlan,
    createRedisCanary02Spend10RecoveryImporter,
    validateCanary02Spend10RecoveryEvidence
} from "../src/server-economy-poc-original-operation-recovery.js";
import {
    createServerEconomyPocInitialSnapshot,
    serverEconomyPocDigest
} from "../src/server-economy-poc-model.js";

const C = CANARY02_SPEND10_RECOVERY_CONTRACT;
const IMPORTED_AT = 1_787_608_000_000;
const LEASE_TOKEN = "canary02-recovery-test-lease";
const LEASE_EPOCH = 9;

function clone(value) {
    return structuredClone(value);
}

function eventRecord() {
    const intent = { playFabId: C.playFabId, eventId: C.eventId, operationId: C.operationId };
    return {
        identity: "event_" + serverEconomyPocDigest({ playFabId: C.playFabId, eventId: C.eventId }),
        immutableHash: C.eventIntentImmutableHash,
        intent
    };
}

function operationRecord() {
    return {
        playFabId: C.playFabId,
        sequence: 2,
        ackedAtUnixMs: null,
        operation: {
            eventId: C.eventId,
            playFabId: C.playFabId,
            createdAtUnixMs: C.createdAtUnixMs,
            immutableHash: C.operationImmutableHash,
            schemaVersion: 1,
            operationId: C.operationId,
            contextHash: C.contextHash,
            diamonds: 0,
            reason: C.reason,
            effectiveAtUnixMs: C.createdAtUnixMs,
            premium: null,
            diamondsDelta: -10,
            kind: "trusted_gameplay",
            eliteBall: 0
        },
        claimOwner: null,
        schemaVersion: 1,
        operationId: C.operationId,
        state: "Pending",
        claimExpiresAtUnixMs: null,
        result: null,
        claimEpoch: 3,
        claimToken: null
    };
}

function attempt(attemptNumber, epoch, state, attemptId, leaseTokenDigest, startedAt, completedAt) {
    return {
        classification: "NOT_APPLIED",
        attemptId,
        attempt: attemptNumber,
        errorCode: "POC_PLAYFAB_NOT_APPLIED",
        operationImmutableHash: C.operationImmutableHash,
        operationId: C.operationId,
        state,
        leaseTokenDigest,
        completedAtUnixMs: completedAt,
        startedAtUnixMs: startedAt,
        nextAttemptAtUnixMs: completedAt + 1_000,
        fencingEpoch: epoch,
        sequence: 2
    };
}

function resolutionRecord() {
    return {
        sequence: 2,
        lastProviderErrorCode: "POC_PLAYFAB_NOT_APPLIED",
        lastProviderAttemptAtUnixMs: 1_787_607_380_914,
        outcome: "applied",
        diamondsDelta: -10,
        playFabId: C.playFabId,
        diamondsAfter: 15,
        providerAttemptOrdinal: 3,
        activeProviderAttemptId: "27fcac7f89d349b6d0e58560319b32cf48e0d10e9856283cb3b1bf0d7ab7ce8a",
        operationId: C.operationId,
        state: "ManualReview",
        immutableHash: C.resolutionImmutableHash,
        diamondsBefore: 25,
        lastProviderClassification: "NOT_APPLIED",
        nextAttemptAtUnixMs: null,
        providerAttemptCount: 3,
        providerAttemptHistory: [
            attempt(
                1,
                3,
                "RetryScheduled",
                "1921a11ad1ed392f2ccd1daf7c55a3485d6c6761590e9c4148ba7189b22f831f",
                "23dcb9d6cf687b579c6e115716f20ad117e079e50fff1dbef3698cc658941878",
                1_787_607_159_920,
                1_787_607_160_684
            ),
            attempt(
                2,
                4,
                "RetryScheduled",
                "eb4d06b8727cc39cebbe0ed9a849b5df140961ef30739ef1e2ac91d1d9bcf306",
                "da440e9bc8a97f2a16fd95d41555a13f61e8a03e51a09ab1541182772b107b15",
                1_787_607_280_924,
                1_787_607_281_748
            ),
            attempt(
                3,
                5,
                "ManualReview",
                "27fcac7f89d349b6d0e58560319b32cf48e0d10e9856283cb3b1bf0d7ab7ce8a",
                "021f25f733e3434259dbb0917f3b6d49faa144cac2c749463416f083d919b542",
                1_787_607_380_150,
                1_787_607_380_914
            )
        ],
        expectedRevision: 2
    };
}

function previousResolution() {
    return {
        sequence: 1,
        immutableHash: C.previousResolutionImmutableHash,
        providerAttemptOrdinal: 1,
        diamondsDelta: 25,
        snapshotRevision: 2,
        diamondsAfter: 25,
        providerAttemptHistory: [],
        expectedRevision: 1,
        operationId: C.previousOperationId,
        state: "Acked",
        playFabId: C.playFabId,
        providerAttemptCount: 0,
        diamondsBefore: 0,
        outcome: "applied"
    };
}

function exactEvidence() {
    return {
        provenance: {
            kind: "RedisAofReplay",
            sha256: C.aofSha256,
            bytes: C.aofBytes,
            concordantRecordCount: C.concordantRecordCount
        },
        semanticContext: {
            contextId: "sandbox:spend_10",
            sessionId: "diamonds-sandbox-canary-cli-session",
            sessionEpoch: 2,
            canonicalEventId: C.eventId
        },
        eventIndexRecord: eventRecord(),
        operationRecord: operationRecord(),
        resolutionRecord: resolutionRecord(),
        previousResolution: previousResolution(),
        provider: {
            titleId: C.titleId,
            playFabId: C.playFabId,
            classification: "NOT_APPLIED",
            snapshot: {
                diamonds: 25,
                revision: 2,
                highValueAppliedThroughSequence: 1
            },
            operationProof: null,
            operationMarker: null,
            operationResultHash: null,
            migrationProof: {
                schemaVersion: 1,
                state: "Completed",
                titleId: C.titleId,
                playFabId: C.playFabId,
                domain: "Diamonds",
                targetValue: 25,
                targetRevision: 2,
                targetOnlyOperationCount: 1,
                appliedTargetOperations: [{
                    operationId: "diamonds-canary-v1:grant-25",
                    operationHash: "3b42649ced522daa90bf0c9bf374caf178e2fe510e7ce45b1d3ff0d60a48db2c",
                    delta: 25,
                    resultingRevision: 2,
                    resultingValue: 25
                }]
            }
        }
    };
}

function plan(evidence = exactEvidence()) {
    return createCanary02Spend10RecoveredOperationPlan({
        evidence,
        recoveryReason: "recover_certified_original_after_test_redis_cleanup",
        importedAtUnixMs: IMPORTED_AT
    });
}

function fakeRedis(responses) {
    const calls = [];
    let offset = 0;
    return {
        calls,
        async sendCommand(command) {
            calls.push(command);
            const configured = responses[Math.min(offset, responses.length - 1)];
            offset += 1;
            if (typeof configured === "function") return configured(command);
            return configured;
        }
    };
}

function recoveredResponse(command) {
    return ["recovered", command[26], command[27], command[29]];
}

test("exact AOF, semantic, event, resolution and provider NOT_APPLIED evidence is accepted", () => {
    const validated = validateCanary02Spend10RecoveryEvidence(exactEvidence());
    assert.equal(validated.status, "complete");
    assert.equal(validated.operationImmutableHash, C.operationImmutableHash);
    assert.equal(validated.providerClassification, "NOT_APPLIED");

    const recovered = plan();
    assert.equal(recovered.status, "RecoveredOriginalOperation");
    assert.equal(recovered.operationId, C.operationId);
    assert.equal(recovered.sequence, 2);
    assert.equal(recovered.inboxRecord.operation.immutableHash, C.operationImmutableHash);
    assert.equal(recovered.resolutionRecord.state, "RetryScheduled");
    assert.equal(recovered.resolutionRecord.providerAttemptHistory.length, 3);
    assert.equal(recovered.resolutionRecord.providerAttemptHistory[2].state, "ManualReview");
    assert.equal(recovered.recoveryAudit.kind, "RecoveredOriginalOperation");
    assert.match(recovered.recoveryAudit.auditHash, /^[a-f0-9]{64}$/u);
});

for (const [label, mutate, expectedCode] of [
    ["wrong operation hash", (value) => {
        value.operationRecord.operation.immutableHash = "f".repeat(64);
    }, "POC_RECOVERY_HASH_MISMATCH"],
    ["wrong sequence", (value) => {
        value.operationRecord.sequence = 3;
    }, "POC_RECOVERY_EVIDENCE_INCOMPLETE"],
    ["wrong delta", (value) => {
        value.operationRecord.operation.diamondsDelta = -11;
    }, "POC_RECOVERY_EVIDENCE_INCOMPLETE"],
    ["partial evidence", (value) => {
        delete value.resolutionRecord;
    }, "POC_RECOVERY_EVIDENCE_INCOMPLETE"],
    ["provider already applied", (value) => {
        value.provider.classification = "APPLIED";
        value.provider.operationProof = {
            operationId: C.operationId,
            immutableHash: C.operationImmutableHash
        };
    }, "POC_RECOVERY_EVIDENCE_INCOMPLETE"]
]) {
    test(label + " is refused before Redis import", () => {
        const evidence = exactEvidence();
        mutate(evidence);
        assert.throws(
            () => validateCanary02Spend10RecoveryEvidence(evidence),
            (error) => error.code === expectedCode
        );
    });
}

test("provider proof cannot be relabeled NOT_APPLIED", () => {
    const evidence = exactEvidence();
    evidence.provider.operationProof = { operationId: C.operationId, immutableHash: C.operationImmutableHash };
    assert.throws(
        () => validateCanary02Spend10RecoveryEvidence(evidence),
        (error) => error.code === "POC_RECOVERY_PROVIDER_APPLIED"
    );
});

test("legacy migration history containing spend-10 cannot be relabeled NOT_APPLIED", () => {
    const evidence = exactEvidence();
    evidence.provider.migrationProof.appliedTargetOperations.push({
        operationId: C.operationId,
        operationHash: C.operationImmutableHash,
        delta: -10,
        resultingRevision: 3,
        resultingValue: 15
    });
    assert.throws(() => validateCanary02Spend10RecoveryEvidence(evidence),
        (error) => error.code === "POC_RECOVERY_PROVIDER_APPLIED");
});

test("Redis import is one atomic fenced Lua call and duplicate import is idempotent", async () => {
    const recovered = plan();
    const redis = fakeRedis([
        recoveredResponse,
        (command) => ["existing", command[26], command[27], command[29]]
    ]);
    const importer = createRedisCanary02Spend10RecoveryImporter({
        redis,
        nowMilliseconds: () => IMPORTED_AT
    });

    const first = await importer.importRecoveredOriginal({
        plan: recovered,
        playerLeaseToken: LEASE_TOKEN,
        playerFencingEpoch: LEASE_EPOCH
    });
    const second = await importer.importRecoveredOriginal({
        plan: recovered,
        playerLeaseToken: LEASE_TOKEN,
        playerFencingEpoch: LEASE_EPOCH
    });

    assert.equal(first.status, "recovered");
    assert.equal(first.resolutionRecord.state, "RetryScheduled");
    assert.equal(first.inboxRecord.operationId, C.operationId);
    assert.equal(second.status, "existing");
    assert.equal(second.audit.auditHash, recovered.recoveryAudit.auditHash);
    assert.equal(redis.calls.length, 2);
    assert.equal(redis.calls[0][0], "EVAL");
    assert.equal(redis.calls[0][2], "10");
    assert.match(redis.calls[0][1], /PTTL/u);
    assert.match(redis.calls[0][1], /previous.state ~= 'Acked'/u);
    assert.match(redis.calls[0][1], /resolution.state ~= 'ManualReview'/u);
    assert.match(redis.calls[0][1], /redis\.call\('SET', KEYS\[2\]/u);
    assert.equal(importer.atomicLua, true);
    assert.equal(importer.exactCanaryOnly, true);
});

test("partial or conflicting durable Redis state is refused", async () => {
    for (const [status, code] of [
        ["partial", "POC_RECOVERY_PARTIAL_STATE"],
        ["sequence_conflict", "POC_RECOVERY_STATE_CONFLICT"],
        ["event_conflict", "POC_RECOVERY_STATE_CONFLICT"]
    ]) {
        const importer = createRedisCanary02Spend10RecoveryImporter({
            redis: fakeRedis([[status]]),
            nowMilliseconds: () => IMPORTED_AT
        });
        await assert.rejects(
            importer.importRecoveredOriginal({
                plan: plan(),
                playerLeaseToken: LEASE_TOKEN,
                playerFencingEpoch: LEASE_EPOCH
            }),
            (error) => error.code === code
        );
    }
});

test("stale recovery worker remains fenced", async () => {
    const importer = createRedisCanary02Spend10RecoveryImporter({
        redis: fakeRedis([["stale_lease"]]),
        nowMilliseconds: () => IMPORTED_AT
    });
    await assert.rejects(
        importer.importRecoveredOriginal({
            plan: plan(),
            playerLeaseToken: LEASE_TOKEN,
            playerFencingEpoch: LEASE_EPOCH
        }),
        (error) => error.code === "POC_STALE_WRITER" && error.retryable === true
    );
});

test("recovered original operation advances legacy Proof V1 to compact Proof V2 at 25 -> 15", async () => {
    process.env.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID = C.titleId;
    process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID = C.playFabId;
    const proofApi = await import("../src/diamonds-migration-proof-companion.js?recovery-original-v2");
    const currentSnapshot = {
        ...createServerEconomyPocInitialSnapshot(C.playFabId, C.createdAtUnixMs),
        revision: 2,
        fencingEpoch: 2,
        diamonds: 25,
        highValueAppliedThroughSequence: 1
    };
    const grantOperation = {
        operationId: "diamonds-canary-v1:grant-25",
        operationHash: "3b42649ced522daa90bf0c9bf374caf178e2fe510e7ce45b1d3ff0d60a48db2c",
        delta: 25,
        resultingRevision: 2,
        resultingValue: 25
    };
    const basis = {
        schemaVersion: proofApi.DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION,
        state: "Completed",
        titleId: C.titleId,
        playFabId: C.playFabId,
        domain: "Diamonds",
        migrationVersion: "diamonds-domain-v1",
        legacyValue: 0,
        targetValue: 25,
        targetRevision: 2,
        planHash: "a".repeat(64),
        scannerHash: "b".repeat(64),
        adapterVersion: "diamonds-target-poc-v1",
        appliedAt: "2026-08-24T12:00:00.000Z",
        fencingEpoch: 2,
        operationId: "diamonds-canary-v1:migration-0-to-0",
        targetDigest: serverEconomyPocDigest(25),
        targetOnlyOperationCount: 1,
        appliedTargetOperations: [grantOperation]
    };
    const currentProof = {
        ...basis,
        resultHash: proofApi.diamondsMigrationProofResultHash(basis, currentSnapshot)
    };
    const nextSnapshot = {
        ...currentSnapshot,
        revision: 3,
        fencingEpoch: 9,
        diamonds: 15,
        highValueAppliedThroughSequence: 2,
        updatedAtUnixMs: IMPORTED_AT
    };
    const operationProof = {
        schemaVersion: 1,
        playFabId: C.playFabId,
        sequence: 2,
        operationId: C.operationId,
        eventId: C.eventId,
        immutableHash: C.operationImmutableHash
    };
    const nextProof = proofApi.advanceDiamondsMigrationProof({
        currentProof,
        currentSnapshot,
        nextSnapshot,
        operationProof,
        currentOperationProof: null
    });

    assert.equal(nextSnapshot.diamonds, 15);
    assert.equal(nextSnapshot.revision, 3);
    assert.equal(nextProof.schemaVersion, proofApi.DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION);
    assert.equal(nextProof.targetValue, 15);
    assert.equal(nextProof.targetRevision, 3);
    assert.equal(nextProof.latestTargetOperation.h, C.operationImmutableHash);
    assert.equal(nextProof.latestTargetOperation.d, -10);
    assert.ok(proofApi.diamondsMigrationProofUtf8Bytes(nextProof) <= 1_024);

    const replay = operationProof.operationId === C.operationId &&
        operationProof.immutableHash === C.operationImmutableHash
        ? { status: "already_applied", balance: nextSnapshot.diamonds }
        : null;
    assert.deepEqual(replay, { status: "already_applied", balance: 15 });
});
