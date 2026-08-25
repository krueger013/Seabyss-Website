import { createHash } from "node:crypto";
import { PAYMENT_REVERSAL_STATUSES } from "./payment-ledger.js";

const INSERT_TRANSACTION_SCRIPT = `-- PAYMENT_LEDGER_INSERT_TRANSACTION_V1
local existing = redis.call("GET", KEYS[1])
if existing then
    local ok, wrapper = pcall(cjson.decode, existing)
    if not ok or type(wrapper) ~= "table" or type(wrapper.record) ~= "table" then
        return {"corrupt", ""}
    end
    if wrapper.immutableHash == ARGV[2] then
        return {"existing", cjson.encode(wrapper.record)}
    end
    return {"conflict", ""}
end
redis.call("SET", KEYS[1], ARGV[1])
for index = 2, #KEYS do
    redis.call("ZADD", KEYS[index], ARGV[3], ARGV[4])
end
return {"created", cjson.encode(cjson.decode(ARGV[1]).record)}
`;

const MUTATE_TRANSACTION_SCRIPT = `-- PAYMENT_LEDGER_MUTATE_TRANSACTION_V1
local serialized = redis.call("GET", KEYS[1])
if not serialized then return {"missing", ""} end
local ok, wrapper = pcall(cjson.decode, serialized)
if not ok or type(wrapper) ~= "table" or type(wrapper.record) ~= "table" then
    return {"corrupt", ""}
end
local record = wrapper.record
local command = cjson.decode(ARGV[4])
local expected = ARGV[1]
local leaseToken = ARGV[2]
local now = tonumber(ARGV[3])
if expected ~= "" and tonumber(expected) ~= tonumber(record.version) then
    return {"version_conflict", tostring(record.version)}
end
local function contains(values, target)
    for _, value in ipairs(values) do if value == target then return true end end
    return false
end
local function activeLease(token)
    return record.leaseToken ~= nil and record.leaseToken ~= cjson.null and
        record.leaseToken == token and record.leaseExpiresAtUnixMs ~= cjson.null and
        tonumber(record.leaseExpiresAtUnixMs) > now
end
local function save(status)
    redis.call("SET", KEYS[1], cjson.encode(wrapper))
    return {status, cjson.encode(record)}
end
local function touch()
    record.updatedAtUnixMs = now
    record.version = tonumber(record.version) + 1
end
local function auditCapacity()
    return type(record.audit) == "table" and #record.audit < 64
end

if command.type == "acquire_lease" then
    if not contains(command.allowedFrom, record.state) then
        return {"invalid_state", tostring(record.state)}
    end
    local active = record.leaseToken ~= nil and record.leaseToken ~= cjson.null and
        record.leaseExpiresAtUnixMs ~= cjson.null and tonumber(record.leaseExpiresAtUnixMs) > now
    if active and record.leaseToken ~= command.token then
        return {"busy", cjson.encode(record)}
    end
    if active and record.leaseToken == command.token then
        return {"acquired", cjson.encode(record)}
    end
    record.leaseOwner = command.owner
    record.leaseToken = command.token
    record.leaseExpiresAtUnixMs = now + tonumber(command.ttlMilliseconds)
    record.leaseEpoch = tonumber(record.leaseEpoch) + 1
    touch()
    return save("acquired")
end

if command.type == "renew_lease" then
    if not activeLease(leaseToken) then return {"lease_conflict", ""} end
    record.leaseExpiresAtUnixMs = now + tonumber(command.ttlMilliseconds)
    touch()
    return save("renewed")
end

if command.type == "release_lease" then
    if record.leaseToken == nil or record.leaseToken == cjson.null or
        record.leaseToken ~= leaseToken then return {"lease_conflict", ""} end
    record.leaseOwner = cjson.null
    record.leaseToken = cjson.null
    record.leaseExpiresAtUnixMs = cjson.null
    touch()
    return save("released")
end

if leaseToken ~= "" and not activeLease(leaseToken) then
    return {"lease_conflict", ""}
end

if command.type == "transition" then
    if not contains(command.allowedFrom, record.state) then
        return {"invalid_state", tostring(record.state)}
    end
    if not auditCapacity() then return {"capacity_exceeded", ""} end
    record.state = command.toState
    record.lastError = command.lastError
    if command.incrementRetry then record.retryCount = tonumber(record.retryCount) + 1 end
    table.insert(record.audit, command.audit)
    touch()
    return save("ok")
end

if command.type == "begin_step" then
    if record.stepJournal == nil or record.stepJournal == cjson.null then
        record.stepJournal = {}
    end
    local existing = record.stepJournal[command.name]
    if existing ~= nil then
        if existing.operationId == command.step.operationId then
            return {"already_present", cjson.encode(record)}
        end
        return {"checkpoint_conflict", ""}
    end
    local count = 0
    for _, _ in pairs(record.stepJournal) do count = count + 1 end
    if count >= tonumber(command.maximumSteps) or not auditCapacity() then
        return {"capacity_exceeded", ""}
    end
    record.stepJournal[command.name] = command.step
    table.insert(record.audit, command.audit)
    touch()
    return save("ok")
end

if command.type == "apply_step" then
    if record.stepJournal == nil or record.stepJournal == cjson.null then
        record.stepJournal = {}
    end
    local existing = record.stepJournal[command.name]
    if existing == nil or existing.operationId ~= command.operationId then
        return {"checkpoint_conflict", ""}
    end
    if existing.status == "StepApplied" then
        if existing.resultHash == command.resultHash then
            return {"already_present", cjson.encode(record)}
        end
        return {"checkpoint_conflict", ""}
    end
    if existing.status ~= "StepPending" or not auditCapacity() then
        return {"checkpoint_conflict", ""}
    end
    existing.status = "StepApplied"
    existing.result = command.result
    existing.resultHash = command.resultHash
    existing.updatedAtUnixMs = now
    existing.appliedAtUnixMs = now
    table.insert(record.audit, command.audit)
    touch()
    return save("ok")
end

if command.type == "checkpoint" then
    if command.requireAppliedStep then
        local appliedStep = record.stepJournal and record.stepJournal[command.name]
        if appliedStep == nil or appliedStep.status ~= "StepApplied" or
            appliedStep.operationId ~= command.checkpoint.operationId or
            appliedStep.resultHash ~= command.checkpoint.resultHash then
            return {"checkpoint_conflict", ""}
        end
    end
    local existing = record.checkpoints[command.name]
    if existing ~= nil then
        if existing.operationId == command.checkpoint.operationId and
            existing.resultHash == command.checkpoint.resultHash then
            return {"already_present", cjson.encode(record)}
        end
        return {"checkpoint_conflict", ""}
    end
    local count = 0
    for _, _ in pairs(record.checkpoints) do count = count + 1 end
    if count >= tonumber(command.maximumCheckpoints) or not auditCapacity() then
        return {"capacity_exceeded", ""}
    end
    record.checkpoints[command.name] = command.checkpoint
    table.insert(record.audit, command.audit)
    touch()
    return save("ok")
end

if command.type == "append_audit" then
    if #record.audit >= tonumber(command.maximumAuditEntries) then
        return {"capacity_exceeded", ""}
    end
    table.insert(record.audit, command.audit)
    touch()
    return save("ok")
end
return {"invalid_command", ""}
`;

