import { createHash } from "node:crypto";

import {
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

export const CANARY02_SPEND10_RECOVERY_CONTRACT = Object.freeze({
    titleId: "1D0C16",
    productionTitleId: "142853",
    playFabId: "C5BD37AA141B3C4E",
    domain: "Diamonds",
    operationId: "diamonds-canary-v1:spend-10",
    eventId: "diamonds-canary-v1:event-spend-10",
    operationImmutableHash: "e738850decaa33a968dd8dee5b7595ab6e1ce6edbbf22dcb071f144714da2eb5",
    contextHash: "867ff05dffc05f2a22d1628dede070e5225ef7d0559dbd8008eab1ec4372435e",
    semanticIntentHash: "8aba116beecb87e94fabc17cd12909804589996e7299460e3d76948b9bbc9c85",
    resolutionImmutableHash: "8949a52148a426597bfa1c6c6ad64b11b6daff0ad841fd905ee5526b095ce6ab",
    eventIntentImmutableHash: "0e81562e1955db6d6a62e8ffbf79cd2cdcbc66e365a82fc2bad43829b23a1731",
    sequence: 2,
    expectedRevision: 2,
    diamondsDelta: -10,
    diamondsBefore: 25,
    diamondsAfter: 15,
    createdAtUnixMs: 1_787_607_159_126,
    reason: "gameplay_canary_spend_10_8aba116beecb87e9",
    previousOperationId: "diamonds-canary-v1:grant-25",
    previousResolutionImmutableHash: "d0bf518c72c4e7df335dad69d5b3bd51c408672a1c8f3f50cd998696949d622b",
    aofSha256: "1d47441ab7b0a57db5e6201586100a1c3fd1290672c1c3c91ba85a61fb09214c",
    aofBytes: 35_724,
    concordantRecordCount: 15
});

const KIND = "RecoveredOriginalOperation";
const DEFAULT_PREFIX = "seabyss:financial:diamonds:sandbox-canary:v1:";

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(actual, expected, label) {
    if (actual !== expected) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", label + " conflicts with certified evidence.");
}

function hash(actual, expected, label) {
    if (typeof actual !== "string" || !/^[a-f0-9]{64}$/u.test(actual) ||
        expected !== undefined && actual !== expected) {
        fail("POC_RECOVERY_HASH_MISMATCH", label + " is not the certified SHA-256.");
    }
}

function number(actual, expected, label) {
    if (!Number.isSafeInteger(actual) || actual !== expected) {
        fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", label + " conflicts with certified evidence.");
    }
}

function validateInbox(record) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    if (!plain(record) || !plain(record.operation)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Inbox record is absent.");
    same(record.schemaVersion, 1, "Inbox schema");
    same(record.playFabId, c.playFabId, "Inbox player");
    same(record.operationId, c.operationId, "Inbox operationId");
    number(record.sequence, c.sequence, "Inbox sequence");
    same(record.state, "Pending", "Inbox state");
    if (record.result !== null || record.ackedAtUnixMs !== null) {
        fail("POC_RECOVERY_PROVIDER_APPLIED", "Inbox evidence reports an applied operation.");
    }
    const operation = record.operation;
    for (const [label, actual, expected] of [
        ["operation schema", operation.schemaVersion, 1],
        ["operation kind", operation.kind, "trusted_gameplay"],
        ["operation player", operation.playFabId, c.playFabId],
        ["operationId", operation.operationId, c.operationId],
        ["eventId", operation.eventId, c.eventId],
        ["reason", operation.reason, c.reason],
        ["legacy diamonds field", operation.diamonds, 0],
        ["Elite field", operation.eliteBall, 0],
        ["Premium field", operation.premium, null]
    ]) same(actual, expected, label);
    number(operation.diamondsDelta, c.diamondsDelta, "Diamonds delta");
    number(operation.createdAtUnixMs, c.createdAtUnixMs, "createdAt");
    number(operation.effectiveAtUnixMs, c.createdAtUnixMs, "effectiveAt");
    hash(operation.contextHash, c.contextHash, "contextHash");
    hash(operation.immutableHash, c.operationImmutableHash, "operation immutableHash");
    const highValueIntent = {
        schemaVersion: operation.schemaVersion,
        kind: operation.kind,
        playFabId: operation.playFabId,
        operationId: operation.operationId,
        eventId: operation.eventId,
        reason: operation.reason,
        diamonds: operation.diamonds,
        diamondsDelta: operation.diamondsDelta ?? null,
        contextHash: operation.contextHash ?? null,
        eliteBall: operation.eliteBall,
        premium: operation.premium
    };
    hash(serverEconomyPocDigest(highValueIntent), c.operationImmutableHash, "stable high-value intent digest");
}

function validateResolution(record) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    if (!plain(record)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Resolution record is absent.");
    for (const [label, actual, expected] of [
        ["resolution player", record.playFabId, c.playFabId],
        ["resolution operationId", record.operationId, c.operationId],
        ["resolution outcome", record.outcome, "applied"],
        ["resolution state", record.state, "ManualReview"],
        ["provider classification", record.lastProviderClassification, "NOT_APPLIED"],
        ["provider error", record.lastProviderErrorCode, "POC_PLAYFAB_NOT_APPLIED"]
    ]) same(actual, expected, label);
    for (const [label, actual, expected] of [
        ["resolution sequence", record.sequence, c.sequence],
        ["expected revision", record.expectedRevision, c.expectedRevision],
        ["before balance", record.diamondsBefore, c.diamondsBefore],
        ["resolution delta", record.diamondsDelta, c.diamondsDelta],
        ["after balance", record.diamondsAfter, c.diamondsAfter],
        ["attempt count", record.providerAttemptCount, 3],
        ["attempt ordinal", record.providerAttemptOrdinal, 3]
    ]) number(actual, expected, label);
    hash(record.immutableHash, c.resolutionImmutableHash, "resolution immutableHash");
    if (!Array.isArray(record.providerAttemptHistory) || record.providerAttemptHistory.length !== 3) {
        fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Three durable provider attempts are required.");
    }
    let previousEpoch = 0;
    for (const [offset, attempt] of record.providerAttemptHistory.entries()) {
        if (!plain(attempt)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Attempt is malformed.");
        number(attempt.attempt, offset + 1, "attempt ordinal");
        same(attempt.operationId, c.operationId, "attempt operationId");
        hash(attempt.operationImmutableHash, c.operationImmutableHash, "attempt immutableHash");
        number(attempt.sequence, c.sequence, "attempt sequence");
        same(attempt.classification, "NOT_APPLIED", "attempt classification");
        same(attempt.errorCode, "POC_PLAYFAB_NOT_APPLIED", "attempt error");
        hash(attempt.attemptId, undefined, "attemptId");
        hash(attempt.leaseTokenDigest, undefined, "attempt lease digest");
        if (!Number.isSafeInteger(attempt.fencingEpoch) || attempt.fencingEpoch <= previousEpoch) {
            fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Attempt fencing epochs are not monotonic.");
        }
        previousEpoch = attempt.fencingEpoch;
    }
}

function validatePrevious(record) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    if (!plain(record)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Previous sequence is absent.");
    same(record.playFabId, c.playFabId, "previous player");
    same(record.operationId, c.previousOperationId, "previous operationId");
    same(record.state, "Acked", "previous state");
    for (const [label, actual, expected] of [
        ["previous sequence", record.sequence, 1],
        ["previous expected revision", record.expectedRevision, 1],
        ["previous before", record.diamondsBefore, 0],
        ["previous delta", record.diamondsDelta, 25],
        ["previous after", record.diamondsAfter, 25],
        ["previous snapshot revision", record.snapshotRevision, 2]
    ]) number(actual, expected, label);
    hash(record.immutableHash, c.previousResolutionImmutableHash, "previous resolution hash");
}

function validateEvent(record) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    const intent = { playFabId: c.playFabId, eventId: c.eventId, operationId: c.operationId };
    if (!plain(record) || !plain(record.intent)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Event index is absent.");
    hash(serverEconomyPocDigest(intent), c.eventIntentImmutableHash, "event intent digest");
    hash(record.immutableHash, c.eventIntentImmutableHash, "event index immutableHash");
    same(record.intent.playFabId, intent.playFabId, "event player");
    same(record.intent.eventId, intent.eventId, "eventId");
    same(record.intent.operationId, intent.operationId, "event operationId");
    same(record.identity, "event_" + serverEconomyPocDigest({ playFabId: c.playFabId, eventId: c.eventId }), "event identity");
}

function validateSemantic(context) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    if (!plain(context)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Semantic context is absent.");
    same(context.contextId, "sandbox:spend_10", "contextId");
    same(context.sessionId, "diamonds-sandbox-canary-cli-session", "sessionId");
    number(context.sessionEpoch, 2, "session epoch");
    same(context.canonicalEventId, c.eventId, "canonical eventId");
    hash(serverEconomyPocDigest(context), c.contextHash, "context digest");
    const intent = {
        playFabId: c.playFabId,
        operationId: c.operationId,
        reason: "canary_spend_10",
        context,
        diamonds: c.diamondsDelta,
        premium: null
    };
    hash(serverEconomyPocDigest(intent), c.semanticIntentHash, "semantic intent digest");
    same(c.reason, "gameplay_canary_spend_10_" + c.semanticIntentHash.slice(0, 16), "semantic reason");
}

function validateProvider(provider) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    if (!plain(provider) || !plain(provider.snapshot) || !plain(provider.migrationProof)) {
        fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Provider readback is incomplete.");
    }
    same(provider.titleId, c.titleId, "provider title");
    if (provider.titleId === c.productionTitleId) fail("POC_RECOVERY_PRODUCTION_FORBIDDEN", "Production is forbidden.");
    same(provider.playFabId, c.playFabId, "provider player");
    same(provider.classification, "NOT_APPLIED", "provider classification");
    if (provider.operationProof !== null || provider.operationMarker !== null ||
        provider.operationResultHash !== null) {
        fail("POC_RECOVERY_PROVIDER_APPLIED", "Provider contains evidence of operation application.");
    }
    number(provider.snapshot.diamonds, c.diamondsBefore, "provider balance");
    number(provider.snapshot.revision, c.expectedRevision, "provider revision");
    number(provider.snapshot.highValueAppliedThroughSequence, 1, "provider cursor");
    same(provider.migrationProof.schemaVersion, 1, "migration proof schema");
    same(provider.migrationProof.state, "Completed", "migration proof state");
    same(provider.migrationProof.titleId, c.titleId, "migration proof title");
    same(provider.migrationProof.playFabId, c.playFabId, "migration proof player");
    same(provider.migrationProof.domain, c.domain, "migration proof domain");
    number(provider.migrationProof.targetValue, c.diamondsBefore, "migration proof target");
    number(provider.migrationProof.targetRevision, c.expectedRevision, "migration proof revision");
    number(provider.migrationProof.targetOnlyOperationCount, 1, "migration proof operation count");
    if (!Array.isArray(provider.migrationProof.appliedTargetOperations)) {
        fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Legacy migration proof operation history is absent.");
    }
    if (provider.migrationProof.appliedTargetOperations.some((entry) =>
        entry?.operationId === c.operationId || entry?.operationHash === c.operationImmutableHash)) {
        fail("POC_RECOVERY_PROVIDER_APPLIED",
            "Legacy migration proof already contains the recovered operation.");
    }
}

export function validateCanary02Spend10RecoveryEvidence(evidence) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    if (!plain(evidence) || !plain(evidence.provenance)) fail("POC_RECOVERY_EVIDENCE_INCOMPLETE", "Evidence is absent.");
    same(evidence.provenance.kind, "RedisAofReplay", "provenance kind");
    hash(evidence.provenance.sha256, c.aofSha256, "AOF SHA-256");
    number(evidence.provenance.bytes, c.aofBytes, "AOF bytes");
    number(evidence.provenance.concordantRecordCount, c.concordantRecordCount, "concordant records");
    validateInbox(evidence.operationRecord);
    validateResolution(evidence.resolutionRecord);
    validatePrevious(evidence.previousResolution);
    validateEvent(evidence.eventIndexRecord);
    validateSemantic(evidence.semanticContext);
    validateProvider(evidence.provider);
    hash(serverEconomyPocDigest({
        playFabId: c.playFabId,
        operationId: c.operationId,
        sequence: c.sequence,
        expectedRevision: c.expectedRevision,
        diamondsBefore: c.diamondsBefore,
        diamondsDelta: c.diamondsDelta,
        diamondsAfter: c.diamondsAfter,
        outcome: "applied"
    }), c.resolutionImmutableHash, "resolution digest");
    return serverEconomyPocReadonly({
        status: "complete",
        evidenceHash: serverEconomyPocDigest(evidence),
        operationImmutableHash: c.operationImmutableHash,
        providerClassification: "NOT_APPLIED"
    });
}

