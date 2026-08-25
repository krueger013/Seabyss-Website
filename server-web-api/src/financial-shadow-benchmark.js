import { setTimeout as delay } from "node:timers/promises";
import { evaluateFinancialShadowPolicy } from "./financial-shadow-policy.js";
import { createFinancialShadowMetrics } from "./financial-shadow-model.js";
import { createMemoryFinancialShadowStateStore } from "./financial-shadow-store.js";
import { createFinancialShadowRuntime } from "./financial-shadow-runtime.js";

function clientSnapshot(snapshot, changes) {
    const value = structuredClone(snapshot);
    delete value.playFabId;
    return { ...value, ...changes };
}

function counter(metrics, name) {
    return Object.entries(metrics.snapshot().counters)
        .filter(([key]) => key.startsWith(`${name}:`))
        .reduce((sum, [, value]) => sum + value, 0);
}

export async function runFinancialShadowBatchBenchmark({
    playerCount,
    eventsPerPlayer = 100,
    batchSize = 25,
    monotonicMilliseconds = () => performance.now()
} = {}) {
    if (![playerCount, eventsPerPlayer, batchSize].every((value) => Number.isSafeInteger(value) && value > 0) ||
        eventsPerPlayer % batchSize !== 0 || batchSize > 500) {
        throw new TypeError("Financial Shadow benchmark shape is invalid.");
    }
    const players = Array.from({ length: playerCount }, (_, index) =>
        `SHADOW_BENCH_PLAYER_${String(index).padStart(4, "0")}`);
    const baseStore = createMemoryFinancialShadowStateStore();
    const storeCalls = { read: 0, compareAndSet: 0, ping: 0 };
    const stateStore = Object.freeze({
        async read(...args) { storeCalls.read += 1; return baseStore.read(...args); },
        async compareAndSet(...args) { storeCalls.compareAndSet += 1; return baseStore.compareAndSet(...args); },
        async ping(...args) { storeCalls.ping += 1; return baseStore.ping(...args); },
        durable: false,
        atomicCas: true
    });
    const metrics = createFinancialShadowMetrics();
    const runtime = createFinancialShadowRuntime({
        stateStore,
        metrics,
        policy: evaluateFinancialShadowPolicy({
            enabled: true,
            nodeEnv: "test",
            shadowEnvironment: "test",
            allowlistedPlayFabIds: players,
            serverId: "SHADOW_BENCH_SERVER",
            redisConfigured: true,
            playFabConfigured: true
        }),
        nowMilliseconds: () => 1_000_000,
        maximumHistoryEntries: playerCount * (eventsPerPlayer / batchSize + 2)
    });
    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const started = monotonicMilliseconds();
    for (const playFabId of players) {
        const session = await runtime.registerPresence({ playFabId, sessionId: `SESSION_${playFabId}` });
        const seed = await runtime.getSnapshot(playFabId);
        await runtime.observe(playFabId, {
            schemaVersion: 1,
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
            operationId: `BENCH_BOOTSTRAP_${playFabId}`,
            eventId: `BENCH_BOOTSTRAP_EVENT_${playFabId}`,
            kind: "snapshot_observation",
            reason: "benchmark_bootstrap",
            contextId: `BENCH_BOOTSTRAP_CONTEXT_${playFabId}`,
            occurredAtUnixMs: 1_000_000,
            effect: {},
            clientBeforeSnapshot: clientSnapshot(seed, {}),
            clientSnapshot: clientSnapshot(seed, {})
        }, { titlePlayerAccountId: `ENTITY_${playFabId}` });
        for (let offset = 0; offset < eventsPerPlayer; offset += batchSize) {
            const before = await runtime.getSnapshot(playFabId);
            const batch = offset / batchSize + 1;
            await runtime.observe(playFabId, {
                schemaVersion: 1,
                sessionId: session.sessionId,
                sessionEpoch: session.sessionEpoch,
                operationId: `BENCH_OPERATION_${playFabId}_${batch}`,
                eventId: `BENCH_EVENT_${playFabId}_${batch}`,
                kind: "elite_ball_delta",
                reason: "benchmark_aggregate",
                contextId: `BENCH_CONTEXT_${playFabId}_${batch}`,
                occurredAtUnixMs: 1_000_000,
                effect: { eliteBallDelta: batchSize, eventCount: batchSize },
                clientBeforeSnapshot: clientSnapshot(before, {}),
                clientSnapshot: clientSnapshot(before, {
                    eliteBall: before.eliteBall + batchSize
                })
            });
        }
    }
    const elapsedMilliseconds = Math.max(0.001, monotonicMilliseconds() - started);
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const eventCount = playerCount * eventsPerPlayer;
    const batchCount = playerCount * (eventsPerPlayer / batchSize);
    return Object.freeze({
        deterministicLocalSimulation: true,
        scope: "runtime_direct_authentication_excluded",
        playerCount,
        eventsPerPlayer,
        batchSize,
        eventCount,
        batchCount,
        bootstrapCount: playerCount,
        elapsedMilliseconds,
        eventsPerSecond: eventCount / (elapsedMilliseconds / 1000),
        memory: Object.freeze({
            heapBeforeBytes,
            heapAfterBytes,
            heapDeltaBytes: heapAfterBytes - heapBeforeBytes
        }),
        calls: Object.freeze({
            redisModeledTotal: storeCalls.read + storeCalls.compareAndSet,
            redisReads: storeCalls.read,
            redisCasWrites: storeCalls.compareAndSet,
            runtimeDirectPlayFabHttp: 0,
            httpAuthenticationExcluded: true,
            targetPlayFabWrites: 0
        }),
        metrics: Object.freeze({
            eliteEvents: counter(metrics, "financial_shadow_elite_events_observed_total"),
            eliteBatches: counter(metrics, "financial_shadow_elite_batch_total"),
            stateWrites: counter(metrics, "financial_shadow_state_write_total")
        })
    });
}

