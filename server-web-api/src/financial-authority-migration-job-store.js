import { createHash } from "node:crypto";

export const FINANCIAL_AUTHORITY_MIGRATION_JOB_SCHEMA_VERSION = 1;
export const FINANCIAL_AUTHORITY_MIGRATION_JOB_STATES = Object.freeze([
    "Queued",
    "Processing",
    "Failed",
    "DryRunCompleted",
    "Completed",
    "ManualReview"
]);

const TERMINAL_STATES = new Set(["DryRunCompleted", "Completed", "ManualReview"]);
const PROCESSABLE_STATES = new Set(["Queued", "Failed", "Processing"]);
const MAXIMUM_RECORD_BYTES = 256 * 1024;

const CREATE_SCRIPT = `-- FINANCIAL_AUTHORITY_MIGRATION_CREATE_V1
if redis.call("EXISTS", KEYS[1]) == 1 then
    return {"existing", redis.call("GET", KEYS[1])}
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("ZADD", KEYS[2], ARGV[2], KEYS[1])
return {"created", ARGV[1]}
`;

const ACQUIRE_SCRIPT = `-- FINANCIAL_AUTHORITY_MIGRATION_ACQUIRE_V1
local text = redis.call("GET", KEYS[1])
if not text then return {"missing", ""} end
local ok, record = pcall(cjson.decode, text)
if not ok or type(record) ~= "table" then return {"corrupt", ""} end
local now = tonumber(ARGV[1])
local active = record.leaseToken ~= nil and record.leaseToken ~= cjson.null and
    record.leaseExpiresAtUnixMs ~= nil and record.leaseExpiresAtUnixMs ~= cjson.null and
    tonumber(record.leaseExpiresAtUnixMs) > now
if active then
    if record.leaseToken == ARGV[3] then return {"acquired", text} end
    return {"busy", text}
end
if record.state ~= "Queued" and record.state ~= "Failed" and record.state ~= "Processing" then
    return {"terminal", text}
end
if record.state == "Failed" and record.nextAttemptAtUnixMs ~= nil and
    record.nextAttemptAtUnixMs ~= cjson.null and tonumber(record.nextAttemptAtUnixMs) > now then
    return {"not_due", text}
end
record.state = "Processing"
record.leaseOwner = ARGV[2]
record.leaseToken = ARGV[3]
record.leaseEpoch = tonumber(record.leaseEpoch) + 1
record.leaseExpiresAtUnixMs = now + tonumber(ARGV[4])
record.attemptCount = tonumber(record.attemptCount) + 1
record.updatedAtUnixMs = now
record.version = tonumber(record.version) + 1
local result = cjson.encode(record)
redis.call("SET", KEYS[1], result)
return {"acquired", result}
`;

const RENEW_SCRIPT = `-- FINANCIAL_AUTHORITY_MIGRATION_RENEW_V1
local text = redis.call("GET", KEYS[1])
if not text then return {"missing", ""} end
local ok, record = pcall(cjson.decode, text)
if not ok or type(record) ~= "table" then return {"corrupt", ""} end
local now = tonumber(ARGV[1])
if record.leaseToken ~= ARGV[2] or tonumber(record.leaseEpoch) ~= tonumber(ARGV[3]) or
    record.leaseExpiresAtUnixMs == nil or record.leaseExpiresAtUnixMs == cjson.null or
    tonumber(record.leaseExpiresAtUnixMs) <= now then
    return {"lease_conflict", text}
end
record.leaseExpiresAtUnixMs = now + tonumber(ARGV[4])
record.updatedAtUnixMs = now
record.version = tonumber(record.version) + 1
local result = cjson.encode(record)
redis.call("SET", KEYS[1], result)
return {"renewed", result}
`;

const RELEASE_SCRIPT = `-- FINANCIAL_AUTHORITY_MIGRATION_RELEASE_V1
local text = redis.call("GET", KEYS[1])
if not text then return {"missing", ""} end
local ok, record = pcall(cjson.decode, text)
if not ok or type(record) ~= "table" then return {"corrupt", ""} end
if record.leaseToken ~= ARGV[2] or tonumber(record.leaseEpoch) ~= tonumber(ARGV[3]) then
    return {"lease_conflict", text}
end
record.leaseOwner = cjson.null
record.leaseToken = cjson.null
record.leaseExpiresAtUnixMs = cjson.null
record.updatedAtUnixMs = tonumber(ARGV[1])
record.version = tonumber(record.version) + 1
local result = cjson.encode(record)
redis.call("SET", KEYS[1], result)
return {"released", result}
`;

