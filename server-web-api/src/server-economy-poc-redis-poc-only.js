import {
    createRedisCompatibleServerEconomyPocOperationInbox,
    createRedisCompatibleServerEconomyPocWalStore
} from "./server-economy-poc-redis-stores.js";

function requireFence(value) {
    if (typeof value !== "function") {
        throw new TypeError("Redis POC stores require assertPlayerFence.");
    }
    return value;
}

/**
 * Standalone Redis durability adapter for local POC testing only.
 *
 * Fencing is asserted before WAL and inbox ACK. The assertion and the Redis
 * mutation are separate operations, so this adapter deliberately advertises
 * that it is NOT an atomic production fencing boundary. The original key
 * layout also has no Redis Cluster hash tags; use only a single-node mock or
 * standalone Redis. PlayFab/entity snapshot CAS remains the durable authority.
 */
export function createFencedStandaloneRedisServerEconomyPocWalStore({
    redis,
    prefix,
    assertPlayerFence
} = {}) {
    const assertFence = requireFence(assertPlayerFence);
    const base = createRedisCompatibleServerEconomyPocWalStore({ redis, prefix });
    return Object.freeze({
        ...base,
        async ackThrough(input) {
            await assertFence({
                playFabId: input.playFabId,
                token: input.leaseToken,
                epoch: input.fencingEpoch
            });
            return base.ackThrough(input);
        },
        pocOnly: true,
        standaloneRedisOnly: true,
        redisClusterCompatible: false,
        atomicPlayerFencing: false,
        ackFenceChecked: true
    });
}

export function createFencedStandaloneRedisServerEconomyPocOperationInbox({
    redis,
    prefix,
    nowMilliseconds,
    assertPlayerFence
} = {}) {
    const assertFence = requireFence(assertPlayerFence);
    const base = createRedisCompatibleServerEconomyPocOperationInbox({
        redis,
        prefix,
        nowMilliseconds,
        assertPlayerFence: assertFence
    });
    return Object.freeze({
        ...base,
        pocOnly: true,
        standaloneRedisOnly: true,
        redisClusterCompatible: false,
        atomicPlayerFencing: false,
        ackFenceChecked: true
    });
}

export const SERVER_ECONOMY_POC_REDIS_SAFETY = Object.freeze({
    productionReady: false,
    reason: "fence assertion and Redis ACK are not one atomic provider transaction",
    redisClusterCompatible: false,
    canonicalSnapshotAuthority: "PlayFab Entity Object ExpectedProfileVersion CAS"
});
