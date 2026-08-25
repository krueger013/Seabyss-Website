import test from "node:test";
import assert from "node:assert/strict";
import {
    createCanonicalMemoryServerEconomyPocHarness,
    createCanonicalServerEconomyPoc
} from "../src/server-economy-poc-canonical.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocWalStore
} from "../src/server-economy-poc-memory-stores.js";
import { ServerEconomyPocSimulatedCrash } from "../src/server-economy-poc-engine.js";

function operation(playFabId, suffix, diamonds, eliteBall = 0) {
    return {
        playFabId,
        operationId: `ROLLBACK_OPERATION_${suffix}`,
        eventId: `ROLLBACK_EVENT_${suffix}`,
        diamonds,
        eliteBall,
        premium: null,
        reason: "rollback_test",
        effectiveAtUnixMs: 1_000_000
    };
}

function createWithStores(harness, {
    operationInbox = harness.stores.operationInbox,
    walStore = harness.stores.walStore
} = {}) {
    return createCanonicalServerEconomyPoc({
        snapshotStore: harness.stores.snapshotStore,
        walStore,
        operationInbox,
        playerLeases: harness.stores.leases,
        gameplayResolutionStore: harness.stores.gameplayResolutionStore,
        authorizeGameplay: async ({ playFabId }) => ({ authorized: true, playFabId }),
        nowMilliseconds: () => harness.clock.now
    });
}

test("inbox sequence rollback is anchored above the durable provider cursor", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "INBOX_ROLLBACK_PLAYER";
    const first = await harness.poc.engine.enqueueAuthoritativeHighValueOperation(
        operation(playFabId, "ORIGINAL", 10)
    );
    await harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: first.record.operationId,
        preferOnline: false
    });
    assert.equal((await harness.poc.readSnapshot(playFabId)).diamonds, 10);

    const rolledBackInbox = createMemoryServerEconomyPocOperationInbox({
        leases: harness.stores.leases,
        nowMilliseconds: () => harness.clock.now
    });
    const resumed = createWithStores(harness, {
        operationInbox: rolledBackInbox,
        walStore: createMemoryServerEconomyPocWalStore({ leases: harness.stores.leases })
    });
    const replacement = await resumed.engine.enqueueAuthoritativeHighValueOperation(
        operation(playFabId, "DIFFERENT_NEW_SEQ1", 99)
    );
    assert.equal(replacement.record.sequence, 2);
    const consumed = await resumed.consumers.consumeHighValue({
        playFabId,
        operationId: replacement.record.operationId,
        preferOnline: false
    });
    assert.equal(consumed.status, "applied");
    assert.equal((await resumed.readSnapshot(playFabId)).diamonds, 109);
    assert.equal((await rolledBackInbox.get(playFabId, replacement.record.operationId)).state, "Acked");
});

test("seq2 is blocked until crashed seq1 is recovered and ACKed so its provider proof cannot be overwritten", async () => {
    let crash = true;
    const harness = createCanonicalMemoryServerEconomyPocHarness({
        hooks: {
            afterSnapshotCas({ domain }) {
                if (domain === "high_value" && crash) {
                    crash = false;
                    throw new ServerEconomyPocSimulatedCrash("proof_before_ack");
                }
            }
        }
    });
    const playFabId = "PROOF_ORDER_PLAYER";
    const first = await harness.poc.engine.enqueueAuthoritativeHighValueOperation(
        operation(playFabId, "FIRST", 10)
    );
    const second = await harness.poc.engine.enqueueAuthoritativeHighValueOperation(
        operation(playFabId, "SECOND", 20)
    );
    assert.equal(first.record.sequence, 1);
    assert.equal(second.record.sequence, 2);

    await assert.rejects(harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: first.record.operationId,
        preferOnline: false
    }), { code: "POC_SIMULATED_CRASH" });
    assert.equal((await harness.poc.readSnapshot(playFabId)).diamonds, 10);

    harness.clock.now += 20_000;
    await assert.rejects(harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: second.record.operationId,
        preferOnline: false
    }), { code: "POC_OPERATION_ORDER_BLOCKED" });
    assert.equal((await harness.poc.readSnapshot(playFabId)).diamonds, 10);

    const recovered = await harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: first.record.operationId,
        preferOnline: false
    });
    assert.equal(recovered.status, "recovered_after_snapshot");
    const appliedSecond = await harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: second.record.operationId,
        preferOnline: false
    });
    assert.equal(appliedSecond.status, "applied");
    assert.equal((await harness.poc.readSnapshot(playFabId)).diamonds, 30);
});