const INSERT_REVERSAL_SCRIPT = `-- PAYMENT_LEDGER_INSERT_REVERSAL_V1
local existing = redis.call("GET", KEYS[1])
if existing then
    local ok, wrapper = pcall(cjson.decode, existing)
    if not ok or type(wrapper) ~= "table" or type(wrapper.record) ~= "table" then
        return {"corrupt", ""}
    end
    if wrapper.immutableHash == ARGV[2] then
        return {"existing", cjson.encode(wrapper.record)}
    end
    return {"conflict", ""}
end
local transactionText = redis.call("GET", KEYS[2])
if not transactionText then return {"missing", ""} end
local ok, transactionWrapper = pcall(cjson.decode, transactionText)
if not ok or type(transactionWrapper) ~= "table" or
    type(transactionWrapper.record) ~= "table" then return {"corrupt", ""} end
local reversalWrapper = cjson.decode(ARGV[1])
local reversal = reversalWrapper.record
local transaction = transactionWrapper.record
if transaction.currency ~= reversal.currency then return {"currency_conflict", ""} end
if tonumber(transaction.reversedAmountMinor) + tonumber(reversal.amountMinor) >
    tonumber(transaction.amountMinor) then return {"amount_exceeded", ""} end
if #transaction.reversalIds >= tonumber(ARGV[5]) or #transaction.audit >= 64 then
    return {"capacity_exceeded", ""}
end
redis.call("SET", KEYS[1], ARGV[1])
for index = 3, #KEYS do redis.call("ZADD", KEYS[index], ARGV[3], ARGV[4]) end
table.insert(transaction.reversalIds, reversal.reversalEventId)
transaction.reversedAmountMinor = tonumber(transaction.reversedAmountMinor) +
    tonumber(reversal.amountMinor)
if reversal.type == "chargeback" then
    transaction.reversalStatus = "ChargebackPendingReview"
elseif reversal.type == "order_canceled" then
    transaction.reversalStatus = "CancellationPendingReview"
else
    transaction.reversalStatus = "RefundPendingReview"
end
table.insert(transaction.audit, {
    actor = "system",
    action = "reversal_linked",
    reason = reversal.reason,
    details = {
        reversalEventId = reversal.reversalEventId,
        type = reversal.type,
        amountMinor = reversal.amountMinor
    },
    atUnixMs = reversal.createdAtUnixMs
})
transaction.updatedAtUnixMs = reversal.createdAtUnixMs
transaction.version = tonumber(transaction.version) + 1
redis.call("SET", KEYS[2], cjson.encode(transactionWrapper))
return {"created", cjson.encode(reversal)}
`;

