import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
    CANARY02_SPEND10_RECOVERY_CONTRACT,
    canary02Spend10RecoveryRedisKeys,
    createCanary02Spend10RecoveredOperationPlan,
    validateCanary02Spend10RecoveryEvidence
} from "./server-economy-poc-original-operation-recovery.js";
import { serverEconomyPocDigest, serverEconomyPocReadonly } from "./server-economy-poc-model.js";

const C = CANARY02_SPEND10_RECOVERY_CONTRACT;
const PROVIDER_PROOF_LIMIT_BYTES = 1_024;

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireFunction(value, name) {
    if (typeof value !== "function") throw new TypeError(name + " is required.");
    return value;
}

function exact(actual, expected, code, label) {
    if (actual !== expected) fail(code, label + " differs from the certified recovery contract.");
}

function digestEqual(actual, expected, label) {
    if (serverEconomyPocDigest(actual) !== serverEconomyPocDigest(expected)) {
        fail("DIAMONDS_RECOVERY_REDIS_AOF_MISMATCH", label + " differs between Redis and the certified AOF.");
    }
}

function parseLine(buffer, offset) {
    const end = buffer.indexOf("\r\n", offset, "utf8");
    if (end < 0) fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF contains an unterminated RESP line.");
    return { value: buffer.toString("utf8", offset, end), next: end + 2 };
}

function parseResp(buffer, offset) {
    if (offset >= buffer.length) fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF ended inside a RESP value.");
    const marker = String.fromCharCode(buffer[offset]);
    const line = parseLine(buffer, offset + 1);
    if (marker === "$".charAt(0)) {
        const length = Number(line.value);
        if (!Number.isSafeInteger(length) || length < -1) fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF bulk length is invalid.");
        if (length === -1) return { value: null, next: line.next };
        const end = line.next + length;
        if (end + 2 > buffer.length || buffer[end] !== 13 || buffer[end + 1] !== 10) {
            fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF bulk payload is truncated.");
        }
        return { value: buffer.toString("utf8", line.next, end), next: end + 2 };
    }
    if (marker === "*".charAt(0)) {
        const count = Number(line.value);
        if (!Number.isSafeInteger(count) || count < 0) fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF array length is invalid.");
        const values = [];
        let next = line.next;
        for (let index = 0; index < count; index += 1) {
            const item = parseResp(buffer, next);
            values.push(item.value);
            next = item.next;
        }
        return { value: values, next };
    }
    if (marker === "+".charAt(0) || marker === "-".charAt(0)) return { value: line.value, next: line.next };
    if (marker === ":".charAt(0)) {
        const number = Number(line.value);
        if (!Number.isSafeInteger(number)) fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF integer is invalid.");
        return { value: number, next: line.next };
    }
    fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF uses an unsupported RESP marker.");
}

export function parseRedisRespAof(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer[0] !== 42) {
        fail("DIAMONDS_RECOVERY_AOF_INVALID", "Recovery evidence must be a non-empty RESP append-only file.");
    }
    const commands = [];
    let offset = 0;
    while (offset < buffer.length) {
        const parsed = parseResp(buffer, offset);
        if (!Array.isArray(parsed.value) || parsed.value.length === 0 ||
            parsed.value.some((value) => typeof value !== "string")) {
            fail("DIAMONDS_RECOVERY_AOF_INVALID", "Redis AOF command is not an array of bulk strings.");
        }
        commands.push(parsed.value);
        offset = parsed.next;
    }
    return Object.freeze(commands.map((command) => Object.freeze([...command])));
}

function json(value, label) {
    try {
        const parsed = JSON.parse(value);
        if (!plain(parsed)) throw new Error();
        return parsed;
    } catch {
        fail("DIAMONDS_RECOVERY_AOF_INVALID", label + " is not a JSON object.");
    }
}