async function sequentialCalls(count, latencyMilliseconds) {
    const started = performance.now();
    for (let index = 0; index < count; index += 1) await delay(latencyMilliseconds);
    return performance.now() - started;
}

export async function runFinancialShadowLoginBenchmark({ latencyMilliseconds = 5 } = {}) {
    if (!Number.isSafeInteger(latencyMilliseconds) || latencyMilliseconds <= 0 || latencyMilliseconds > 100) {
        throw new TypeError("Financial Shadow login benchmark latency is invalid.");
    }
    const legacy = { mode: "legacy", playFabHttpCalls: 3, redisCalls: 0, authCacheHits: 0, modeledCalls: 3 };
    const legacyShadow = {
        mode: "legacy_plus_shadow_cold_auth",
        playFabHttpCalls: 4,
        redisCalls: 1,
        authCacheHits: 0,
        modeledCalls: 5
    };
    const target = { mode: "target_snapshot_only", playFabHttpCalls: 2, redisCalls: 0, authCacheHits: 0, modeledCalls: 2 };
    const warmShadowSnapshot = {
        mode: "shadow_snapshot_warm_auth_and_snapshot_cache",
        playFabHttpCalls: 0,
        redisCalls: 0,
        authCacheHits: 1,
        modeledCalls: 0
    };
    const warmShadowObserve = {
        mode: "shadow_observe_warm_auth",
        playFabHttpCalls: 0,
        redisCalls: 2,
        authCacheHits: 1,
        modeledCalls: 2
    };
    for (const value of [legacy, legacyShadow, target, warmShadowSnapshot, warmShadowObserve]) {
        value.elapsedMilliseconds = value.modeledCalls === 0 ? 0 : await sequentialCalls(value.modeledCalls, latencyMilliseconds);
    }
    return Object.freeze({
        deterministicLocalSimulation: true,
        injectedRoundTripLatencyMilliseconds: latencyMilliseconds,
        assumptions: Object.freeze({
            legacy: "session auth + legacy profile + inventory",
            legacyShadow: "legacy login + cold AuthenticateSessionTicket + Redis Shadow snapshot",
            target: "session auth + canonical provider snapshot",
            warm: "ticket digest auth cache hit; snapshot may also hit its bounded process cache"
        }),
        legacy: Object.freeze(legacy),
        legacyShadow: Object.freeze(legacyShadow),
        targetSnapshotOnly: Object.freeze(target),
        warmShadowSnapshot: Object.freeze(warmShadowSnapshot),
        warmShadowObserve: Object.freeze(warmShadowObserve)
    });
}
