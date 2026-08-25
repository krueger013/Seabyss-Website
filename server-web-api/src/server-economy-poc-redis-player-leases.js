import { createHash } from "node:crypto";
import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const LEASE_SCHEMA_VERSION = 1;
const MINIMUM_TTL_MILLISECONDS = 1_000;
const MAXIMUM_TTL_MILLISECONDS = 300_000;
const LEASE_FIELDS = Object.freeze([
    "acquiredAtUnixMs",
    "epoch",
    "expiresAtUnixMs",
    "owner",
    "playFabId",
    "schemaVersion",
    "tokenDigest"
]);

const LUA_COMMON = `
local function now_milliseconds()
  local current = redis.call('TIME')
  return tonumber(current[1]) * 1000 + math.floor(tonumber(current[2]) / 1000)
end

local function decode_lease(raw, expected_player)
  local ok, lease = pcall(cjson.decode, raw)
  if not ok or type(lease) ~= 'table' then return nil end
  local allowed = {
    acquiredAtUnixMs=true, epoch=true, expiresAtUnixMs=true, owner=true,
    playFabId=true, schemaVersion=true, tokenDigest=true
  }
  local count = 0
  for key, _ in pairs(lease) do
    if not allowed[key] then return nil end
    count = count + 1
  end
  if count ~= 7 or lease.schemaVersion ~= 1 or lease.playFabId ~= expected_player or
     type(lease.owner) ~= 'string' or string.len(lease.owner) == 0 or
     type(lease.tokenDigest) ~= 'string' or string.len(lease.tokenDigest) ~= 64 or
     not string.match(lease.tokenDigest, '^[0-9a-f]+$') or
     type(lease.epoch) ~= 'number' or lease.epoch <= 0 or lease.epoch ~= math.floor(lease.epoch) or
     type(lease.acquiredAtUnixMs) ~= 'number' or lease.acquiredAtUnixMs < 0 or
     lease.acquiredAtUnixMs ~= math.floor(lease.acquiredAtUnixMs) or
     type(lease.expiresAtUnixMs) ~= 'number' or
     lease.expiresAtUnixMs <= lease.acquiredAtUnixMs or
     lease.expiresAtUnixMs ~= math.floor(lease.expiresAtUnixMs) then
    return nil
  end
  return lease
end
`;

const ACQUIRE_SCRIPT = `-- SERVER_ECONOMY_POC_PLAYER_LEASE_ACQUIRE_V1
${LUA_COMMON}
local raw = redis.call('GET', KEYS[1])
local now = now_milliseconds()
if raw then
  local lease = decode_lease(raw, ARGV[1])
  if not lease then return {'corrupt', ''} end
  if redis.call('PTTL', KEYS[1]) <= 0 then return {'corrupt', ''} end
  if lease.expiresAtUnixMs > now then
    if lease.tokenDigest == ARGV[3] then
      if lease.owner ~= ARGV[2] then return {'corrupt', ''} end
      return {'acquired', raw}
    end
    return {'busy', raw}
  end
end
local current_epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
local minimum_epoch_exclusive = tonumber(ARGV[5])
if current_epoch < minimum_epoch_exclusive then
  redis.call('SET', KEYS[2], tostring(minimum_epoch_exclusive))
end
local epoch = redis.call('INCR', KEYS[2])
local lease = {
  schemaVersion=1,
  playFabId=ARGV[1],
  owner=ARGV[2],
  tokenDigest=ARGV[3],
  epoch=epoch,
  acquiredAtUnixMs=now,
  expiresAtUnixMs=now + tonumber(ARGV[4])
}
local serialized = cjson.encode(lease)
redis.call('SET', KEYS[1], serialized, 'PX', ARGV[4])
return {'acquired', serialized}
`;

const RENEW_SCRIPT = `-- SERVER_ECONOMY_POC_PLAYER_LEASE_RENEW_V1
${LUA_COMMON}
local raw = redis.call('GET', KEYS[1])
if not raw then return {'stale', ''} end
local lease = decode_lease(raw, ARGV[1])
if not lease then return {'corrupt', ''} end
local now = now_milliseconds()
if lease.tokenDigest ~= ARGV[2] or tonumber(lease.epoch) ~= tonumber(ARGV[3]) or
   lease.expiresAtUnixMs <= now or redis.call('PTTL', KEYS[1]) <= 0 then
  return {'stale', raw}
end
lease.expiresAtUnixMs = now + tonumber(ARGV[4])
local serialized = cjson.encode(lease)
redis.call('SET', KEYS[1], serialized, 'PX', ARGV[4])
return {'renewed', serialized}
`;