export function extractCanary02Spend10AofEvidence(buffer) {
    const bytes = buffer.length;
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    exact(bytes, C.aofBytes, "DIAMONDS_RECOVERY_AOF_MISMATCH", "AOF byte size");
    exact(sha256, C.aofSha256, "DIAMONDS_RECOVERY_AOF_MISMATCH", "AOF SHA-256");
    const redisKeys = canary02Spend10RecoveryRedisKeys();
    const relevant = new Set([
        redisKeys.operation,
        redisKeys.resolution,
        redisKeys.previousResolution,
        redisKeys.eventIndex
    ]);
    const values = new Map();
    let concordantRecordCount = 0;
    let relevantDeleteCount = 0;
    for (const command of parseRedisRespAof(buffer)) {
        const name = command[0].toUpperCase();
        if (name === "SET" && command.length >= 3 && relevant.has(command[1])) {
            values.set(command[1], command[2]);
            if (command[1] === redisKeys.operation || command[1] === redisKeys.resolution ||
                command[1] === redisKeys.eventIndex) concordantRecordCount += 1;
        }
        if ((name === "DEL" || name === "UNLINK") && command.slice(1).some((key) => relevant.has(key))) {
            for (const key of command.slice(1)) if (relevant.has(key)) values.delete(key);
            relevantDeleteCount += 1;
        }
    }
    exact(relevantDeleteCount, 0, "DIAMONDS_RECOVERY_AOF_MISMATCH", "economic evidence deletion count");
    exact(concordantRecordCount, C.concordantRecordCount,
        "DIAMONDS_RECOVERY_AOF_MISMATCH", "concordant AOF record count");
    for (const key of relevant) {
        if (!values.has(key)) fail("DIAMONDS_RECOVERY_AOF_INCOMPLETE", "A required durable record is absent from the AOF.");
    }
    return serverEconomyPocReadonly({
        provenance: { kind: "RedisAofReplay", sha256, bytes, concordantRecordCount },
        semanticContext: {
            contextId: "sandbox:spend_10",
            sessionId: "diamonds-sandbox-canary-cli-session",
            sessionEpoch: 2,
            canonicalEventId: C.eventId
        },
        operationRecord: json(values.get(redisKeys.operation), "Inbox operation"),
        resolutionRecord: json(values.get(redisKeys.resolution), "Gameplay resolution"),
        previousResolution: json(values.get(redisKeys.previousResolution), "Previous resolution"),
        eventIndexRecord: json(values.get(redisKeys.eventIndex), "Event index")
    });
}

export function readCanary02Spend10AofEvidence(path) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("AOF path is required.");
    return extractCanary02Spend10AofEvidence(readFileSync(path));
}

function providerEvidence(state) {
    if (!plain(state) || !plain(state.target) || !plain(state.migrationProof)) {
        fail("DIAMONDS_RECOVERY_PROVIDER_STATE_INVALID", "Provider readback is incomplete.");
    }
    exact(state.titleId, C.titleId, "DIAMONDS_RECOVERY_IDENTITY_INVALID", "Sandbox Title");
    exact(state.productionTitleId, C.productionTitleId, "DIAMONDS_RECOVERY_IDENTITY_INVALID", "Production Title");
    exact(state.productionTitleUntouched, true, "DIAMONDS_RECOVERY_IDENTITY_INVALID", "Production isolation");
    exact(state.playFabId, C.playFabId, "DIAMONDS_RECOVERY_IDENTITY_INVALID", "Canary identity");
    exact(state.target.diamonds, C.diamondsBefore, "DIAMONDS_RECOVERY_PROVIDER_STATE_INVALID", "Target balance");
    exact(state.target.revision, C.expectedRevision, "DIAMONDS_RECOVERY_PROVIDER_STATE_INVALID", "Target revision");
    exact(state.target.highValueAppliedThroughSequence, 1,
        "DIAMONDS_RECOVERY_PROVIDER_STATE_INVALID", "Target sequence cursor");
    exact(state.migrationProof.schemaVersion, 1, "DIAMONDS_RECOVERY_PROVIDER_STATE_INVALID", "Migration proof schema");
    exact(state.migrationProof.state, "Completed", "DIAMONDS_RECOVERY_PROVIDER_STATE_INVALID", "Migration proof state");
    if (state.providerProof?.verified !== false || state.providerProof?.reason !== "missing") {
        fail("DIAMONDS_RECOVERY_PROVIDER_APPLIED", "Provider does not prove spend-10 NOT_APPLIED.");
    }
    return {
        titleId: state.titleId,
        playFabId: state.playFabId,
        classification: "NOT_APPLIED",
        snapshot: {
            diamonds: state.target.diamonds,
            revision: state.target.revision,
            highValueAppliedThroughSequence: state.target.highValueAppliedThroughSequence
        },
        operationProof: null,
        operationMarker: null,
        operationResultHash: null,
        migrationProof: state.migrationProof
    };
}

function counter(metrics, name) {
    const value = metrics?.counters?.[name + "|"] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) fail("DIAMONDS_RECOVERY_METRICS_INVALID", "Provider metric is invalid.");
    return value;
}

function assertScheduled(state, auditHash) {
    providerEvidence(state);
    exact(state.operation?.state, "Pending", "DIAMONDS_RECOVERY_IMPORT_INVALID", "Inbox state");
    exact(state.resolution?.state, "RetryScheduled", "DIAMONDS_RECOVERY_IMPORT_INVALID", "Resolution state");
    exact(state.resolution?.operationId, C.operationId, "DIAMONDS_RECOVERY_IMPORT_INVALID", "Resolution operationId");
    exact(state.resolution?.sequence, C.sequence, "DIAMONDS_RECOVERY_IMPORT_INVALID", "Resolution sequence");
    exact(state.resolution?.recovery?.auditHash, auditHash, "DIAMONDS_RECOVERY_IMPORT_INVALID", "Recovery audit");
}