export function createCanary02Spend10RecoveredOperationPlan({
    evidence,
    recoveryReason,
    importedAtUnixMs
} = {}) {
    const validated = validateCanary02Spend10RecoveryEvidence(evidence);
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    const importedAt = serverEconomyPocNonNegative(importedAtUnixMs, "importedAtUnixMs");
    const auditBasis = {
        schemaVersion: 1,
        kind: KIND,
        titleId: c.titleId,
        playFabId: c.playFabId,
        domain: c.domain,
        operationId: c.operationId,
        operationImmutableHash: c.operationImmutableHash,
        sequence: c.sequence,
        diamondsDelta: c.diamondsDelta,
        expectedRevision: c.expectedRevision,
        diamondsBefore: c.diamondsBefore,
        diamondsAfter: c.diamondsAfter,
        provenance: structuredClone(evidence.provenance),
        evidenceHash: validated.evidenceHash,
        recoveryReason: serverEconomyPocId(recoveryReason, "recoveryReason", 160),
        importedAtUnixMs: importedAt
    };
    const recoveryAudit = { ...auditBasis, auditHash: serverEconomyPocDigest(auditBasis) };
    return serverEconomyPocReadonly({
        status: KIND,
        operationId: c.operationId,
        operationImmutableHash: c.operationImmutableHash,
        sequence: c.sequence,
        recoveryAudit,
        inboxRecord: {
            ...structuredClone(evidence.operationRecord),
            state: "Pending",
            claimOwner: null,
            claimToken: null,
            claimExpiresAtUnixMs: null,
            result: null,
            ackedAtUnixMs: null,
            recovery: structuredClone(recoveryAudit)
        },
        resolutionRecord: {
            ...structuredClone(evidence.resolutionRecord),
            state: "RetryScheduled",
            activeProviderAttemptId: null,
            nextAttemptAtUnixMs: importedAt,
            recovery: structuredClone(recoveryAudit)
        },
        eventIndexRecord: structuredClone(evidence.eventIndexRecord)
    });
}

