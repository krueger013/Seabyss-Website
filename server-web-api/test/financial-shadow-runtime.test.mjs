import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFinancialShadowPolicy, parseFinancialShadowAllowlist } from "../src/financial-shadow-policy.js";
import { createFinancialShadowMetrics } from "../src/financial-shadow-model.js";
import {
    createMemoryFinancialShadowStateStore,
    createRedisFinancialShadowStateStore,
    financialShadowRedisKey
} from "../src/financial-shadow-store.js";
import { createFinancialShadowRuntime } from "../src/financial-shadow-runtime.js";

const PLAYER = "SHADOW_PLAYER_0001";

function policy(serverId = "SHADOW_SERVER_A", overrides = {}) {
    return evaluateFinancialShadowPolicy({
        enabled: true,
        nodeEnv: "development",
        shadowEnvironment: "sandbox",
        allowlistedPlayFabIds: [PLAYER],
        serverId,
        redisConfigured: true,
        playFabConfigured: true,
        ...overrides
    });
}

function createHarness({ store = createMemoryFinancialShadowStateStore(), serverId = "SHADOW_SERVER_A", clock = { now: 1000 } } = {}) {
    const metrics = createFinancialShadowMetrics();
    const runtime = createFinancialShadowRuntime({
        stateStore: store,
        policy: policy(serverId),
        metrics,
        nowMilliseconds: () => clock.now,
        monotonicMilliseconds: () => clock.now,
        presenceLeaseTtlMilliseconds: 1000
    });
    return { runtime, store, clock, metrics };
}

function clientSnapshot(snapshot, changes = {}) {
    const clone = structuredClone(snapshot);
    delete clone.playFabId;
    return { ...clone, ...changes };
}

function observation({ session, snapshot, suffix, kind = "diamonds_delta", effect = { diamondsDelta: 5 }, changes = {}, occurredAtUnixMs = 1000 }) {
    return {
        schemaVersion: 1,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        operationId: `SHADOW_OPERATION_${suffix}`,
        eventId: `SHADOW_EVENT_${suffix}`,
        kind,
        reason: "shadow_test",
        contextId: `SHADOW_CONTEXT_${suffix}`,
        occurredAtUnixMs,
        effect,
        clientBeforeSnapshot: clientSnapshot(snapshot),
        clientSnapshot: clientSnapshot(snapshot, changes)
    };
}

async function bootstrap(runtime, session, suffix = "BOOTSTRAP") {
    const before = await runtime.getSnapshot(PLAYER);
    const result = await runtime.observe(PLAYER, observation({
        session,
        snapshot: before,
        suffix,
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    }), { titlePlayerAccountId: "TPA_SHADOW_PLAYER" });
    const inbox = await runtime.claimInbox({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch });
    const delivery = inbox.deliveries.find((entry) => entry.deliveryId === result.delivery.deliveryId);
    await runtime.ackDelivery({
        playFabId: PLAYER,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        deliveryId: delivery.deliveryId,
        deliveryEpoch: delivery.deliveryEpoch
    });
    return runtime.getSnapshot(PLAYER);
}

function counter(metrics, prefix) {
    return Object.entries(metrics.snapshot().counters)
        .filter(([name]) => name.startsWith(`${prefix}:`))
        .reduce((sum, [, value]) => sum + value, 0);
}

test("Shadow policy is off by default and wildcard allowlists are always forbidden", () => {
    assert.equal(evaluateFinancialShadowPolicy().enabled, false);
    assert.deepEqual(parseFinancialShadowAllowlist(" B ,A,A "), ["A", "B"]);
    assert.throws(() => parseFinancialShadowAllowlist("*"), { code: "FINANCIAL_SHADOW_WILDCARD_FORBIDDEN" });
});

test("Shadow activation fails closed in production, cutover, purchase, missing Redis, and empty allowlist states", () => {
    assert.throws(() => policy("A", { nodeEnv: "production" }), { code: "FINANCIAL_SHADOW_PRODUCTION_FORBIDDEN" });
    assert.throws(() => policy("A", { financialAuthorityCutoverEnabled: true }), { code: "FINANCIAL_SHADOW_CUTOVER_CONFLICT" });
    assert.throws(() => policy("A", { purchasesGlobalEnabled: true }), { code: "FINANCIAL_SHADOW_PURCHASE_GATE_CONFLICT" });
    assert.throws(() => policy("A", { checkoutSandboxEnabled: true }), { code: "FINANCIAL_SHADOW_PURCHASE_GATE_CONFLICT" });
    assert.throws(() => policy("A", { hardenedCatalogEnabled: true }), { code: "FINANCIAL_SHADOW_PURCHASE_GATE_CONFLICT" });
    assert.throws(() => policy("A", { redisConfigured: false }), { code: "FINANCIAL_SHADOW_REDIS_REQUIRED" });
    assert.throws(() => policy("A", { allowlistedPlayFabIds: [] }), { code: "FINANCIAL_SHADOW_ALLOWLIST_REQUIRED" });
});