const ASSERT_CURRENT_SCRIPT = `-- SERVER_ECONOMY_POC_PLAYER_LEASE_ASSERT_CURRENT_V1
${LUA_COMMON}
local raw = redis.call('GET', KEYS[1])
if not raw then return {'stale', ''} end
local lease = decode_lease(raw, ARGV[1])
if not lease then return {'corrupt', ''} end
local now = now_milliseconds()
if lease.tokenDigest ~= ARGV[2] or tonumber(lease.epoch) ~= tonumber(ARGV[3]) or
   lease.expiresAtUnixMs <= now or redis.call('PTTL', KEYS[1]) <= 0 then
  return {'stale', raw}
end
return {'current', raw}
`;

const RELEASE_SCRIPT = `-- SERVER_ECONOMY_POC_PLAYER_LEASE_RELEASE_V1
${LUA_COMMON}
local raw = redis.call('GET', KEYS[1])
if not raw then return {'stale', ''} end
local lease = decode_lease(raw, ARGV[1])
if not lease then return {'corrupt', ''} end
local now = now_milliseconds()
if lease.tokenDigest ~= ARGV[2] or tonumber(lease.epoch) ~= tonumber(ARGV[3]) or
   lease.expiresAtUnixMs <= now or redis.call('PTTL', KEYS[1]) <= 0 then
  return {'stale', raw}
end
redis.call('DEL', KEYS[1])
return {'released', raw}
`;

const INSPECT_SCRIPT = `-- SERVER_ECONOMY_POC_PLAYER_LEASE_INSPECT_V1
${LUA_COMMON}
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing', ''} end
local lease = decode_lease(raw, ARGV[1])
if not lease then return {'corrupt', ''} end
local now = now_milliseconds()
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then return {'corrupt', ''} end
if lease.expiresAtUnixMs <= now or ttl <= 0 then return {'missing', ''} end
return {'found', raw}
`;