test("WAL nextSequence rollback behind provider ammo cursor fails closed before ACK or empty result", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "WAL_ROLLBACK_PLAYER";
    const seed = await harness.poc.engine.enqueueAuthoritativeHighValueOperation(
        operation(playFabId, "AMMO_SEED", 0, 10)
    );
    await harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: seed.record.operationId,
        preferOnline: false
    });
    await harness.poc.engine.appendEliteBallDelta({
        playFabId,
        eventId: "WAL_ROLLBACK_SHOT",
        delta: -1,
        reason: "combat_shot"
    });
    await harness.poc.engine.flushEliteBall(playFabId, { batchSize: 1 });
    const before = await harness.poc.readSnapshot(playFabId);
    assert.equal(before.eliteBall, 9);
    assert.equal(before.ammoAppliedThroughSequence, 1);

    const rolledBackWal = createMemoryServerEconomyPocWalStore({
        leases: harness.stores.leases
    });
    const resumed = createWithStores(harness, { walStore: rolledBackWal });
    await assert.rejects(
        resumed.engine.flushEliteBall(playFabId, { batchSize: 1 }),
        { code: "POC_WAL_SEQUENCE_ROLLBACK" }
    );
    assert.deepEqual(await resumed.readSnapshot(playFabId), before);
    assert.equal((await rolledBackWal.status(playFabId)).nextSequence, 0);
});

test("WAL lost then reused seq1 cannot ACK a different ammo event against provider cursor1", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "WAL_EQUAL_SEQUENCE_REUSE_PLAYER";
    const seed = await harness.poc.engine.enqueueAuthoritativeHighValueOperation(
        operation(playFabId, "EQUAL_SEQUENCE_AMMO_SEED", 0, 10)
    );
    await harness.poc.consumers.consumeHighValue({
        playFabId,
        operationId: seed.record.operationId,
        preferOnline: false
    });
    await harness.poc.engine.appendEliteBallDelta({
        playFabId,
        eventId: "WAL_ORIGINAL_SEQ1_SHOT",
        delta: -1,
        reason: "combat_shot"
    });
    await harness.poc.engine.flushEliteBall(playFabId, { batchSize: 1 });
    const before = await harness.poc.readSnapshot(playFabId);
    assert.equal(before.eliteBall, 9);
    assert.equal(before.ammoAppliedThroughSequence, 1);

    const rolledBackWal = createMemoryServerEconomyPocWalStore({
        leases: harness.stores.leases
    });
    const resumed = createWithStores(harness, { walStore: rolledBackWal });
    const reused = await resumed.engine.appendEliteBallDelta({
        playFabId,
        eventId: "WAL_DIFFERENT_NEW_SEQ1_REWARD",
        delta: 5,
        reason: "quest_reward"
    });
    assert.equal(reused.entry.sequence, 1);
    assert.equal((await rolledBackWal.status(playFabId)).pendingCount, 1);

    await assert.rejects(
        resumed.engine.flushEliteBall(playFabId, { batchSize: 1 }),
        { code: "POC_AMMO_PROOF_MISMATCH" }
    );

    const after = await resumed.readSnapshot(playFabId);
    const walAfter = await rolledBackWal.status(playFabId);
    assert.deepEqual(after, before);
    assert.equal(after.eliteBall, 9);
    assert.equal(walAfter.nextSequence, 1);
    assert.equal(walAfter.ackedThroughSequence, 0);
    assert.equal(walAfter.pendingCount, 1);
});