const MUTATE_REVERSAL_SCRIPT = `-- PAYMENT_LEDGER_MUTATE_REVERSAL_V1
local reversalText = redis.call("GET", KEYS[1])
if not reversalText then return {"missing", ""} end
local transactionText = redis.call("GET", KEYS[2])
if not transactionText then return {"missing", ""} end
local okReversal, reversalWrapper = pcall(cjson.decode, reversalText)
local okTransaction, transactionWrapper = pcall(cjson.decode, transactionText)
if not okReversal or not okTransaction or type(reversalWrapper.record) ~= "table" or
    type(transactionWrapper.record) ~= "table" then return {"corrupt", ""} end
local reversal = reversalWrapper.record
local transaction = transactionWrapper.record
local expected = ARGV[1]
local now = tonumber(ARGV[2])
local command = cjson.decode(ARGV[3])
if expected ~= "" and tonumber(expected) ~= tonumber(reversal.version) then
    return {"version_conflict", tostring(reversal.version)}
end
local allowed = false
for _, value in ipairs(command.allowedFrom) do
    if value == reversal.status then allowed = true end
end
if command.type ~= "transition" or not allowed then
    return {"invalid_state", tostring(reversal.status)}
end
if #reversal.audit >= 64 or #transaction.audit >= 64 then
    return {"capacity_exceeded", ""}
end
local oldStatus = reversal.status
reversal.status = command.toStatus
table.insert(reversal.audit, command.audit)
reversal.updatedAtUnixMs = now
reversal.version = tonumber(reversal.version) + 1
for index = 3, #KEYS do redis.call("ZREM", KEYS[index], ARGV[4]) end
redis.call("ZADD", KEYS[tonumber(ARGV[6])], ARGV[5], ARGV[4])
if reversal.status == "ResolvedNoClawback" then
    transaction.reversalStatus = "ReviewedNoClawback"
elseif reversal.type == "chargeback" then
    transaction.reversalStatus = "ChargebackPendingReview"
elseif reversal.type == "order_canceled" then
    transaction.reversalStatus = "CancellationPendingReview"
else
    transaction.reversalStatus = "RefundPendingReview"
end
table.insert(transaction.audit, {
    actor = command.audit.actor,
    action = "reversal_status_updated",
    reason = command.audit.reason,
    details = { reversalEventId = reversal.reversalEventId, status = reversal.status },
    atUnixMs = now
})
transaction.updatedAtUnixMs = now
transaction.version = tonumber(transaction.version) + 1
redis.call("SET", KEYS[1], cjson.encode(reversalWrapper))
redis.call("SET", KEYS[2], cjson.encode(transactionWrapper))
return {"ok", cjson.encode(reversal)}
`;

