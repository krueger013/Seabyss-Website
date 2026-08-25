import test from "node:test";
import assert from "node:assert/strict";
import { runFinancialShadowBatchBenchmark, runFinancialShadowLoginBenchmark } from "../src/financial-shadow-benchmark.js";

test("20-player Shadow benchmark batches 2,000 Elite events with honest state-call accounting", async () => {
    const result = await runFinancialShadowBatchBenchmark({ playerCount: 20 });
    assert.equal(result.deterministicLocalSimulation, true);
    assert.equal(result.scope, "runtime_direct_authentication_excluded");
    assert.equal(result.eventCount, 2000);
    assert.equal(result.batchCount, 80);
    assert.equal(result.metrics.eliteEvents, 2000);
    assert.equal(result.metrics.eliteBatches, 80);
    assert.equal(result.metrics.stateWrites, 120);
    assert.equal(result.calls.redisCasWrites, 120);
    assert.equal(result.calls.redisReads, 120);
    assert.equal(result.calls.redisModeledTotal, 240);
    assert.equal(result.calls.runtimeDirectPlayFabHttp, 0);
    assert.equal(result.calls.httpAuthenticationExcluded, true);
    assert.equal(result.calls.targetPlayFabWrites, 0);
    assert.ok(result.eventsPerSecond > 0);
    assert.ok(Number.isSafeInteger(result.memory.heapAfterBytes));
});

test("100-player Shadow benchmark batches 10,000 Elite events into 400 observations", async () => {
    const result = await runFinancialShadowBatchBenchmark({ playerCount: 100 });
    assert.equal(result.eventCount, 10_000);
    assert.equal(result.batchCount, 400);
    assert.equal(result.metrics.eliteEvents, 10_000);
    assert.equal(result.metrics.eliteBatches, 400);
    assert.equal(result.metrics.stateWrites, 600);
    assert.equal(result.calls.redisCasWrites, 600);
    assert.equal(result.calls.redisReads, 600);
    assert.equal(result.calls.redisModeledTotal, 1200);
    assert.equal(result.calls.runtimeDirectPlayFabHttp, 0);
    assert.equal(result.calls.httpAuthenticationExcluded, true);
    assert.equal(result.calls.targetPlayFabWrites, 0);
});

test("login benchmark distinguishes cold HTTP authentication from warm digest-cache paths", async () => {
    const result = await runFinancialShadowLoginBenchmark({ latencyMilliseconds: 2 });
    assert.equal(result.deterministicLocalSimulation, true);
    assert.equal(result.legacy.modeledCalls, 3);
    assert.equal(result.legacyShadow.modeledCalls, 5);
    assert.equal(result.targetSnapshotOnly.modeledCalls, 2);
    assert.equal(result.legacyShadow.playFabHttpCalls, 4);
    assert.equal(result.legacyShadow.redisCalls, 1);
    assert.equal(result.warmShadowSnapshot.authCacheHits, 1);
    assert.equal(result.warmShadowSnapshot.playFabHttpCalls, 0);
    assert.equal(result.warmShadowObserve.redisCalls, 2);
    assert.ok(result.legacyShadow.elapsedMilliseconds > result.targetSnapshotOnly.elapsedMilliseconds);
    assert.ok(result.legacy.elapsedMilliseconds > 0);
});
