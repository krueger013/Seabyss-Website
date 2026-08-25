import { createHash } from "node:crypto";
import {
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function memoryUniqueStore(conflictCode, identityName) {
    const records = new Map();
    async function claim({ identity, intent }) {
        const id = serverEconomyPocId(identity, identityName, 255);
        const immutableHash = serverEconomyPocDigest(intent);
        const existing = records.get(id);
        if (existing) {
            if (existing.immutableHash !== immutableHash) {
                serverEconomyPocFail(conflictCode, `${identityName} is already bound to another economic intent.`);
            }
            return serverEconomyPocReadonly({ status: "existing", record: existing });
        }
        const record = { identity: id, immutableHash, intent: structuredClone(intent) };
        records.set(id, record);
        return serverEconomyPocReadonly({ status: "claimed", record });
    }
    return Object.freeze({ claim, durable: false, memoryTestOnly: true, atomic: true });
}

export function createMemoryServerEconomyPocProviderTransactionGuard() {
    return memoryUniqueStore("POC_PROVIDER_TRANSACTION_CONFLICT", "providerTransactionId");
}

export function createMemoryServerEconomyPocEventIndex() {
    return memoryUniqueStore("POC_EVENT_IDEMPOTENCY_CONFLICT", "scoped eventId");
}

const CLAIM_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local parsed = cjson.decode(existing)
  if parsed.immutableHash ~= ARGV[1] then return {'conflict', existing} end
  return {'existing', existing}
end
redis.call('SET', KEYS[1], ARGV[2])
return {'claimed', ARGV[2]}
`;

function redisUniqueStore({ redis, prefix, family, conflictCode, identityName }) {
    if (typeof redis?.sendCommand !== "function") throw new TypeError("Redis sendCommand is required.");
    const key = (identity) => {
        const id = serverEconomyPocId(identity, identityName, 255);
        const hash = createHash("sha256").update(id, "utf8").digest("hex");
        return `${prefix}${family}:{${hash}}`;
    };
    async function claim({ identity, intent }) {
        const id = serverEconomyPocId(identity, identityName, 255);
        const immutableHash = serverEconomyPocDigest(intent);
        const record = { identity: id, immutableHash, intent };
        const result = await redis.sendCommand([
            "EVAL", CLAIM_SCRIPT, "1", key(id), immutableHash, JSON.stringify(record)
        ]);
        if (result?.[0] === "conflict") {
            serverEconomyPocFail(conflictCode, `${identityName} is already bound to another economic intent.`);
        }
        return serverEconomyPocReadonly({
            status: result[0],
            record: JSON.parse(result[1])
        });
    }
    return Object.freeze({
        claim,
        durable: true,
        redisCompatible: true,
        atomic: true,
        redisClusterHashTagged: true
    });
}

export function createRedisServerEconomyPocProviderTransactionGuard({
    redis,
    prefix = "server:economy:poc:v1:"
} = {}) {
    return redisUniqueStore({
        redis,
        prefix,
        family: "provider-transaction",
        conflictCode: "POC_PROVIDER_TRANSACTION_CONFLICT",
        identityName: "providerTransactionId"
    });
}

export function createRedisServerEconomyPocEventIndex({
    redis,
    prefix = "server:economy:poc:v1:"
} = {}) {
    return redisUniqueStore({
        redis,
        prefix,
        family: "event-index",
        conflictCode: "POC_EVENT_IDEMPOTENCY_CONFLICT",
        identityName: "scoped eventId"
    });
}
