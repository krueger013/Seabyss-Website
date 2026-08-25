import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFinancialShadowPolicy } from "../src/financial-shadow-policy.js";
import {
    createFinancialShadowInitialSnapshot,
    createFinancialShadowMetrics
} from "../src/financial-shadow-model.js";
import { createMemoryFinancialShadowStateStore } from "../src/financial-shadow-store.js";
import { createFinancialShadowRuntime } from "../src/financial-shadow-runtime.js";
import {
    createCachedPlayFabSessionTicketAuthenticator,
    createPlayFabSessionTicketAuthenticator
} from "../src/playfab-session-ticket-authenticator.js";
import { createMemoryServerEconomyPocOperationInbox } from "../src/server-economy-poc-memory-stores.js";
import { createServerEconomyPocHighValueOperation } from "../src/server-economy-poc-domain-model.js";
import { createFinancialShadowPocInboxAdapter } from "../src/financial-shadow-poc-inbox-adapter.js";
import { createFinancialShadowPocInboxService } from "../src/financial-shadow-poc-inbox-service.js";

const PLAYER = "SHADOW_SECOND_PASS_PLAYER";
const ENTITY = "TPA_SHADOW_SECOND_PASS_PLAYER";

function shadowPolicy(serverId = "SHADOW_SECOND_PASS_SERVER") {
    return evaluateFinancialShadowPolicy({
        enabled: true,
        nodeEnv: "test",
        shadowEnvironment: "test",
        allowlistedPlayFabIds: [PLAYER],
        serverId,
        redisConfigured: true,
        playFabConfigured: true
    });
}

function harness({ store = createMemoryFinancialShadowStateStore(), clock = { now: 10_000 }, history = 2000, serverId } = {}) {
    const metrics = createFinancialShadowMetrics();
    const runtime = createFinancialShadowRuntime({
        stateStore: store,
        policy: shadowPolicy(serverId),
        metrics,
        nowMilliseconds: () => clock.now,
        monotonicMilliseconds: () => clock.now,
        presenceLeaseTtlMilliseconds: 1000,
        maximumHistoryEntries: history
    });
    return { runtime, store, clock, metrics };
}

function client(snapshot, changes = {}) {
    const value = structuredClone(snapshot);
    delete value.playFabId;
    return { ...value, ...changes };
}

function observeDto({ session, before, after = {}, suffix, kind, effect, occurredAtUnixMs = 10_000 }) {
    return {
        schemaVersion: 1,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        operationId: `OP_${suffix}`,
        eventId: `EVENT_${suffix}`,
        kind,
        reason: "second_pass_test",
        contextId: `CONTEXT_${suffix}`,
        occurredAtUnixMs,
        effect,
        clientBeforeSnapshot: client(before),
        clientSnapshot: client(before, after)
    };
}

async function registerAndBootstrap(runtime, initial = null, sessionId = "SECOND_PASS_SESSION") {
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId });
    const seed = initial || await runtime.getSnapshot(PLAYER);
    const bootstrap = await runtime.observe(PLAYER, observeDto({
        session,
        before: seed,
        suffix: `BOOTSTRAP_${session.sessionEpoch}`,
        kind: "snapshot_observation",
        effect: {}
    }), { playFabId: PLAYER, titlePlayerAccountId: ENTITY, entity: { id: ENTITY, type: "title_player_account" } });
    return { session, seed, bootstrap };
}

function premium(tier, activatedAtUnixMs, expiresAtUnixMs) {
    return { tier, activatedAtUnixMs, expiresAtUnixMs };
}

