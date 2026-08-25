import { createServerEconomyPocBatchService } from "./server-economy-poc-consumers.js";
import { createNoopServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";
import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function safeMetric(metrics, method, ...args) {
    try { metrics[method](...args); } catch {}
}

export function createServerEconomyPocOnlineHandshakeConsumerHub({
    engine,
    metrics = createNoopServerEconomyPocMetrics(),
    monotonicMilliseconds = () => performance.now()
} = {}) {
    if (!engine || typeof engine.processHighValueOperation !== "function" ||
        typeof engine.processNextHighValue !== "function" || typeof engine.flushEliteBall !== "function") {
        throw new TypeError("Online handshake consumer engine is incomplete.");
    }
    const sessions = new Map();
    const sessionEpochs = new Map();

    function current(playFabId, sessionId, sessionEpoch) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const record = sessions.get(player);
        if (!record || record.sessionId !== sessionId || record.sessionEpoch !== sessionEpoch) {
            serverEconomyPocFail("POC_STALE_ONLINE_SESSION", "Online session is absent or stale.", { statusCode: 409 });
        }
        return record;
    }

    function registerOnlineSession({
        playFabId,
        sessionId,
        beforeAuthoritativeMutation,
        onSnapshot,
        afterAuthoritativeMutation = async () => {}
    } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const id = serverEconomyPocId(sessionId, "sessionId", 200);
        if (typeof beforeAuthoritativeMutation !== "function" || typeof onSnapshot !== "function" ||
            typeof afterAuthoritativeMutation !== "function") {
            throw new TypeError("Online financial handshake callbacks are required.");
        }
        const sessionEpoch = (sessionEpochs.get(player) || 0) + 1;
        sessionEpochs.set(player, sessionEpoch);
        sessions.set(player, Object.freeze({
            playFabId: player,
            sessionId: id,
            sessionEpoch,
            beforeAuthoritativeMutation,
            onSnapshot,
            afterAuthoritativeMutation
        }));
        return Object.freeze({ playFabId: player, sessionId: id, sessionEpoch });
    }

    function unregisterOnlineSession({ playFabId, sessionId, sessionEpoch } = {}) {
        const session = current(playFabId, sessionId, sessionEpoch);
        sessions.delete(session.playFabId);
        return Object.freeze({ status: "unregistered" });
    }

    async function flushAllAmmo(playFabId, consumer) {
        const results = [];
        for (;;) {
            const flushed = await engine.flushEliteBall(playFabId, { consumer });
            if (flushed.status === "empty") break;
            results.push(flushed);
        }
        return Object.freeze(results);
    }

    async function beginHandshake(session, operationId, markStarted) {
        markStarted();
        const response = await session.beforeAuthoritativeMutation(Object.freeze({
            playFabId: session.playFabId,
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
            operationId,
            action: "pause_and_drain_financial_hot_state"
        }));
        if (response?.acknowledged !== true || response.hotStateDrained !== true) {
            serverEconomyPocFail("POC_ONLINE_HANDSHAKE_REJECTED", "Online server did not drain and pause financial hot state.", { retryable: true, statusCode: 409 });
        }
        const ammo = await flushAllAmmo(session.playFabId, "online_handshake");
        safeMetric(metrics, "increment", "online_handshake_total");
        return ammo;
    }

    async function finishHandshake(session, snapshot, operationId, source, markResumed) {
        let delivered = false;
        try {
            await session.onSnapshot(serverEconomyPocReadonly(snapshot), Object.freeze({
                source,
                operationId,
                sessionEpoch: session.sessionEpoch
            }));
            delivered = true;
            safeMetric(metrics, "increment", "online_snapshot_delivery_total", 1, { source });
        } finally {
            try {
                await session.afterAuthoritativeMutation(Object.freeze({
                    playFabId: session.playFabId,
                    sessionId: session.sessionId,
                    sessionEpoch: session.sessionEpoch,
                    operationId,
                    action: delivered ? "resume_from_canonical_snapshot" : "abort_and_resume",
                    outcome: delivered ? "committed" : "snapshot_delivery_failed",
                    revision: snapshot.revision,
                    requiresSnapshotReload: !delivered
                }));
            } finally {
                markResumed();
            }
        }
    }

    async function abortHandshake(session, operationId, error, markResumed, knownSnapshot = null) {
        let snapshot = knownSnapshot;
        let delivered = false;
        let snapshotErrorCode = null;
        try {
            try {
                snapshot = await engine.readSnapshot(session.playFabId);
            } catch (snapshotError) {
                snapshotErrorCode = snapshotError?.code || snapshotError?.name || "POC_ONLINE_ABORT_SNAPSHOT_READ_FAILED";
            }
            if (snapshot) {
                try {
                    await session.onSnapshot(serverEconomyPocReadonly(snapshot), Object.freeze({
                        source: "handshake_abort_reconciliation",
                        operationId,
                        sessionEpoch: session.sessionEpoch,
                        failureCode: error?.code || error?.name || "POC_ONLINE_MUTATION_FAILED"
                    }));
                    delivered = true;
                } catch (snapshotError) {
                    snapshotErrorCode = snapshotError?.code || snapshotError?.name || "POC_ONLINE_ABORT_SNAPSHOT_DELIVERY_FAILED";
                }
            }
            await session.afterAuthoritativeMutation(Object.freeze({
                playFabId: session.playFabId,
                sessionId: session.sessionId,
                sessionEpoch: session.sessionEpoch,
                operationId,
                action: delivered ? "resume_from_canonical_snapshot_after_abort" : "reload_canonical_snapshot_and_resume",
                outcome: "mutation_failed",
                errorCode: error?.code || error?.name || "POC_ONLINE_MUTATION_FAILED",
                snapshotErrorCode,
                canonicalSnapshotDelivered: delivered,
                requiresSnapshotReload: !delivered,
                revision: snapshot?.revision ?? null
            }));
            safeMetric(metrics, "increment", "online_handshake_abort_total");
        } finally {
            markResumed();
        }
    }

    async function guardedHandshake(session, operationId, work, source) {
        let started = false;
        let resumed = false;
        let lastDurableSnapshot = null;
        try {
            const ammo = await beginHandshake(session, operationId, () => { started = true; });
            lastDurableSnapshot = ammo.at(-1)?.snapshot || null;
            const value = await work();
            if (!value?.snapshot) {
                serverEconomyPocFail("POC_ONLINE_HANDSHAKE_EMPTY", "Online handshake produced no canonical snapshot.", { retryable: true });
            }
            await finishHandshake(session, value.snapshot, operationId, source, () => { resumed = true; });
            return { value, ammo };
        } catch (error) {
            if (started && !resumed) {
                try {
                    await abortHandshake(session, operationId, error, () => { resumed = true; }, lastDurableSnapshot);
                } catch (resumeError) {
                    try {
                        error.resumeErrorCode = resumeError?.code || resumeError?.name || "POC_ONLINE_RESUME_FAILED";
                    } catch {}
                }
            }
            throw error;
        }
    }


    async function consumeHighValue({ playFabId, operationId, preferOnline = true } = {}) {
        const started = monotonicMilliseconds();
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const session = preferOnline ? sessions.get(player) : null;
        let ammo = Object.freeze([]);
        const consumer = session ? "online" : "offline";
        let result;
        if (session) {
            const handled = await guardedHandshake(
                session, operationId,
                () => engine.processHighValueOperation({ playFabId: player, operationId, consumer }),
                "high_value_after_hot_state_flush"
            );
            result = handled.value;
            ammo = handled.ammo;
        } else {
            result = await engine.processHighValueOperation({ playFabId: player, operationId, consumer });
        }
        safeMetric(metrics, "observe", "consumer_duration_ms", Math.max(0, monotonicMilliseconds() - started), { consumer });
        return serverEconomyPocReadonly({ ...result, consumer, handshakeAmmoFlushes: ammo.length });
    }

    async function consumePendingPlayer(playFabId, { preferOnline = true, maximumOperations = 100 } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const session = preferOnline ? sessions.get(player) : null;
        const maximum = serverEconomyPocPositive(maximumOperations, "maximumOperations");
        let ammo = Object.freeze([]);
        const drain = async () => {
            const results = [];
            for (let index = 0; index < maximum; index += 1) {
                const result = await engine.processNextHighValue(player, { consumer: session ? "online" : "offline" });
                if (result.status === "empty") break;
                results.push(result);
            }
            const snapshot = results.at(-1)?.snapshot || await engine.readSnapshot(player);
            return { results, snapshot };
        };
        let results;
        if (session) {
            const handled = await guardedHandshake(
                session,
                "scheduled_pending_drain",
                drain,
                "high_value_drain_after_hot_state_flush"
            );
            results = handled.value.results;
            ammo = handled.ammo;
        } else {
            results = (await drain()).results;
        }
        return Object.freeze(Object.assign(results, { handshakeAmmoFlushes: ammo.length }));
    }

    async function appendOnlineEliteBallDelta({
        playFabId, sessionId, sessionEpoch, eventId, delta, reason = "online_combat"
    } = {}) {
        current(playFabId, sessionId, sessionEpoch);
        return engine.appendEliteBallDelta({ playFabId, eventId, delta, reason });
    }

    async function flushOnlineEliteBall({ playFabId, sessionId, sessionEpoch, batchSize } = {}) {
        const session = current(playFabId, sessionId, sessionEpoch);
        const result = await engine.flushEliteBall(playFabId, { batchSize, consumer: "online" });
        await session.onSnapshot(result.snapshot, Object.freeze({ source: "elite_ball_flush" }));
        return result;
    }

    async function offlineTick({ maximumPlayers = 100, maximumOperationsPerPlayer = 100 } = {}) {
        const maximum = serverEconomyPocPositive(maximumPlayers, "maximumPlayers");
        const highValuePlayers = await engine.stores.operationInbox.listPlayersWithPending({ limit: maximum });
        const walPlayers = await engine.stores.walStore.listPlayersWithPending({ limit: maximum });
        const highValue = [];
        const ammo = [];
        for (const playFabId of highValuePlayers) {
            try {
                const online = sessions.has(playFabId);
                highValue.push({
                    playFabId,
                    consumer: online ? "online" : "offline",
                    results: await consumePendingPlayer(playFabId, {
                        preferOnline: true,
                        maximumOperations: maximumOperationsPerPlayer
                    })
                });
            } catch (error) {
                highValue.push({ playFabId, error: error?.code || "POC_SCHEDULED_CONSUME_FAILED" });
            }
        }
        for (const playFabId of walPlayers) {
            if (sessions.has(playFabId)) {
                ammo.push({ playFabId, status: "online_owned", consumer: "online" });
                continue;
            }
            try {
                ammo.push({ playFabId, consumer: "offline", result: await engine.flushEliteBall(playFabId, { consumer: "offline" }) });
            } catch (error) {
                ammo.push({ playFabId, error: error?.code || "POC_SCHEDULED_FLUSH_FAILED" });
            }
        }
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
        hasOnlineSession: (playFabId) => sessions.has(playFabId),
        hotStateHandshakeRequired: true
    });
}

export function createServerEconomyPocOnlineHandshakeBatchService(options = {}) {
    return createServerEconomyPocBatchService(options);
}