const ACQUIRE_RESOURCE_LEASE_SCRIPT = `-- PAYMENT_LEDGER_ACQUIRE_RESOURCE_LEASE_V1
local existing = redis.call("GET", KEYS[1])
if existing then
    local ok, lease = pcall(cjson.decode, existing)
    if not ok or type(lease) ~= "table" then return {"corrupt", ""} end
    if tonumber(lease.expiresAtUnixMs) > tonumber(ARGV[1]) then
        if lease.token == ARGV[3] then return {"acquired", existing} end
        return {"busy", existing}
    end
end
local epoch = redis.call("INCR", KEYS[2])
local lease = {
    resourceType = ARGV[5],
    resourceId = ARGV[6],
    owner = ARGV[2],
    token = ARGV[3],
    epoch = epoch,
    acquiredAtUnixMs = tonumber(ARGV[1]),
    expiresAtUnixMs = tonumber(ARGV[1]) + tonumber(ARGV[4])
}
local serialized = cjson.encode(lease)
redis.call("SET", KEYS[1], serialized, "PX", ARGV[4])
return {"acquired", serialized}
`;

const RENEW_RESOURCE_LEASE_SCRIPT = `-- PAYMENT_LEDGER_RENEW_RESOURCE_LEASE_V1
local existing = redis.call("GET", KEYS[1])
if not existing then return {"lease_conflict", ""} end
local ok, lease = pcall(cjson.decode, existing)
if not ok or type(lease) ~= "table" then return {"corrupt", ""} end
if lease.token ~= ARGV[2] or tonumber(lease.expiresAtUnixMs) <= tonumber(ARGV[1]) then
    return {"lease_conflict", ""}
end
lease.expiresAtUnixMs = tonumber(ARGV[1]) + tonumber(ARGV[3])
local serialized = cjson.encode(lease)
redis.call("SET", KEYS[1], serialized, "PX", ARGV[3])
return {"renewed", serialized}
`;

const RELEASE_RESOURCE_LEASE_SCRIPT = `-- PAYMENT_LEDGER_RELEASE_RESOURCE_LEASE_V1
local existing = redis.call("GET", KEYS[1])
if not existing then return {"lease_conflict", ""} end
local ok, lease = pcall(cjson.decode, existing)
if not ok or type(lease) ~= "table" then return {"corrupt", ""} end
if lease.token ~= ARGV[1] then return {"lease_conflict", ""} end
redis.call("DEL", KEYS[1])
return {"released", existing}
`;

function hash(value) {
    return createHash("sha256").update(value, "utf8").digest("base64url");
}

function canonicalPrefix(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 300 ||
        value !== value.trim() || /\s/u.test(value)) {
        throw new TypeError("Redis payment ledger prefix is invalid.");
    }
    return value;
}

function normalizeRedisTransactionArrays(record) {
    if (!record || typeof record !== "object" ||
        !Object.hasOwn(record, "reversalIds")) return record;
    if (Array.isArray(record.reversalIds)) return record;
    if (record.reversalIds && typeof record.reversalIds === "object" &&
        !Array.isArray(record.reversalIds) && Object.keys(record.reversalIds).length === 0) {
        return { ...record, reversalIds: [] };
    }
    throw new Error("Redis payment transaction reversalIds is invalid.");
}

function parseRecord(value, kind) {
    let wrapper;
    try {
        wrapper = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        throw new Error(`Redis payment ${kind} record is malformed.`);
    }
    if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper) ||
        typeof wrapper.immutableHash !== "string" || !wrapper.record ||
        typeof wrapper.record !== "object" || Array.isArray(wrapper.record)) {
        throw new Error(`Redis payment ${kind} record is invalid.`);
    }
    return { ...wrapper, record: normalizeRedisTransactionArrays(wrapper.record) };
}

function parseEval(result, recordName = "record") {
    if (!Array.isArray(result) || typeof result[0] !== "string") {
        throw new Error("Redis payment ledger script returned an invalid response.");
    }
    if (result[0] === "corrupt" || result[0] === "invalid_command") {
        throw new Error("Redis payment ledger contains corrupt or unsupported data.");
    }
    const raw = result[1] ? JSON.parse(result[1]) : null;
    const parsed = normalizeRedisTransactionArrays(raw);
    if (result[0] === "version_conflict") {
        return { status: result[0], currentVersion: Number(result[1]) };
    }
    return parsed ? { status: result[0], [recordName]: parsed } : { status: result[0] };
}

