import { createHash } from "node:crypto";

import { parseRedisRespAof } from "./diamonds-canary-spend10-recovery-harness.js";
import {
    CANARY02_SPEND10_RECOVERY_CONTRACT
} from "./server-economy-poc-original-operation-recovery.js";
import {
    CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT,
    historicalSequenceRebaseRedisKeys
} from "./server-economy-poc-historical-sequence-rebase.js";
import {
    serverEconomyPocDigest,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const C = CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT;
const S = CANARY02_SPEND10_RECOVERY_CONTRACT;
const TARGET_PREFIX = "seabyss:financial:diamonds:sandbox-canary:v1:";
const LEDGER_PREFIX = "seabyss:payments:diamonds:sandbox-canary:v1:";
const BOOTSTRAP_JOURNAL_KEY = "seabyss:financial-canary:bootstrap:v2:journal";
const PROVIDER_ATTESTATION_KEY = "seabyss:financial-canary:bootstrap:v2:provider-attestation";

const GRANT = Object.freeze({
    operationId: "diamonds-canary-v1:grant-25",
    sequence: 1,
    delta: 25,
    operationHash: "3b42649ced522daa90bf0c9bf374caf178e2fe510e7ce45b1d3ff0d60a48db2c",
    resolutionHash: "d0bf518c72c4e7df335dad69d5b3bd51c408672a1c8f3f50cd998696949d622b",
    eventHash: "dde94506b5f4b4e135f854a54f017cc903f865d3e01748cce9178bb0074f96df"
});

const IMPORT_LUA = `-- SEABYSS_FINANCIAL_CANARY02_V2_CERTIFIED_BOOTSTRAP
local bindingRaw = redis.call('GET', KEYS[1])
if not bindingRaw or bindingRaw ~= ARGV[1] then return {'binding_mismatch'} end
local existingJournal = redis.call('GET', KEYS[2])
if existingJournal then
  if existingJournal == ARGV[2] then return {'existing', existingJournal} end
  return {'journal_conflict'}
end
local existing = redis.call('KEYS', 'seabyss:*')
for _, key in ipairs(existing) do
  if key ~= KEYS[1] and key ~= ARGV[3] then return {'dataset_not_empty', key} end
end
local stringsOk, strings = pcall(cjson.decode, ARGV[4])
local zsetsOk, zsets = pcall(cjson.decode, ARGV[5])
local setsOk, sets = pcall(cjson.decode, ARGV[6])
if not stringsOk or not zsetsOk or not setsOk or type(strings) ~= 'table' or
   type(zsets) ~= 'table' or type(sets) ~= 'table' then return {'payload_invalid'} end
for _, item in ipairs(strings) do
  if type(item) ~= 'table' or type(item.key) ~= 'string' or type(item.value) ~= 'string' or
     redis.call('EXISTS', item.key) ~= 0 then return {'payload_conflict'} end
  redis.call('SET', item.key, item.value)
end
for _, item in ipairs(zsets) do
  if type(item) ~= 'table' or type(item.key) ~= 'string' or type(item.entries) ~= 'table' or
     redis.call('EXISTS', item.key) ~= 0 then return {'payload_conflict'} end
  for _, entry in ipairs(item.entries) do
    if type(entry) ~= 'table' or tonumber(entry.score) == nil or type(entry.member) ~= 'string' then
      return {'payload_invalid'}
    end
    redis.call('ZADD', item.key, tostring(entry.score), entry.member)
  end
end
for _, item in ipairs(sets) do
  if type(item) ~= 'table' or type(item.key) ~= 'string' or type(item.members) ~= 'table' or
     redis.call('EXISTS', item.key) ~= 0 then return {'payload_conflict'} end
  for _, member in ipairs(item.members) do
    if type(member) ~= 'string' then return {'payload_invalid'} end
    redis.call('SADD', item.key, member)
  end
end
redis.call('SET', KEYS[2], ARGV[2])
return {'imported', ARGV[2]}
`;

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(actual, expected, label, code = "FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH") {
    if (actual !== expected) fail(code, `${label} differs from certified Canary_02 evidence.`);
}

function sha256Buffer(value) {
    return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseJson(raw, label) {
    try {
        const value = JSON.parse(raw);
        if (!plain(value)) throw new TypeError();
        return value;
    } catch {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_INVALID", `${label} is not a JSON object.`);
    }
}

function assertHash(value, expected, label) {
    if (typeof value !== "string" || value !== expected) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH", `${label} hash differs from certified evidence.`);
    }
}

function playerBase() {
    const playerHash = sha256Text(C.playFabId);
    return Object.freeze({
        playerHash,
        base: `${TARGET_PREFIX}player:${playerHash}:`,
        resolutionBase: `${TARGET_PREFIX}player:{${playerHash}}:gameplay-resolution:`
    });
}

function operationKey(operationId) {
    const { base } = playerBase();
    return `${base}inbox:operation:${sha256Text(operationId)}`;
}

function resolutionKey(operationId) {
    const { resolutionBase } = playerBase();
    return `${resolutionBase}${sha256Text(operationId)}`;
}

function replayCertifiedPrefix(commands) {
    const strings = new Map();
    const zsets = new Map();
    const sets = new Map();
    for (const command of commands) {
        const name = String(command[0] || "").toUpperCase();
        const key = command[1];
        if (name === "SET" && typeof key === "string") {
            strings.set(key, command[2]);
        } else if (name === "INCR" && typeof key === "string") {
            strings.set(key, String(Number(strings.get(key) || 0) + 1));
        } else if ((name === "DEL" || name === "UNLINK") && command.length > 1) {
            for (const removed of command.slice(1)) {
                strings.delete(removed);
                zsets.delete(removed);
                sets.delete(removed);
            }
        } else if (name === "ZADD" && typeof key === "string") {
            const entries = zsets.get(key) || new Map();
            for (let index = 2; index + 1 < command.length; index += 2) {
                entries.set(command[index + 1], Number(command[index]));
            }
            zsets.set(key, entries);
        } else if (name === "ZREM" && typeof key === "string") {
            const entries = zsets.get(key) || new Map();
            for (const member of command.slice(2)) entries.delete(member);
            zsets.set(key, entries);
        } else if (name === "SADD" && typeof key === "string") {
            const members = sets.get(key) || new Set();
            for (const member of command.slice(2)) members.add(member);
            sets.set(key, members);
        } else if (name === "SREM" && typeof key === "string") {
            const members = sets.get(key) || new Set();
            for (const member of command.slice(2)) members.delete(member);
            sets.set(key, members);
        }
    }
    return { strings, zsets, sets };
}

function findEventIndex(strings, operationId) {
    const matches = [];
    for (const [key, raw] of strings) {
        if (!key.startsWith(`${TARGET_PREFIX}event-index:`)) continue;
        const record = parseJson(raw, "event-index record");
        if (record.intent?.operationId === operationId) matches.push({ key, raw, record });
    }
    if (matches.length !== 1) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH", `Expected one event-index for ${operationId}.`);
    }
    return matches[0];
}