function assertApplied(state) {
    exact(state.target?.diamonds, C.diamondsAfter, "DIAMONDS_RECOVERY_APPLY_INVALID", "Target balance");
    exact(state.target?.revision, 3, "DIAMONDS_RECOVERY_APPLY_INVALID", "Target revision");
    exact(state.target?.highValueAppliedThroughSequence, C.sequence,
        "DIAMONDS_RECOVERY_APPLY_INVALID", "Target sequence cursor");
    exact(state.operation?.state, "Acked", "DIAMONDS_RECOVERY_APPLY_INVALID", "Inbox state");
    exact(state.resolution?.state, "Acked", "DIAMONDS_RECOVERY_APPLY_INVALID", "Resolution state");
    exact(state.migrationProof?.schemaVersion, 2, "DIAMONDS_RECOVERY_APPLY_INVALID", "Migration proof schema");
    exact(state.providerProof?.verified, true, "DIAMONDS_RECOVERY_APPLY_INVALID", "Provider proof");
    exact(state.providerProof?.operationId, C.operationId, "DIAMONDS_RECOVERY_APPLY_INVALID", "Provider operationId");
    exact(state.providerProof?.operationHash, C.operationImmutableHash,
        "DIAMONDS_RECOVERY_APPLY_INVALID", "Provider operation hash");
}

