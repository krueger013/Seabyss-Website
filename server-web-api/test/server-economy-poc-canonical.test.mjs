import test from "node:test";
import assert from "node:assert/strict";
import {
    createCanonicalMemoryServerEconomyPocHarness,
    createCanonicalServerEconomyPoc
} from "../src/server-economy-poc-canonical.js";
import {
    createValidatedServerEconomyPocReceiptProjectionForTests as receipt
} from "../src/server-economy-poc-receipt-mapper.js";
import {
    mapValidatedXsollaReceiptToFinalServerEconomyPocOperation
} from "../src/server-economy-poc-receipt-mapper-final.js";
import { ServerEconomyPocSimulatedCrash } from "../src/server-economy-poc-engine.js";

const player = "POC_PLAYER";

function projection(sku, transactionId, effectiveAtUnixMs = 1_000_000) {
    return receipt({
        playFabId: player,
        providerTransactionId: transactionId,
        sku,
        effectiveAtUnixMs
    });
}

function secondPoc(harness, options = {}) {
    return createCanonicalServerEconomyPoc({
        snapshotStore: harness.stores.snapshotStore,
        walStore: harness.stores.walStore,
        operationInbox: harness.stores.operationInbox,
        playerLeases: harness.stores.leases,
        gameplayResolutionStore: harness.stores.gameplayResolutionStore,
        metrics: harness.metrics,
        authorizeGameplay: async ({ playFabId }) => ({ authorized: true, playFabId }),
        authorizeSession: async (input) => ({
            authorized: true,
            playFabId: input.playFabId,
            sessionId: input.sessionId,
            sessionEpoch: input.sessionEpoch,
            principal: { kind: "local_test_server" }
        }),
        nowMilliseconds: () => harness.clock.now,
        ...options
    });
}

test("server plans map Diamond-only, Starter I and Premium-only exactly", () => {
    const diamond = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(
        projection("seabyss_diamond_pack_1", "TX_DIAMOND")
    );
    assert.deepEqual(
        { diamonds: diamond.diamonds, eliteBall: diamond.eliteBall, premium: diamond.premium },
        { diamonds: 500, eliteBall: 0, premium: null }
    );

    const starter = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(
        projection("seabyss_starter_pack_1", "TX_STARTER")
    );
    assert.deepEqual(
        { diamonds: starter.diamonds, eliteBall: starter.eliteBall, premium: starter.premium },
        { diamonds: 1000, eliteBall: 13000, premium: { tier: "bronze", durationSeconds: 86400 } }
    );

    const premium = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(
        projection("seabyss_premium_gold", "TX_PREMIUM")
    );
    assert.deepEqual(
        { diamonds: premium.diamonds, eliteBall: premium.eliteBall, premium: premium.premium },
        { diamonds: 0, eliteBall: 0, premium: { tier: "gold", durationSeconds: 30 * 86400 } }
    );
    assert.equal(diamond.source, "server_product_plan");
});

test("receipt projection rejects caller supplied economics", () => {
    const forged = { ...projection("seabyss_diamond_pack_1", "TX_FORGED"), diamonds: 999999 };
    assert.throws(
        () => mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(forged),
        { code: "POC_CLIENT_ECONOMICS_REJECTED" }
    );
});

test("Starter I writes one canonical snapshot and read snapshots are immutable", async () => {
    const { poc } = createCanonicalMemoryServerEconomyPocHarness();
    const result = await poc.consumeValidatedXsollaReceipt(
        projection("seabyss_starter_pack_1", "TX_STARTER_APPLY"),
        { preferOnline: false }
    );
    assert.equal(result.consumed.status, "applied");
    const snapshot = await poc.readSnapshot(player);
    assert.equal(snapshot.diamonds, 1000);
    assert.equal(snapshot.eliteBall, 13000);
    assert.deepEqual(snapshot.premium, {
        tier: 1,
        activatedAtUnixMs: 1_000_000,
        expiresAtUnixMs: 1_000_000 + 86400_000
    });
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.highValueAppliedThroughSequence, 1);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.premium), true);
    assert.throws(() => { snapshot.diamonds = 7; }, TypeError);
});

