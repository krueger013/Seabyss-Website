import { createCanonicalMemoryServerEconomyPocHarness } from "./server-economy-poc-canonical.js";
import { serverEconomyPocPositive, serverEconomyPocReadonly } from "./server-economy-poc-model.js";

function counter(metrics, name, labels = "") {
    return metrics.counters[`${name}|${labels}`] || 0;
}

export async function runServerEconomyPocDeterministicLoginSimulation({ receiptCount = 12 } = {}) {
    const count = serverEconomyPocPositive(receiptCount, "receiptCount");
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "POC_LOGIN_SIMULATION";
    for (let index = 0; index < count; index += 1) {
        const operationId = `historical_${index}`;
        await harness.poc.engine.enqueueAuthoritativeHighValueOperation({
            playFabId,
            operationId,
            eventId: `historical_event_${index}`,
            diamonds: 1,
            eliteBall: 0,
            premium: null,
            reason: "historical_receipt_simulation",
            effectiveAtUnixMs: harness.clock.now
        });
        await harness.poc.engine.processHighValueOperation({
            playFabId,
            operationId,
            consumer: "historical_login_simulation"
        });
    }
    const beforeLogin = harness.metrics.snapshot();
    const snapshot = await harness.poc.snapshotOnlyLogin(playFabId);
    const afterLogin = harness.metrics.snapshot();
    return serverEconomyPocReadonly({
        simulationType: "deterministic_local_memory_mock",
        historicalLogin: {
            receiptScans: count,
            sequentialProviderMutations: count,
            sequentialCheckpointWrites: count,
            modeledRoundTrips: count * 3
        },
        canonicalSnapshotLogin: {
            receiptScans: 0,
            providerMutations: counter(afterLogin, "provider_call_total", "domain=high_value") -
                counter(beforeLogin, "provider_call_total", "domain=high_value"),
            snapshotReads: counter(afterLogin, "snapshot_read_total") - counter(beforeLogin, "snapshot_read_total"),
            diamonds: snapshot.diamonds,
            revision: snapshot.revision
        }
    });
}

export async function runServerEconomyPocAmmoBenchmark({
    players = 20,
    eventsPerPlayer = 100,
    batchSize = 20
} = {}) {
    const playerCount = serverEconomyPocPositive(players, "players");
    const eventCount = serverEconomyPocPositive(eventsPerPlayer, "eventsPerPlayer");
    const batch = serverEconomyPocPositive(batchSize, "batchSize");
    const harness = createCanonicalMemoryServerEconomyPocHarness({ ammoBatchSize: batch });
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();

    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
        const playFabId = `POC_BENCH_${playerIndex}`;
        const operationId = `seed_${playerIndex}`;
        await harness.poc.engine.enqueueAuthoritativeHighValueOperation({
            playFabId,
            operationId,
            eventId: `seed_event_${playerIndex}`,
            diamonds: 0,
            eliteBall: eventCount,
            premium: null,
            reason: "benchmark_seed",
            effectiveAtUnixMs: harness.clock.now
        });
        await harness.poc.engine.processHighValueOperation({ playFabId, operationId, consumer: "benchmark" });
        for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
            await harness.poc.engine.appendEliteBallDelta({
                playFabId,
                eventId: `shot_${playerIndex}_${eventIndex}`,
                delta: -1,
                reason: "benchmark_shot"
            });
        }
    }

    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
        const playFabId = `POC_BENCH_${playerIndex}`;
        for (;;) {
            const result = await harness.poc.engine.flushEliteBall(playFabId, {
                batchSize: batch,
                consumer: "benchmark"
            });
            if (result.status === "empty") break;
        }
    }

    const elapsedMilliseconds = Math.max(0.001, performance.now() - started);
    const heapAfter = process.memoryUsage().heapUsed;
    const metrics = harness.metrics.snapshot();
    const totalEvents = playerCount * eventCount;
    const expectedFlushes = playerCount * Math.ceil(eventCount / batch);
    return serverEconomyPocReadonly({
        simulationType: "deterministic_local_memory_mock",
        players: playerCount,
        eventsPerPlayer: eventCount,
        totalEvents,
        batchSize: batch,
        expectedAmmoProviderFlushes: expectedFlushes,
        actualAmmoProviderFlushes: counter(metrics, "provider_call_total", "domain=elite_ball_flush"),
        walAppends: counter(metrics, "wal_append_total"),
        ammoEventsFlushed: counter(metrics, "ammo_event_flushed_total", "consumer=benchmark"),
        snapshotWrites: counter(metrics, "snapshot_write_total", "domain=elite_ball_flush"),
        elapsedMilliseconds,
        eventsPerSecond: totalEvents * 1000 / elapsedMilliseconds,
        heapDeltaBytes: heapAfter - heapBefore,
        memoryImplementationOnly: true
    });
}
