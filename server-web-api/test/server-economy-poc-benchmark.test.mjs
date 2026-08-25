import test from "node:test";
import assert from "node:assert/strict";
import {
    runServerEconomyPocAmmoBenchmark,
    runServerEconomyPocDeterministicLoginSimulation
} from "../src/server-economy-poc-benchmark.js";
import { runServerEconomyPocLoginLatencyBenchmark } from "../src/server-economy-poc-latency-benchmark.js";

for (const players of [20, 100]) {
    test(`${players} players aggregate 100 shots each into 20-event provider batches`, async () => {
        const result = await runServerEconomyPocAmmoBenchmark({
            players,
            eventsPerPlayer: 100,
            batchSize: 20
        });
        assert.equal(result.totalEvents, players * 100);
        assert.equal(result.walAppends, players * 100);
        assert.equal(result.ammoEventsFlushed, players * 100);
        assert.equal(result.expectedAmmoProviderFlushes, players * 5);
        assert.equal(result.actualAmmoProviderFlushes, players * 5);
        assert.equal(result.snapshotWrites, players * 5);
        assert.ok(result.eventsPerSecond > 0);
        assert.equal(result.memoryImplementationOnly, true);
    });
}

test("historical login simulation performs sequential work while canonical login reads one snapshot", async () => {
    const result = await runServerEconomyPocDeterministicLoginSimulation({ receiptCount: 12 });
    assert.equal(result.simulationType, "deterministic_local_memory_mock");
    assert.equal(result.historicalLogin.receiptScans, 12);
    assert.equal(result.historicalLogin.sequentialProviderMutations, 12);
    assert.equal(result.canonicalSnapshotLogin.receiptScans, 0);
    assert.equal(result.canonicalSnapshotLogin.providerMutations, 0);
    assert.equal(result.canonicalSnapshotLogin.snapshotReads, 1);
    assert.equal(result.canonicalSnapshotLogin.diamonds, 12);
    assert.equal(result.historicalLogin.modeledRoundTrips, 36);
});

test("awaited 5ms round-trip model compares 36 legacy calls with one snapshot call", async () => {
    const result = await runServerEconomyPocLoginLatencyBenchmark({
        receiptCount: 12,
        mockedRoundTripMilliseconds: 5
    });
    assert.equal(result.assumptions.networkUsed, false);
    assert.equal(result.historicalLogin.roundTrips, 36);
    assert.equal(result.canonicalSnapshotLogin.roundTrips, 1);
    assert.ok(result.historicalLogin.elapsedMilliseconds > result.canonicalSnapshotLogin.elapsedMilliseconds);
    assert.ok(result.measuredSpeedup > 10);
});
