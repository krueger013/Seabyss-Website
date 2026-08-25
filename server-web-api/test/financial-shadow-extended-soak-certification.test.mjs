import test from "node:test";
import assert from "node:assert/strict";
import {
    CANARY_PLAYFAB_ID,
    createCertificationProviderScheduler
} from "../financial-shadow-canary-e2e-certification.mjs";
import {
    SOAK_CYCLES_PER_SEGMENT,
    SOAK_ELITE_BATCHES_PER_CYCLE,
    SOAK_EVENTS_PER_BATCH,
    SOAK_LOGICAL_DURATION_MILLISECONDS,
    SOAK_SEGMENT_COUNT,
    SOAK_TOTAL_ELITE_BATCHES,
    SOAK_TOTAL_ELITE_MUTATIONS,
    buildEliteSoakObservation,
    createPlayFabFetchObserver,
    createRedisCommandObserver,
    loadExtendedSoakConfiguration,
    summarizeExtendedSoakSegments
} from "../financial-shadow-extended-soak-certification.mjs";

function environment(overrides = {}) {
    return {
        NODE_ENV: "test",
        FINANCIAL_SHADOW_EXTENDED_SOAK_ENABLED: "true",
        FINANCIAL_SHADOW_CANARY_E2E_ENABLED: "true",
        FINANCIAL_SHADOW_CANARY_E2E_MUTATION_ENABLED: "true",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "1D0C16",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: "TEST_ONLY_NOT_A_REAL_SECRET_KEY",
        FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS: CANARY_PLAYFAB_ID,
        FINANCIAL_SHADOW_MODE_ENABLED: "true",
        FINANCIAL_SHADOW_ENVIRONMENT: "sandbox",
        FINANCIAL_SHADOW_CANARY_E2E_RUN_ID: "extended-soak-unit",
        FINANCIAL_SHADOW_CANARY_E2E_CONTROL_TOKEN: "TEST_ONLY_CONTROL_TOKEN_32_BYTES_MINIMUM",
        FINANCIAL_SHADOW_CANARY_E2E_REDIS_URL: "redis://127.0.0.1:63884",
        ...overrides
    };
}

function snapshot(changes = {}) {
    return {
        schemaVersion: 1,
        playFabId: CANARY_PLAYFAB_ID,
        revision: 40,
        fencingEpoch: 2,
        highValueAppliedThroughSequence: 0,
        ammoAppliedThroughSequence: 100,
        diamonds: 500,
        eliteBall: 1000,
        premium: { tier: 0, activatedAtUnixMs: null, expiresAtUnixMs: null },
        updatedAtUnixMs: 1000,
        ...changes
    };
}

test("extended soak configuration is exact, fixed-volume, fail-closed, and Production-refusing", () => {
    const value = loadExtendedSoakConfiguration(environment());
    assert.equal(value.titleId, "1D0C16");
    assert.equal(value.canaryPlayFabId, CANARY_PLAYFAB_ID);
    assert.equal(value.segmentCount, 5);
    assert.equal(value.cyclesPerSegment, 20);
    assert.equal(value.totalEliteBatches, 1000);
    assert.equal(value.totalEliteMutations, 10_000);
    assert.equal(value.logicalDurationMilliseconds, 7_200_000);
    assert.throws(() => loadExtendedSoakConfiguration(environment({
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "142853"
    })), { code: "SHADOW_E2E_TITLE_REFUSED" });
    assert.throws(() => loadExtendedSoakConfiguration(environment({
        FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS: "*"
    })), { code: "SHADOW_E2E_ALLOWLIST_REFUSED" });
    assert.throws(() => loadExtendedSoakConfiguration(environment({
        PURCHASES_GLOBAL_ENABLED: "true"
    })), { code: "SHADOW_E2E_ACTIVE_GATE_REFUSED" });
});

