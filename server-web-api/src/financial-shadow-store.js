import { createHash } from "node:crypto";
import { serverEconomyPocClone, serverEconomyPocFail, serverEconomyPocId, serverEconomyPocReadonly } from "./server-economy-poc-model.js";

const REDIS_CAS_SCRIPT = `-- FINANCIAL_SHADOW_STATE_CAS_V1
local raw = redis.call('GET', KEYS[1])
local expected = tonumber(ARGV[1])
local current = -1
if raw then
  local decoded = cjson.decode(raw)
  current = tonumber(decoded.stateVersion)
end
if current ~= expected then return {'conflict', raw or ''} end
redis.call('SET', KEYS[1], ARGV[2])
return {'updated', ARGV[2]}
`;

function parse(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw !== "string") serverEconomyPocFail("FINANCIAL_SHADOW_STORE_PROTOCOL", "Shadow store returned non-text state.");
    try { return JSON.parse(raw); } catch {
        serverEconomyPocFail("FINANCIAL_SHADOW_STORE_CORRUPT", "Shadow store contains invalid JSON.");
    }
}

function validateCasInput({ playFabId, expectedStateVersion, nextState }) {
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < -1 ||
        !nextState || typeof nextState !== "object" || Array.isArray(nextState) ||
        nextState.playFabId !== player || nextState.stateVersion !== expectedStateVersion + 1) {
        throw new TypeError("Financial Shadow CAS input is invalid.");
    }
    return player;
}

export function createMemoryFinancialShadowStateStore({ initialStates = [] } = {}) {
    const values = new Map();
    for (const state of initialStates) {
        const player = serverEconomyPocId(state?.playFabId, "playFabId", 160);
        values.set(player, JSON.stringify(state));
    }
    async function read(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        return serverEconomyPocReadonly(parse(values.get(player) ?? null));
    }
    async function compareAndSet(input) {
        const player = validateCasInput(input);
        const current = parse(values.get(player) ?? null);
        const currentVersion = current?.stateVersion ?? -1;
        if (currentVersion !== input.expectedStateVersion) {
            return serverEconomyPocReadonly({ status: "version_conflict", state: current });
        }
        values.set(player, JSON.stringify(input.nextState));
        return serverEconomyPocReadonly({ status: "updated", state: input.nextState });
    }
    async function ping() { return true; }
    function exportStates() { return [...values.values()].map((raw) => JSON.parse(raw)); }
    return Object.freeze({ read, compareAndSet, ping, exportStates, durable: false, atomicCas: true, provider: "memory_test" });
}

export function financialShadowRedisKey(prefix, playFabId) {
    const normalizedPrefix = serverEconomyPocId(prefix, "Financial Shadow Redis prefix", 160);
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    const digest = createHash("sha256").update(player, "utf8").digest("hex");
    return `${normalizedPrefix}{${digest}}:state`;
}

export function createRedisFinancialShadowStateStore({
    redisClient,
    prefix = "seabyss:financial:shadow:v1:"
} = {}) {
    if (!redisClient || typeof redisClient.get !== "function" ||
        typeof redisClient.eval !== "function" || typeof redisClient.ping !== "function") {
        throw new TypeError("Financial Shadow Redis store requires get/eval/ping.");
    }
    serverEconomyPocId(prefix, "Financial Shadow Redis prefix", 160);
    async function read(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        return serverEconomyPocReadonly(parse(await redisClient.get(financialShadowRedisKey(prefix, player))));
    }
    async function compareAndSet(input) {
        const player = validateCasInput(input);
        const nextRaw = JSON.stringify(input.nextState);
        const result = await redisClient.eval(REDIS_CAS_SCRIPT, {
            keys: [financialShadowRedisKey(prefix, player)],
            arguments: [String(input.expectedStateVersion), nextRaw]
        });
        if (!Array.isArray(result) || !["updated", "conflict"].includes(result[0])) {
            serverEconomyPocFail("FINANCIAL_SHADOW_STORE_PROTOCOL", "Shadow Redis CAS returned an invalid result.", { retryable: true });
        }
        const state = serverEconomyPocReadonly(parse(result[1]));
        return serverEconomyPocReadonly({
            status: result[0] === "updated" ? "updated" : "version_conflict",
            state
        });
    }
    async function ping() { return (await redisClient.ping()) === "PONG"; }
    return Object.freeze({
        read,
        compareAndSet,
        ping,
        durable: true,
        redisCompatible: true,
        atomicCas: true,
        clusterHashTaggedKeys: true,
        provider: "redis",
        prefix
    });
}

export const FINANCIAL_SHADOW_REDIS_SCRIPTS = Object.freeze({ stateCas: REDIS_CAS_SCRIPT });