test("existing-player bootstrap is explicit, non-authoritative, and seeds comparisons without provider writes", async () => {
    const { runtime, store } = harness();
    const initial = createFinancialShadowInitialSnapshot(PLAYER, 9000);
    const legacy = {
        ...initial,
        revision: 7,
        fencingEpoch: 4,
        diamonds: 1234,
        eliteBall: 9876,
        premium: premium(2, 1000, 101000),
        updatedAtUnixMs: 9000
    };
    const session = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "BOOTSTRAP_EXISTING" });
    const delta = observeDto({ session, before: initial, suffix: "MUST_BOOTSTRAP", kind: "diamonds_delta", effect: { diamondsDelta: 1 }, after: { diamonds: 1 } });
    await assert.rejects(runtime.observe(PLAYER, delta), { code: "FINANCIAL_SHADOW_BOOTSTRAP_REQUIRED" });
    const result = await runtime.observe(PLAYER, observeDto({ session, before: legacy, suffix: "EXISTING", kind: "snapshot_observation", effect: {} }), {
        playFabId: PLAYER, titlePlayerAccountId: ENTITY, entity: { id: ENTITY, type: "title_player_account" }
    });
    assert.equal(result.sourceAttested, false);
    assert.equal(result.mismatch.economicMatch, true);
    assert.equal(result.modelSnapshot.revision, legacy.revision + 1);
    assert.equal(result.modelSnapshot.fencingEpoch, session.sessionEpoch);
    assert.equal(result.modelSnapshot.diamonds, 1234);
    assert.equal(result.modelSnapshot.eliteBall, 9876);
    assert.deepEqual(result.modelSnapshot.premium, legacy.premium);
    assert.equal(runtime.targetPlayFabWritesAllowed, false);
    const state = await store.read(PLAYER);
    assert.equal(state.bootstrap.status, "client_observed_non_authoritative");
    assert.equal(state.bootstrap.sourceAttested, false);
    assert.equal(state.bootstrap.titlePlayerAccountDerived, true);
});

test("semantic Premium grants deterministically extend, upgrade, and detect a forged Legacy-after", async () => {
    const { runtime } = harness();
    const { session } = await registerAndBootstrap(runtime);
    let before = await runtime.getSnapshot(PLAYER);
    const bronzeExpiry = 10_000 + 86_400_000;
    let result = await runtime.observe(PLAYER, observeDto({
        session, before, suffix: "BRONZE", kind: "premium_observation",
        effect: { tier: 1, durationSeconds: 86_400, effectiveAtUnixMs: 10_000 },
        after: { premium: premium(1, 10_000, bronzeExpiry) }
    }));
    assert.equal(result.mismatch.severity, "none");
    before = result.modelSnapshot;
    const extendedExpiry = bronzeExpiry + 86_400_000;
    result = await runtime.observe(PLAYER, observeDto({
        session, before, suffix: "BRONZE_EXTENSION", kind: "premium_observation", occurredAtUnixMs: 20_000,
        effect: { tier: 1, durationSeconds: 86_400, effectiveAtUnixMs: 20_000 },
        after: { premium: premium(1, 10_000, extendedExpiry) }
    }));
    assert.equal(result.mismatch.severity, "none");
    before = result.modelSnapshot;
    const goldExpiry = extendedExpiry + 86_400_000;
    result = await runtime.observe(PLAYER, observeDto({
        session, before, suffix: "GOLD", kind: "premium_observation", occurredAtUnixMs: 30_000,
        effect: { tier: 3, durationSeconds: 86_400, effectiveAtUnixMs: 30_000 },
        after: { premium: premium(1, 10_000, goldExpiry) }
    }));
    assert.equal(result.modelSnapshot.premium.tier, 3);
    assert.equal(result.modelSnapshot.premium.expiresAtUnixMs, goldExpiry);
    assert.equal(result.mismatch.severity, "critical");
    assert.equal(result.mismatch.domainMatches.Premium, false);
});

test("expired Premium normalizes to None for read and subsequent domain comparisons", async () => {
    const { runtime, clock } = harness();
    const initial = {
        ...createFinancialShadowInitialSnapshot(PLAYER, 9000),
        premium: premium(1, 1000, 10_500),
        updatedAtUnixMs: 9000
    };
    const { session } = await registerAndBootstrap(runtime, initial, "PREMIUM_EXPIRY_SESSION");
    clock.now = 10_600;
    const normalized = await runtime.getSnapshot(PLAYER);
    assert.deepEqual(normalized.premium, premium(0, null, null));
    const result = await runtime.observe(PLAYER, observeDto({
        session,
        before: normalized,
        suffix: "AFTER_PREMIUM_EXPIRY",
        kind: "diamonds_delta",
        effect: { diamondsDelta: 1 },
        occurredAtUnixMs: 10_600,
        after: { diamonds: 1 }
    }));
    assert.equal(result.mismatch.severity, "none");
    assert.deepEqual(result.modelSnapshot.premium, premium(0, null, null));
});