function validateAcknowledgedOperation({ record, operationId, sequence, delta, operationHash }) {
    if (!plain(record) || !plain(record.operation)) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_INVALID", `${operationId} Inbox record is absent.`);
    }
    same(record.schemaVersion, 1, `${operationId} Inbox schema`);
    same(record.playFabId, C.playFabId, `${operationId} player`);
    same(record.operationId, operationId, `${operationId} identity`);
    same(record.sequence, sequence, `${operationId} sequence`);
    same(record.state, "Acked", `${operationId} state`);
    if (!plain(record.result) || !Number.isSafeInteger(record.ackedAtUnixMs)) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH", `${operationId} is not durably ACKed.`);
    }
    same(record.operation.diamondsDelta, delta, `${operationId} delta`);
    assertHash(record.operation.immutableHash, operationHash, `${operationId} operation`);
}

function validatePendingXsd2(record) {
    if (!plain(record) || !plain(record.operation)) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_INVALID", "Historical xsd2 Inbox record is absent.");
    }
    same(record.schemaVersion, 1, "xsd2 Inbox schema");
    same(record.playFabId, C.playFabId, "xsd2 player");
    same(record.operationId, C.operationId, "xsd2 operationId");
    same(record.sequence, C.originalSequence, "xsd2 original sequence");
    same(record.state, "Pending", "xsd2 state");
    same(record.result, null, "xsd2 result");
    same(record.ackedAtUnixMs, null, "xsd2 ACK");
    same(record.claimOwner, null, "xsd2 claim owner");
    same(record.claimToken, null, "xsd2 claim token");
    same(record.claimExpiresAtUnixMs, null, "xsd2 claim expiry");
    same(record.operation.diamonds, C.diamondsDelta, "xsd2 delta");
    assertHash(record.operation.immutableHash, C.operationImmutableHash, "xsd2 operation");
}