test("GET snapshot cache returns the strict POC ten-field model without provider writes", async () => {
    const { runtime, metrics } = createHarness();
    const first = await runtime.getSnapshot(PLAYER);
    const second = await runtime.getSnapshot(PLAYER);
    assert.deepEqual(Object.keys(first).sort(), [
        "ammoAppliedThroughSequence", "diamonds", "eliteBall", "fencingEpoch",
        "highValueAppliedThroughSequence", "playFabId", "premium", "revision",
        "schemaVersion", "updatedAtUnixMs"
    ]);
    assert.deepEqual(second, first);
    assert.equal(runtime.authoritative, false);
    assert.equal(runtime.targetPlayFabWritesAllowed, false);
    assert.equal(counter(metrics, "financial_shadow_cache_miss_total"), 1);
    assert.equal(counter(metrics, "financial_shadow_cache_hit_total"), 1);
});

test("first snapshot bootstrap advances an existing contract revision exactly once and exact replay is a no-op", async () => {
    const { runtime, store, clock } = createHarness();
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_BOOTSTRAP_REVISION" });
    const existing = {
        ...(await runtime.getSnapshot(PLAYER)),
        revision: 17,
        updatedAtUnixMs: 500,
        diamonds: 91,
        eliteBall: 37
    };
    const input = observation({
        session,
        snapshot: existing,
        suffix: "BOOTSTRAP_REVISION",
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    });

    const first = await runtime.observe(PLAYER, input, { titlePlayerAccountId: "TPA_SHADOW_PLAYER" });
    const stateAfterFirst = await store.read(PLAYER);
    clock.now += 500;
    const replay = await runtime.observe(PLAYER, input, { titlePlayerAccountId: "TPA_SHADOW_PLAYER" });
    const stateAfterReplay = await store.read(PLAYER);

    assert.equal(first.status, "observed");
    assert.equal(first.modelSnapshot.revision, 18);
    assert.equal(first.modelSnapshot.fencingEpoch, session.sessionEpoch);
    assert.equal(first.modelSnapshot.diamonds, existing.diamonds);
    assert.equal(first.modelSnapshot.eliteBall, existing.eliteBall);
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.modelSnapshot, first.modelSnapshot);
    assert.equal(stateAfterReplay.stateVersion, stateAfterFirst.stateVersion);
    assert.equal(stateAfterReplay.snapshot.revision, 18);
    assert.equal(stateAfterReplay.observations.length, 1);
    assert.equal(stateAfterReplay.deliveries.length, 1);
});

test("concurrent identical bootstrap has one revision winner while a stale session cannot mutate the snapshot", async () => {
    const store = createMemoryFinancialShadowStateStore();
    const clock = { now: 1000 };
    const a = createHarness({ store, serverId: "SHADOW_SERVER_A", clock }).runtime;
    const sessionA = await a.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_CONCURRENT_A" });
    const seed = {
        ...(await a.getSnapshot(PLAYER)),
        revision: 40,
        updatedAtUnixMs: 900
    };
    const input = observation({
        session: sessionA,
        snapshot: seed,
        suffix: "CONCURRENT_BOOTSTRAP",
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    });
    const [left, right] = await Promise.all([
        a.observe(PLAYER, structuredClone(input), { titlePlayerAccountId: "TPA_SHADOW_PLAYER" }),
        a.observe(PLAYER, structuredClone(input), { titlePlayerAccountId: "TPA_SHADOW_PLAYER" })
    ]);
    assert.deepEqual([left.status, right.status].sort(), ["observed", "replayed"]);
    assert.equal((await a.getSnapshot(PLAYER)).revision, 41);
    assert.equal((await store.read(PLAYER)).observations.length, 1);

    clock.now += 1001;
    const b = createHarness({ store, serverId: "SHADOW_SERVER_B", clock }).runtime;
    const sessionB = await b.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_CONCURRENT_B" });
    const beforeStaleAttempt = await b.getSnapshot(PLAYER);
    const stale = observation({
        session: sessionA,
        snapshot: beforeStaleAttempt,
        suffix: "STALE_SNAPSHOT",
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    });
    await assert.rejects(
        a.observe(PLAYER, stale, { titlePlayerAccountId: "TPA_SHADOW_PLAYER" }),
        { code: "FINANCIAL_SHADOW_STALE_PRESENCE" }
    );
    assert.equal((await b.getSnapshot(PLAYER)).revision, 41);

    const fresh = observation({
        session: sessionB,
        snapshot: beforeStaleAttempt,
        suffix: "FRESH_SNAPSHOT",
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    });
    const freshResult = await b.observe(PLAYER, fresh, { titlePlayerAccountId: "TPA_SHADOW_PLAYER" });
    assert.equal(freshResult.modelSnapshot.revision, 42);
    assert.equal(freshResult.modelSnapshot.fencingEpoch, sessionB.sessionEpoch);
});

