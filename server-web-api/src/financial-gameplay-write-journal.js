import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const STATES = new Set(["Pending", "ProviderApplied", "Completed", "ManualReview"]);
const MAXIMUM_CAS_ATTEMPTS = 24;

export class FinancialGameplayJournalError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "FinancialGameplayJournalError";
        this.code = code;
        this.retryable = options.retryable === true;
    }
}

function fail(code, message, options) {
    throw new FinancialGameplayJournalError(code, message, options);
}

function token(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_JOURNAL_ARGUMENT", `${name} is invalid.`);
    }
    return value;
}

function text(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_JOURNAL_ARGUMENT", `${name} is invalid.`);
    }
    return value;
}

function positive(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        fail("INVALID_JOURNAL_ARGUMENT", `${name} must be a positive safe integer.`);
    }
    return value;
}

function milliseconds(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        fail("INVALID_JOURNAL_ARGUMENT", `${name} must be a non-negative safe integer.`);
    }
    return value;
}

function clone(value) {
    return structuredClone(value);
}

function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) freeze(child);
    }
    return value;
}

function output(value) {
    return freeze(clone(value));
}

function key(playFabId, operationId) {
    return `${token(playFabId, "playFabId", 160)}\u0000${token(operationId, "operationId", 160)}`;
}

function validateOperations(operations) {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
        fail("INVALID_JOURNAL_ARGUMENT", "operations must contain 1 to 50 entries.");
    }
    const seen = new Set();
    return operations.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            fail("INVALID_JOURNAL_ARGUMENT", "operation entry is invalid.");
        }
        const resourceId = token(entry.resourceId, "resourceId", 255);
        if (!Number.isSafeInteger(entry.delta) || entry.delta === 0) {
            fail("INVALID_JOURNAL_ARGUMENT", "operation delta is invalid.");
        }
        if (seen.has(resourceId)) fail("INVALID_JOURNAL_ARGUMENT", "duplicate resourceId.");
        seen.add(resourceId);
        return { resourceId, delta: entry.delta };
    });
}

function validateRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        record.schemaVersion !== SCHEMA_VERSION || !STATES.has(record.state)) {
        fail("JOURNAL_CORRUPT", "Gameplay financial journal record is invalid.");
    }
    key(record.playFabId, record.operationId);
    positive(record.version, "record.version");
    return record;
}

export function createMemoryFinancialGameplayWriteJournalStore() {
    const records = new Map();
    return Object.freeze({
        async get(playFabId, operationId) {
            const record = records.get(key(playFabId, operationId));
            return record ? clone(record) : null;
        },
        async create(record) {
            validateRecord(record);
            const recordKey = key(record.playFabId, record.operationId);
            if (records.has(recordKey)) {
                return { status: "existing", record: clone(records.get(recordKey)) };
            }
            records.set(recordKey, clone(record));
            return { status: "created", record: clone(record) };
        },
        async compareAndSet({ playFabId, operationId, expectedVersion, record }) {
            validateRecord(record);
            const recordKey = key(playFabId, operationId);
            const current = records.get(recordKey);
            if (!current) return { status: "missing" };
            if (current.version !== expectedVersion) {
                return { status: "version_conflict", record: clone(current) };
            }
            records.set(recordKey, clone(record));
            return { status: "updated", record: clone(record) };
        },
        async ping() {
            return true;
        }
    });
}

function redisKey(prefix, playFabId, operationId) {
    const digest = createHash("sha256")
        .update(`${playFabId}\u0000${operationId}`, "utf8")
        .digest("hex");
    return `${prefix}${digest}`;
}

const REDIS_CAS = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local current = cjson.decode(raw)
if tonumber(current.version) ~= tonumber(ARGV[1]) then
  return {'version_conflict', raw}