test("same receipt replay at a different clock is exactly once", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const projectionValue = projection("seabyss_diamond_pack_1", "TX_REPLAY");
    const first = await harness.poc.consumeValidatedXsollaReceipt(projectionValue, { preferOnline: false });
    harness.clock.now += 123_456;
    const replay = await harness.poc.consumeValidatedXsollaReceipt(projectionValue, { preferOnline: false });
    assert.equal(first.submitted.status, "submitted");
    assert.equal(replay.submitted.status, "existing");
    assert.equal(replay.consumed.status, "already_acked");
    assert.equal((await harness.poc.readSnapshot(player)).diamonds, 500);
});

test("provider transaction owns identity even if a different SKU is replayed", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    await harness.poc.enqueueValidatedXsollaReceipt(
        projection("seabyss_diamond_pack_1", "TX_PROVIDER_UNIQUE")
    );
    await assert.rejects(
        harness.poc.enqueueValidatedXsollaReceipt(
            projection("seabyss_diamond_pack_2", "TX_PROVIDER_UNIQUE")
        ),
        { code: "POC_PROVIDER_TRANSACTION_CONFLICT" }
    );
});

test("crash after snapshot CAS before ACK reconciles without a double grant", async () => {
    let crash = true;
    const harness = createCanonicalMemoryServerEconomyPocHarness({
        hooks: {
            afterSnapshotCas({ domain }) {
                if (domain === "high_value" && crash) {
                    crash = false;
                    throw new ServerEconomyPocSimulatedCrash("after_snapshot_before_ack");
                }
            }
        }
    });
    const enqueued = await harness.poc.enqueueValidatedXsollaReceipt(
        projection("seabyss_starter_pack_1", "TX_CRASH")
    );
    await assert.rejects(
        harness.poc.consumers.consumeHighValue({
            playFabId: player,
            operationId: enqueued.operation.operationId,
            preferOnline: false
        }),
        { code: "POC_SIMULATED_CRASH" }
    );
    const afterCrash = await harness.poc.readSnapshot(player);
    const expiry = afterCrash.premium.expiresAtUnixMs;
    assert.equal(afterCrash.diamonds, 1000);
    harness.clock.now += 20_000;
    const resumed = secondPoc(harness);
    const recovered = await resumed.consumers.consumeHighValue({
        playFabId: player,
        operationId: enqueued.operation.operationId,
        preferOnline: false
    });
    assert.equal(recovered.status, "recovered_after_snapshot");
    const final = await resumed.readSnapshot(player);
    assert.equal(final.diamonds, 1000);
    assert.equal(final.eliteBall, 13000);
    assert.equal(final.premium.expiresAtUnixMs, expiry);
    assert.equal((await resumed.engine.stores.operationInbox.get(player, enqueued.operation.operationId)).state, "Acked");
});

test("old receipt uses durable Premium time but never regresses snapshot updatedAt", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness({ clock: { now: 2_000_000 } });
    await harness.poc.consumeValidatedXsollaReceipt(
        projection("seabyss_premium_gold", "TX_NEWER", 2_000_000),
        { preferOnline: false }
    );
    const first = await harness.poc.readSnapshot(player);
    harness.clock.now = 5_000_000;
    await harness.poc.consumeValidatedXsollaReceipt(
        projection("seabyss_starter_pack_1", "TX_OLDER", 1_000_000),
        { preferOnline: false }
    );
    const final = await harness.poc.readSnapshot(player);
    assert.equal(final.updatedAtUnixMs, 5_000_000);
    assert.ok(final.updatedAtUnixMs >= first.updatedAtUnixMs);
    assert.equal(final.premium.tier, 3);
    assert.equal(final.premium.expiresAtUnixMs, first.premium.expiresAtUnixMs + 86400_000);
});

