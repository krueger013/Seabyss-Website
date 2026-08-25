import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFinancialShadowPolicy } from "../src/financial-shadow-policy.js";
import { createFinancialShadowMetrics } from "../src/financial-shadow-model.js";
import { createMemoryFinancialShadowStateStore } from "../src/financial-shadow-store.js";
import { createFinancialShadowRuntime } from "../src/financial-shadow-runtime.js";
import { createServerEconomyPocHighValueOperation } from "../src/server-economy-poc-domain-model.js";

const PLAYER = "SHADOW_OFFLINE_ATTESTED_PLAYER";
const ENTITY = "TPA_SHADOW_OFFLINE_ATTESTED";

function policy() {
    return evaluateFinancialShadowPolicy({
        enabled: true, nodeEnv: "test", shadowEnvironment: "sandbox",
        allowlistedPlayFabIds: [PLAYER], serverId: "SHADOW_OFFLINE_ATTESTED_SERVER",
        redisConfigured: true, playFabConfigured: true
    });
}

function runtimeHarness({ offline = false } = {}) {
    const clock = { now: 10_000 };
    const metrics = createFinancialShadowMetrics();
    const runtime = createFinancialShadowRuntime({
        stateStore: createMemoryFinancialShadowStateStore(), policy: policy(), metrics,
        nowMilliseconds: () => clock.now, monotonicMilliseconds: () => clock.now,
        presenceLeaseTtlMilliseconds: 1_000,
        allowOfflineSourceAttestedProjection: offline,
        offlineSourceAttestedPlayFabId: offline ? PLAYER : null
    });
    return { clock, metrics, runtime };
}

async function bootstrap(runtime) {
    const presence = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "BOOTSTRAP_SESSION" });
    const before = await runtime.getSnapshot(PLAYER);
    const client = structuredClone(before);
    delete client.playFabId;
    await runtime.observe(PLAYER, {
        schemaVersion: 1, sessionId: presence.sessionId, sessionEpoch: presence.sessionEpoch,
        operationId: "OFFLINE_BOOTSTRAP_OPERATION", eventId: "OFFLINE_BOOTSTRAP_EVENT",
        kind: "snapshot_observation", reason: "offline_source_attested_test",
        contextId: "OFFLINE_BOOTSTRAP_CONTEXT", occurredAtUnixMs: 10_000,
        effect: {}, clientBeforeSnapshot: client, clientSnapshot: client
    }, {
        playFabId: PLAYER, titlePlayerAccountId: ENTITY,
        entity: { id: ENTITY, type: "title_player_account" }
    });
}

function operation() {
    return createServerEconomyPocHighValueOperation({
        playFabId: PLAYER, operationId: "OFFLINE_SOURCE_ATTESTED_DIAMOND_I",
        eventId: "OFFLINE_SOURCE_ATTESTED_DIAMOND_I_EVENT",
        diamonds: 500, createdAtUnixMs: 10_000
    });
}

test("offline source-attested projection remains disabled by default", async () => {
    const { clock, runtime } = runtimeHarness();
    await bootstrap(runtime);
    clock.now = 11_001;
    await assert.rejects(
        runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: operation(), sequence: 1 }),
        { code: "FINANCIAL_SHADOW_EXTERNAL_PLAYER_OFFLINE" }
    );
    assert.equal(runtime.offlineSourceAttestedProjection, false);
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 0);
});