end
redis.call('SET', KEYS[1], ARGV[2])
return {'updated', ARGV[2]}
`;

export function createRedisFinancialGameplayWriteJournalStore({
    redis,
    prefix = "financial:gameplay:write:v1:"
} = {}) {
    if (!redis || typeof redis.sendCommand !== "function") {
        throw new TypeError("Redis client.sendCommand is required.");
    }
    token(prefix, "Redis journal prefix", 160);
    const recordKey = (playFabId, operationId) => redisKey(
        prefix,
        token(playFabId, "playFabId", 160),
        token(operationId, "operationId", 160)
    );
    const parse = (raw) => raw === null ? null : validateRecord(JSON.parse(raw));
    return Object.freeze({
        async get(playFabId, operationId) {
            return parse(await redis.sendCommand(["GET", recordKey(playFabId, operationId)]));
        },
        async create(record) {
            validateRecord(record);
            const redisRecordKey = recordKey(record.playFabId, record.operationId);
            const result = await redis.sendCommand([
                "SET", redisRecordKey, JSON.stringify(record), "NX"
            ]);
            if (result === "OK") return { status: "created", record: clone(record) };
            const existing = parse(await redis.sendCommand(["GET", redisRecordKey]));
            if (!existing) fail("JOURNAL_STORE_RACE", "Journal create raced with deletion.", { retryable: true });
            return { status: "existing", record: existing };
        },
        async compareAndSet({ playFabId, operationId, expectedVersion, record }) {
            validateRecord(record);
            positive(expectedVersion, "expectedVersion");
            const result = await redis.sendCommand([
                "EVAL", REDIS_CAS, "1", recordKey(playFabId, operationId),
                String(expectedVersion), JSON.stringify(record)
            ]);
            if (!Array.isArray(result) || typeof result[0] !== "string") {
                fail("JOURNAL_STORE_PROTOCOL", "Redis journal CAS returned an invalid result.", { retryable: true });
            }
            return {
                status: result[0],
                ...(typeof result[1] === "string" ? { record: parse(result[1]) } : {})
            };
        },
        async ping() {
            return (await redis.sendCommand(["PING"])) === "PONG";
        }
    });
}

export function createFinancialGameplayWriteJournal({
    store,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!store || typeof store.get !== "function" || typeof store.create !== "function" ||
        typeof store.compareAndSet !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Durable gameplay journal store and clock are required.");
    }
    const now = () => milliseconds(nowMilliseconds(), "journal clock");

    async function get(playFabId, operationId) {
        const record = await store.get(playFabId, operationId);
        return record ? output(validateRecord(record)) : null;
    }

    async function begin({ playFabId, operationId, eventId, actionId, reason, operations, requestHash }) {
        const atUnixMs = now();
        const record = {
            schemaVersion: SCHEMA_VERSION,
            playFabId: token(playFabId, "playFabId", 160),
            operationId: token(operationId, "operationId", 160),
            eventId: token(eventId, "eventId", 160),
            actionId: token(actionId, "actionId", 160),
            reason: text(reason, "reason", 160),
            requestHash: token(requestHash, "requestHash", 128),
            operations: validateOperations(operations),
            state: "Pending",
            version: 1,
            highestFencingEpoch: 0,
            activeLeaseToken: null,
            activeLeaseEpoch: null,
            expectedEtag: null,
            idempotencyCreatedAtUtc: new Date(atUnixMs).toISOString(),
            beforeQuantities: null,
            providerEvidence: null,
            afterQuantities: null,
            result: null,
            manualReviewReason: null,
            createdAtUnixMs: atUnixMs,
            updatedAtUnixMs: atUnixMs
        };
        const result = await store.create(record);
        if (!result || !["created", "existing"].includes(result.status)) {
            fail("JOURNAL_STORE_PROTOCOL", "Journal create returned an invalid result.", { retryable: true });
        }
        const observed = validateRecord(result.record);
        if (observed.requestHash !== record.requestHash) {
            fail("IDEMPOTENCY_CONFLICT", "operationId is already bound to another immutable request.");
        }
        return output(observed);
    }

    async function update(playFabId, operationId, transform) {
        for (let attempt = 0; attempt < MAXIMUM_CAS_ATTEMPTS; attempt += 1) {
            const current = await store.get(playFabId, operationId);
            if (!current) fail("JOURNAL_MISSING", "Gameplay journal entry is missing.");
            validateRecord(current);
            const transformed = transform(clone(current));
            if (transformed === null) return output(current);
            transformed.version = current.version + 1;
            transformed.updatedAtUnixMs = now();
            validateRecord(transformed);
            const result = await store.compareAndSet({
                playFabId,
                operationId,
                expectedVersion: current.version,
                record: transformed
            });
            if (result?.status === "updated") return output(validateRecord(result.record));
            if (result?.status === "version_conflict") continue;
            if (result?.status === "missing") fail("JOURNAL_MISSING", "Gameplay journal entry disappeared.");
            fail("JOURNAL_STORE_PROTOCOL", "Journal CAS returned an invalid result.", { retryable: true });
        }
        fail("JOURNAL_CAS_CONFLICT", "Gameplay journal CAS retry budget was exhausted.", { retryable: true });
    }

    const owns = (record, leaseToken, fencingEpoch) =>
        record.activeLeaseToken === token(leaseToken, "leaseToken", 255) &&
        record.activeLeaseEpoch === positive(fencingEpoch, "fencingEpoch") &&
        record.highestFencingEpoch === fencingEpoch;

    async function claim({ playFabId, operationId, leaseToken, fencingEpoch }) {
        return update(playFabId, operationId, (record) => {
            const epoch = positive(fencingEpoch, "fencingEpoch");
            const lease = token(leaseToken, "leaseToken", 255);
            if (record.state === "Completed" || record.state === "ManualReview") return null;
            if (epoch < record.highestFencingEpoch) {
                fail("STALE_FENCING_EPOCH", "Stale gameplay financial worker was fenced.");
            }
            record.highestFencingEpoch = epoch;
            record.activeLeaseEpoch = epoch;
            record.activeLeaseToken = lease;
            return record;
        });
    }

    async function prepare({ playFabId, operationId, leaseToken, fencingEpoch, expectedEtag, beforeQuantities }) {
        return update(playFabId, operationId, (record) => {
            if (!owns(record, leaseToken, fencingEpoch)) fail("STALE_FENCING_EPOCH", "Gameplay prepare was fenced.");
            if (record.expectedEtag !== null) return null;
            record.expectedEtag = token(expectedEtag, "expectedEtag", 1024);
            record.beforeQuantities = clone(beforeQuantities);
            return record;
        });
    }

    async function recordProviderApplied({
        playFabId, operationId, leaseToken, fencingEpoch, providerEvidence, afterQuantities
    }) {
        return update(playFabId, operationId, (record) => {
            if (!owns(record, leaseToken, fencingEpoch)) fail("STALE_FENCING_EPOCH", "Provider evidence write was fenced.");
            if (record.state === "ProviderApplied") return null;
            if (record.state !== "Pending" || record.expectedEtag === null) {
                fail("INVALID_JOURNAL_STATE", "Provider evidence cannot be recorded in this state.");
            }
            record.providerEvidence = clone(providerEvidence);
            record.afterQuantities = clone(afterQuantities);
            record.state = "ProviderApplied";
            return record;
        });
    }

    async function complete({ playFabId, operationId, leaseToken, fencingEpoch, result }) {
        return update(playFabId, operationId, (record) => {
            if (record.state === "Completed") return null;
            if (!owns(record, leaseToken, fencingEpoch)) fail("STALE_FENCING_EPOCH", "Gameplay completion was fenced.");
            if (record.state !== "ProviderApplied" || !record.providerEvidence) {
                fail("INVALID_JOURNAL_STATE", "Completed requires durable provider evidence.");
            }
            record.result = clone(result);
            record.state = "Completed";
            return record;
        });
    }

    async function manualReview({ playFabId, operationId, leaseToken, fencingEpoch, reason }) {
        return update(playFabId, operationId, (record) => {
            if (record.state === "Completed") fail("COMPLETED_IMMUTABLE", "Completed gameplay mutation is immutable.");
            if (!owns(record, leaseToken, fencingEpoch)) fail("STALE_FENCING_EPOCH", "ManualReview write was fenced.");
            record.state = "ManualReview";
            record.manualReviewReason = text(reason, "manualReviewReason", 1000);
            return record;
        });
    }

    async function health() {
        return typeof store.ping === "function" ? (await store.ping()) === true : false;
    }

    return Object.freeze({ begin, get, claim, prepare, recordProviderApplied, complete, manualReview, health });
}