const REPLACE_SCRIPT = `-- FINANCIAL_AUTHORITY_MIGRATION_REPLACE_V1
local text = redis.call("GET", KEYS[1])
if not text then return {"missing", ""} end
local currentOk, current = pcall(cjson.decode, text)
local nextOk, next = pcall(cjson.decode, ARGV[6])
if not currentOk or type(current) ~= "table" or not nextOk or type(next) ~= "table" then
    return {"corrupt", ""}
end
local now = tonumber(ARGV[1])
if tonumber(current.version) ~= tonumber(ARGV[2]) then return {"version_conflict", text} end
if current.leaseToken ~= ARGV[3] or tonumber(current.leaseEpoch) ~= tonumber(ARGV[4]) or
    current.leaseExpiresAtUnixMs == nil or current.leaseExpiresAtUnixMs == cjson.null or
    tonumber(current.leaseExpiresAtUnixMs) <= now then
    return {"lease_conflict", text}
end
if next.playFabId ~= current.playFabId or next.mode ~= current.mode or
    next.leaseToken ~= current.leaseToken or next.leaseOwner ~= current.leaseOwner or
    tonumber(next.leaseEpoch) ~= tonumber(current.leaseEpoch) or
    tonumber(next.leaseExpiresAtUnixMs) ~= tonumber(current.leaseExpiresAtUnixMs) then
    return {"invariant_conflict", text}
end
next.version = tonumber(current.version) + 1
next.updatedAtUnixMs = now
local result = cjson.encode(next)
redis.call("SET", KEYS[1], result)
return {"replaced", result}
`;

const PROMOTE_SCRIPT = `-- FINANCIAL_AUTHORITY_MIGRATION_PROMOTE_V1
local text = redis.call("GET", KEYS[1])
if not text then return {"missing", ""} end
local ok, record = pcall(cjson.decode, text)
if not ok or type(record) ~= "table" then return {"corrupt", ""} end
if tonumber(record.version) ~= tonumber(ARGV[1]) then return {"version_conflict", text} end
if record.mode ~= "dry_run" or record.state ~= "DryRunCompleted" or
    record.plan == nil or record.plan == cjson.null or record.plan.planHash ~= ARGV[3] or
    (record.leaseToken ~= nil and record.leaseToken ~= cjson.null) then
    return {"invalid_state", text}
end
record.mode = "apply"
record.state = "Queued"
record.nextAttemptAtUnixMs = cjson.null
record.lastError = cjson.null
record.updatedAtUnixMs = tonumber(ARGV[2])
record.version = tonumber(record.version) + 1
local result = cjson.encode(record)
redis.call("SET", KEYS[1], result)
return {"promoted", result}
`;

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function boundedText(value, name, maximumLength = 1024) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegative(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
    return value;
}

function clone(value) {
    return structuredClone(value);
}

function serialized(record) {
    const text = JSON.stringify(record);
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAXIMUM_RECORD_BYTES) {
        throw new RangeError("Financial migration job exceeds its durable record limit.");
    }
    return text;
}

function validateError(value) {
    if (value === null) return null;
    if (!plain(value)) throw new TypeError("lastError is invalid.");
    canonical(value.code, "lastError.code", 160);
    boundedText(value.message, "lastError.message", 1024);
    if (typeof value.retryable !== "boolean") throw new TypeError("lastError.retryable is invalid.");
    return value;
}

export function validateFinancialAuthorityMigrationJob(record) {
    if (!plain(record) || record.schemaVersion !== FINANCIAL_AUTHORITY_MIGRATION_JOB_SCHEMA_VERSION) {
        throw new TypeError("Financial migration job schema is invalid.");
    }
    canonical(record.playFabId, "playFabId", 128);
    if (record.mode !== "dry_run" && record.mode !== "apply") throw new TypeError("mode is invalid.");
    if (!FINANCIAL_AUTHORITY_MIGRATION_JOB_STATES.includes(record.state)) {
        throw new TypeError("state is invalid.");
    }
    for (const [name, value] of [
        ["version", record.version],
        ["attemptCount", record.attemptCount],
        ["createdAtUnixMs", record.createdAtUnixMs],
        ["updatedAtUnixMs", record.updatedAtUnixMs],
        ["leaseEpoch", record.leaseEpoch]
    ]) nonNegative(value, name);
    if (record.version === 0) throw new TypeError("version must be positive.");
    for (const name of ["nextAttemptAtUnixMs", "leaseExpiresAtUnixMs"]) {
        if (record[name] !== null) nonNegative(record[name], name);
    }
    const hasLease = record.leaseToken !== null || record.leaseOwner !== null ||
        record.leaseExpiresAtUnixMs !== null;
    if (hasLease) {
        canonical(record.leaseOwner, "leaseOwner", 160);
        canonical(record.leaseToken, "leaseToken", 320);
        if (record.leaseExpiresAtUnixMs === null || record.leaseEpoch === 0) {
            throw new TypeError("lease is incomplete.");
        }
    }
    if (!plain(record.checkpoints)) throw new TypeError("checkpoints is invalid.");
    if (!Array.isArray(record.conflicts) || record.conflicts.length > 128) {
        throw new TypeError("conflicts is invalid.");
    }
    validateError(record.lastError);
    serialized(record);
    return record;
}