/**
 * Extracts only the exact allowlisted historical records from the immutable
 * certified AOF prefix. The continuation is intentionally ignored here: it is
 * audit evidence, never the new dataset authority.
 */
export function extractCertifiedCanary02V2BootstrapEvidence(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < C.persistenceAofBytes) {
        fail("FINANCIAL_CANARY_V2_AOF_MISMATCH", "Legacy AOF is shorter than certified evidence.");
    }
    const prefix = buffer.subarray(0, C.persistenceAofBytes);
    same(sha256Buffer(prefix), C.persistenceAofSha256, "legacy AOF prefix",
        "FINANCIAL_CANARY_V2_AOF_MISMATCH");
    const commands = parseRedisRespAof(prefix);
    const state = replayCertifiedPrefix(commands);
    const keys = historicalSequenceRebaseRedisKeys();
    const grantKey = operationKey(GRANT.operationId);
    const spendKey = operationKey(S.operationId);
    const xsd2Key = keys.operation;
    const grantRaw = state.strings.get(grantKey);
    const spendRaw = state.strings.get(spendKey);
    const xsd2Raw = state.strings.get(xsd2Key);
    const grant = parseJson(grantRaw, "grant +25 Inbox record");
    const spend = parseJson(spendRaw, "spend -10 Inbox record");
    const xsd2 = parseJson(xsd2Raw, "historical xsd2 Inbox record");
    validateAcknowledgedOperation({ record: grant, operationId: GRANT.operationId,
        sequence: GRANT.sequence, delta: GRANT.delta, operationHash: GRANT.operationHash });
    validateAcknowledgedOperation({ record: spend, operationId: S.operationId,
        sequence: S.sequence, delta: S.diamondsDelta, operationHash: S.operationImmutableHash });
    validatePendingXsd2(xsd2);

    const grantResolutionKey = resolutionKey(GRANT.operationId);
    const spendResolutionKey = resolutionKey(S.operationId);
    const grantResolutionRaw = state.strings.get(grantResolutionKey);
    const spendResolutionRaw = state.strings.get(spendResolutionKey);
    const grantResolution = parseJson(grantResolutionRaw, "grant +25 resolution");
    const spendResolution = parseJson(spendResolutionRaw, "spend -10 resolution");
    assertHash(grantResolution.immutableHash, GRANT.resolutionHash, "grant +25 resolution");
    assertHash(spendResolution.immutableHash, S.resolutionImmutableHash, "spend -10 resolution");
    same(grantResolution.state, "Acked", "grant +25 resolution state");
    same(spendResolution.state, "Acked", "spend -10 resolution state");
    same(grantResolution.sequence, 1, "grant +25 resolution sequence");
    same(spendResolution.sequence, 2, "spend -10 resolution sequence");

    const grantEvent = findEventIndex(state.strings, GRANT.operationId);
    const spendEvent = findEventIndex(state.strings, S.operationId);
    const xsd2Event = findEventIndex(state.strings, C.operationId);
    assertHash(grantEvent.record.immutableHash, GRANT.eventHash, "grant +25 event-index");
    assertHash(spendEvent.record.immutableHash, S.eventIntentImmutableHash, "spend -10 event-index");
    assertHash(xsd2Event.record.immutableHash, C.eventIndexImmutableHash, "xsd2 event-index");
    same(xsd2Event.record.identity, C.eventIndexIdentity, "xsd2 event identity");

    const providerGuardRaw = state.strings.get(keys.providerGuard);
    const providerGuard = parseJson(providerGuardRaw, "xsd2 provider guard");
    assertHash(providerGuard.immutableHash, C.providerGuardImmutableHash, "xsd2 provider guard");
    same(providerGuard.intent?.operationId, C.operationId, "xsd2 provider guard operation");
    same(providerGuard.intent?.playFabId, C.playFabId, "xsd2 provider guard player");

    const ledgerRaw = state.strings.get(keys.ledger);
    const ledger = parseJson(ledgerRaw, "xsd2 ledger wrapper");
    assertHash(ledger.immutableHash, C.ledgerImmutableHash, "xsd2 ledger");
    same(ledger.record?.state, "Failed", "xsd2 ledger state");
    same(ledger.record?.providerTransactionId, C.providerTransactionId, "xsd2 ledger transaction");
    same(ledger.record?.receiptId, C.receiptId, "xsd2 ledger receipt");
    same(ledger.record?.planHash, C.planHash, "xsd2 ledger plan");
    same(ledger.record?.stepJournal?.diamonds_target_granted?.status,
        "StepPending", "xsd2 target step");
    if (ledger.record?.stepJournal?.diamonds_target_granted?.resultHash != null ||
        ledger.record?.checkpoints?.diamonds_target_granted ||
        ledger.record?.checkpoints?.profile_granted) {
        fail("FINANCIAL_CANARY_V2_PROVIDER_ALREADY_APPLIED",
            "Historical xsd2 ledger contains an applied Target result.");
    }

    same(Number(state.strings.get(keys.sequence)), C.historicalReservedSequence,
        "historical sequence counter");
    const inboxIndex = state.zsets.get(keys.index);
    if (!(inboxIndex instanceof Map) || inboxIndex.get(grantKey) !== 1 ||
        inboxIndex.get(spendKey) !== 2 || inboxIndex.get(xsd2Key) !== 1 ||
        [...inboxIndex.values()].includes(C.rebasedSequence)) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH",
            "Historical Inbox index does not preserve seq1/seq2 with orphaned seq3.");
    }
    if (state.strings.has(keys.resolution)) {
        fail("FINANCIAL_CANARY_V2_PROVIDER_ALREADY_APPLIED",
            "Historical xsd2 has a gameplay resolution.");
    }

    const ledgerIndexes = [];
    for (const [key, entries] of state.zsets) {
        if (!key.startsWith(`${LEDGER_PREFIX}idx:tx:`)) continue;
        if (entries.size !== 1 || entries.get(keys.ledger) !== ledger.record.createdAtUnixMs) {
            fail("FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH", "Payment ledger index is inconsistent.");
        }
        ledgerIndexes.push({ key, entries: [{ score: ledger.record.createdAtUnixMs, member: keys.ledger }] });
    }
    if (ledgerIndexes.length !== 5) {
        fail("FINANCIAL_CANARY_V2_EVIDENCE_MISMATCH", "Exactly five xsd2 ledger indexes are required.");
    }

    const recoveryAuditKey = `${TARGET_PREFIX}player:{${keys.playerHash}}:recovery-audit:${sha256Text(S.operationId)}`;
    const recoveryAuditRaw = state.strings.get(recoveryAuditKey);
    const recoveryAudit = parseJson(recoveryAuditRaw, "spend -10 recovery audit");
    same(recoveryAudit.operationId, S.operationId, "spend recovery operationId");

    const strings = [
        { key: `${TARGET_PREFIX}player:${keys.playerHash}:identity`, value: C.playFabId },
        { key: keys.sequence, value: String(C.historicalReservedSequence) },
        { key: grantKey, value: grantRaw },
        { key: spendKey, value: spendRaw },
        { key: xsd2Key, value: xsd2Raw },
        { key: grantResolutionKey, value: grantResolutionRaw },
        { key: spendResolutionKey, value: spendResolutionRaw },
        { key: recoveryAuditKey, value: recoveryAuditRaw },
        { key: grantEvent.key, value: grantEvent.raw },
        { key: spendEvent.key, value: spendEvent.raw },
        { key: xsd2Event.key, value: xsd2Event.raw },
        { key: keys.providerGuard, value: providerGuardRaw },
        { key: keys.ledger, value: ledgerRaw }
    ].sort((left, right) => left.key.localeCompare(right.key));
    const zsets = [
        { key: keys.index, entries: [
            { score: 1, member: grantKey },
            { score: 2, member: spendKey },
            { score: 1, member: xsd2Key }
        ].sort((left, right) => left.member.localeCompare(right.member)) },
        ...ledgerIndexes
    ].sort((left, right) => left.key.localeCompare(right.key));
    const sets = [{ key: keys.players, members: [keys.playerHash] }];
    return serverEconomyPocReadonly({
        certifiedPrefixSha256: C.persistenceAofSha256,
        certifiedPrefixBytes: C.persistenceAofBytes,
        fullAofSha256: sha256Buffer(buffer),
        fullAofBytes: buffer.length,
        commandCount: commands.length,
        strings,
        zsets,
        sets,
        evidenceRedis: {
            operationRecord: xsd2,
            sequenceCounter: C.historicalReservedSequence,
            operationIndexScore: C.originalSequence,
            rebaseAudit: null,
            originalArchive: null,
            rebaseJournal: null,
            activeBinding: null,
            playerIdentity: C.playFabId,
            playerRegistered: true,
            providerGuardRecord: providerGuard,
            ledgerWrapper: ledger,
            resolutionRecord: null,
            eventIndexRecord: xsd2Event.record,
            raw: {
                operationRecord: xsd2Raw,
                providerGuardRecord: providerGuardRaw,
                ledgerWrapper: ledgerRaw,
                eventIndexRecord: xsd2Event.raw,
                rebaseAudit: null,
                originalArchive: null,
                rebaseJournal: null,
                activeBinding: null
            },
            rebasedSequenceOccupied: false,
            indexEntryCount: 3,
            inboxOperationCount: 3,
            pendingInboxOperationCount: 1,
            rebasedSequenceRecordCount: 0,
            targetOperationDiscovered: true
        },
        provenance: {
            persistenceDigest: sha256Buffer(buffer),
            totalBytes: buffer.length,
            fileCount: 1,
            aofSha256: C.persistenceAofSha256,
            aofBytes: C.persistenceAofBytes,
            currentAofSha256: sha256Buffer(buffer),
            currentAofBytes: buffer.length,
            source: "certified_legacy_aof_read_only",
            allocatorHistory: {
                counterBeforeAllocation: C.historicalCounterBeforeAllocation,
                incrementReservedSequence: C.historicalReservedSequence,
                persistedOperationSequence: C.originalSequence,
                persistedIndexSequence: C.originalSequence,
                rebasedSequenceRecordAbsent: true
            }
        }
    });
}