test("delayed Premium observation stacks at effective time while current read remains expired", async () => {
    const { runtime, store, clock } = harness();
    const initial = {
        ...createFinancialShadowInitialSnapshot(PLAYER, 9000),
        premium: premium(1, 9000, 10_100),
        updatedAtUnixMs: 9000
    };
    await registerAndBootstrap(runtime, initial, "PREMIUM_DELAYED_ORIGINAL_SESSION");
    clock.now = 12_000;
    const renewed = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "PREMIUM_DELAYED_RENEWED_SESSION" });
    const historicalAfter = premium(1, 9000, 11_100);
    const dto = observeDto({
        session: renewed,
        before: initial,
        suffix: "PREMIUM_DELAYED_EFFECTIVE_TIME",
        kind: "premium_observation",
        effect: { tier: 1, durationSeconds: 1, effectiveAtUnixMs: 10_050 },
        occurredAtUnixMs: 10_050,
        after: { premium: historicalAfter }
    });
    const result = await runtime.observe(PLAYER, dto);
    assert.equal(result.status, "observed");
    assert.equal(result.mismatch.severity, "none");
    assert.deepEqual(result.modelSnapshot.premium, historicalAfter);
    assert.deepEqual(result.delivery.payload.modelSnapshot.premium, historicalAfter);
    assert.deepEqual((await runtime.getSnapshot(PLAYER)).premium, premium(0, null, null));
    const durable = await store.read(PLAYER);
    assert.deepEqual(durable.snapshot.premium, historicalAfter);
    const replay = await runtime.observe(PLAYER, dto);
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.modelSnapshot.premium, historicalAfter);
});

test("observation replay survives a renewed session epoch but economic intent changes conflict", async () => {
    const { runtime, clock } = harness();
    const { session } = await registerAndBootstrap(runtime);
    const before = await runtime.getSnapshot(PLAYER);
    const original = observeDto({ session, before, suffix: "RENEWED_REPLAY", kind: "diamonds_delta", effect: { diamondsDelta: 5 }, after: { diamonds: 5 } });
    assert.equal((await runtime.observe(PLAYER, original)).status, "observed");
    clock.now += 1001;
    const renewed = await runtime.registerPresence({ playFabId: PLAYER, sessionId: "SECOND_PASS_SESSION_RENEWED" });
    const replay = { ...original, sessionId: renewed.sessionId, sessionEpoch: renewed.sessionEpoch };
    assert.equal((await runtime.observe(PLAYER, replay)).status, "replayed");
    await assert.rejects(runtime.observe(PLAYER, { ...replay, effect: { diamondsDelta: 6 } }), { code: "FINANCIAL_SHADOW_IDEMPOTENCY_CONFLICT" });
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 5);
});

test("durable evidence preserves user/source/event/time and Legacy plus Shadow before/after", async () => {
    const { runtime, store } = harness();
    const { session } = await registerAndBootstrap(runtime);
    const before = await runtime.getSnapshot(PLAYER);
    const dto = observeDto({ session, before, suffix: "EVIDENCE", kind: "diamonds_delta", effect: { diamondsDelta: 9 }, after: { diamonds: 9 } });
    await runtime.observe(PLAYER, dto);
    const state = await store.read(PLAYER);
    const record = state.observations.find((entry) => entry.operationId === dto.operationId);
    assert.deepEqual(Object.keys(record.evidence).sort(), ["legacy", "operation", "schemaVersion", "shadow", "source", "sourceAttested", "user"]);
    assert.equal(record.evidence.user.playFabId, PLAYER);
    assert.equal(record.evidence.source, "unity_shadow_telemetry");
    assert.equal(record.evidence.operation.reason, dto.reason);
    assert.equal(record.evidence.operation.contextId, dto.contextId);
    assert.equal(record.evidence.operation.occurredAtUnixMs, dto.occurredAtUnixMs);
    assert.equal(record.evidence.legacy.before.diamonds, 0);
    assert.equal(record.evidence.legacy.after.diamonds, 9);
    assert.equal(record.evidence.shadow.before.diamonds, 0);
    assert.equal(record.evidence.shadow.after.diamonds, 9);
});