test("Elite soak observations aggregate ten semantic events, preserve order, and predict exact structural state", () => {
    const session = { sessionId: "SOAK_SESSION", sessionEpoch: 7 };
    const positive = buildEliteSoakObservation({
        runId: "extended-soak-unit", segmentIndex: 0, cycleIndex: 0, batchIndex: 0,
        session, before: snapshot(), logicalNowUnixMs: 2000
    });
    assert.equal(positive.mutationCount, SOAK_EVENTS_PER_BATCH);
    assert.deepEqual(positive.observation.effect, { eliteBallDelta: 10, eventCount: 10 });
    assert.equal(positive.expected.eliteBall, 1010);
    assert.equal(positive.expected.ammoAppliedThroughSequence, 110);
    assert.equal(positive.expected.revision, 41);
    assert.equal(positive.expected.fencingEpoch, 7);
    assert.equal(positive.expected.updatedAtUnixMs, 2000);
    assert.equal("playFabId" in positive.observation.clientSnapshot, false);

    const negative = buildEliteSoakObservation({
        runId: "extended-soak-unit", segmentIndex: 0, cycleIndex: 0, batchIndex: 1,
        session, before: positive.expected, logicalNowUnixMs: 2000
    });
    assert.deepEqual(negative.observation.effect, { eliteBallDelta: -10, eventCount: 10 });
    assert.equal(negative.expected.eliteBall, 1000);
    assert.equal(negative.expected.ammoAppliedThroughSequence, 120);
    assert.notEqual(negative.observation.operationId, positive.observation.operationId);
});

test("PlayFab fetch instrumentation refuses every other Title and exports no credentials or payloads", async () => {
    const calls = [];
    let now = 10;
    const observer = createPlayFabFetchObserver({
        fetchImpl: async (input, init) => {
            calls.push({ input, init });
            return { ok: true, status: 200 };
        },
        monotonicMilliseconds: () => ++now
    });
    await observer.fetch("https://1d0c16.playfabapi.com/Server/GetUserAccountInfo", {
        headers: { "X-SecretKey": "MUST_NOT_APPEAR" },
        body: JSON.stringify({ PlayFabId: CANARY_PLAYFAB_ID })
    });
    const metrics = observer.snapshot();
    assert.equal(calls.length, 1);
    assert.equal(metrics.endpoints["Server/GetUserAccountInfo"].requests, 1);
    assert.equal(metrics.endpoints["Server/GetUserAccountInfo"].success, 1);
    assert.equal(metrics.includesHeaders, false);
    assert.equal(metrics.includesBodies, false);
    assert.doesNotMatch(JSON.stringify(metrics), /MUST_NOT_APPEAR|61AD15CDA4137EA9/u);
    await assert.rejects(observer.fetch(
        "https://142853.playfabapi.com/Server/GetUserAccountInfo", {}),
    { code: "SHADOW_SOAK_PLAYFAB_TITLE_REFUSED" });
    await assert.rejects(observer.fetch(
        "https://1d0c16.playfabapi.com/Object/SetObjects", {}),
    { code: "SHADOW_SOAK_PLAYFAB_ENDPOINT_REFUSED" });
    await assert.rejects(observer.fetch(
        "https://1d0c16.playfabapi.com/Server/AddUserVirtualCurrency", {}),
    { code: "SHADOW_SOAK_PLAYFAB_ENDPOINT_REFUSED" });
    assert.equal(calls.length, 1);
});

test("Redis instrumentation counts command names and latency without arguments or values", async () => {
    let now = 0;
    const observer = createRedisCommandObserver({ monotonicMilliseconds: () => ++now });
    const fake = {
        async get() { return "SENSITIVE_VALUE"; },
        async set() { return "OK"; },
        async eval() { return ["updated", "SENSITIVE_VALUE"]; },
        async sendCommand() { return "PONG"; },
        async connect() {},
        async quit() {}
    };
    const redis = observer.decorate(fake);
    await redis.get("SENSITIVE_KEY");
    await redis.set("SENSITIVE_KEY", "SENSITIVE_VALUE");
    await redis.eval("SENSITIVE_LUA", {});
    await redis.sendCommand(["MGET", "SENSITIVE_KEY"]);
    const metrics = observer.snapshot();
    assert.equal(metrics.commands.GET.count, 1);
    assert.equal(metrics.commands.SET.count, 1);
    assert.equal(metrics.commands.EVAL.count, 1);
    assert.equal(metrics.commands.MGET.count, 1);
    assert.equal(metrics.includesArguments, false);
    assert.equal(metrics.includesValues, false);
    assert.doesNotMatch(JSON.stringify(metrics), /SENSITIVE/u);
});

test("provider scheduler recreates around one durable Pending operation and the new instance resumes it", async () => {
    const durable = { pending: true, drains: 0 };
    const engine = {
        async processHighValueOperation() {},
        async drainHighValue() {
            if (!durable.pending) return [];
            durable.pending = false;
            durable.drains += 1;
            return [{ status: "applied" }];
        },
        async flushEliteBall() { return { status: "empty" }; },
        async appendEliteBallDelta() {},
        async readSnapshot() { return snapshot(); },
        stores: {
            operationInbox: {
                async listPlayersWithPending() {
                    return durable.pending ? [CANARY_PLAYFAB_ID] : [];
                }
            },
            walStore: { async listPlayersWithPending() { return []; } }
        }
    };
    const first = createCertificationProviderScheduler({ providerRuntime: engine });
    assert.equal(first.service.start().status, "started");
    await first.service.stop();
    assert.equal(durable.pending, true);

    const recreated = createCertificationProviderScheduler({ providerRuntime: engine });
    recreated.service.start();
    const result = await recreated.service.tick();
    await recreated.service.stop();
    assert.equal(result.highValue.length, 1);
    assert.equal(result.highValue[0].results.length, 1);
    assert.equal(durable.pending, false);
    assert.equal(durable.drains, 1);
});