function validateProviderAttestation(attestation) {
    if (!plain(attestation) || attestation.schemaVersion !== 1 ||
        attestation.kind !== "Canary02PlayFabProviderAttestation" ||
        attestation.titleId !== C.titleId || attestation.playFabId !== C.playFabId ||
        attestation.targetDiamonds !== C.targetDiamonds ||
        attestation.targetRevision !== C.targetRevision ||
        attestation.providerCursor !== C.providerCursor ||
        attestation.migrationProofSchemaVersion !== C.migrationProofSchemaVersion ||
        attestation.targetOnlyOperationCount !== C.targetOnlyOperationCount ||
        attestation.spend10ProofVerified !== true || attestation.xsd2ProofMissing !== true ||
        typeof attestation.providerStateDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(attestation.providerStateDigest) ||
        typeof attestation.receiptDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(attestation.receiptDigest)) {
        fail("FINANCIAL_CANARY_V2_PROVIDER_ATTESTATION_INVALID",
            "PlayFab/receipt attestation does not prove the exact Canary_02 state.");
    }
    return attestation;
}

export function createCanary02V2BootstrapImportPlan({
    historical,
    providerAttestation,
    datasetBinding,
    importedAtUnixMs
} = {}) {
    if (!plain(historical) || !Array.isArray(historical.strings) ||
        !Array.isArray(historical.zsets) || !Array.isArray(historical.sets) ||
        !plain(datasetBinding) || datasetBinding.schemaVersion !== 2 ||
        datasetBinding.sandboxTitleId !== C.titleId ||
        datasetBinding.canaryPlayFabId !== C.playFabId ||
        datasetBinding.environment !== "sandbox" ||
        typeof datasetBinding.bindingHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(datasetBinding.bindingHash) ||
        !Number.isSafeInteger(importedAtUnixMs) || importedAtUnixMs < 0) {
        fail("FINANCIAL_CANARY_V2_IMPORT_PLAN_INVALID", "V2 bootstrap import inputs are invalid.");
    }
    const attestation = validateProviderAttestation(providerAttestation);
    const providerJson = JSON.stringify(attestation);
    const strings = [
        ...historical.strings,
        { key: PROVIDER_ATTESTATION_KEY, value: providerJson }
    ].sort((left, right) => left.key.localeCompare(right.key));
    const importPayload = {
        strings,
        zsets: historical.zsets,
        sets: historical.sets
    };
    const importHash = serverEconomyPocDigest(importPayload);
    const journalBasis = {
        schemaVersion: 2,
        kind: "CertifiedCanary02HistoricalImport",
        sandboxTitleId: C.titleId,
        canaryPlayFabId: C.playFabId,
        datasetId: datasetBinding.datasetId,
        runtimeId: datasetBinding.runtimeId,
        bindingHash: datasetBinding.bindingHash,
        legacyAofSha256: historical.certifiedPrefixSha256,
        legacyAofBytes: historical.certifiedPrefixBytes,
        providerStateDigest: attestation.providerStateDigest,
        receiptDigest: attestation.receiptDigest,
        importedOperationIds: [GRANT.operationId, S.operationId, C.operationId],
        originalXsd2Sequence: C.originalSequence,
        targetSequenceCursor: C.providerCursor,
        orphanedReservedSequence: C.rebasedSequence,
        importHash,
        importedAtUnixMs
    };
    const journal = { ...journalBasis, journalHash: serverEconomyPocDigest(journalBasis) };
    return serverEconomyPocReadonly({
        strings,
        zsets: historical.zsets,
        sets: historical.sets,
        importHash,
        providerAttestation: attestation,
        journal,
        journalJson: JSON.stringify(journal)
    });
}

