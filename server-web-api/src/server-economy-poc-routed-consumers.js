import {
    createServerEconomyPocBatchService,
    createServerEconomyPocConsumerHub
} from "./server-economy-poc-consumers.js";
import { createNoopServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";
import {
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function safeMetric(metrics, method, ...args) {
    try { metrics[method](...args); } catch {}
}

/**
 * Scheduler-facing consumer hub. Pending high-value work is always routed via
 * the same inbox and a registered online session is notified immediately.
 * Ammo for an online-owned session is deliberately left for that session's
 * flush, avoiding a silent offline consume while the player is active.
 */
export function createRoutedServerEconomyPocConsumerHub({
    engine,
    metrics = createNoopServerEconomyPocMetrics(),
    monotonicMilliseconds = () => performance.now()
} = {}) {
    const base = createServerEconomyPocConsumerHub({ engine, metrics, monotonicMilliseconds });

    async function offlineTick({ maximumPlayers = 100, maximumOperationsPerPlayer = 100 } = {}) {
        const maximum = serverEconomyPocPositive(maximumPlayers, "maximumPlayers");
        const started = monotonicMilliseconds();
        const highValuePlayers = await engine.stores.operationInbox.listPlayersWithPending({ limit: maximum });
        const walPlayers = await engine.stores.walStore.listPlayersWithPending({ limit: maximum });
        const highValue = [];
        const ammo = [];

        for (const playFabId of highValuePlayers) {
            try {
                const online = base.hasOnlineSession(playFabId);
                highValue.push({
                    playFabId,
                    consumer: online ? "online" : "offline",
                    results: await base.consumePendingPlayer(playFabId, {
                        preferOnline: true,
                        maximumOperations: maximumOperationsPerPlayer
                    })
                });
            } catch (error) {
                highValue.push({ playFabId, error: error?.code || "POC_SCHEDULED_CONSUME_FAILED" });
            }
        }

        for (const playFabId of walPlayers) {
            if (base.hasOnlineSession(playFabId)) {
                ammo.push({ playFabId, status: "online_owned", consumer: "online" });
                continue;
            }
            try {
                ammo.push({
                    playFabId,
                    consumer: "offline",
                    result: await engine.flushEliteBall(playFabId, { consumer: "offline" })
                });
            } catch (error) {
                ammo.push({ playFabId, error: error?.code || "POC_SCHEDULED_FLUSH_FAILED" });
            }
        }

        safeMetric(metrics, "increment", "routed_scheduler_tick_total");
        safeMetric(metrics, "observe", "routed_scheduler_tick_duration_ms",
            Math.max(0, monotonicMilliseconds() - started));
        return serverEconomyPocReadonly({ highValue, ammo });
    }

    return Object.freeze({
        ...base,
        offlineTick,
        routingPolicy: Object.freeze({
            highValue: "registered_online_else_offline",
            onlineAmmo: "online_session_owned"
        })
    });
}

export function createRoutedServerEconomyPocBatchService(options = {}) {
    return createServerEconomyPocBatchService(options);
}
