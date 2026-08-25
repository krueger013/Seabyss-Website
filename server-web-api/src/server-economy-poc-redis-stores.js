import { createHash } from "node:crypto";
import {
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function hash(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function redisClient(redis) {
    if (!redis || typeof redis.sendCommand !== "function") {
        throw new TypeError("Redis-compatible client.sendCommand is required.");
    }
    return redis;
}

function resultArray(value, name) {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
        serverEconomyPocFail("POC_REDIS_PROTOCOL", `${name} returned an invalid Redis result.`, { retryable: true });
    }
    return value;
}

function parse(value, name) {
    if (typeof value !== "string") serverEconomyPocFail("POC_REDIS_PROTOCOL", `${name} is missing.`, { retryable: true });
    try { return JSON.parse(value); } catch {
        serverEconomyPocFail("POC_REDIS_CORRUPT", `${name} contains invalid JSON.`);
    }
}

const WAL_APPEND_SCRIPT = `
local existing = redis.call('GET', KEYS[3])
if existing then
  local decoded = cjson.decode(existing)
  if decoded.immutableHash ~= ARGV[1] then return {'conflict', existing} end
  return {'existing', existing}
end
local sequence = redis.call('INCR', KEYS[1])
local record = cjson.decode(ARGV[2])
record.sequence = sequence
local encoded = cjson.encode(record)
redis.call('SET', KEYS[3], encoded)
redis.call('ZADD', KEYS[2], sequence, KEYS[3])
redis.call('SADD', KEYS[4], ARGV[3])
redis.call('SETNX', KEYS[5], ARGV[4])
return {'appended', encoded}
`;

const WAL_ACK_SCRIPT = `
local maximum = tonumber(redis.call('GET', KEYS[1]) or '0')
local requested = tonumber(ARGV[1])
if requested > maximum then return {'invalid', tostring(maximum)} end
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if requested > current then redis.call('SET', KEYS[2], requested) current = requested end
return {'acked', tostring(current)}
`;

export function createRedisCompatibleServerEconomyPocWalStore({
    redis,
    prefix = "server:economy:poc:v1:"
} = {}) {
    const client = redisClient(redis);
    serverEconomyPocId(prefix, "Redis prefix", 160);
    const playersKey = `${prefix}wal:players`;
    const keys = (playFabId) => {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const playerHash = hash(player);
        const base = `${prefix}player:${playerHash}:`;
        return {
            player,
            playerHash,
            sequence: `${base}wal:sequence`,
            index: `${base}wal:index`,
            ack: `${base}wal:acked`,
            playerId: `${base}identity`
        };
    };

    async function append(event) {
        const playerKeys = keys(event?.playFabId);
        const eventId = serverEconomyPocId(event?.eventId, "eventId", 200);
        const immutableHash = serverEconomyPocId(event?.immutableHash, "immutableHash", 128);
        const eventKey = `${prefix}player:${playerKeys.playerHash}:wal:event:${hash(eventId)}`;
        const result = resultArray(await client.sendCommand([
            "EVAL", WAL_APPEND_SCRIPT, "5",
            playerKeys.sequence, playerKeys.index, eventKey, playersKey, playerKeys.playerId,
            immutableHash, JSON.stringify(event), playerKeys.playerHash, playerKeys.player
        ]), "WAL append");
        if (result[0] === "conflict") {
            serverEconomyPocFail("POC_WAL_IDEMPOTENCY_CONFLICT", "Ammo eventId is bound to another event.");
        }
        if (!["appended", "existing"].includes(result[0])) {
            serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis WAL append returned an unknown status.", { retryable: true });
        }
        return serverEconomyPocReadonly({ status: result[0], entry: parse(result[1], "WAL entry") });
    }

    async function scanAfter({ playFabId, afterSequence, limit }) {
        const playerKeys = keys(playFabId);
        const after = serverEconomyPocNonNegative(afterSequence, "afterSequence");
        const maximum = serverEconomyPocPositive(limit, "WAL scan limit");
        const eventKeys = await client.sendCommand([
            "ZRANGEBYSCORE", playerKeys.index, `(${after}`, "+inf", "LIMIT", "0", String(maximum)
        ]);
        if (!Array.isArray(eventKeys)) serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis WAL index is invalid.", { retryable: true });
        const rawEntries = eventKeys.length === 0 ? [] : await client.sendCommand(["MGET", ...eventKeys]);
        if (!Array.isArray(rawEntries) || rawEntries.some((entry) => typeof entry !== "string")) {
            serverEconomyPocFail("POC_REDIS_CORRUPT", "Redis WAL references a missing event.");
        }
        const [nextRaw, ackRaw] = await client.sendCommand([
            "MGET", playerKeys.sequence, playerKeys.ack
        ]);
        return serverEconomyPocReadonly({
            entries: rawEntries.map((entry) => parse(entry, "WAL entry")),
            nextSequence: Number(nextRaw || 0),
            ackedThroughSequence: Number(ackRaw || 0)
        });
    }

    async function ackThrough({ playFabId, throughSequence }) {
        const playerKeys = keys(playFabId);
        const through = serverEconomyPocNonNegative(throughSequence, "throughSequence");
        const result = resultArray(await client.sendCommand([
            "EVAL", WAL_ACK_SCRIPT, "2", playerKeys.sequence, playerKeys.ack, String(through)
        ]), "WAL ACK");
        if (result[0] === "invalid") serverEconomyPocFail("POC_WAL_ACK_INVALID", "WAL ACK exceeds the durable sequence.");
        if (result[0] !== "acked") serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis WAL ACK returned an unknown status.", { retryable: true });
        return serverEconomyPocReadonly({ status: "acked", ackedThroughSequence: Number(result[1]) });
    }

    async function status(playFabId) {
        const playerKeys = keys(playFabId);
        const values = await client.sendCommand(["MGET", playerKeys.sequence, playerKeys.ack]);
        if (!Array.isArray(values)) serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis WAL status is invalid.", { retryable: true });
        const nextSequence = Number(values[0] || 0);
        const ackedThroughSequence = Number(values[1] || 0);
        return serverEconomyPocReadonly({
            nextSequence,
            ackedThroughSequence,
            pendingCount: nextSequence - ackedThroughSequence
        });
    }

    async function listPlayersWithPending({ limit = 100 } = {}) {
        const maximum = serverEconomyPocPositive(limit, "player scan limit");
        const hashes = await client.sendCommand(["SMEMBERS", playersKey]);
        if (!Array.isArray(hashes)) serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis WAL player set is invalid.", { retryable: true });
        const result = [];
        for (const playerHash of hashes.sort()) {
            if (result.length >= maximum) break;
            const base = `${prefix}player:${playerHash}:`;
            const values = await client.sendCommand([
                "MGET", `${base}identity`, `${base}wal:sequence`, `${base}wal:acked`
            ]);
            if (typeof values?.[0] === "string" && Number(values[1] || 0) > Number(values[2] || 0)) {
                result.push(values[0]);
            }
        }
        return Object.freeze(result);
    }

    return Object.freeze({ append, scanAfter, ackThrough, status, listPlayersWithPending,
        durable: true, redisCompatible: true });
}

const INBOX_SUBMIT_LEGACY_SCRIPT = `
local existing = redis.call('GET', KEYS[3])
if existing then
  local decoded = cjson.decode(existing)
  if decoded.operation.immutableHash ~= ARGV[1] then return {'conflict', existing} end
  return {'existing', existing}
end
local sequence = redis.call('INCR', KEYS[1])
local operation = cjson.decode(ARGV[2])
local record = {
 schemaVersion=1, playFabId=operation.playFabId, operationId=operation.operationId,
 sequence=sequence, state='Pending', operation=operation, claimEpoch=0,
 claimOwner=cjson.null, claimToken=cjson.null, claimExpiresAtUnixMs=cjson.null,
 result=cjson.null, ackedAtUnixMs=cjson.null
}
local encoded = cjson.encode(record)
redis.call('SET', KEYS[3], encoded)
redis.call('ZADD', KEYS[2], sequence, KEYS[3])
redis.call('SADD', KEYS[4], ARGV[3])
redis.call('SETNX', KEYS[5], ARGV[4])
return {'submitted', encoded}
`;

const INBOX_SUBMIT_FENCED_SCRIPT = `-- SERVER_ECONOMY_POC_UNIFIED_SEQUENCE_SUBMIT_V1
local existing = redis.call('GET', KEYS[3])
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if not ok or type(decoded) ~= 'table' then return {'corrupt', existing} end
  if decoded.operation.immutableHash ~= ARGV[1] then return {'conflict', existing} end
  return {'existing', existing}
end

local floor = tonumber(ARGV[7])
if not floor or floor < 0 or floor ~= math.floor(floor) then return {'invalid', ''} end
local lease_raw = redis.call('GET', KEYS[6])
if not lease_raw then return {'stale', ''} end
local lease_ok, lease = pcall(cjson.decode, lease_raw)
if not lease_ok or type(lease) ~= 'table' or lease.schemaVersion ~= 1 or
   lease.playFabId ~= ARGV[4] or lease.tokenDigest ~= ARGV[5] or
   tonumber(lease.epoch) ~= tonumber(ARGV[6]) then
  return {'stale', lease_raw}
end
local current_time = redis.call('TIME')
local now = tonumber(current_time[1]) * 1000 + math.floor(tonumber(current_time[2]) / 1000)
if tonumber(lease.expiresAtUnixMs or 0) <= now or redis.call('PTTL', KEYS[6]) <= 0 then
  return {'stale', lease_raw}
end
local operation_ok, operation = pcall(cjson.decode, ARGV[2])
if not operation_ok or type(operation) ~= 'table' or operation.playFabId ~= ARGV[4] or
   operation.immutableHash ~= ARGV[1] then
  return {'invalid', ''}
end

local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if not current or current < 0 or current ~= math.floor(current) then return {'corrupt', ''} end
if current < floor then redis.call('SET', KEYS[1], tostring(floor)) end
local sequence = redis.call('INCR', KEYS[1])
local record = {
 schemaVersion=1, playFabId=operation.playFabId, operationId=operation.operationId,
 sequence=sequence, state='Pending', operation=operation, claimEpoch=0,
 claimOwner=cjson.null, claimToken=cjson.null, claimExpiresAtUnixMs=cjson.null,
 result=cjson.null, ackedAtUnixMs=cjson.null
}
local encoded = cjson.encode(record)
redis.call('SET', KEYS[3], encoded)
redis.call('ZADD', KEYS[2], sequence, KEYS[3])
redis.call('SADD', KEYS[4], ARGV[3])
redis.call('SETNX', KEYS[5], ARGV[4])
return {'submitted', encoded}
`;

const INBOX_CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local record = cjson.decode(raw)
if record.state == 'Acked' then return {'acked', raw} end
local now = tonumber(ARGV[3])
if record.state == 'Claimed' and tonumber(record.claimExpiresAtUnixMs or 0) > now and record.claimToken ~= ARGV[2] then
 return {'busy', raw}
end
if record.state ~= 'Claimed' or record.claimToken ~= ARGV[2] or tonumber(record.claimExpiresAtUnixMs or 0) <= now then
 record.claimEpoch = tonumber(record.claimEpoch or 0) + 1
end
record.state = 'Claimed'
record.claimOwner = ARGV[1]
record.claimToken = ARGV[2]
record.claimExpiresAtUnixMs = now + tonumber(ARGV[4])
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded)
return {'claimed', encoded}
`;

const INBOX_ACK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local record = cjson.decode(raw)
if record.state == 'Acked' then return {'acked', raw} end
local now = tonumber(ARGV[3])
if record.state ~= 'Claimed' or record.claimToken ~= ARGV[1] or
 tonumber(record.claimEpoch) ~= tonumber(ARGV[2]) or tonumber(record.claimExpiresAtUnixMs or 0) <= now then
 return {'stale', raw}
end
record.state = 'Acked'
record.result = cjson.decode(ARGV[4])
record.ackedAtUnixMs = now
record.claimExpiresAtUnixMs = cjson.null
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded)
return {'acked', encoded}
`;