export async function runCanary02Spend10RecoveryHarness({
    explicitlyEnabled = false,
    providerWritesEnabled = false,
    aofEvidence,
    dependencies,
    nowMilliseconds = () => Date.now(),
    validateEvidence = validateCanary02Spend10RecoveryEvidence,
    createRecoveryPlan = createCanary02Spend10RecoveredOperationPlan
} = {}) {
    if (explicitlyEnabled !== true || providerWritesEnabled !== true) {
        fail("DIAMONDS_RECOVERY_DISABLED", "Recovery and its single provider attempt require explicit enablement.");
    }
    if (!plain(aofEvidence) || !plain(dependencies) || typeof nowMilliseconds !== "function") {
        throw new TypeError("Recovery harness dependencies are invalid.");
    }
    for (const method of [
        "inspectFinishState", "readRecoveryRedisRecords", "acquireRecoveryPlayerLease",
        "importRecoveredOriginalOperation", "releaseRecoveryPlayerLease",
        "consumeExistingTargetOperation", "readProviderHttpMetrics", "readProofWriteDiagnostics"
    ]) requireFunction(dependencies[method], "dependencies." + method);

    const before = await dependencies.inspectFinishState();
    const redisBefore = await dependencies.readRecoveryRedisRecords();
    if (redisBefore.audit !== null) fail("DIAMONDS_RECOVERY_ALREADY_IMPORTED", "Recovery audit already exists.");
    digestEqual(redisBefore.operationRecord, aofEvidence.operationRecord, "Inbox operation");
    digestEqual(redisBefore.resolutionRecord, aofEvidence.resolutionRecord, "Gameplay resolution");
    digestEqual(redisBefore.previousResolution, aofEvidence.previousResolution, "Previous resolution");
    digestEqual(redisBefore.eventIndexRecord, aofEvidence.eventIndexRecord, "Event index");
    digestEqual(before.operation, aofEvidence.operationRecord, "Provider/Redis Inbox readback");
    digestEqual(before.resolution, aofEvidence.resolutionRecord, "Provider/Redis resolution readback");

    const evidence = { ...aofEvidence, provider: providerEvidence(before) };
    const validated = validateEvidence(evidence);
    exact(validated.status, "complete", "DIAMONDS_RECOVERY_EVIDENCE_INCOMPLETE", "Recovery evidence status");
    const importedAtUnixMs = nowMilliseconds();
    const plan = createRecoveryPlan({
        evidence,
        recoveryReason: "recover_certified_original_after_test_redis_cleanup",
        importedAtUnixMs
    });

    const acquired = await dependencies.acquireRecoveryPlayerLease();
    if (acquired?.status !== "acquired" || !plain(acquired.lease)) {
        fail("DIAMONDS_RECOVERY_LEASE_UNAVAILABLE", "A fresh provider-fenced recovery lease was not acquired.");
    }
    let imported;
    try {
        imported = await dependencies.importRecoveredOriginalOperation({ plan, lease: acquired.lease });
        if (!new Set(["recovered", "existing"]).has(imported?.status) ||
            imported.recoveredOriginalOperation !== true) {
            fail("DIAMONDS_RECOVERY_IMPORT_INVALID", "Original operation was not durably recovered.");
        }
    } finally {
        const released = await dependencies.releaseRecoveryPlayerLease({ lease: acquired.lease });
        if (released?.status !== "released") {
            fail("DIAMONDS_RECOVERY_LEASE_RELEASE_FAILED", "Recovery lease was not released.");
        }
    }

    const scheduled = await dependencies.inspectFinishState();
    assertScheduled(scheduled, plan.recoveryAudit.auditHash);
    const metricsBefore = await dependencies.readProviderHttpMetrics();
    const proofBefore = await dependencies.readProofWriteDiagnostics();
    if (proofBefore !== null) fail("DIAMONDS_RECOVERY_DIAGNOSTICS_DIRTY", "Economic proof diagnostics were not empty before retry.");

    const applied = await dependencies.consumeExistingTargetOperation({
        operationId: C.operationId,
        consumer: "diamonds-canary-original-recovery"
    });
    exact(applied?.status, "applied", "DIAMONDS_RECOVERY_PROVIDER_NOT_APPLIED", "Provider result");
    const after = await dependencies.inspectFinishState();
    assertApplied(after);
    const metricsAfter = await dependencies.readProviderHttpMetrics();
    const proofAfter = await dependencies.readProofWriteDiagnostics();
    exact(proofAfter?.operationId, C.operationId, "DIAMONDS_RECOVERY_PROOF_DIAGNOSTICS_INVALID", "Prepared proof operationId");
    exact(proofAfter?.operationHash, C.operationImmutableHash,
        "DIAMONDS_RECOVERY_PROOF_DIAGNOSTICS_INVALID", "Prepared proof operation hash");
    exact(proofAfter?.schemaVersion, 2, "DIAMONDS_RECOVERY_PROOF_DIAGNOSTICS_INVALID", "Prepared proof schema");
    if (!Number.isSafeInteger(proofAfter?.bytes) || proofAfter.bytes < 1 ||
        proofAfter.bytes > PROVIDER_PROOF_LIMIT_BYTES || proofAfter.providerRequestAttempted !== true ||
        proofAfter.providerWriteCompleted !== true) {
        fail("DIAMONDS_RECOVERY_PROOF_DIAGNOSTICS_INVALID", "Proof V2 pre-provider size/write evidence is invalid.");
    }

    const replayMetricsBefore = await dependencies.readProviderHttpMetrics();
    const replayProofBefore = await dependencies.readProofWriteDiagnostics();
    const replay = await dependencies.consumeExistingTargetOperation({
        operationId: C.operationId,
        consumer: "diamonds-canary-original-recovery-replay"
    });
    exact(replay?.status, "already_acked", "DIAMONDS_RECOVERY_REPLAY_INVALID", "Replay result");
    const finalState = await dependencies.inspectFinishState();
    assertApplied(finalState);
    const replayMetricsAfter = await dependencies.readProviderHttpMetrics();
    const replayProofAfter = await dependencies.readProofWriteDiagnostics();
    exact(counter(replayMetricsAfter, "playfab_set_objects_total") -
        counter(replayMetricsBefore, "playfab_set_objects_total"), 0,
    "DIAMONDS_RECOVERY_REPLAY_MUTATED", "Replay SetObjects count");
    digestEqual(replayProofAfter, replayProofBefore, "Replay proof diagnostics");
    exact(finalState.target.revision, after.target.revision,
        "DIAMONDS_RECOVERY_REPLAY_MUTATED", "Replay revision");
    exact(finalState.target.diamonds, after.target.diamonds,
        "DIAMONDS_RECOVERY_REPLAY_MUTATED", "Replay balance");

    return serverEconomyPocReadonly({
        verdict: "PASS",
        recoveryEvidence: "COMPLETE",
        recoveredOriginalOperation: true,
        operationId: C.operationId,
        sequence: C.sequence,
        payloadHashVerified: true,
        evidenceHash: validated.evidenceHash,
        recoveryAuditHash: plan.recoveryAudit.auditHash,
        providerAttempted: true,
        payloadBytes: proofAfter.bytes,
        balanceBefore: C.diamondsBefore,
        balanceAfter: C.diamondsAfter,
        revisionBefore: C.expectedRevision,
        revisionAfter: finalState.target.revision,
        proofSchema: finalState.migrationProof.schemaVersion,
        operationState: finalState.operation.state,
        replay: replay.status,
        providerSetObjectsDuringAttempt:
            counter(metricsAfter, "playfab_set_objects_total") - counter(metricsBefore, "playfab_set_objects_total"),
        economicProviderWrites: 1,
        replayProviderWrites: 0,
        productionUntouched: true
    });
}