test("scheduled tick routes a registered player online and publishes the snapshot", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const deliveries = [];
    harness.poc.registerOnlineSession({
        playFabId: player,
        sessionId: "ONLINE_SESSION",
        beforeAuthoritativeMutation: async () => ({ acknowledged: true, hotStateDrained: true }),
        onSnapshot: async (snapshot, metadata) => deliveries.push({ snapshot, metadata })
    });
    await harness.poc.enqueueValidatedXsollaReceipt(
        projection("seabyss_diamond_pack_1", "TX_ONLINE")
    );
    const tick = await harness.poc.offlineTick();
    assert.equal(tick.highValue[0].consumer, "online");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].snapshot.diamonds, 500);
    assert.equal(deliveries[0].metadata.source, "high_value_drain_after_hot_state_flush");
});

test("offline worker consumes the same durable inbox without a login", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    await harness.poc.enqueueValidatedXsollaReceipt(
        projection("seabyss_diamond_pack_1", "TX_OFFLINE")
    );
    const tick = await harness.poc.offlineTick();
    assert.equal(tick.highValue[0].consumer, "offline");
    assert.equal((await harness.poc.readSnapshot(player)).diamonds, 500);
});

test("two workers race one receipt and canonical balance changes once", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const peer = secondPoc(harness);
    const enqueued = await harness.poc.enqueueValidatedXsollaReceipt(
        projection("seabyss_diamond_pack_1", "TX_TWO_WORKERS")
    );
    const settled = await Promise.allSettled([
        harness.poc.engine.processHighValueOperation({ playFabId: player, operationId: enqueued.operation.operationId }),
        peer.engine.processHighValueOperation({ playFabId: player, operationId: enqueued.operation.operationId })
    ]);
    assert.ok(settled.some((entry) => entry.status === "fulfilled"));
    assert.equal((await harness.poc.readSnapshot(player)).diamonds, 500);
    assert.equal((await harness.poc.readSnapshot(player)).revision, 1);
});

test("expired worker is fenced after a second worker resumes", async () => {
    let enteredResolve;
    let resumeResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const resume = new Promise((resolve) => { resumeResolve = resolve; });
    const harness = createCanonicalMemoryServerEconomyPocHarness({
        hooks: {
            async afterInboxClaim() {
                enteredResolve();
                await resume;
            }
        }
    });
    const enqueued = await harness.poc.enqueueValidatedXsollaReceipt(
        projection("seabyss_diamond_pack_1", "TX_STALE")
    );
    const staleAttempt = harness.poc.engine.processHighValueOperation({
        playFabId: player,
        operationId: enqueued.operation.operationId
    });
    await entered;
    harness.clock.now += 20_000;
    const winner = secondPoc(harness);
    const result = await winner.engine.processHighValueOperation({
        playFabId: player,
        operationId: enqueued.operation.operationId
    });
    resumeResolve();
    assert.equal(result.status, "applied");
    await assert.rejects(staleAttempt, { code: "POC_STALE_WRITER" });
    assert.equal((await winner.readSnapshot(player)).diamonds, 500);
});

test("ammo event retry is stable and 100 shots flush in four provider calls", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness({ ammoBatchSize: 25 });
    await harness.poc.consumeValidatedXsollaReceipt(
        projection("seabyss_starter_pack_1", "TX_AMMO_SEED"),
        { preferOnline: false }
    );
    const first = await harness.poc.engine.appendEliteBallDelta({
        playFabId: player,
        eventId: "SHOT_0",
        delta: -1,
        reason: "combat_shot"
    });
    harness.clock.now += 1000;
    const retry = await harness.poc.engine.appendEliteBallDelta({
        playFabId: player,
        eventId: "SHOT_0",
        delta: -1,
        reason: "combat_shot"
    });
    assert.equal(first.status, "appended");
    assert.equal(retry.status, "existing");
    await assert.rejects(
        harness.poc.engine.appendEliteBallDelta({
            playFabId: player,
            eventId: "SHOT_0",
            delta: -2,
            reason: "combat_shot"
        }),
        { code: "POC_WAL_IDEMPOTENCY_CONFLICT" }
    );
    for (let index = 1; index < 100; index += 1) {
        await harness.poc.engine.appendEliteBallDelta({
            playFabId: player,
            eventId: `SHOT_${index}`,
            delta: -1,
            reason: "combat_shot"
        });
    }
    let flushes = 0;
    for (;;) {
        const result = await harness.poc.engine.flushEliteBall(player, { batchSize: 25, consumer: "test" });
        if (result.status === "empty") break;
        flushes += 1;
    }
    assert.equal(flushes, 4);
    assert.equal((await harness.poc.readSnapshot(player)).eliteBall, 12900);
    const metrics = harness.poc.metricsSnapshot();
    assert.equal(metrics.counters["wal_append_total|"], 100);
    assert.equal(metrics.counters["provider_call_total|domain=elite_ball_flush"], 4);
    assert.equal(metrics.counters["snapshot_write_total|domain=elite_ball_flush"], 4);
});