export function createFinancialAuthorityMigrationJob({
    playFabId,
    mode = "dry_run",
    nowUnixMs = Date.now()
} = {}) {
    canonical(playFabId, "playFabId", 128);
    if (mode !== "dry_run" && mode !== "apply") throw new TypeError("mode is invalid.");
    nonNegative(nowUnixMs, "nowUnixMs");
    return validateFinancialAuthorityMigrationJob({
        schemaVersion: FINANCIAL_AUTHORITY_MIGRATION_JOB_SCHEMA_VERSION,
        playFabId,
        mode,
        state: "Queued",
        version: 1,
        attemptCount: 0,
        createdAtUnixMs: nowUnixMs,
        updatedAtUnixMs: nowUnixMs,
        nextAttemptAtUnixMs: null,
        plan: null,
        checkpoints: {},
        conflicts: [],
        lastError: null,
        leaseOwner: null,
        leaseToken: null,
        leaseEpoch: 0,
        leaseExpiresAtUnixMs: null
    });
}

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function transitionAllowed(current, next) {
    if (current === next) return current === "Processing";
    return current === "Processing" &&
        ["Failed", "DryRunCompleted", "Completed", "ManualReview"].includes(next);
}

function validateReplacement(current, next) {
    validateFinancialAuthorityMigrationJob(next);
    if (next.schemaVersion !== current.schemaVersion || next.playFabId !== current.playFabId ||
        next.mode !== current.mode || next.createdAtUnixMs !== current.createdAtUnixMs ||
        next.attemptCount !== current.attemptCount || next.leaseOwner !== current.leaseOwner ||
        next.leaseToken !== current.leaseToken || next.leaseEpoch !== current.leaseEpoch ||
        next.leaseExpiresAtUnixMs !== current.leaseExpiresAtUnixMs ||
        !transitionAllowed(current.state, next.state)) {
        throw new TypeError("Financial migration job replacement violates an immutable invariant.");
    }
    if (current.plan !== null && !same(current.plan, next.plan)) {
        throw new TypeError("Persisted financial migration plan is immutable.");
    }
    for (const [name, checkpoint] of Object.entries(current.checkpoints)) {
        const candidate = next.checkpoints[name];
        const validTransition = checkpoint?.status === "StepPending" && candidate?.status === "StepApplied" &&
            candidate.operationId === checkpoint.operationId && candidate.requestHash === checkpoint.requestHash &&
            same(candidate.intent, checkpoint.intent);
        if (!same(checkpoint, candidate) && !validTransition) {
            throw new TypeError("Financial migration checkpoints are immutable and monotonic.");
        }
    }
    if (TERMINAL_STATES.has(current.state)) {
        throw new TypeError("Terminal financial migration jobs are immutable.");
    }
}

function parseResult(result) {
    if (!Array.isArray(result) || typeof result[0] !== "string") {
        throw new TypeError("Redis financial migration store returned an invalid result.");
    }
    let record = null;
    if (typeof result[1] === "string" && result[1].length > 0) {
        record = JSON.parse(result[1]);
        validateFinancialAuthorityMigrationJob(record);
    }
    return { status: result[0], record };
}