function encodedIdentity(...values) {
    return hash(values.join("\0"));
}

export function createRedisPaymentLedgerStore(redisClient, {
    prefix = "seabyss:payments:ledger:v1:"
} = {}) {
    if (!redisClient || typeof redisClient.get !== "function" ||
        typeof redisClient.eval !== "function" || typeof redisClient.zRange !== "function" ||
        typeof redisClient.mGet !== "function" || typeof redisClient.ping !== "function") {
        throw new TypeError("Redis payment ledger client is not configured.");
    }
    const root = canonicalPrefix(prefix);
    const transactionKey = (provider, transactionId) =>
        `${root}tx:${encodedIdentity(provider, transactionId)}`;
    const reversalKey = (provider, eventId) =>
        `${root}reversal:${encodedIdentity(provider, eventId)}`;
    const transactionIndex = (index, value) =>
        `${root}idx:tx:${index}:${hash(value)}`;
    const reversalIndex = (index, value) =>
        `${root}idx:reversal:${index}:${hash(value)}`;
    const allTransactionsKey = `${root}idx:tx:all`;
    const allReversalsKey = `${root}idx:reversal:all`;
    const resourceLeaseKey = (type, id) =>
        `${root}resource-lease:${encodedIdentity(type, id)}`;
    const resourceEpochKey = (type, id) =>
        `${root}resource-lease-epoch:${encodedIdentity(type, id)}`;

    async function readTransaction(provider, providerTransactionId) {
        const value = await redisClient.get(transactionKey(provider, providerTransactionId));
        return value === null ? null : parseRecord(value, "transaction").record;
    }

    async function readReversal(provider, reversalEventId) {
        const value = await redisClient.get(reversalKey(provider, reversalEventId));
        return value === null ? null : parseRecord(value, "reversal").record;
    }

    async function readPage(key, cursor, limit, provider, kind) {
        const offset = Number(cursor);
        const members = await redisClient.zRange(key, offset, offset + limit - 1);
        if (!Array.isArray(members)) throw new Error("Redis payment index response is invalid.");
        const serialized = members.length === 0 ? [] : await redisClient.mGet(members);
        if (!Array.isArray(serialized) || serialized.length !== members.length) {
            throw new Error("Redis payment index records are invalid.");
        }
        const items = serialized
            .filter((value) => value !== null)
            .map((value) => parseRecord(value, kind).record)
            .filter((record) => !provider || record.provider === provider);
        return {
            items,
            nextCursor: members.length === limit ? String(offset + members.length) : null
        };
    }

    return Object.freeze({
        async insertTransaction({ record, immutableHash }) {
            const key = transactionKey(record.provider, record.providerTransactionId);
            const wrapper = JSON.stringify({ immutableHash, record });
            const keys = [allTransactionsKey];
            for (const [index, value] of [
                ["orderId", record.orderId],
                ["receiptId", record.receiptId],
                ["playFabId", record.playFabId],
                ["sku", record.sku]
            ]) {
                if (value !== null && value !== undefined) keys.push(transactionIndex(index, value));
            }
            return parseEval(await redisClient.eval(INSERT_TRANSACTION_SCRIPT, {
                keys: [key, ...keys],
                arguments: [wrapper, immutableHash, String(record.createdAtUnixMs), key]
            }));
        },

        async getTransaction({ provider, providerTransactionId }) {
            return readTransaction(provider, providerTransactionId);
        },

        async mutateTransaction(input) {
            return parseEval(await redisClient.eval(MUTATE_TRANSACTION_SCRIPT, {
                keys: [transactionKey(input.provider, input.providerTransactionId)],
                arguments: [
                    input.expectedVersion === null || input.expectedVersion === undefined
                        ? ""
                        : String(input.expectedVersion),
                    input.leaseToken || "",
                    String(input.atUnixMs),
                    JSON.stringify(input.command)
                ]
            }));
        },

        async queryTransactions({ index, value, provider, cursor, limit }) {
            return readPage(transactionIndex(index, value), cursor, limit, provider, "transaction");
        },

        async scanTransactions({ cursor, limit }) {
            return readPage(allTransactionsKey, cursor, limit, null, "transaction");
        },

        async insertReversal({ record, immutableHash, maximumReversals }) {
            const key = reversalKey(record.provider, record.reversalEventId);
            const wrapper = JSON.stringify({ immutableHash, record });
            const indexKeys = [
                allReversalsKey,
                reversalIndex("originalTransaction", record.providerTransactionId),
                reversalIndex("playFabId", record.playFabId),
                reversalIndex("type", record.type),
                reversalIndex("status", record.status)
            ];
            return parseEval(await redisClient.eval(INSERT_REVERSAL_SCRIPT, {
                keys: [
                    key,
                    transactionKey(record.provider, record.providerTransactionId),
                    ...indexKeys
                ],
                arguments: [
                    wrapper,
                    immutableHash,
                    String(record.createdAtUnixMs),
                    key,
                    String(maximumReversals)
                ]
            }));
        },

        async getReversal({ provider, reversalEventId }) {
            return readReversal(provider, reversalEventId);
        },

        async mutateReversal(input) {
            const current = await readReversal(input.provider, input.reversalEventId);
            if (!current) return { status: "missing" };
            const key = reversalKey(input.provider, input.reversalEventId);
            const statusKeys = PAYMENT_REVERSAL_STATUSES.map((status) =>
                reversalIndex("status", status));
            const targetPosition = 3 + PAYMENT_REVERSAL_STATUSES.indexOf(input.command.toStatus);
            return parseEval(await redisClient.eval(MUTATE_REVERSAL_SCRIPT, {
                keys: [
                    key,
                    transactionKey(input.provider, current.providerTransactionId),
                    ...statusKeys
                ],
                arguments: [
                    input.expectedVersion === null || input.expectedVersion === undefined
                        ? ""
                        : String(input.expectedVersion),
                    String(input.atUnixMs),
                    JSON.stringify(input.command),
                    key,
                    String(current.createdAtUnixMs),
                    String(targetPosition)
                ]
            }));
        },

        async queryReversals({ index, value, provider, cursor, limit }) {
            return readPage(reversalIndex(index, value), cursor, limit, provider, "reversal");
        },

        async scanReversals({ cursor, limit }) {
            return readPage(allReversalsKey, cursor, limit, null, "reversal");
        },

        async acquireResourceLease(input) {
            return parseEval(await redisClient.eval(ACQUIRE_RESOURCE_LEASE_SCRIPT, {
                keys: [
                    resourceLeaseKey(input.resourceType, input.resourceId),
                    resourceEpochKey(input.resourceType, input.resourceId)
                ],
                arguments: [
                    String(input.atUnixMs),
                    input.owner,
                    input.token,
                    String(input.ttlMilliseconds),
                    input.resourceType,
                    input.resourceId
                ]
            }), "lease");
        },

        async renewResourceLease(input) {
            return parseEval(await redisClient.eval(RENEW_RESOURCE_LEASE_SCRIPT, {
                keys: [resourceLeaseKey(input.resourceType, input.resourceId)],
                arguments: [
                    String(input.atUnixMs),
                    input.token,
                    String(input.ttlMilliseconds)
                ]
            }), "lease");
        },

        async releaseResourceLease(input) {
            return parseEval(await redisClient.eval(RELEASE_RESOURCE_LEASE_SCRIPT, {
                keys: [resourceLeaseKey(input.resourceType, input.resourceId)],
                arguments: [input.token]
            }), "lease");
        },

        async ping() {
            return await redisClient.ping() === "PONG";
        }
    });
}

export const PAYMENT_LEDGER_REDIS_SCRIPTS = Object.freeze({
    insertTransaction: INSERT_TRANSACTION_SCRIPT,
    mutateTransaction: MUTATE_TRANSACTION_SCRIPT,
    insertReversal: INSERT_REVERSAL_SCRIPT,
    mutateReversal: MUTATE_REVERSAL_SCRIPT,
    acquireResourceLease: ACQUIRE_RESOURCE_LEASE_SCRIPT,
    renewResourceLease: RENEW_RESOURCE_LEASE_SCRIPT,
    releaseResourceLease: RELEASE_RESOURCE_LEASE_SCRIPT
});