test("concurrent distinct snapshot observations serialize into strictly monotonic revisions", async () => {
    const { runtime, store } = createHarness();
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_DISTINCT_CAS" });
    const seed = {
        ...(await runtime.getSnapshot(PLAYER)),
        revision: 70
    };
    const left = observation({
        session,
        snapshot: seed,
        suffix: "DISTINCT_LEFT",
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    });
    const right = observation({
        session,
        snapshot: seed,
        suffix: "DISTINCT_RIGHT",
        kind: "snapshot_observation",
        effect: {},
        changes: {}
    });

    const results = await Promise.all([
        runtime.observe(PLAYER, left, { titlePlayerAccountId: "TPA_SHADOW_PLAYER" }),
        runtime.observe(PLAYER, right, { titlePlayerAccountId: "TPA_SHADOW_PLAYER" })
    ]);
    assert.deepEqual(results.map((result) => result.modelSnapshot.revision).sort((a, b) => a - b), [71, 72]);
    const state = await store.read(PLAYER);
    assert.equal(state.snapshot.revision, 72);
    assert.equal(state.observations.length, 2);
    assert.equal(state.deliveries.length, 2);
});

test("observation is non-authoritative, idempotent across clocks, and queues one durable operation delivery", async () => {
    const { runtime, clock, metrics } = createHarness();
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_A" });
    const before = await bootstrap(runtime, session);
    const input = observation({ session, snapshot: before, suffix: "DIAMONDS", changes: { diamonds: 5 } });
    const first = await runtime.observe(PLAYER, input);
    clock.now += 500;
    const replay = await runtime.observe(PLAYER, input);
    assert.equal(first.status, "observed");
    assert.equal(first.authoritative, false);
    assert.equal(first.sourceAttested, false);
    assert.equal(first.modelSnapshot.diamonds, 5);
    assert.equal(first.mismatch.severity, "none");
    assert.equal(replay.status, "replayed");
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 5);
    const inbox = await runtime.claimInbox({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch });
    assert.equal(inbox.deliveries.filter((entry) => entry.state !== "Acked").length, 1);
    assert.equal(counter(metrics, "financial_shadow_observation_replay_total"), 1);
});

test("mismatch model classifies material economic drift as critical and records exact contract metrics", async () => {
    const { runtime, metrics } = createHarness();
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_A" });
    const before = await bootstrap(runtime, session);
    const baseline = metrics.contractSnapshot();
    const result = await runtime.observe(PLAYER, observation({ session, snapshot: before, suffix: "CRITICAL", changes: { diamonds: 500 } }));
    assert.equal(result.modelSnapshot.diamonds, 5);
    assert.equal(result.mismatch.severity, "critical");
    assert.ok(result.mismatch.economicFields.some((field) => field.path === "diamonds"));
    const after = metrics.contractSnapshot();
    assert.equal(after.shadow_compare_count, baseline.shadow_compare_count + 1);
    assert.equal(after.shadow_mismatch_count, baseline.shadow_mismatch_count + 1);
    assert.equal(after.shadow_match_count, baseline.shadow_match_count);
    assert.equal(after.shadow_mismatch_diamonds, baseline.shadow_mismatch_diamonds + 1);
});

test("operationId and eventId conflicts never apply a second shadow delta", async () => {
    const { runtime } = createHarness();
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_A" });
    const before = await bootstrap(runtime, session);
    const first = observation({ session, snapshot: before, suffix: "IDENTITY", changes: { diamonds: 5 } });
    await runtime.observe(PLAYER, first);
    await assert.rejects(runtime.observe(PLAYER, { ...first, effect: { diamondsDelta: 6 } }), { code: "FINANCIAL_SHADOW_IDEMPOTENCY_CONFLICT" });
    const after = await runtime.getSnapshot(PLAYER);
    const duplicateEvent = observation({ session, snapshot: after, suffix: "OTHER", changes: { diamonds: 10 } });
    duplicateEvent.eventId = first.eventId;
    await assert.rejects(runtime.observe(PLAYER, duplicateEvent), { code: "FINANCIAL_SHADOW_EVENT_CONFLICT" });
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 5);
});

