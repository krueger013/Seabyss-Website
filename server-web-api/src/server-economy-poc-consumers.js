import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";
import { createNoopServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";

function safeMetric(metrics, method, ...args) {
    try { metrics[method](...args); } catch {}
}

export function createServerEconomyPocConsumerHub({
    engine,
    metrics = createNoopServerEconomyPocMetrics(),
    monotonicMilliseconds = () => performance.now()
} = {}) {
    if (!engine || typeof engine.processHighValueOperation !== "function" ||
        typeof engine.drainHighValue !== "function" || typeof engine.flushEliteBall !== "function" ||
        typeof engine.appendEliteBallDelta !== "function" || typeof engine.readSnapshot !== "function" ||
        typeof metrics?.increment !== "function" || typeof metrics?.observe !== "function" ||
        typeof monotonicMilliseconds !== "function") {
        throw new TypeError("Server economy POC consumer dependencies are incomplete.");
    }
    const sessions = new Map();
    const sessionEpochs = new Map();

    function currentSession(playFabId, sessionId, sessionEpoch) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const id = serverEconomyPocId(sessionId, "sessionId", 200);
        const epoch = serverEconomyPocPositive(sessionEpoch, "sessionEpoch");
        const current = sessions.get(player);
        if (!current || current.sessionId !== id || current.sessionEpoch !== epoch) {
            serverEconomyPocFail("POC_STALE_ONLINE_SESSION", "Online server session is absent or stale.", { statusCode: 409 });
        }
        return current;
    }

    function registerOnlineSession({ playFabId, sessionId, onSnapshot = async () => {} } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const id = serverEconomyPocId(sessionId, "sessionId", 200);
        if (typeof onSnapshot !== "function") throw new TypeError("Online snapshot observer is required.");
        const sessionEpoch = (sessionEpochs.get(player) || 0) + 1;
        sessionEpochs.set(player, sessionEpoch);
        const record = Object.freeze({ playFabId: player, sessionId: id, sessionEpoch, onSnapshot });
        sessions.set(player, record);
        safeMetric(metrics, "increment", "online_session_registered_total");
        return Object.freeze({ playFabId: player, sessionId: id, sessionEpoch });
    }

    function unregisterOnlineSession({ playFabId, sessionId, sessionEpoch } = {}) {
        const current = currentSession(playFabId, sessionId, sessionEpoch);
        sessions.delete(current.playFabId);
        safeMetric(metrics, "increment", "online_session_unregistered_total");
        return Object.freeze({ status: "unregistered" });
    }

    async function notifyOnline(session, snapshot, source) {
        await session.onSnapshot(serverEconomyPocReadonly(snapshot), Object.freeze({ source }));
        safeMetric(metrics, "increment", "online_snapshot_delivery_total", 1, { source });
    }

    async function consumeHighValue({ playFabId, operationId, preferOnline = true } = {}) {
        const started = monotonicMilliseconds();
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const session = preferOnline ? sessions.get(player) : null;
        const consumer = session ? "online" : "offline";
        const result = await engine.processHighValueOperation({ playFabId: player, operationId, consumer });
        if (session) await notifyOnline(session, result.snapshot, "high_value");
        safeMetric(metrics, "increment", `${consumer}_consume_total`, 1, { domain: "high_value" });
        safeMetric(metrics, "observe", "consumer_duration_ms", Math.max(0, monotonicMilliseconds() - started), { consumer, domain: "high_value" });
        return serverEconomyPocReadonly({ ...result, consumer });
    }

    async function consumePendingPlayer(playFabId, { preferOnline = true, maximumOperations = 100 } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const session = preferOnline ? sessions.get(player) : null;
        const consumer = session ? "online" : "offline";
        const results = await engine.drainHighValue(player, { consumer, maximumOperations });
        if (session && results.length > 0) {
            await notifyOnline(session, results.at(-1).snapshot, "high_value_drain");
        }
        return Object.freeze(results);
    }

    async function appendOnlineEliteBallDelta({
        playFabId, sessionId, sessionEpoch, eventId, delta, reason = "online_combat"
    } = {}) {
        currentSession(playFabId, sessionId, sessionEpoch);
        return engine.appendEliteBallDelta({ playFabId, eventId, delta, reason });
    }

    async function flushOnlineEliteBall({ playFabId, sessionId, sessionEpoch, batchSize } = {}) {
        const session = currentSession(playFabId, sessionId, sessionEpoch);
        const result = await engine.flushEliteBall(playFabId, { batchSize, consumer: "online" });
        await notifyOnline(session, result.snapshot, "elite_ball_flush");
        return result;
    }

    async function offlineTick({ maximumPlayers = 100, maximumOperationsPerPlayer = 100 } = {}) {
        const maximum = serverEconomyPocPositive(maximumPlayers, "maximumPlayers");
        const started = monotonicMilliseconds();
        const highValuePlayers = await engine.stores.operationInbox.listPlayersWithPending({ limit: maximum });
        const walPlayers = await engine.stores.walStore.listPlayersWithPending({ limit: maximum });
        const highValue = [];
        const ammo = [];
        for (const playFabId of highValuePlayers) {
            try {
                highValue.push({ playFabId, results: await consumePendingPlayer(playFabId, {
                    preferOnline: false,
                    maximumOperations: maximumOperationsPerPlayer
                }) });
            } catch (error) {
                highValue.push({ playFabId, error: error?.code || "POC_OFFLINE_CONSUME_FAILED" });
            }
        }
        for (const playFabId of walPlayers) {
            try {
                ammo.push({ playFabId, result: await engine.flushEliteBall(playFabId, { consumer: "offline" }) });
            } catch (error) {
                ammo.push({ playFabId, error: error?.code || "POC_OFFLINE_FLUSH_FAILED" });
            }
        }
        safeMetric(metrics, "increment", "offline_tick_total");
        safeMetric(metrics, "observe", "offline_tick_duration_ms", Math.max(0, monotonicMilliseconds() - started));
        return serverEconomyPocReadonly({ highValue, ammo });
    }

    async function snapshotOnlyLogin(playFabId) {
        const snapshot = await engine.readSnapshot(playFabId);
        safeMetric(metrics, "increment", "snapshot_only_login_total");
        return snapshot;
    }

    return Object.freeze({
        registerOnlineSession,
        unregisterOnlineSession,
        consumeHighValue,
        consumePendingPlayer,
        appendOnlineEliteBallDelta,
        flushOnlineEliteBall,
        offlineTick,
        snapshotOnlyLogin,
        hasOnlineSession: (playFabId) => sessions.has(playFabId)
    });
}