test("trusted Diamonds grant, spend, terminal insufficient result and later operation", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const dto = (operationId, eventId, diamondsDelta) => ({
        playFabId: player,
        sessionId: "SESSION",
        sessionEpoch: 1,
        operationId,
        eventId,
        diamondsDelta,
        reason: "quest_reward",
        contextId: "QUEST_1"
    });
    assert.equal((await harness.poc.trustedDiamonds.execute(dto("GRANT_10", "EVENT_GRANT", 10))).consumed.status, "applied");
    await harness.poc.trustedDiamonds.enqueue(dto("SPEND_A", "EVENT_SPEND_A", -7));
    await harness.poc.trustedDiamonds.enqueue(dto("SPEND_B", "EVENT_SPEND_B", -7));
    assert.equal((await harness.poc.engine.processNextHighValue(player)).status, "applied");
    assert.equal((await harness.poc.engine.processNextHighValue(player)).status, "rejected_insufficient_funds");
    assert.equal((await harness.poc.trustedDiamonds.execute(dto("LATER", "EVENT_LATER", 2))).consumed.status, "applied");
    const snapshot = await harness.poc.readSnapshot(player);
    assert.equal(snapshot.diamonds, 5);
    assert.equal(snapshot.highValueAppliedThroughSequence, 4);
});

test("trusted DTO rejects client financial metadata and binds eventId uniquely", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const base = {
        playFabId: player,
        sessionId: "SESSION",
        sessionEpoch: 1,
        operationId: "OP_A",
        eventId: "EVENT_UNIQUE",
        diamondsDelta: 1,
        reason: "quest_reward",
        contextId: "QUEST_1"
    };
    await assert.rejects(
        harness.poc.trustedDiamonds.execute({ ...base, balance: 999 }),
        { code: "POC_TRUSTED_DIAMONDS_DTO_INVALID" }
    );
    await harness.poc.trustedDiamonds.enqueue(base);
    await assert.rejects(
        harness.poc.trustedDiamonds.enqueue({ ...base, operationId: "OP_B" }),
        { code: "POC_EVENT_IDEMPOTENCY_CONFLICT" }
    );
    const replay = await harness.poc.trustedDiamonds.enqueue(base);
    assert.equal(replay.submitted.status, "existing");
});

test("trusted gameplay Premium uses numeric tier and durable effective time", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const result = await harness.poc.gameplay.submitAndConsumeTrustedGameplayOperation({
        principal: { kind: "local_test_server" },
        playFabId: player,
        operationId: "GAMEPLAY_PREMIUM",
        diamondsDelta: 1,
        premium: { tier: "silver", durationSeconds: 3600 },
        reason: "admin_test_reward",
        context: { contextId: "ADMIN_CASE" },
        effectiveAtUnixMs: 900_000
    });
    assert.equal(result.consumed.status, "applied");
    assert.deepEqual((await harness.poc.readSnapshot(player)).premium, {
        tier: 2,
        activatedAtUnixMs: 900_000,
        expiresAtUnixMs: 4_500_000
    });
});