function hash(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createMemoryFinancialAuthorityMigrationJobStore() {
    const records = new Map();

    function load(playFabId) {
        canonical(playFabId, "playFabId", 128);
        return records.get(playFabId) || null;
    }

    return Object.freeze({
        durable: false,
        async create(record) {
            validateFinancialAuthorityMigrationJob(record);
            const existing = load(record.playFabId);
            if (existing) return { status: "existing", record: clone(existing) };
            records.set(record.playFabId, clone(record));
            return { status: "created", record: clone(record) };
        },
        async get(playFabId) {
            const record = load(playFabId);
            return record ? clone(record) : null;
        },
        async acquireLease(playFabId, { owner, token, ttlMilliseconds, nowUnixMs }) {
            canonical(owner, "owner", 160);
            canonical(token, "token", 320);
            nonNegative(nowUnixMs, "nowUnixMs");
            if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0) {
                throw new TypeError("ttlMilliseconds is invalid.");
            }
            const current = load(playFabId);
            if (!current) return { status: "missing", record: null };
            const active = current.leaseToken !== null && current.leaseExpiresAtUnixMs > nowUnixMs;
            if (active) return { status: current.leaseToken === token ? "acquired" : "busy", record: clone(current) };
            if (!PROCESSABLE_STATES.has(current.state)) return { status: "terminal", record: clone(current) };
            if (current.state === "Failed" && current.nextAttemptAtUnixMs !== null &&
                current.nextAttemptAtUnixMs > nowUnixMs) {
                return { status: "not_due", record: clone(current) };
            }
            current.state = "Processing";
            current.leaseOwner = owner;
            current.leaseToken = token;
            current.leaseEpoch += 1;
            current.leaseExpiresAtUnixMs = nowUnixMs + ttlMilliseconds;
            current.attemptCount += 1;
            current.updatedAtUnixMs = nowUnixMs;
            current.version += 1;
            validateFinancialAuthorityMigrationJob(current);
            return { status: "acquired", record: clone(current) };
        },
        async renewLease(playFabId, { token, epoch, ttlMilliseconds, nowUnixMs }) {
            const current = load(playFabId);
            if (!current) return { status: "missing", record: null };
            const valid = current.leaseToken === token && current.leaseEpoch === epoch &&
                current.leaseExpiresAtUnixMs > nowUnixMs;
            if (!valid) return { status: "lease_conflict", record: clone(current) };
            current.leaseExpiresAtUnixMs = nowUnixMs + ttlMilliseconds;
            current.updatedAtUnixMs = nowUnixMs;
            current.version += 1;
            return { status: "renewed", record: clone(current) };
        },
        async releaseLease(playFabId, { token, epoch, nowUnixMs }) {
            const current = load(playFabId);
            if (!current) return { status: "missing", record: null };
            if (current.leaseToken !== token || current.leaseEpoch !== epoch) {
                return { status: "lease_conflict", record: clone(current) };
            }
            current.leaseOwner = null;
            current.leaseToken = null;
            current.leaseExpiresAtUnixMs = null;
            current.updatedAtUnixMs = nowUnixMs;
            current.version += 1;
            return { status: "released", record: clone(current) };
        },
        async compareAndSet(playFabId, { expectedVersion, token, epoch, next, nowUnixMs }) {
            const current = load(playFabId);
            if (!current) return { status: "missing", record: null };
            if (current.version !== expectedVersion) return { status: "version_conflict", record: clone(current) };
            if (current.leaseToken !== token || current.leaseEpoch !== epoch ||
                current.leaseExpiresAtUnixMs <= nowUnixMs) {
                return { status: "lease_conflict", record: clone(current) };
            }
            const candidate = clone(next);
            candidate.version = current.version + 1;
            candidate.updatedAtUnixMs = nowUnixMs;
            validateReplacement(current, candidate);
            records.set(playFabId, candidate);
            return { status: "replaced", record: clone(candidate) };
        },
        async promoteDryRun(playFabId, { expectedVersion, expectedPlanHash, nowUnixMs }) {
            const current = load(playFabId);
            if (!current) return { status: "missing", record: null };
            if (current.version !== expectedVersion) return { status: "version_conflict", record: clone(current) };
            if (current.mode !== "dry_run" || current.state !== "DryRunCompleted" || current.leaseToken !== null ||
                current.plan?.planHash !== expectedPlanHash) {
                return { status: "invalid_state", record: clone(current) };
            }
            current.mode = "apply";
            current.state = "Queued";
            current.nextAttemptAtUnixMs = null;
            current.lastError = null;
            current.updatedAtUnixMs = nowUnixMs;
            current.version += 1;
            return { status: "promoted", record: clone(current) };
        },
        async scan({ cursor = "0", limit = 100 } = {}) {
            const offset = Number(cursor);
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
                throw new TypeError("scan page is invalid.");
            }
            const values = [...records.values()].sort((left, right) =>
                left.createdAtUnixMs - right.createdAtUnixMs || left.playFabId.localeCompare(right.playFabId));
            const items = values.slice(offset, offset + limit).map(clone);
            return { items, nextCursor: offset + items.length < values.length ? String(offset + items.length) : null };
        },
        async ping() { return true; }
    });
}