function expectedKeys(plan) {
    return new Set([
        ...plan.strings.map((item) => item.key),
        ...plan.zsets.map((item) => item.key),
        ...plan.sets.map((item) => item.key),
        BOOTSTRAP_JOURNAL_KEY
    ]);
}

async function inspectImport(redis, plan) {
    const journalRaw = await redis.sendCommand(["GET", BOOTSTRAP_JOURNAL_KEY]);
    const journal = journalRaw === null ? null : parseJson(journalRaw, "V2 bootstrap journal");
    if (journal && JSON.stringify(journal) !== JSON.stringify(plan.journal)) {
        fail("FINANCIAL_CANARY_V2_IMPORT_READBACK_FAILED", "Bootstrap journal readback differs.");
    }
    for (const item of plan.strings) {
        const raw = await redis.sendCommand(["GET", item.key]);
        if (raw !== item.value) fail("FINANCIAL_CANARY_V2_IMPORT_READBACK_FAILED", `String ${item.key} differs.`);
    }
    for (const item of plan.zsets) {
        const raw = await redis.sendCommand(["ZRANGE", item.key, "0", "-1", "WITHSCORES"]);
        const actual = [];
        for (let index = 0; index + 1 < raw.length; index += 2) {
            actual.push({ member: raw[index], score: Number(raw[index + 1]) });
        }
        const wanted = [...item.entries]
            .map((entry) => ({ member: entry.member, score: Number(entry.score) }))
            .sort((left, right) => left.score - right.score || left.member.localeCompare(right.member));
        if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
            fail("FINANCIAL_CANARY_V2_IMPORT_READBACK_FAILED", `Sorted set ${item.key} differs.`);
        }
    }
    for (const item of plan.sets) {
        const actual = await redis.sendCommand(["SMEMBERS", item.key]);
        if (JSON.stringify([...actual].sort()) !== JSON.stringify([...item.members].sort())) {
            fail("FINANCIAL_CANARY_V2_IMPORT_READBACK_FAILED", `Set ${item.key} differs.`);
        }
    }
    return serverEconomyPocReadonly({
        imported: journal !== null,
        journal,
        importedKeyCount: expectedKeys(plan).size,
        pendingXsd2Sequence: C.originalSequence,
        targetSequenceCounter: C.rebasedSequence
    });
}