test("Elite pending then Diamonds then Elite flush has no cross-domain false mismatch", async () => {
    const { runtime, metrics } = harness();
    const { session } = await registerAndBootstrap(runtime);
    const beforeDiamonds = await runtime.getSnapshot(PLAYER);
    const diamonds = observeDto({
        session,
        before: beforeDiamonds,
        suffix: "INTERLEAVED_DIAMONDS",
        kind: "diamonds_delta",
        effect: { diamondsDelta: 2 },
        after: { diamonds: 2, eliteBall: 5 }
    });
    diamonds.clientBeforeSnapshot = client(beforeDiamonds, { eliteBall: 5 });
    const diamondResult = await runtime.observe(PLAYER, diamonds);
    assert.equal(diamondResult.mismatch.severity, "none");
    assert.equal(diamondResult.mismatch.economicMatch, true);
    const beforeEliteFlush = await runtime.getSnapshot(PLAYER);
    const eliteResult = await runtime.observe(PLAYER, observeDto({
        session,
        before: beforeEliteFlush,
        suffix: "INTERLEAVED_ELITE_FLUSH",
        kind: "elite_ball_delta",
        effect: { eliteBallDelta: 5, eventCount: 1 },
        after: { eliteBall: 5 }
    }));
    assert.equal(eliteResult.mismatch.severity, "none");
    assert.equal(eliteResult.mismatch.economicMatch, true);
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 2);
    assert.equal((await runtime.getSnapshot(PLAYER)).eliteBall, 5);
    assert.equal(metrics.contractSnapshot().shadow_mismatch_count, 0);
});

test("ACKed history compacts to a bounded replay tombstone and never silently reapplies retired operations", async () => {
    const { runtime, store } = harness({ history: 4 });
    const { session, bootstrap } = await registerAndBootstrap(runtime);
    async function drain() {
        const inbox = await runtime.claimInbox({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch, limit: 100 });
        for (const delivery of inbox.deliveries) {
            await runtime.ackDelivery({ playFabId: PLAYER, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch, deliveryId: delivery.deliveryId, deliveryEpoch: delivery.deliveryEpoch });
        }
    }
    await drain();
    for (let index = 1; index <= 8; index += 1) {
        const before = await runtime.getSnapshot(PLAYER);
        await runtime.observe(PLAYER, observeDto({ session, before, suffix: `COMPACT_${index}`, kind: "diamonds_delta", effect: { diamondsDelta: 1 }, after: { diamonds: before.diamonds + 1 } }));
        await drain();
    }
    const state = await store.read(PLAYER);
    assert.ok(state.observations.length < 4);
    assert.ok(state.deliveries.length < 4);
    assert.ok(state.diagnostics.compactedObservationCount > 0);
    await assert.rejects(runtime.observe(PLAYER, {
        schemaVersion: 1,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        operationId: bootstrap.operationId,
        eventId: bootstrap.eventId,
        kind: "snapshot_observation",
        reason: "second_pass_test",
        contextId: `CONTEXT_BOOTSTRAP_${session.sessionEpoch}`,
        occurredAtUnixMs: 10_000,
        effect: {},
        clientBeforeSnapshot: client(createFinancialShadowInitialSnapshot(PLAYER, 10_000)),
        clientSnapshot: client(createFinancialShadowInitialSnapshot(PLAYER, 10_000))
    }), { code: "FINANCIAL_SHADOW_RETIRED_REPLAY" });
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 8);
});