function segmentResult(index) {
    return {
        segment: index,
        titleId: "1D0C16",
        canaryPlayFabId: CANARY_PLAYFAB_ID,
        serverId: `SERVER_${index}`,
        targetPlayFabWritesAllowed: false,
        logicalStartUnixMs: Date.UTC(2031, 0, 1) + index * 20 * 72_000,
        logicalEndUnixMs: Date.UTC(2031, 0, 1) + (index + 1) * 20 * 72_000,
        recoveredAcrossSegment: index === 0 ? 0 : 1,
        initialElite: 100,
        finalElite: 100,
        exactStructuralComparisons: SOAK_CYCLES_PER_SEGMENT * SOAK_ELITE_BATCHES_PER_CYCLE,
        eliteBatches: SOAK_CYCLES_PER_SEGMENT * SOAK_ELITE_BATCHES_PER_CYCLE,
        eliteMutations: SOAK_CYCLES_PER_SEGMENT * SOAK_ELITE_BATCHES_PER_CYCLE * SOAK_EVENTS_PER_BATCH,
        queue: { Pending: index === SOAK_SEGMENT_COUNT - 1 ? 0 : 1,
            Claimed: 0, Acked: 10, retainedDeliveries: 11,
            retainedObservations: 11, compactedObservations: 0 },
        provider: { pendingPlayers: 0, walPending: 0, leasePresent: false },
        consistency: { unexplainedMismatch: 0, lostOperation: 0,
            doubleOperation: 0, staleWriterAccepted: 0 }
    };
}

test("five distinct process segments summarize to the exact two-hour/10k/1000 soak contract", () => {
    assert.equal(SOAK_SEGMENT_COUNT, 5);
    assert.equal(SOAK_TOTAL_ELITE_BATCHES, 1000);
    assert.equal(SOAK_TOTAL_ELITE_MUTATIONS, 10_000);
    assert.equal(SOAK_LOGICAL_DURATION_MILLISECONDS, 7_200_000);
    const result = summarizeExtendedSoakSegments(
        Array.from({ length: SOAK_SEGMENT_COUNT }, (_, index) => segmentResult(index)));
    assert.equal(result.verdict, "PASS");
    assert.equal(result.distinctServerInstances, 5);
    assert.equal(result.cycles, 100);
    assert.equal(result.eliteBatches, 1000);
    assert.equal(result.eliteMutations, 10_000);
    assert.equal(result.finalQueue.Pending, 0);
});

test("aggregate refuses shortened duration, lost recovery, or a non-read-only segment", () => {
    const valid = Array.from({ length: SOAK_SEGMENT_COUNT }, (_, index) => segmentResult(index));
    assert.throws(() => summarizeExtendedSoakSegments(valid.map((value, index) => index === 4
        ? { ...value, logicalEndUnixMs: value.logicalEndUnixMs - 72_000 }
        : value)), { code: "SHADOW_SOAK_SUMMARY_FAILED" });
    assert.throws(() => summarizeExtendedSoakSegments(valid.map((value, index) => index === 2
        ? { ...value, recoveredAcrossSegment: 0 }
        : value)), { code: "SHADOW_SOAK_SUMMARY_FAILED" });
    assert.throws(() => summarizeExtendedSoakSegments(valid.map((value, index) => index === 3
        ? { ...value, targetPlayFabWritesAllowed: true }
        : value)), { code: "SHADOW_SOAK_SUMMARY_FAILED" });
});

test("aggregate accepts one intentionally claimed cross-process delivery before final recovery", () => {
    const values = Array.from({ length: SOAK_SEGMENT_COUNT }, (_, index) => segmentResult(index));
    for (let index = 0; index < SOAK_SEGMENT_COUNT - 1; index += 1) {
        values[index] = { ...values[index], queue: { ...values[index].queue,
            Pending: 0, Claimed: 1 } };
    }
    assert.equal(summarizeExtendedSoakSegments(values).verdict, "PASS");
});