export function createServerEconomyPocBatchService({
    consumerHub,
    intervalMilliseconds = 1000,
    maximumPlayers = 100,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
} = {}) {
    if (typeof consumerHub?.offlineTick !== "function" ||
        typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
        throw new TypeError("Server economy POC batch service dependencies are incomplete.");
    }
    serverEconomyPocPositive(intervalMilliseconds, "batch interval");
    serverEconomyPocPositive(maximumPlayers, "maximumPlayers");
    let running = false;
    let timer = null;
    let activeTick = null;
    let lastResult = null;
    let lastError = null;

    async function tick() {
        if (activeTick) return activeTick;
        activeTick = consumerHub.offlineTick({ maximumPlayers })
            .then((result) => { lastResult = result; lastError = null; return result; })
            .catch((error) => { lastError = error; throw error; })
            .finally(() => { activeTick = null; });
        return activeTick;
    }

    function schedule() {
        if (!running) return;
        timer = setTimeoutImpl(async () => {
            try { await tick(); } catch {}
            schedule();
        }, intervalMilliseconds);
        timer?.unref?.();
    }

    function start() {
        if (running) return Object.freeze({ status: "already_running" });
        running = true;
        schedule();
        return Object.freeze({ status: "started" });
    }

    async function stop() {
        running = false;
        if (timer !== null) clearTimeoutImpl(timer);
        timer = null;
        if (activeTick) await activeTick.catch(() => {});
        return Object.freeze({ status: "stopped" });
    }

    function health() {
        return Object.freeze({
            running,
            intervalMilliseconds,
            maximumPlayers,
            lastResult: lastResult ? "success" : null,
            lastError: lastError?.code || lastError?.name || null
        });
    }

    return Object.freeze({ tick, start, stop, health });
}