const RECOVERY_LUA = [
    "-- SEABYSS_CANARY02_SPEND10_ORIGINAL_OPERATION_RECOVERY_V1",
    "local leaseRaw = redis.call('GET', KEYS[1])",
    "if not leaseRaw then return {'stale_lease'} end",
    "local lease = cjson.decode(leaseRaw)",
    "if lease.playFabId ~= ARGV[1] or lease.tokenDigest ~= ARGV[2] or tonumber(lease.epoch) ~= tonumber(ARGV[3]) or tonumber(lease.expiresAtUnixMs or 0) <= tonumber(ARGV[4]) or redis.call('PTTL', KEYS[1]) <= 0 then return {'stale_lease'} end",
    "local previousRaw = redis.call('GET', KEYS[9])",
    "if not previousRaw then return {'previous_missing'} end",
    "local previous = cjson.decode(previousRaw)",
    "if previous.operationId ~= ARGV[5] or tonumber(previous.sequence) ~= 1 or previous.state ~= 'Acked' or previous.immutableHash ~= ARGV[6] or tonumber(previous.snapshotRevision) ~= 2 or tonumber(previous.diamondsAfter) ~= 25 then return {'previous_conflict'} end",
    "local auditRaw = redis.call('GET', KEYS[10])",
    "if auditRaw then local audit = cjson.decode(auditRaw) if audit.auditHash ~= ARGV[7] then return {'audit_conflict'} end return {'existing', redis.call('GET', KEYS[2]) or '', redis.call('GET', KEYS[3]) or '', auditRaw} end",
    "local eventRaw = redis.call('GET', KEYS[8])",
    "if eventRaw then local event = cjson.decode(eventRaw) if event.immutableHash ~= ARGV[8] then return {'event_conflict'} end else redis.call('SET', KEYS[8], ARGV[9]) end",
    "local inboxRaw = redis.call('GET', KEYS[2])",
    "local resolutionRaw = redis.call('GET', KEYS[3])",
    "if (inboxRaw and not resolutionRaw) or (resolutionRaw and not inboxRaw) then return {'partial'} end",
    "if inboxRaw and resolutionRaw then",
    " local inbox = cjson.decode(inboxRaw) local resolution = cjson.decode(resolutionRaw)",
    " if inbox.playFabId ~= ARGV[1] or inbox.operationId ~= ARGV[10] or tonumber(inbox.sequence) ~= tonumber(ARGV[11]) or inbox.state ~= 'Pending' or inbox.operation.immutableHash ~= ARGV[12] or inbox.result ~= cjson.null or resolution.playFabId ~= ARGV[1] or resolution.operationId ~= ARGV[10] or tonumber(resolution.sequence) ~= tonumber(ARGV[11]) or resolution.state ~= 'ManualReview' or resolution.immutableHash ~= ARGV[13] or resolution.lastProviderClassification ~= 'NOT_APPLIED' then return {'conflict'} end",
    "else",
    " local sequence = tonumber(redis.call('GET', KEYS[4]) or '0')",
    " if sequence ~= 1 and sequence ~= tonumber(ARGV[11]) then return {'sequence_conflict'} end",
    " local members = redis.call('ZRANGEBYSCORE', KEYS[5], ARGV[11], ARGV[11])",
    " if #members > 0 and not (#members == 1 and members[1] == KEYS[2]) then return {'sequence_conflict'} end",
    "end",
    "redis.call('SET', KEYS[2], ARGV[14])",
    "redis.call('SET', KEYS[3], ARGV[15])",
    "redis.call('SET', KEYS[4], ARGV[11])",
    "redis.call('ZADD', KEYS[5], ARGV[11], KEYS[2])",
    "redis.call('SETNX', KEYS[6], ARGV[1])",
    "redis.call('SADD', KEYS[7], ARGV[16])",
    "redis.call('SET', KEYS[10], ARGV[17])",
    "return {'recovered', ARGV[14], ARGV[15], ARGV[17]}"
].join("\n");