export function createFinancialCanary02V2Bootstrapper({
    redis,
    datasetBindingKey,
    runtimeIdKey,
    datasetBindingRaw
} = {}) {
    if (typeof redis?.sendCommand !== "function" ||
        typeof datasetBindingKey !== "string" || datasetBindingKey.length === 0 ||
        typeof runtimeIdKey !== "string" || runtimeIdKey.length === 0 ||
        typeof datasetBindingRaw !== "string" || datasetBindingRaw.length === 0) {
        throw new TypeError("Financial Canary_02 V2 bootstrapper is not configured.");
    }
    const binding = parseJson(datasetBindingRaw, "V2 dataset binding");

    async function importCertified(plan) {
        if (!plain(plan?.journal) || plan.journal.bindingHash !== binding.bindingHash) {
            fail("FINANCIAL_CANARY_V2_IMPORT_PLAN_INVALID", "Import plan is not bound to this dataset.");
        }
        const response = await redis.sendCommand([
            "EVAL", IMPORT_LUA, "2", datasetBindingKey, BOOTSTRAP_JOURNAL_KEY,
            datasetBindingRaw, plan.journalJson, runtimeIdKey,
            JSON.stringify(plan.strings), JSON.stringify(plan.zsets), JSON.stringify(plan.sets)
        ]);
        if (!Array.isArray(response) || !["imported", "existing"].includes(response[0])) {
            const code = {
                binding_mismatch: "FINANCIAL_CANARY_V2_BINDING_MISMATCH",
                journal_conflict: "FINANCIAL_CANARY_V2_IMPORT_CONFLICT",
                dataset_not_empty: "FINANCIAL_CANARY_V2_DATASET_NOT_EMPTY",
                payload_invalid: "FINANCIAL_CANARY_V2_IMPORT_PAYLOAD_INVALID",
                payload_conflict: "FINANCIAL_CANARY_V2_IMPORT_CONFLICT"
            }[response?.[0]] || "FINANCIAL_CANARY_V2_IMPORT_FAILED";
            fail(code, `Certified V2 import was refused (${response?.[0] || "protocol"}).`);
        }
        const aof = await redis.sendCommand(["WAITAOF", "1", "0", "5000"]);
        if (!Array.isArray(aof) || Number(aof[0]) < 1) {
            fail("FINANCIAL_CANARY_V2_IMPORT_AOF_UNCONFIRMED", "V2 import AOF fsync was not confirmed.");
        }
        const readback = await inspectImport(redis, plan);
        return serverEconomyPocReadonly({
            status: response[0],
            aofLocalFsync: true,
            localAofAcknowledgements: Number(aof[0]),
            readback
        });
    }

    return Object.freeze({
        binding: serverEconomyPocReadonly(binding),
        inspect: (plan) => inspectImport(redis, plan),
        importCertified
    });
}

export const FINANCIAL_CANARY02_V2_BOOTSTRAP = Object.freeze({
    titleId: C.titleId,
    productionTitleId: C.productionTitleId,
    playFabId: C.playFabId,
    targetPrefix: TARGET_PREFIX,
    ledgerPrefix: LEDGER_PREFIX,
    bootstrapJournalKey: BOOTSTRAP_JOURNAL_KEY,
    providerAttestationKey: PROVIDER_ATTESTATION_KEY,
    grant: GRANT,
    spend: S,
    xsd2: C
});