test("session authenticator derives complete TPA identity and bounded digest cache has cold/warm semantics", async () => {
    let providerCalls = 0;
    let now = 1000;
    const provider = createPlayFabSessionTicketAuthenticator({
        titleId: "142853",
        secretKey: "LOCAL_MOCK_SECRET_NEVER_LOGGED",
        fetchImpl: async () => {
            providerCalls += 1;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                async text() {
                    return JSON.stringify({ code: 200, data: { IsSessionTicketExpired: false, UserInfo: {
                        PlayFabId: PLAYER,
                        TitleInfo: { TitlePlayerAccount: { Id: ENTITY, Type: "title_player_account" } }
                    } } });
                }
            };
        }
    });
    const cached = createCachedPlayFabSessionTicketAuthenticator({ authenticate: provider, ttlMilliseconds: 500, maximumEntries: 2, nowMilliseconds: () => now });
    const ticket = "VALID_PLAYFAB_SESSION_TICKET_SECOND_PASS";
    const [first, concurrent] = await Promise.all([cached.authenticate(ticket), cached.authenticate(ticket)]);
    assert.deepEqual(first, concurrent);
    assert.equal(first.playFabId, PLAYER);
    assert.equal(first.titlePlayerAccountId, ENTITY);
    assert.deepEqual(first.entity, { id: ENTITY, type: "title_player_account" });
    assert.equal(providerCalls, 1);
    assert.equal((await cached.authenticate(ticket)).playFabId, PLAYER);
    assert.equal(providerCalls, 1);
    now += 501;
    await cached.authenticate(ticket);
    assert.equal(providerCalls, 2);
    const diagnostics = cached.diagnostics();
    assert.equal(diagnostics.storesRawTickets, false);
    assert.equal(JSON.stringify(diagnostics).includes(ticket), false);
    assert.equal(diagnostics.missCount, 2);
    assert.ok(diagnostics.hitCount >= 2);
});

function durableMirrorInbox(clock) {
    const memory = createMemoryServerEconomyPocOperationInbox({ nowMilliseconds: () => clock.now });
    return Object.freeze({ ...memory, durable: true, shadowProjectionOnly: true, deterministicMemoryMock: true });
}

test("delayed external Premium projections preserve raw stacking history and expose a current view", async () => {
    const { runtime, store, clock } = harness({ serverId: "SHADOW_DELAYED_PROJECTION_SERVER" });
    const initial = {
        ...createFinancialShadowInitialSnapshot(PLAYER, 9000),
        premium: premium(1, 9000, 10_100),
        updatedAtUnixMs: 9000
    };
    await registerAndBootstrap(runtime, initial, "DELAYED_PROJECTION_ORIGINAL_SESSION");
    clock.now = 12_000;
    await runtime.registerPresence({ playFabId: PLAYER, sessionId: "DELAYED_PROJECTION_RENEWED_SESSION" });
    const firstOperation = createServerEconomyPocHighValueOperation({
        playFabId: PLAYER,
        operationId: "DELAYED_PREMIUM_PROJECTION_1",
        eventId: "DELAYED_PREMIUM_PROJECTION_EVENT_1",
        premium: { tier: "bronze", durationSeconds: 1 },
        createdAtUnixMs: 10_050
    });
    const first = await runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: firstOperation, sequence: 1 });
    assert.equal(first.status, "projected");
    assert.deepEqual(first.modelSnapshot.premium, premium(0, null, null));
    assert.deepEqual(first.delivery.payload.modelSnapshot.premium, premium(0, null, null));
    let durable = await store.read(PLAYER);
    assert.deepEqual(durable.snapshot.premium, premium(1, 9000, 11_100));
    assert.equal(durable.snapshot.updatedAtUnixMs, 12_000);

    const secondOperation = createServerEconomyPocHighValueOperation({
        playFabId: PLAYER,
        operationId: "DELAYED_PREMIUM_PROJECTION_2",
        eventId: "DELAYED_PREMIUM_PROJECTION_EVENT_2",
        premium: { tier: "gold", durationSeconds: 1 },
        createdAtUnixMs: 10_500
    });
    const second = await runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: secondOperation, sequence: 2 });
    assert.equal(second.status, "projected");
    assert.deepEqual(second.modelSnapshot.premium, premium(3, 9000, 12_100));
    durable = await store.read(PLAYER);
    assert.deepEqual(durable.snapshot.premium, premium(3, 9000, 12_100));
    assert.equal(durable.snapshot.updatedAtUnixMs, 12_000);

    const replay = await runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: firstOperation, sequence: 1 });
    assert.equal(replay.status, "replayed");
    durable = await store.read(PLAYER);
    assert.equal(durable.snapshot.highValueAppliedThroughSequence, 2);
    assert.deepEqual(durable.snapshot.premium, premium(3, 9000, 12_100));
});