test("explicit opt-in projects exactly once offline and delivers on reconnect", async () => {
    const { clock, metrics, runtime } = runtimeHarness({ offline: true });
    await bootstrap(runtime);
    clock.now = 11_001;
    const first = await runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: operation(), sequence: 1 });
    assert.equal(first.status, "projected");
    assert.equal(first.consumptionMode, "offline");
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 500);
    const replay = await runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: operation(), sequence: 1 });
    assert.equal(replay.status, "replayed");
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 500);
    const reconnect = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "RECONNECT_SESSION" });
    const inbox = await runtime.claimInbox({
        playFabId: PLAYER, sessionId: reconnect.sessionId,
        sessionEpoch: reconnect.sessionEpoch, limit: 10
    });
    const delivery = inbox.deliveries.find((entry) =>
        entry.operationId === "OFFLINE_SOURCE_ATTESTED_DIAMOND_I");
    assert.ok(delivery);
    assert.equal(delivery.payload.sourceAttested, true);
    assert.equal(delivery.payload.consumptionMode, "offline");
    const input = {
        playFabId: PLAYER, sessionId: reconnect.sessionId, sessionEpoch: reconnect.sessionEpoch,
        deliveryId: delivery.deliveryId, deliveryEpoch: delivery.deliveryEpoch
    };
    assert.equal((await runtime.ackDelivery(input)).status, "acked");
    assert.equal((await runtime.ackDelivery(input)).status, "already_acked");
    assert.equal(Object.entries(metrics.snapshot().counters)
        .filter(([name]) => name.startsWith("financial_shadow_external_offline_projection_total:"))
        .reduce((sum, [, value]) => sum + value, 0), 1);
    assert.equal(runtime.offlineSourceAttestedProjection, true);
});

test("offline opt-in refuses an unbootstrapped or non-allowlisted identity", async () => {
    const { clock, runtime } = runtimeHarness({ offline: true });
    clock.now = 11_001;
    await assert.rejects(
        runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: operation(), sequence: 1 }),
        { code: "FINANCIAL_SHADOW_BOOTSTRAP_REQUIRED" }
    );
    await assert.rejects(
        runtime.projectExternalPocOperation({ playFabId: "NOT_ALLOWLISTED", operation: operation(), sequence: 1 }),
        { code: "FINANCIAL_SHADOW_PLAYER_FORBIDDEN" }
    );
});

test("canonical trusted operation rejects extra fields, a forged hash, and a negative delta", async () => {
    const { clock, runtime } = runtimeHarness({ offline: true });
    await bootstrap(runtime);
    clock.now = 11_001;
    const valid = operation();
    for (const forged of [
        { ...valid, callerReward: 500 },
        { ...valid, immutableHash: "0".repeat(64) },
        { ...valid, diamonds: -500 }
    ]) {
        await assert.rejects(
            runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: forged, sequence: 1 }),
            { code: "FINANCIAL_SHADOW_EXTERNAL_OPERATION_INVALID" }
        );
    }
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 0);
});

test("concurrent offline retry allocates one strict epoch, clears expired presence, and fences stale session", async () => {
    const clock = { now: 10_000 };
    const store = createMemoryFinancialShadowStateStore();
    const makeRuntime = () => createFinancialShadowRuntime({
        stateStore: store,
        policy: policy(),
        metrics: createFinancialShadowMetrics(),
        nowMilliseconds: () => clock.now,
        monotonicMilliseconds: () => clock.now,
        presenceLeaseTtlMilliseconds: 1_000,
        maximumCasAttempts: 12,
        allowOfflineSourceAttestedProjection: true,
        offlineSourceAttestedPlayFabId: PLAYER
    });
    const workerA = makeRuntime();
    const workerB = makeRuntime();
    await bootstrap(workerA);
    const expired = await store.read(PLAYER);
    assert.equal(expired.presence.sessionEpoch, 1);
    clock.now = 11_001;
    const results = await Promise.all([
        workerA.projectExternalPocOperation({ playFabId: PLAYER, operation: operation(), sequence: 1 }),
        workerB.projectExternalPocOperation({ playFabId: PLAYER, operation: operation(), sequence: 1 })
    ]);
    assert.deepEqual(results.map((entry) => entry.status).sort(), ["projected", "replayed"]);
    const stored = await store.read(PLAYER);
    assert.equal(stored.presence, null);
    assert.equal(stored.nextSessionEpoch, 2);
    assert.equal(stored.snapshot.fencingEpoch, 2);
    assert.equal(stored.snapshot.diamonds, 500);
    await assert.rejects(workerA.heartbeatPresence({
        playFabId: PLAYER,
        sessionId: "BOOTSTRAP_SESSION",
        sessionEpoch: 1
    }), { code: "FINANCIAL_SHADOW_STALE_PRESENCE" });
    const reconnect = await workerB.registerPresence({ playFabId: PLAYER, sessionId: "POST_OFFLINE_RECONNECT" });
    assert.equal(reconnect.sessionEpoch, 3);
    assert.equal(reconnect.fencingEpoch, 3);
});
