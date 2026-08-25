import { createHash } from "node:crypto";
import {
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const MAXIMUM_PROVIDER_ATTEMPT_HISTORY = 16;
function tokenDigest(token) {
    return createHash("sha256").update(
        serverEconomyPocId(token, "player lease token", 255),
        "utf8"
    ).digest("hex");
}

function operationHash(value) {
    const hash = serverEconomyPocId(value, "operation immutable hash", 64);
    if (!/^[0-9a-f]{64}$/u.test(hash)) {
        serverEconomyPocFail("POC_GAMEPLAY_ATTEMPT_IDENTITY_INVALID", "Operation immutable hash is invalid.");
    }
    return hash;
}

function attemptMetadata(input) {
    const metadata = Object.freeze({
        playFabId: serverEconomyPocId(input.playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(input.operationId, "operationId", 200),
        operationImmutableHash: operationHash(input.operationImmutableHash),
        sequence: serverEconomyPocPositive(input.sequence, "operation sequence"),
        fencingEpoch: serverEconomyPocPositive(input.epoch, "fencing epoch"),
        leaseTokenDigest: tokenDigest(input.token),
        startedAtUnixMs: serverEconomyPocNonNegative(input.startedAtUnixMs, "provider attempt start timestamp")
    });
    return Object.freeze({
        ...metadata,
        attemptId: serverEconomyPocDigest(metadata)
    });
}

function transitionAttemptMetadata(input) {
    return Object.freeze({
        playFabId: serverEconomyPocId(input.playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(input.operationId, "operationId", 200),
        attemptId: serverEconomyPocId(input.attemptId, "provider attempt id", 64),
        fencingEpoch: serverEconomyPocPositive(input.epoch, "fencing epoch"),
        leaseTokenDigest: tokenDigest(input.token),
        completedAtUnixMs: serverEconomyPocNonNegative(
            input.completedAtUnixMs,
            "provider attempt completion timestamp"
        )
    });
}

function attemptHistory(record) {
    if (!Array.isArray(record.providerAttemptHistory)) record.providerAttemptHistory = [];
    if (!Number.isSafeInteger(record.providerAttemptOrdinal) || record.providerAttemptOrdinal < 0) {
        record.providerAttemptOrdinal = record.providerAttemptHistory.reduce((maximum, entry) =>
            Number.isSafeInteger(entry?.attempt) && entry.attempt > maximum ? entry.attempt : maximum, 0);
    }
    return record.providerAttemptHistory;
}

function assertAttemptIdentity(record, metadata) {
    if (record.operationId !== metadata.operationId || record.sequence !== metadata.sequence) {
        serverEconomyPocFail("POC_GAMEPLAY_ATTEMPT_IDENTITY_INVALID", "Provider attempt changed operation identity.");
    }
    for (const previous of attemptHistory(record)) {
        if (previous?.operationId !== undefined && previous.operationId !== metadata.operationId ||
            previous?.operationImmutableHash !== undefined &&
                previous.operationImmutableHash !== metadata.operationImmutableHash ||
            previous?.sequence !== undefined && previous.sequence !== metadata.sequence) {
            serverEconomyPocFail("POC_GAMEPLAY_ATTEMPT_IDENTITY_INVALID", "Provider attempt history has another operation identity.");
        }
    }
}

function beginAttempt(record, metadata) {
    if (!record || !["Prepared", "RetryScheduled", "SnapshotApplied"].includes(record.state)) {
        serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", "Retryable gameplay resolution is absent.");
    }
    assertAttemptIdentity(record, metadata);
    const history = attemptHistory(record);
    for (const previous of history) {
        if (!Number.isSafeInteger(previous?.fencingEpoch)) continue;
        if (previous.fencingEpoch >= metadata.fencingEpoch) {
            serverEconomyPocFail("POC_STALE_WRITER", "Provider attempt did not acquire a newer fencing epoch.", {
                retryable: true
            });
        }
    }
    const ordinal = record.providerAttemptOrdinal + 1;
    const attempt = {
        attempt: ordinal,
        attemptId: metadata.attemptId,
        operationId: metadata.operationId,
        operationImmutableHash: metadata.operationImmutableHash,
        sequence: metadata.sequence,
        fencingEpoch: metadata.fencingEpoch,
        leaseTokenDigest: metadata.leaseTokenDigest,
        state: "Active",
        startedAtUnixMs: metadata.startedAtUnixMs,
        completedAtUnixMs: null,
        classification: null,
        errorCode: null,
        nextAttemptAtUnixMs: null
    };
    for (const previous of history) {
        if (previous?.state !== "Active") continue;
        previous.state = "Stale";
        previous.completedAtUnixMs = metadata.startedAtUnixMs;
        previous.staleByAttemptId = attempt.attemptId;
    }
    appendBounded(history, attempt);
    record.providerAttemptOrdinal = ordinal;
    record.activeProviderAttemptId = attempt.attemptId;
    if (record.state !== "SnapshotApplied") record.state = "Prepared";
    record.nextAttemptAtUnixMs = null;
    return attempt;
}

function boundAttempt(record, input, allowedStates) {
    const metadata = transitionAttemptMetadata(input);
    const history = attemptHistory(record);
    const attempt = history.find((entry) => entry?.attemptId === metadata.attemptId);
    if (!attempt || record.activeProviderAttemptId !== metadata.attemptId ||
        attempt.fencingEpoch !== metadata.fencingEpoch ||
        attempt.leaseTokenDigest !== metadata.leaseTokenDigest ||
        !allowedStates.includes(attempt.state)) {
        serverEconomyPocFail("POC_STALE_WRITER", "Provider attempt context is stale or belongs to another lease.", {
            retryable: true
        });
    }
    return { attempt, metadata };
}

function identity(input) {
    return {
        playFabId: serverEconomyPocId(input.playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(input.operationId, "operationId", 200),
        sequence: input.sequence,
        expectedRevision: input.expectedRevision,
        diamondsBefore: input.diamondsBefore,
        diamondsDelta: input.diamondsDelta,
        diamondsAfter: input.diamondsAfter,
        outcome: input.outcome
    };
}

function retryMetadata(input) {
    const attemptedAtUnixMs = serverEconomyPocNonNegative(
        input.attemptedAtUnixMs,
        "provider attempt timestamp"
    );
    const nextAttemptAtUnixMs = serverEconomyPocNonNegative(
        input.nextAttemptAtUnixMs,
        "next provider attempt timestamp"
    );
    if (nextAttemptAtUnixMs <= attemptedAtUnixMs) {
        serverEconomyPocFail("POC_PROVIDER_RETRY_POLICY_INVALID", "Provider retry backoff must advance time.");
    }
    return Object.freeze({
        playFabId: serverEconomyPocId(input.playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(input.operationId, "operationId", 200),
        classification: serverEconomyPocId(input.classification, "provider classification", 80),
        errorCode: serverEconomyPocId(input.errorCode, "provider error code", 160),
        attemptedAtUnixMs,
        nextAttemptAtUnixMs,
        maximumAttempts: serverEconomyPocPositive(input.maximumAttempts, "maximum provider attempts")
    });
}

function manualReviewMetadata(input) {
    return Object.freeze({
        playFabId: serverEconomyPocId(input.playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(input.operationId, "operationId", 200),
        classification: serverEconomyPocId(input.classification, "provider classification", 80),
        errorCode: serverEconomyPocId(input.errorCode, "provider error code", 160),
        attemptedAtUnixMs: serverEconomyPocNonNegative(
            input.attemptedAtUnixMs,
            "provider attempt timestamp"
        )
    });
}

function initialRecord(intent) {
    return {
        ...intent,
        immutableHash: serverEconomyPocDigest(intent),
        state: "Prepared",
        providerAttemptCount: 0,
        providerAttemptOrdinal: 0,
        activeProviderAttemptId: null,
        nextAttemptAtUnixMs: null,
        lastProviderClassification: null,
        lastProviderErrorCode: null,
        lastProviderAttemptAtUnixMs: null,
        providerAttemptHistory: []
    };
}

function appendBounded(history, value) {
    history.push(value);
    if (history.length > MAXIMUM_PROVIDER_ATTEMPT_HISTORY) {
        history.splice(0, history.length - MAXIMUM_PROVIDER_ATTEMPT_HISTORY);
    }
}

export function createMemoryServerEconomyPocGameplayResolutionStore({
    assertPlayerFence = null
} = {}) {
    const records = new Map();
    const key = (playFabId, operationId) => `${playFabId}\u0000${operationId}`;

    async function prepare(input) {
        const intent = identity(input);
        const record = initialRecord(intent);
        const recordKey = key(intent.playFabId, intent.operationId);
        const existing = records.get(recordKey);
        if (existing) {
            if (existing.immutableHash !== record.immutableHash) {
                serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_CONFLICT", "Gameplay operation has another durable resolution intent.");
            }
            return serverEconomyPocReadonly({ status: "existing", record: existing });
        }
        records.set(recordKey, record);
        return serverEconomyPocReadonly({ status: "prepared", record });
    }

    async function get(playFabId, operationId) {
        const record = records.get(key(playFabId, operationId));
        return record ? serverEconomyPocReadonly(record) : null;
    }

    async function beginProviderAttempt(input) {
        if (assertPlayerFence) await assertPlayerFence(input);
        const metadata = attemptMetadata(input);
        const record = records.get(key(metadata.playFabId, metadata.operationId));
        const attempt = beginAttempt(record, metadata);
        return serverEconomyPocReadonly({ status: "begun", attempt, record });
    }

    async function recordProviderFailure(input) {
        if (assertPlayerFence) await assertPlayerFence(input);
        const metadata = retryMetadata(input);
        const record = records.get(key(metadata.playFabId, metadata.operationId));
        if (!record || !["Prepared", "RetryScheduled"].includes(record.state)) {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", "Retryable gameplay resolution is absent.");
        }
        const { attempt } = boundAttempt(record, {
            ...input,
            completedAtUnixMs: metadata.attemptedAtUnixMs
        }, ["Active"]);
        record.providerAttemptCount = Number(record.providerAttemptCount || 0) + 1;
        record.lastProviderClassification = metadata.classification;
        record.lastProviderErrorCode = metadata.errorCode;
        record.lastProviderAttemptAtUnixMs = metadata.attemptedAtUnixMs;
        attempt.classification = metadata.classification;
        attempt.errorCode = metadata.errorCode;
        attempt.completedAtUnixMs = metadata.attemptedAtUnixMs;
        attempt.nextAttemptAtUnixMs = metadata.nextAttemptAtUnixMs;
        if (record.providerAttemptCount >= metadata.maximumAttempts) {
            attempt.state = "ManualReview";
            record.state = "ManualReview";
            record.nextAttemptAtUnixMs = null;
            return serverEconomyPocReadonly({ status: "manual_review", record });
        }
        attempt.state = "RetryScheduled";
        record.state = "RetryScheduled";
        record.nextAttemptAtUnixMs = metadata.nextAttemptAtUnixMs;
        return serverEconomyPocReadonly({ status: "retry_scheduled", record });
    }

    async function markManualReview(input) {
        if (assertPlayerFence) await assertPlayerFence(input);
        const metadata = manualReviewMetadata(input);
        const record = records.get(key(metadata.playFabId, metadata.operationId));
        if (!record || !["Prepared", "RetryScheduled", "ManualReview"].includes(record.state)) {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", "Gameplay resolution cannot enter ManualReview.");
        }
        const { attempt } = boundAttempt(record, {
            ...input,
            completedAtUnixMs: metadata.attemptedAtUnixMs
        }, ["Active"]);
        attempt.state = "ManualReview";
        attempt.classification = metadata.classification;
        attempt.errorCode = metadata.errorCode;
        attempt.completedAtUnixMs = metadata.attemptedAtUnixMs;
        record.state = "ManualReview";
        record.nextAttemptAtUnixMs = null;
        record.lastProviderClassification = metadata.classification;
        record.lastProviderErrorCode = metadata.errorCode;
        record.lastProviderAttemptAtUnixMs = metadata.attemptedAtUnixMs;
        return serverEconomyPocReadonly({ status: "manual_review", record });
    }

    async function markSnapshotApplied(input) {
        if (assertPlayerFence) await assertPlayerFence(input);
        const record = records.get(key(input.playFabId, input.operationId));
        if (!record || !["Prepared", "RetryScheduled", "SnapshotApplied"].includes(record.state)) {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", "Gameplay resolution intent is absent.");
        }
        const { attempt, metadata } = boundAttempt(record, input, ["Active", "SnapshotApplied"]);
        attempt.state = "SnapshotApplied";
        attempt.completedAtUnixMs = metadata.completedAtUnixMs;
        attempt.snapshotRevision = input.snapshotRevision;
        record.state = "SnapshotApplied";
        record.nextAttemptAtUnixMs = null;
        record.snapshotRevision = input.snapshotRevision;
        return serverEconomyPocReadonly({ status: "snapshot_applied", record });
    }

    async function markAcked(input) {
        if (assertPlayerFence) await assertPlayerFence(input);
        const record = records.get(key(input.playFabId, input.operationId));
        if (!record || record.state !== "SnapshotApplied") {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", "Applied gameplay resolution is absent.");
        }
        const { attempt, metadata } = boundAttempt(record, input, ["SnapshotApplied", "Acked"]);
        attempt.state = "Acked";
        attempt.completedAtUnixMs = metadata.completedAtUnixMs;
        record.state = "Acked";
        return serverEconomyPocReadonly({ status: "acked", record });
    }

    return Object.freeze({
        prepare,
        get,
        beginProviderAttempt,
        recordProviderFailure,
        markManualReview,
        markSnapshotApplied,
        markAcked,
        durable: false,
        memoryTestOnly: true,
        boundedProviderAttemptHistory: MAXIMUM_PROVIDER_ATTEMPT_HISTORY
    });
}

function redisClient(redis) {
    if (typeof redis?.sendCommand !== "function") throw new TypeError("Redis sendCommand is required.");
    return redis;
}

function playerHash(playFabId) {
    return createHash("sha256").update(playFabId, "utf8").digest("hex");
}

const PREPARE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local parsed = cjson.decode(existing)
  if parsed.immutableHash ~= ARGV[1] then return {'conflict', existing} end
  return {'existing', existing}
end
redis.call('SET', KEYS[1], ARGV[2])
return {'prepared', ARGV[2]}
`;
const BEGIN_PROVIDER_ATTEMPT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local parsed = cjson.decode(raw)
if parsed.state ~= 'Prepared' and parsed.state ~= 'RetryScheduled' and parsed.state ~= 'SnapshotApplied' then
  return {'invalid', raw}
end
if parsed.operationId ~= ARGV[1] or tonumber(parsed.sequence) ~= tonumber(ARGV[3]) then
  return {'identity', raw}
end
local history = parsed.providerAttemptHistory or {}
local maximumOrdinal = tonumber(parsed.providerAttemptOrdinal or 0)
for _, previous in ipairs(history) do
  if tonumber(previous.attempt or 0) > maximumOrdinal then maximumOrdinal = tonumber(previous.attempt) end
  if previous.operationId ~= nil and previous.operationId ~= ARGV[1] then return {'identity', raw} end
  if previous.operationImmutableHash ~= nil and previous.operationImmutableHash ~= ARGV[2] then
    return {'identity', raw}
  end
  if previous.sequence ~= nil and tonumber(previous.sequence) ~= tonumber(ARGV[3]) then return {'identity', raw} end
  if previous.fencingEpoch ~= nil and tonumber(previous.fencingEpoch) >= tonumber(ARGV[4]) then
    return {'stale', raw}
  end
end
local ordinal = maximumOrdinal + 1
local currentAttempt = {
  attempt=ordinal,
  attemptId=ARGV[7],
  operationId=ARGV[1],
  operationImmutableHash=ARGV[2],
  sequence=tonumber(ARGV[3]),
  fencingEpoch=tonumber(ARGV[4]),
  leaseTokenDigest=ARGV[5],
  state='Active',
  startedAtUnixMs=tonumber(ARGV[6]),
  completedAtUnixMs=cjson.null,
  classification=cjson.null,
  errorCode=cjson.null,
  nextAttemptAtUnixMs=cjson.null
}
for _, previous in ipairs(history) do
  if previous.state == 'Active' then
    previous.state = 'Stale'
    previous.completedAtUnixMs = tonumber(ARGV[6])
    previous.staleByAttemptId = ARGV[7]
  end
end
table.insert(history, currentAttempt)
while #history > tonumber(ARGV[8]) do table.remove(history, 1) end
parsed.providerAttemptHistory = history
parsed.providerAttemptOrdinal = ordinal
parsed.activeProviderAttemptId = ARGV[7]
if parsed.state ~= 'SnapshotApplied' then parsed.state = 'Prepared' end
parsed.nextAttemptAtUnixMs = cjson.null
local encoded = cjson.encode(parsed)
redis.call('SET', KEYS[1], encoded)
return {'begun', encoded}
`;

const RECORD_PROVIDER_FAILURE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local parsed = cjson.decode(raw)
if parsed.state ~= 'Prepared' and parsed.state ~= 'RetryScheduled' then return {'invalid', raw} end
if parsed.activeProviderAttemptId ~= ARGV[7] then return {'stale', raw} end
local history = parsed.providerAttemptHistory or {}
local currentAttempt = nil
for _, candidate in ipairs(history) do
  if candidate.attemptId == ARGV[7] then currentAttempt = candidate end
end
if currentAttempt == nil or currentAttempt.state ~= 'Active' or
   tonumber(currentAttempt.fencingEpoch) ~= tonumber(ARGV[8]) or currentAttempt.leaseTokenDigest ~= ARGV[9] then
  return {'stale', raw}
end
parsed.providerAttemptCount = tonumber(parsed.providerAttemptCount or 0) + 1
parsed.lastProviderClassification = ARGV[1]
parsed.lastProviderErrorCode = ARGV[2]
parsed.lastProviderAttemptAtUnixMs = tonumber(ARGV[3])
currentAttempt.classification = ARGV[1]
currentAttempt.errorCode = ARGV[2]
currentAttempt.completedAtUnixMs = tonumber(ARGV[3])
currentAttempt.nextAttemptAtUnixMs = tonumber(ARGV[4])
if parsed.providerAttemptCount >= tonumber(ARGV[5]) then
  currentAttempt.state = 'ManualReview'
  parsed.state = 'ManualReview'
  parsed.nextAttemptAtUnixMs = cjson.null
else
  currentAttempt.state = 'RetryScheduled'
  parsed.state = 'RetryScheduled'
  parsed.nextAttemptAtUnixMs = tonumber(ARGV[4])
end
local encoded = cjson.encode(parsed)
redis.call('SET', KEYS[1], encoded)
return {parsed.state == 'ManualReview' and 'manual_review' or 'retry_scheduled', encoded}
`;

const MANUAL_REVIEW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local parsed = cjson.decode(raw)
if parsed.state ~= 'Prepared' and parsed.state ~= 'RetryScheduled' and parsed.state ~= 'ManualReview' then
  return {'invalid', raw}
end
if parsed.activeProviderAttemptId ~= ARGV[4] then return {'stale', raw} end
local history = parsed.providerAttemptHistory or {}
local currentAttempt = nil
for _, candidate in ipairs(history) do
  if candidate.attemptId == ARGV[4] then currentAttempt = candidate end
end
if currentAttempt == nil or currentAttempt.state ~= 'Active' or
   tonumber(currentAttempt.fencingEpoch) ~= tonumber(ARGV[5]) or currentAttempt.leaseTokenDigest ~= ARGV[6] then
  return {'stale', raw}
end
currentAttempt.state = 'ManualReview'
currentAttempt.classification = ARGV[1]
currentAttempt.errorCode = ARGV[2]
currentAttempt.completedAtUnixMs = tonumber(ARGV[3])
parsed.state = 'ManualReview'
parsed.nextAttemptAtUnixMs = cjson.null
parsed.lastProviderClassification = ARGV[1]
parsed.lastProviderErrorCode = ARGV[2]
parsed.lastProviderAttemptAtUnixMs = tonumber(ARGV[3])
local encoded = cjson.encode(parsed)
redis.call('SET', KEYS[1], encoded)
return {'manual_review', encoded}
`;

const TRANSITION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local parsed = cjson.decode(raw)
if parsed.activeProviderAttemptId ~= ARGV[3] then return {'stale', raw} end
local history = parsed.providerAttemptHistory or {}
local currentAttempt = nil
for _, candidate in ipairs(history) do
  if candidate.attemptId == ARGV[3] then currentAttempt = candidate end
end
if currentAttempt == nil or tonumber(currentAttempt.fencingEpoch) ~= tonumber(ARGV[4]) or
   currentAttempt.leaseTokenDigest ~= ARGV[5] then return {'stale', raw} end
if ARGV[1] == 'SnapshotApplied' then
  if parsed.state ~= 'Prepared' and parsed.state ~= 'RetryScheduled' and parsed.state ~= 'SnapshotApplied' then
    return {'invalid', raw}
  end
  if currentAttempt.state ~= 'Active' and currentAttempt.state ~= 'SnapshotApplied' then return {'stale', raw} end
  currentAttempt.state = 'SnapshotApplied'
  currentAttempt.completedAtUnixMs = tonumber(ARGV[6])
  currentAttempt.snapshotRevision = tonumber(ARGV[2])
  parsed.state = 'SnapshotApplied'
  parsed.nextAttemptAtUnixMs = cjson.null
  parsed.snapshotRevision = tonumber(ARGV[2])
elseif ARGV[1] == 'Acked' then
  if parsed.state ~= 'SnapshotApplied' and parsed.state ~= 'Acked' then return {'invalid', raw} end
  if currentAttempt.state ~= 'SnapshotApplied' and currentAttempt.state ~= 'Acked' then return {'stale', raw} end
  currentAttempt.state = 'Acked'
  currentAttempt.completedAtUnixMs = tonumber(ARGV[6])
  parsed.state = 'Acked'
else return {'invalid', raw} end
local encoded = cjson.encode(parsed)
redis.call('SET', KEYS[1], encoded)
return {'updated', encoded}
`;

export function createStandaloneRedisServerEconomyPocGameplayResolutionStore({
    redis,
    prefix = "server:economy:poc:v1:",
    assertPlayerFence
} = {}) {
    const client = redisClient(redis);
    if (typeof assertPlayerFence !== "function") throw new TypeError("Resolution store fence assertion is required.");
    const key = (playFabId, operationId) => {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const operation = serverEconomyPocId(operationId, "operationId", 200);
        const hash = playerHash(player);
        const operationHash = createHash("sha256").update(operation, "utf8").digest("hex");
        return `${prefix}player:{${hash}}:gameplay-resolution:${operationHash}`;
    };
    const parse = (value) => serverEconomyPocReadonly(JSON.parse(value));

    async function prepare(input) {
        const intent = identity(input);
        const record = initialRecord(intent);
        const result = await client.sendCommand([
            "EVAL", PREPARE_SCRIPT, "1", key(intent.playFabId, intent.operationId),
            record.immutableHash, JSON.stringify(record)
        ]);
        if (result?.[0] === "conflict") {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_CONFLICT", "Gameplay operation has another durable resolution intent.");
        }
        return serverEconomyPocReadonly({ status: result[0], record: parse(result[1]) });
    }

    async function get(playFabId, operationId) {
        const raw = await client.sendCommand(["GET", key(playFabId, operationId)]);
        return raw === null ? null : parse(raw);
    }

    function assertScriptTransition(result, allowed, message) {
        if (result?.[0] === "stale") {
            serverEconomyPocFail("POC_STALE_WRITER", "Provider attempt context is stale or belongs to another lease.", {
                retryable: true
            });
        }
        if (result?.[0] === "identity") {
            serverEconomyPocFail("POC_GAMEPLAY_ATTEMPT_IDENTITY_INVALID", "Provider attempt changed operation identity.");
        }
        if (!allowed.has(result?.[0])) {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", message);
        }
    }

    async function beginProviderAttempt(input) {
        await assertPlayerFence({ playFabId: input.playFabId, token: input.token, epoch: input.epoch });
        const metadata = attemptMetadata(input);
        const result = await client.sendCommand([
            "EVAL", BEGIN_PROVIDER_ATTEMPT_SCRIPT, "1", key(metadata.playFabId, metadata.operationId),
            metadata.operationId, metadata.operationImmutableHash, String(metadata.sequence),
            String(metadata.fencingEpoch), metadata.leaseTokenDigest, String(metadata.startedAtUnixMs),
            metadata.attemptId, String(MAXIMUM_PROVIDER_ATTEMPT_HISTORY)
        ]);
        assertScriptTransition(result, new Set(["begun"]), "Provider attempt context could not be started.");
        const record = parse(result[1]);
        const attempt = record.providerAttemptHistory.find((entry) => entry.attemptId === metadata.attemptId);
        if (!attempt) {
            serverEconomyPocFail("POC_GAMEPLAY_RESOLUTION_MISSING", "Provider attempt context was not persisted.");
        }
        return serverEconomyPocReadonly({ status: "begun", attempt, record });
    }

    async function recordProviderFailure(input) {
        await assertPlayerFence({ playFabId: input.playFabId, token: input.token, epoch: input.epoch });
        const metadata = retryMetadata(input);
        const attempt = transitionAttemptMetadata({
            ...input,
            completedAtUnixMs: metadata.attemptedAtUnixMs
        });
        const result = await client.sendCommand([
            "EVAL", RECORD_PROVIDER_FAILURE_SCRIPT, "1", key(metadata.playFabId, metadata.operationId),
            metadata.classification, metadata.errorCode, String(metadata.attemptedAtUnixMs),
            String(metadata.nextAttemptAtUnixMs), String(metadata.maximumAttempts),
            String(MAXIMUM_PROVIDER_ATTEMPT_HISTORY), attempt.attemptId,
            String(attempt.fencingEpoch), attempt.leaseTokenDigest
        ]);
        assertScriptTransition(
            result,
            new Set(["retry_scheduled", "manual_review"]),
            "Provider retry metadata transition failed."
        );
        return serverEconomyPocReadonly({ status: result[0], record: parse(result[1]) });
    }

    async function markManualReview(input) {
        await assertPlayerFence({ playFabId: input.playFabId, token: input.token, epoch: input.epoch });
        const metadata = manualReviewMetadata(input);
        const attempt = transitionAttemptMetadata({
            ...input,
            completedAtUnixMs: metadata.attemptedAtUnixMs
        });
        const result = await client.sendCommand([
            "EVAL", MANUAL_REVIEW_SCRIPT, "1", key(metadata.playFabId, metadata.operationId),
            metadata.classification, metadata.errorCode, String(metadata.attemptedAtUnixMs),
            attempt.attemptId, String(attempt.fencingEpoch), attempt.leaseTokenDigest
        ]);
        assertScriptTransition(result, new Set(["manual_review"]), "ManualReview metadata transition failed.");
        return serverEconomyPocReadonly({ status: result[0], record: parse(result[1]) });
    }

    async function transition(input, state, snapshotRevision = 0) {
        await assertPlayerFence({ playFabId: input.playFabId, token: input.token, epoch: input.epoch });
        const attempt = transitionAttemptMetadata(input);
        const result = await client.sendCommand([
            "EVAL", TRANSITION_SCRIPT, "1", key(input.playFabId, input.operationId),
            state, String(snapshotRevision), attempt.attemptId, String(attempt.fencingEpoch),
            attempt.leaseTokenDigest, String(attempt.completedAtUnixMs)
        ]);
        assertScriptTransition(result, new Set(["updated"]), "Gameplay resolution transition failed.");
        return serverEconomyPocReadonly({
            status: state === "Acked" ? "acked" : "snapshot_applied",
            record: parse(result[1])
        });
    }

    return Object.freeze({
        prepare,
        get,
        recordProviderFailure,
        beginProviderAttempt,
        markManualReview,
        markSnapshotApplied: (input) => transition(input, "SnapshotApplied", input.snapshotRevision),
        markAcked: (input) => transition(input, "Acked"),
        durable: true,
        redisCompatible: true,
        redisClusterHashTagged: true,
        atomicPlayerFencing: false,
        boundedProviderAttemptHistory: MAXIMUM_PROVIDER_ATTEMPT_HISTORY,
        pocOnly: true
    });
}