test("external canonical POC mirror projects then ACKs durably, and crash after projection reconciles without duplicate", async () => {
    const clock = { now: 10_000 };
    const store = createMemoryFinancialShadowStateStore();
    const { runtime } = harness({ store, clock, serverId: "SHADOW_POC_SERVER" });
    await registerAndBootstrap(runtime, null, "POC_ONLINE_SESSION");
    const inbox = durableMirrorInbox(clock);
    const operation = createServerEconomyPocHighValueOperation({
        playFabId: PLAYER,
        operationId: "POC_EXTERNAL_STARTER_I",
        eventId: "POC_EXTERNAL_STARTER_I_EVENT",
        diamonds: 1000,
        eliteBall: 13000,
        premium: { tier: "bronze", durationSeconds: 86400 },
        createdAtUnixMs: 10_000
    });
    const crashing = createFinancialShadowPocInboxAdapter({
        operationInbox: inbox,
        runtime,
        serverId: "SHADOW_POC_SERVER",
        hooks: { afterProjectionBeforeAck() { const error = new Error("simulated crash"); error.code = "FINANCIAL_SHADOW_TEST_CRASH"; throw error; } }
    });
    await crashing.enqueueCanonicalProjection(operation);
    await assert.rejects(crashing.consumeNext(PLAYER), { code: "FINANCIAL_SHADOW_TEST_CRASH" });
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 1000);
    const restarted = createFinancialShadowPocInboxAdapter({ operationInbox: inbox, runtime, serverId: "SHADOW_POC_SERVER" });
    const recovery = await restarted.consumeNext(PLAYER);
    assert.equal(recovery.status, "projected_and_acked");
    assert.equal(recovery.projection.status, "replayed");
    const record = await inbox.get(PLAYER, operation.operationId);
    assert.equal(record.state, "Acked");
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 1000);
    assert.equal((await runtime.getSnapshot(PLAYER)).eliteBall, 13000);
    assert.equal((await runtime.getSnapshot(PLAYER)).premium.tier, 1);
    assert.equal(restarted.acknowledgesAuthoritativeInbox, false);
});