const INBOX_RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local record = cjson.decode(raw)
if record.state == 'Acked' then return {'acked', raw} end
local now = tonumber(ARGV[3])
if record.state ~= 'Claimed' or record.claimToken ~= ARGV[1] or
 tonumber(record.claimEpoch) ~= tonumber(ARGV[2]) or tonumber(record.claimExpiresAtUnixMs or 0) <= now then
 return {'stale', raw}
end
record.state = 'Pending'
record.claimOwner = cjson.null
record.claimToken = cjson.null
record.claimExpiresAtUnixMs = cjson.null
local encoded = cjson.encode(record)
redis.call('SET', KEYS[1], encoded)
return {'released', encoded}
`;

export function createRedisCompatibleServerEconomyPocOperationInbox({
    redis,
    prefix = "server:economy:poc:v1:",
    nowMilliseconds = () => Date.now(),
    assertPlayerFence = null,
    requireSequenceAllocationFence = false
} = {}) {
    const client = redisClient(redis);
    serverEconomyPocId(prefix, "Redis prefix", 160);
    if (typeof nowMilliseconds !== "function" ||
        assertPlayerFence !== null && typeof assertPlayerFence !== "function" ||
        typeof requireSequenceAllocationFence !== "boolean") {
        throw new TypeError("Redis inbox dependencies are invalid.");
    }
    const playersKey = `${prefix}inbox:players`;
    const keys = (playFabId, operationId = null) => {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const playerHash = hash(player);
        const base = `${prefix}player:${playerHash}:`;
        return {
            player,
            playerHash,
            sequence: `${base}inbox:sequence`,
            index: `${base}inbox:index`,
            playerId: `${base}identity`,
            sequenceLease: `${prefix}{${playerHash}}:player-lease`,
            operation: operationId === null ? null
                : `${base}inbox:operation:${hash(serverEconomyPocId(operationId, "operationId", 200))}`
        };
    };
    const now = () => serverEconomyPocNonNegative(nowMilliseconds(), "inbox clock");

    function allocationContext(value) {
        if (value === null) return null;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            serverEconomyPocFail("POC_SEQUENCE_ALLOCATION_CONTEXT_REQUIRED",
                "A fenced provider-anchored sequence allocation context is required.");
        }
        return Object.freeze({
            minimumSequenceExclusive: serverEconomyPocNonNegative(
                value.minimumSequenceExclusive,
                "minimum sequence exclusive"
            ),
            playerLeaseToken: serverEconomyPocId(value.playerLeaseToken, "sequence lease token", 255),
            playerFencingEpoch: serverEconomyPocPositive(value.playerFencingEpoch, "sequence fencing epoch")
        });
    }

    async function submit(operation, allocation = null) {
        const operationKeys = keys(operation?.playFabId, operation?.operationId);
        const context = allocationContext(allocation);
        if (requireSequenceAllocationFence && context === null) {
            const existing = await get(operationKeys.player, operation.operationId);
            if (existing) {
                if (existing.operation.immutableHash !== operation.immutableHash) {
                    serverEconomyPocFail("POC_OPERATION_IDEMPOTENCY_CONFLICT",
                        "operationId is bound to another operation.");
                }
                return serverEconomyPocReadonly({ status: "existing", record: existing });
            }
            serverEconomyPocFail("POC_SEQUENCE_ALLOCATION_CONTEXT_REQUIRED",
                "A fenced provider-anchored sequence allocation context is required.");
        }
        const script = context === null ? INBOX_SUBMIT_LEGACY_SCRIPT : INBOX_SUBMIT_FENCED_SCRIPT;
        const scriptKeys = context === null
            ? [operationKeys.sequence, operationKeys.index, operationKeys.operation, playersKey, operationKeys.playerId]
            : [operationKeys.sequence, operationKeys.index, operationKeys.operation, playersKey,
                operationKeys.playerId, operationKeys.sequenceLease];
        const scriptArgs = [
            operation.immutableHash,
            JSON.stringify(operation),
            operationKeys.playerHash,
            operationKeys.player,
            ...(context === null ? [] : [
                hash(context.playerLeaseToken),
                String(context.playerFencingEpoch),
                String(context.minimumSequenceExclusive)
            ])
        ];
        const result = resultArray(await client.sendCommand([
            "EVAL", script, String(scriptKeys.length), ...scriptKeys, ...scriptArgs
        ]), "inbox submit");
        if (result[0] === "conflict") serverEconomyPocFail("POC_OPERATION_IDEMPOTENCY_CONFLICT", "operationId is bound to another operation.");
        if (result[0] === "stale") serverEconomyPocFail("POC_STALE_WRITER", "Sequence allocator lease is stale.", { retryable: true });
        if (result[0] === "corrupt") serverEconomyPocFail("POC_REDIS_CORRUPT", "Redis sequence allocator state is corrupt.");
        if (result[0] === "invalid") serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis sequence allocator input is invalid.");
        if (!["submitted", "existing"].includes(result[0])) serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis inbox submit returned an unknown status.", { retryable: true });
        return serverEconomyPocReadonly({ status: result[0], record: parse(result[1], "inbox record") });
    }

    async function get(playFabId, operationId) {
        const operationKeys = keys(playFabId, operationId);
        const raw = await client.sendCommand(["GET", operationKeys.operation]);
        return raw === null ? null : serverEconomyPocReadonly(parse(raw, "inbox record"));
    }

    async function scanAfter({ playFabId, afterSequence, limit = 100 }) {
        const playerKeys = keys(playFabId);
        const after = serverEconomyPocNonNegative(afterSequence, "afterSequence");
        const maximum = serverEconomyPocPositive(limit, "inbox scan limit");
        const operationKeys = await client.sendCommand([
            "ZRANGEBYSCORE", playerKeys.index, `(${after}`, "+inf", "LIMIT", "0", String(maximum)
        ]);
        if (!Array.isArray(operationKeys)) serverEconomyPocFail("POC_REDIS_PROTOCOL", "Redis inbox index is invalid.", { retryable: true });
        const raw = operationKeys.length === 0 ? [] : await client.sendCommand(["MGET", ...operationKeys]);
        const nextRaw = await client.sendCommand(["GET", playerKeys.sequence]);
        return serverEconomyPocReadonly({
            entries: raw.map((entry) => parse(entry, "inbox record")),
            nextSequence: Number(nextRaw || 0)
        });
    }

    async function claim({ playFabId, operationId, owner, token, ttlMilliseconds }) {
        const operationKeys = keys(playFabId, operationId);
        const result = resultArray(await client.sendCommand([
            "EVAL", INBOX_CLAIM_SCRIPT, "1", operationKeys.operation,
            serverEconomyPocId(owner, "claim owner", 160),
            serverEconomyPocId(token, "claim token", 255), String(now()),
            String(serverEconomyPocPositive(ttlMilliseconds, "claim TTL"))
        ]), "inbox claim");
        return serverEconomyPocReadonly({
            status: result[0],
            ...(typeof result[1] === "string" ? { record: parse(result[1], "inbox record") } : {})
        });
    }

    async function ack({
        playFabId, operationId, claimToken, claimEpoch, playerLeaseToken, playerFencingEpoch, result
    }) {
        if (assertPlayerFence) {
            await assertPlayerFence({ playFabId, token: playerLeaseToken, epoch: playerFencingEpoch });
        }
        const operationKeys = keys(playFabId, operationId);
        const response = resultArray(await client.sendCommand([
            "EVAL", INBOX_ACK_SCRIPT, "1", operationKeys.operation,
            serverEconomyPocId(claimToken, "claim token", 255),
            String(serverEconomyPocPositive(claimEpoch, "claim epoch")),
            String(now()), JSON.stringify(result)
        ]), "inbox ACK");
        if (response[0] === "stale") serverEconomyPocFail("POC_STALE_INBOX_CLAIM", "Operation inbox ACK was fenced.", { retryable: true });
        return serverEconomyPocReadonly({
            status: response[0],
            ...(typeof response[1] === "string" ? { record: parse(response[1], "inbox record") } : {})
        });
    }

    async function releaseClaim({ playFabId, operationId, claimToken, claimEpoch }) {
        const operationKeys = keys(playFabId, operationId);
        const response = resultArray(await client.sendCommand([
            "EVAL", INBOX_RELEASE_SCRIPT, "1", operationKeys.operation,
            serverEconomyPocId(claimToken, "claim token", 255),
            String(serverEconomyPocPositive(claimEpoch, "claim epoch")), String(now())
        ]), "inbox release");
        if (response[0] === "stale") serverEconomyPocFail("POC_STALE_INBOX_CLAIM", "Operation inbox release was fenced.", { retryable: true });
        return serverEconomyPocReadonly({
            status: response[0],
            ...(typeof response[1] === "string" ? { record: parse(response[1], "inbox record") } : {})
        });
    }

    async function listPlayersWithPending({ limit = 100 } = {}) {
        const maximum = serverEconomyPocPositive(limit, "player scan limit");
        const hashes = await client.sendCommand(["SMEMBERS", playersKey]);
        const result = [];
        for (const playerHash of (Array.isArray(hashes) ? hashes.sort() : [])) {
            if (result.length >= maximum) break;
            const base = `${prefix}player:${playerHash}:`;
            const playerId = await client.sendCommand(["GET", `${base}identity`]);
            const operationKeys = await client.sendCommand(["ZRANGE", `${base}inbox:index`, "0", "-1"]);
            const raw = Array.isArray(operationKeys) && operationKeys.length > 0
                ? await client.sendCommand(["MGET", ...operationKeys]) : [];
            if (typeof playerId === "string" && raw.some((entry) => parse(entry, "inbox record").state !== "Acked")) {
                result.push(playerId);
            }
        }
        return Object.freeze(result);
    }

    return Object.freeze({ submit, get, scanAfter, claim, ack, releaseClaim, listPlayersWithPending,
        durable: true, redisCompatible: true, claimAckFencing: true,
        providerCursorFloorSupported: true,
        atomicSequenceAllocationFence: true,
        sequenceAllocationFenceRequired: requireSequenceAllocationFence === true });
}