export function canary02Spend10RecoveryRedisKeys(prefix = DEFAULT_PREFIX) {
    const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
    const playerHash = sha256(c.playFabId);
    const operationHash = sha256(c.operationId);
    const previousHash = sha256(c.previousOperationId);
    const eventIdentity = "event_" + serverEconomyPocDigest({ playFabId: c.playFabId, eventId: c.eventId });
    const base = prefix + "player:" + playerHash + ":";
    return Object.freeze({
        playerHash,
        lease: prefix + "{" + playerHash + "}:player-lease",
        operation: base + "inbox:operation:" + operationHash,
        resolution: prefix + "player:{" + playerHash + "}:gameplay-resolution:" + operationHash,
        sequence: base + "inbox:sequence",
        index: base + "inbox:index",
        playerId: base + "identity",
        players: prefix + "inbox:players",
        eventIndex: prefix + "event-index:{" + sha256(eventIdentity) + "}",
        previousResolution: prefix + "player:{" + playerHash + "}:gameplay-resolution:" + previousHash,
        audit: prefix + "player:{" + playerHash + "}:recovery-audit:" + operationHash
    });
}

export function createRedisCanary02Spend10RecoveryImporter({
    redis,
    prefix = DEFAULT_PREFIX,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (typeof redis?.sendCommand !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Recovery importer requires Redis sendCommand and a clock.");
    }
    serverEconomyPocId(prefix, "recovery Redis prefix", 160);
    const redisKeys = canary02Spend10RecoveryRedisKeys(prefix);

    async function importRecoveredOriginal({ plan, playerLeaseToken, playerFencingEpoch } = {}) {
        if (!plain(plan) || plan.status !== KIND ||
            plan.operationId !== CANARY02_SPEND10_RECOVERY_CONTRACT.operationId) {
            fail("POC_RECOVERY_PLAN_INVALID", "Recovered original operation plan is invalid.");
        }
        const token = serverEconomyPocId(playerLeaseToken, "player lease token", 255);
        const epoch = serverEconomyPocPositive(playerFencingEpoch, "player fencing epoch");
        const now = serverEconomyPocNonNegative(nowMilliseconds(), "recovery import time");
        const c = CANARY02_SPEND10_RECOVERY_CONTRACT;
        const result = await redis.sendCommand([
            "EVAL", RECOVERY_LUA, "10",
            redisKeys.lease, redisKeys.operation, redisKeys.resolution, redisKeys.sequence,
            redisKeys.index, redisKeys.playerId, redisKeys.players, redisKeys.eventIndex,
            redisKeys.previousResolution, redisKeys.audit,
            c.playFabId, sha256(token), String(epoch), String(now), c.previousOperationId,
            c.previousResolutionImmutableHash, plan.recoveryAudit.auditHash,
            c.eventIntentImmutableHash, JSON.stringify(plan.eventIndexRecord), c.operationId,
            String(c.sequence), c.operationImmutableHash, c.resolutionImmutableHash,
            JSON.stringify(plan.inboxRecord), JSON.stringify(plan.resolutionRecord),
            redisKeys.playerHash, JSON.stringify(plan.recoveryAudit)
        ]);
        if (!Array.isArray(result) || typeof result[0] !== "string") {
            fail("POC_RECOVERY_REDIS_PROTOCOL", "Recovery import returned invalid Redis data.");
        }
        if (result[0] === "stale_lease") {
            serverEconomyPocFail("POC_STALE_WRITER", "Recovery lease is absent, expired, or fenced.", {
                retryable: true,
                statusCode: 409
            });
        }
        if (result[0] === "existing") {
            return serverEconomyPocReadonly({
                status: "existing",
                recoveredOriginalOperation: true,
                audit: result[3] ? JSON.parse(result[3]) : plan.recoveryAudit
            });
        }
        if (result[0] !== "recovered") {
            fail(
                result[0] === "partial" ? "POC_RECOVERY_PARTIAL_STATE" : "POC_RECOVERY_STATE_CONFLICT",
                "Recovery import refused inconsistent durable state (" + result[0] + ")."
            );
        }
        return serverEconomyPocReadonly({
            status: "recovered",
            recoveredOriginalOperation: true,
            inboxRecord: JSON.parse(result[1]),
            resolutionRecord: JSON.parse(result[2]),
            audit: JSON.parse(result[3])
        });
    }

    return Object.freeze({
        importRecoveredOriginal,
        keys: redisKeys,
        durable: true,
        redisCompatible: true,
        atomicLua: true,
        exactCanaryOnly: true
    });
}