function tokenDigest(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

function validatedPrefix(value) {
    const prefix = serverEconomyPocId(value, "Redis player lease prefix", 160);
    if (/[{}]/u.test(prefix)) {
        throw new TypeError("Redis player lease prefix cannot contain a cluster hash tag.");
    }
    return prefix;
}

function ttlMilliseconds(value) {
    const ttl = serverEconomyPocPositive(value, "lease TTL");
    if (ttl < MINIMUM_TTL_MILLISECONDS || ttl > MAXIMUM_TTL_MILLISECONDS) {
        throw new TypeError("Player lease TTL is outside its safe range.");
    }
    return ttl;
}

function parseScriptResult(value, operation) {
    if (!Array.isArray(value) || typeof value[0] !== "string" ||
        value.length < 1 || value.length > 2 ||
        value.length === 2 && typeof value[1] !== "string") {
        serverEconomyPocFail(
            "POC_REDIS_LEASE_PROTOCOL",
            `Redis player lease ${operation} returned an invalid response.`,
            { retryable: true }
        );
    }
    if (value[0] === "corrupt") {
        serverEconomyPocFail(
            "POC_REDIS_LEASE_CORRUPT",
            "Redis player lease contains corrupt or mismatched state."
        );
    }
    return { status: value[0], raw: value[1] || null };
}

function parseStoredLease(raw) {
    let lease;
    try {
        lease = JSON.parse(raw);
    } catch {
        serverEconomyPocFail("POC_REDIS_LEASE_CORRUPT", "Redis player lease is invalid JSON.");
    }
    if (!lease || typeof lease !== "object" || Array.isArray(lease) ||
        JSON.stringify(Object.keys(lease).sort()) !== JSON.stringify(LEASE_FIELDS) ||
        lease.schemaVersion !== LEASE_SCHEMA_VERSION ||
        typeof lease.tokenDigest !== "string" || !/^[a-f0-9]{64}$/u.test(lease.tokenDigest)) {
        serverEconomyPocFail("POC_REDIS_LEASE_CORRUPT", "Redis player lease has an invalid schema.");
    }
    serverEconomyPocId(lease.playFabId, "stored lease playFabId", 160);
    serverEconomyPocId(lease.owner, "stored lease owner", 160);
    serverEconomyPocPositive(lease.epoch, "stored lease epoch");
    serverEconomyPocNonNegative(lease.acquiredAtUnixMs, "stored lease acquisition time");
    serverEconomyPocPositive(lease.expiresAtUnixMs, "stored lease expiration time");
    if (lease.expiresAtUnixMs <= lease.acquiredAtUnixMs) {
        serverEconomyPocFail("POC_REDIS_LEASE_CORRUPT", "Redis player lease expiration is invalid.");
    }
    return serverEconomyPocReadonly(lease);
}

function runtimeLease(stored, token) {
    return serverEconomyPocReadonly({
        playFabId: stored.playFabId,
        owner: stored.owner,
        token,
        epoch: stored.epoch,
        acquiredAtUnixMs: stored.acquiredAtUnixMs,
        expiresAtUnixMs: stored.expiresAtUnixMs
    });
}

function assertStoredOwnership(stored, {
    playFabId,
    owner = null,
    token = null,
    epoch = null
}) {
    if (stored.playFabId !== playFabId ||
        owner !== null && stored.owner !== owner ||
        token !== null && stored.tokenDigest !== tokenDigest(token) ||
        epoch !== null && stored.epoch !== epoch) {
        serverEconomyPocFail(
            "POC_REDIS_LEASE_CORRUPT",
            "Redis player lease response does not match the requested owner, token, or epoch."
        );
    }
    return stored;
}

function staleWriter() {
    serverEconomyPocFail(
        "POC_STALE_WRITER",
        "Player lease is absent, expired, or fenced.",
        { retryable: true, statusCode: 409 }
    );
}

export function createRedisServerEconomyPocPlayerLeases({
    redis,
    prefix = "server:economy:poc:v1:"
} = {}) {
    if (!redis || typeof redis.sendCommand !== "function") {
        throw new TypeError("Redis player leases require client.sendCommand.");
    }
    const root = validatedPrefix(prefix);

    function keys(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const playerHash = createHash("sha256").update(player, "utf8").digest("hex");
        const base = `${root}{${playerHash}}:`;
        return Object.freeze({
            player,
            lease: `${base}player-lease`,
            epoch: `${base}player-lease-epoch`
        });
    }

    async function evaluate(script, redisKeys, args, operation) {
        let result;
        try {
            result = await redis.sendCommand([
                "EVAL", script, String(redisKeys.length), ...redisKeys, ...args
            ]);
        } catch (error) {
            const failure = new Error(`Redis player lease ${operation} is unavailable.`);
            failure.code = "POC_REDIS_LEASE_UNAVAILABLE";
            failure.retryable = true;
            failure.cause = error;
            throw failure;
        }
        return parseScriptResult(result, operation);
    }

    async function acquire({
        playFabId,
        owner,
        token,
        ttlMilliseconds: requestedTtl,
        minimumEpochExclusive = 0
    } = {}) {
        const playerKeys = keys(playFabId);
        const leaseOwner = serverEconomyPocId(owner, "lease owner", 160);
        const leaseToken = serverEconomyPocId(token, "lease token", 255);
        const ttl = ttlMilliseconds(requestedTtl);
        const epochFloor = serverEconomyPocNonNegative(
            minimumEpochExclusive,
            "minimum fencing epoch"
        );
        const result = await evaluate(
            ACQUIRE_SCRIPT,
            [playerKeys.lease, playerKeys.epoch],
            [
                playerKeys.player,
                leaseOwner,
                tokenDigest(leaseToken),
                String(ttl),
                String(epochFloor)
            ],
            "acquire"
        );
        if (!result.raw || !["acquired", "busy"].includes(result.status)) {
            serverEconomyPocFail("POC_REDIS_LEASE_PROTOCOL", "Redis player lease acquire returned an unknown status.", { retryable: true });
        }
        const stored = assertStoredOwnership(parseStoredLease(result.raw), {
            playFabId: playerKeys.player,
            ...(result.status === "acquired" ? { owner: leaseOwner, token: leaseToken } : {})
        });
        return serverEconomyPocReadonly({
            status: result.status,
            lease: result.status === "acquired" ? runtimeLease(stored, leaseToken) : stored
        });
    }

    async function renew({ playFabId, token, epoch, ttlMilliseconds: requestedTtl } = {}) {
        const playerKeys = keys(playFabId);
        const leaseToken = serverEconomyPocId(token, "lease token", 255);
        const fencingEpoch = serverEconomyPocPositive(epoch, "fencing epoch");
        const ttl = ttlMilliseconds(requestedTtl);
        const result = await evaluate(
            RENEW_SCRIPT,
            [playerKeys.lease],
            [playerKeys.player, tokenDigest(leaseToken), String(fencingEpoch), String(ttl)],
            "renew"
        );
        if (result.status === "stale") staleWriter();
        if (result.status !== "renewed" || !result.raw) {
            serverEconomyPocFail("POC_REDIS_LEASE_PROTOCOL", "Redis player lease renew returned an unknown status.", { retryable: true });
        }
        const stored = parseStoredLease(result.raw);
        assertStoredOwnership(stored, {
            playFabId: playerKeys.player,
            token: leaseToken,
            epoch: fencingEpoch
        });
        return serverEconomyPocReadonly({ status: "renewed", lease: runtimeLease(stored, leaseToken) });
    }

    async function assertCurrent({ playFabId, token, epoch } = {}) {
        const playerKeys = keys(playFabId);
        const leaseToken = serverEconomyPocId(token, "lease token", 255);
        const fencingEpoch = serverEconomyPocPositive(epoch, "fencing epoch");
        const result = await evaluate(
            ASSERT_CURRENT_SCRIPT,
            [playerKeys.lease],
            [playerKeys.player, tokenDigest(leaseToken), String(fencingEpoch)],
            "assertCurrent"
        );
        if (result.status === "stale") staleWriter();
        if (result.status !== "current" || !result.raw) {
            serverEconomyPocFail("POC_REDIS_LEASE_PROTOCOL", "Redis player lease assertion returned an unknown status.", { retryable: true });
        }
        const stored = assertStoredOwnership(parseStoredLease(result.raw), {
            playFabId: playerKeys.player,
            token: leaseToken,
            epoch: fencingEpoch
        });
        return serverEconomyPocReadonly({ status: "current", lease: stored });
    }

    async function release({ playFabId, token, epoch } = {}) {
        const playerKeys = keys(playFabId);
        const leaseToken = serverEconomyPocId(token, "lease token", 255);
        const fencingEpoch = serverEconomyPocPositive(epoch, "fencing epoch");
        const result = await evaluate(
            RELEASE_SCRIPT,
            [playerKeys.lease],
            [playerKeys.player, tokenDigest(leaseToken), String(fencingEpoch)],
            "release"
        );
        if (result.status === "stale") return Object.freeze({ status: "stale" });
        if (result.status !== "released" || !result.raw) {
            serverEconomyPocFail("POC_REDIS_LEASE_PROTOCOL", "Redis player lease release returned an unknown status.", { retryable: true });
        }
        const stored = assertStoredOwnership(parseStoredLease(result.raw), {
            playFabId: playerKeys.player,
            token: leaseToken,
            epoch: fencingEpoch
        });
        return serverEconomyPocReadonly({ status: "released", lease: stored });
    }

    async function inspect(playFabId) {
        const playerKeys = keys(playFabId);
        const result = await evaluate(
            INSPECT_SCRIPT,
            [playerKeys.lease],
            [playerKeys.player],
            "inspect"
        );
        if (["missing", "stale"].includes(result.status)) return null;
        if (result.status !== "found" || !result.raw) {
            serverEconomyPocFail("POC_REDIS_LEASE_PROTOCOL", "Redis player lease inspect returned an unknown status.", { retryable: true });
        }
        return parseStoredLease(result.raw);
    }

    return Object.freeze({
        acquire,
        renew,
        assertCurrent,
        release,
        inspect,
        durable: true,
        redisCompatible: true,
        atomicLua: true,
        persistentFencingEpoch: true,
        leaseKeyHasTtl: true,
        storesRawToken: false,
        clusterHashTaggedKeys: true
    });
}

export const SERVER_ECONOMY_POC_REDIS_PLAYER_LEASE_SCRIPTS = Object.freeze({
    acquire: ACQUIRE_SCRIPT,
    renew: RENEW_SCRIPT,
    assertCurrent: ASSERT_CURRENT_SCRIPT,
    release: RELEASE_SCRIPT,
    inspect: INSPECT_SCRIPT
});