test("shared store provides distributed owner lease, expiry takeover, and stale-server fencing", async () => {
    const store = createMemoryFinancialShadowStateStore();
    const clock = { now: 1000 };
    const a = createHarness({ store, serverId: "SHADOW_SERVER_A", clock }).runtime;
    const b = createHarness({ store, serverId: "SHADOW_SERVER_B", clock }).runtime;
    const sessionA = await a.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_A" });
    await assert.rejects(b.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_B" }), { code: "FINANCIAL_SHADOW_PRESENCE_BUSY" });
    clock.now += 1001;
    const sessionB = await b.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_B" });
    assert.equal(sessionB.status, "taken_over");
    assert.equal(sessionB.sessionEpoch, sessionA.sessionEpoch + 1);
    await assert.rejects(a.heartbeatPresence({ playFabId: PLAYER, sessionId: sessionA.sessionId, sessionEpoch: sessionA.sessionEpoch }), { code: "FINANCIAL_SHADOW_STALE_PRESENCE" });
    assert.equal((await b.heartbeatPresence({ playFabId: PLAYER, sessionId: sessionB.sessionId, sessionEpoch: sessionB.sessionEpoch })).status, "renewed");
});

test("delivery claim and ACK remain idempotent after a server process restart", async () => {
    const store = createMemoryFinancialShadowStateStore();
    const clock = { now: 1000 };
    const firstRuntime = createHarness({ store, serverId: "SHADOW_SERVER_STABLE", clock }).runtime;
    const session = await firstRuntime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_STABLE" });
    const before = await bootstrap(firstRuntime, session);
    await firstRuntime.observe(PLAYER, observation({ session, snapshot: before, suffix: "RESTART", changes: { diamonds: 5 } }));
    const claimed = await firstRuntime.claimInbox({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch });
    const delivery = claimed.deliveries.find((entry) => entry.state === "Claimed");
    const restarted = createHarness({ store, serverId: "SHADOW_SERVER_STABLE", clock }).runtime;
    const ackInput = { playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch, deliveryId: delivery.deliveryId, deliveryEpoch: delivery.deliveryEpoch };
    assert.equal((await restarted.ackDelivery(ackInput)).status, "acked");
    assert.equal((await restarted.ackDelivery(ackInput)).status, "already_acked");
    assert.equal((await restarted.claimInbox({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch })).deliveries.length, 0);
});

test("100 Elite events are modeled in four bounded batches and four shadow writes", async () => {
    const { runtime, metrics } = createHarness();
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SESSION_BATCH" });
    await bootstrap(runtime, session);
    for (let batch = 1; batch <= 4; batch += 1) {
        const before = await runtime.getSnapshot(PLAYER);
        await runtime.observe(PLAYER, observation({
            session, snapshot: before, suffix: `ELITE_${batch}`, kind: "elite_ball_delta",
            effect: { eliteBallDelta: 25, eventCount: 25 },
            changes: { eliteBall: before.eliteBall + 25 }
        }));
    }
    const final = await runtime.getSnapshot(PLAYER);
    assert.equal(final.eliteBall, 100);
    assert.equal(final.ammoAppliedThroughSequence, 100);
    assert.equal(counter(metrics, "financial_shadow_elite_batch_total"), 4);
    assert.equal(counter(metrics, "financial_shadow_elite_events_observed_total"), 100);
});

test("Redis store uses one atomic hash-tagged CAS state key and survives runtime reconstruction", async () => {
    const values = new Map();
    const redis = {
        async get(key) { return values.get(key) ?? null; },
        async ping() { return "PONG"; },
        async eval(script, { keys, arguments: args }) {
            assert.match(script, /FINANCIAL_SHADOW_STATE_CAS_V1/u);
            const raw = values.get(keys[0]) ?? null;
            const current = raw ? JSON.parse(raw).stateVersion : -1;
            if (current !== Number(args[0])) return ["conflict", raw || ""];
            values.set(keys[0], args[1]);
            return ["updated", args[1]];
        }
    };
    const store = createRedisFinancialShadowStateStore({ redisClient: redis });
    const key = financialShadowRedisKey(store.prefix, PLAYER);
    assert.match(key, /\{[a-f0-9]{64}\}:state$/u);
    assert.equal(key.includes(PLAYER), false);
    const clock = { now: 1000 };
    const first = createHarness({ store, serverId: "REDIS_SERVER", clock }).runtime;
    const session = await first.registerPresence({ playFabId: PLAYER, sessionId: "REDIS_SESSION" });
    const second = createHarness({ store, serverId: "REDIS_SERVER", clock }).runtime;
    assert.equal((await second.heartbeatPresence({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch })).status, "renewed");
    assert.deepEqual(await first.getSnapshot(PLAYER), await second.getSnapshot(PLAYER));
    assert.equal((await second.health()).healthy, true);
});