test("persistent mirror service is fail-closed for authoritative inbox and runs projection-only lifecycle", async () => {
    const clock = { now: 10_000 };
    const { runtime } = harness({ clock, serverId: "SHADOW_SERVICE_SERVER" });
    await registerAndBootstrap(runtime, null, "SERVICE_SESSION");
    const authoritative = createMemoryServerEconomyPocOperationInbox({ nowMilliseconds: () => clock.now });
    assert.throws(() => createFinancialShadowPocInboxService({
        operationInbox: authoritative, runtime, serverId: "SHADOW_SERVICE_SERVER"
    }), /durable projection-only/u);
    const inbox = durableMirrorInbox(clock);
    let scheduled = null;
    const service = createFinancialShadowPocInboxService({
        operationInbox: inbox,
        runtime,
        serverId: "SHADOW_SERVICE_SERVER",
        setIntervalImpl(callback) { scheduled = callback; return { unref() {} }; },
        clearIntervalImpl() { scheduled = null; }
    });
    assert.equal(service.start().status, "started");
    assert.equal(typeof scheduled, "function");
    const operation = createServerEconomyPocHighValueOperation({
        playFabId: PLAYER, operationId: "SERVICE_DIAMONDS", eventId: "SERVICE_DIAMONDS_EVENT",
        diamonds: 50, createdAtUnixMs: 10_000
    });
    await service.enqueueCanonicalProjection(operation);
    await service.drainOnce();
    assert.equal((await inbox.get(PLAYER, operation.operationId)).state, "Acked");
    assert.equal(service.health().healthy, true);
    assert.equal(service.health().projectionOnly, true);
    assert.equal(service.health().authoritativeInboxAcknowledged, false);
    assert.equal((await service.stop()).status, "stopped");
    assert.equal(service.health().running, false);
});
test("offline player defers without failing the loop or starving a later online player", async () => {
    const clock = { now: 10_000 };
    const inbox = durableMirrorInbox(clock);
    const offlinePlayer = "SHADOW_OFFLINE_FIRST";
    const onlinePlayer = "SHADOW_ONLINE_SECOND";
    const offlineOperation = createServerEconomyPocHighValueOperation({
        playFabId: offlinePlayer, operationId: "OFFLINE_PENDING_OPERATION",
        eventId: "OFFLINE_PENDING_EVENT", diamonds: 5, createdAtUnixMs: clock.now
    });
    const onlineOperation = createServerEconomyPocHighValueOperation({
        playFabId: onlinePlayer, operationId: "ONLINE_PROJECTED_OPERATION",
        eventId: "ONLINE_PROJECTED_EVENT", diamonds: 7, createdAtUnixMs: clock.now
    });
    await inbox.submit(offlineOperation);
    await inbox.submit(onlineOperation);
    const projected = [];
    const service = createFinancialShadowPocInboxService({
        operationInbox: inbox,
        serverId: "SHADOW_FAIR_SERVICE",
        runtime: {
            async projectExternalPocOperation({ playFabId, operation }) {
                if (playFabId === offlinePlayer) {
                    const error = new Error("offline");
                    error.code = "FINANCIAL_SHADOW_EXTERNAL_PLAYER_OFFLINE";
                    throw error;
                }
                projected.push(operation.operationId);
                return { delivery: { deliveryId: `DELIVERY_${operation.operationId}` } };
            }
        },
        setIntervalImpl() { return { unref() {} }; },
        clearIntervalImpl() {}
    });
    service.start();
    const result = await service.drainOnce();
    assert.equal(result.status, "ok");
    assert.equal(result.deferredPlayerCount, 1);
    assert.deepEqual(projected, [onlineOperation.operationId]);
    assert.equal((await inbox.get(offlinePlayer, offlineOperation.operationId)).state, "Pending");
    assert.equal((await inbox.get(onlinePlayer, onlineOperation.operationId)).state, "Acked");
    assert.equal(service.health().healthy, true);
    assert.equal(service.health().loopFailureCount, 0);
    assert.equal(service.health().deferredPlayerCount, 1);
    await service.stop();
});

test("external POC eventId uniqueness rejects a second operation without a second projection", async () => {
    const { runtime } = harness({ serverId: "SHADOW_EVENT_SERVER" });
    await registerAndBootstrap(runtime, null, "EVENT_SESSION");
    const first = createServerEconomyPocHighValueOperation({ playFabId: PLAYER, operationId: "EXTERNAL_A", eventId: "EXTERNAL_SHARED_EVENT", diamonds: 7, createdAtUnixMs: 10_000 });
    const second = createServerEconomyPocHighValueOperation({ playFabId: PLAYER, operationId: "EXTERNAL_B", eventId: "EXTERNAL_SHARED_EVENT", diamonds: 11, createdAtUnixMs: 10_000 });
    await runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: first, sequence: 1 });
    await assert.rejects(runtime.projectExternalPocOperation({ playFabId: PLAYER, operation: second, sequence: 2 }), { code: "FINANCIAL_SHADOW_EVENT_CONFLICT" });
    assert.equal((await runtime.getSnapshot(PLAYER)).diamonds, 7);
});
