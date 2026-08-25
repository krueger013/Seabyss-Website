import { createFinancialShadowPocInboxAdapter } from "./financial-shadow-poc-inbox-adapter.js";
import { serverEconomyPocFail, serverEconomyPocPositive, serverEconomyPocReadonly } from "./server-economy-poc-model.js";
const DEFERRED_PLAYER_CODES = Object.freeze(new Set([
    "FINANCIAL_SHADOW_EXTERNAL_PLAYER_OFFLINE",
    "FINANCIAL_SHADOW_BOOTSTRAP_REQUIRED"
]));

/**
 * Persistent scheduler for the dedicated canonical-POC Shadow mirror inbox.
 * The supplied inbox must be durable and explicitly projection-only. The
 * service therefore cannot consume or ACK the authoritative financial inbox.
 */
export function createFinancialShadowPocInboxService({
    operationInbox,
    runtime,
    serverId,
    intervalMilliseconds = 2000,
    maximumPlayersPerTick = 50,
    maximumOperationsPerPlayer = 20,
    hooks = {},
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval
} = {}) {
    if (operationInbox?.durable !== true || operationInbox?.shadowProjectionOnly !== true ||
        typeof operationInbox.listPlayersWithPending !== "function") {
        throw new TypeError("Financial Shadow POC service requires a durable projection-only mirror inbox.");
    }
    if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
        throw new TypeError("Financial Shadow POC service scheduler dependencies are invalid.");
    }
    const interval = serverEconomyPocPositive(intervalMilliseconds, "Shadow POC mirror interval");
    const playerLimit = serverEconomyPocPositive(maximumPlayersPerTick, "Shadow POC mirror player limit");
    const operationLimit = serverEconomyPocPositive(maximumOperationsPerPlayer, "Shadow POC mirror operation limit");
    if (interval < 250 || interval > 60_000 || playerLimit > 1000 || operationLimit > 100) {
        throw new TypeError("Financial Shadow POC service bounds are unsafe.");
    }
    const adapter = createFinancialShadowPocInboxAdapter({ operationInbox, runtime, serverId, hooks });
    let timer = null;
    let activeTick = null;
    let lastSuccessAtUnixMs = null;
    let lastFailureAtUnixMs = null;
    let lastErrorCode = null;
    let loopSuccessCount = 0;
    let loopFailureCount = 0;
    let projectedCount = 0;
    let deferredPlayerCount = 0;

    async function runTick() {
        if (activeTick) return activeTick;
        activeTick = (async () => {
            const players = await operationInbox.listPlayersWithPending({ limit: playerLimit });
            for (const playFabId of players) {
                for (let index = 0; index < operationLimit; index += 1) {
                    let outcome;
                    try {
                        outcome = await adapter.consumeNext(playFabId);
                    } catch (error) {
                        if (!DEFERRED_PLAYER_CODES.has(error?.code)) throw error;
                        deferredPlayerCount += 1;
                        hooks.onPlayerDeferred?.({ playFabId, errorCode: error.code });
                        break;
                    }
                    if (outcome.status === "empty") break;
                    if (outcome.status === "projected_and_acked") projectedCount += 1;
                    if (outcome.status === "already_acked") continue;
                }
            }
            loopSuccessCount += 1;
            lastSuccessAtUnixMs = Date.now();
            lastErrorCode = null;
            return serverEconomyPocReadonly({
                status: "ok", playerCount: players.length,
                projectedCount, deferredPlayerCount
            });
        })().catch((error) => {
            loopFailureCount += 1;
            lastFailureAtUnixMs = Date.now();
            lastErrorCode = error?.code || "FINANCIAL_SHADOW_POC_LOOP_FAILED";
            hooks.onLoopError?.(error);
            throw error;
        }).finally(() => { activeTick = null; });
        return activeTick;
    }

    function start() {
        if (timer) return Object.freeze({ status: "already_started" });
        timer = setIntervalImpl(() => { void runTick().catch(() => {}); }, interval);
        timer?.unref?.();
        return Object.freeze({ status: "started" });
    }

    async function stop() {
        if (timer) clearIntervalImpl(timer);
        timer = null;
        await activeTick?.catch(() => {});
        return Object.freeze({ status: "stopped" });
    }

    async function enqueueCanonicalProjection(operation) {
        const result = await adapter.enqueueCanonicalProjection(operation);
        void runTick().catch(() => {});
        return result;
    }

    function health() {
        return serverEconomyPocReadonly({
            healthy: timer !== null && lastErrorCode === null,
            running: timer !== null,
            durable: true,
            projectionOnly: true,
            authoritativeInboxAcknowledged: false,
            lastSuccessAtUnixMs,
            lastFailureAtUnixMs,
            lastErrorCode,
            loopSuccessCount,
            loopFailureCount,
            projectedCount,
            deferredPlayerCount
        });
    }

    async function drainOnce() {
        if (timer === null) {
            serverEconomyPocFail("FINANCIAL_SHADOW_POC_SERVICE_STOPPED", "Shadow POC mirror service is stopped.", { retryable: true });
        }
        return runTick();
    }

    return Object.freeze({
        start,
        stop,
        drainOnce,
        enqueueCanonicalProjection,
        health,
        adapter,
        authoritative: false,
        grantsRewards: false,
        acknowledgesAuthoritativeInbox: false
    });
}