export function createRedisFinancialAuthorityMigrationJobStore(redisClient, {
    keyPrefix = "seabyss:{financial-authority-migration-v2}:"
} = {}) {
    if (!redisClient || typeof redisClient.eval !== "function" || typeof redisClient.get !== "function" ||
        typeof redisClient.zRange !== "function" || typeof redisClient.mGet !== "function" ||
        typeof redisClient.ping !== "function") {
        throw new TypeError("Redis financial migration job store is not configured.");
    }
    canonical(keyPrefix, "keyPrefix", 160);
    if (!/\{[^{}]+\}/u.test(keyPrefix)) {
        throw new TypeError("keyPrefix must include a Redis Cluster hash tag.");
    }
    const indexKey = `${keyPrefix}jobs`;
    const jobKey = (playFabId) => `${keyPrefix}job:${hash(canonical(playFabId, "playFabId", 128))}`;
    const evaluate = (script, keys, args) => redisClient.eval(script, {
        keys,
        arguments: args.map((value) => String(value))
    });

    return Object.freeze({
        durable: true,
        async create(record) {
            validateFinancialAuthorityMigrationJob(record);
            return parseResult(await evaluate(CREATE_SCRIPT, [jobKey(record.playFabId), indexKey], [
                serialized(record), record.createdAtUnixMs
            ]));
        },
        async get(playFabId) {
            const text = await redisClient.get(jobKey(playFabId));
            if (text === null) return null;
            const record = JSON.parse(text);
            validateFinancialAuthorityMigrationJob(record);
            return record;
        },
        async acquireLease(playFabId, { owner, token, ttlMilliseconds, nowUnixMs }) {
            canonical(owner, "owner", 160);
            canonical(token, "token", 320);
            return parseResult(await evaluate(ACQUIRE_SCRIPT, [jobKey(playFabId)], [
                nowUnixMs, owner, token, ttlMilliseconds
            ]));
        },
        async renewLease(playFabId, { token, epoch, ttlMilliseconds, nowUnixMs }) {
            return parseResult(await evaluate(RENEW_SCRIPT, [jobKey(playFabId)], [
                nowUnixMs, token, epoch, ttlMilliseconds
            ]));
        },
        async releaseLease(playFabId, { token, epoch, nowUnixMs }) {
            return parseResult(await evaluate(RELEASE_SCRIPT, [jobKey(playFabId)], [nowUnixMs, token, epoch]));
        },
        async compareAndSet(playFabId, { expectedVersion, token, epoch, next, nowUnixMs }) {
            const current = await this.get(playFabId);
            if (current === null) return { status: "missing", record: null };
            const candidate = clone(next);
            candidate.version = current.version + 1;
            candidate.updatedAtUnixMs = nowUnixMs;
            validateReplacement(current, candidate);
            return parseResult(await evaluate(REPLACE_SCRIPT, [jobKey(playFabId)], [
                nowUnixMs, expectedVersion, token, epoch, candidate.schemaVersion, serialized(candidate)
            ]));
        },
        async promoteDryRun(playFabId, { expectedVersion, expectedPlanHash, nowUnixMs }) {
            canonical(expectedPlanHash, "expectedPlanHash", 128);
            return parseResult(await evaluate(PROMOTE_SCRIPT, [jobKey(playFabId)], [
                expectedVersion, nowUnixMs, expectedPlanHash
            ]));
        },
        async scan({ cursor = "0", limit = 100 } = {}) {
            const offset = Number(cursor);
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
                throw new TypeError("scan page is invalid.");
            }
            const keys = await redisClient.zRange(indexKey, offset, offset + limit - 1);
            const texts = keys.length === 0 ? [] : await redisClient.mGet(keys);
            const items = texts.filter((value) => value !== null).map((value) => {
                const record = JSON.parse(value);
                validateFinancialAuthorityMigrationJob(record);
                return record;
            });
            return { items, nextCursor: keys.length === limit ? String(offset + keys.length) : null };
        },
        async ping() { return (await redisClient.ping()) === "PONG"; }
    });
}

export const FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS = Object.freeze({
    create: CREATE_SCRIPT,
    acquire: ACQUIRE_SCRIPT,
    renew: RENEW_SCRIPT,
    release: RELEASE_SCRIPT,
    replace: REPLACE_SCRIPT,
    promote: PROMOTE_SCRIPT
});
