import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalMemoryServerEconomyPocHarness } from "../src/server-economy-poc-canonical.js";
import { createValidatedServerEconomyPocReceiptProjectionForTests as receipt } from "../src/server-economy-poc-receipt-mapper.js";

function registerTrackedSession(harness, playFabId, {
    onSnapshot = async () => {}
} = {}) {
    const before = [];
    const after = [];
    const delivered = [];
    const session = harness.poc.registerOnlineSession({
        playFabId,
        sessionId: `SESSION_${playFabId}`,
        beforeAuthoritativeMutation: async (request) => {
            before.push(request);
            return { acknowledged: true, hotStateDrained: true };
        },
        onSnapshot: async (snapshot, metadata) => {
            delivered.push({ snapshot, metadata });
            return onSnapshot(snapshot, metadata);
        },
        afterAuthoritativeMutation: async (request) => after.push(request)
    });
    return { session, before, after, delivered };
}

test("online flush failure resumes exactly once from the reconciled canonical snapshot", async () => {
    const failure = Object.assign(new Error("simulated flush crash"), { code: "POC_TEST_FLUSH_FAILURE" });
    const harness = createCanonicalMemoryServerEconomyPocHarness({
        hooks: {
            async afterSnapshotCas({ domain }) {
                if (domain === "elite_ball_flush") throw failure;
            }
        }
    });
    const playFabId = "ONLINE_FLUSH_FAILURE_PLAYER";
    await harness.poc.consumeValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "ONLINE_FLUSH_FAILURE_SEED",
        sku: "seabyss_starter_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }), { preferOnline: false });

    const tracked = registerTrackedSession(harness, playFabId);
    await harness.poc.appendOnlineEliteBallDelta({
        playFabId,
        sessionId: tracked.session.sessionId,
        sessionEpoch: tracked.session.sessionEpoch,
        eventId: "ONLINE_FLUSH_FAILURE_SHOT",
        delta: -1,
        reason: "online_combat"
    });
    await harness.poc.enqueueValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "ONLINE_FLUSH_FAILURE_PAYMENT",
        sku: "seabyss_diamond_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }));

    await assert.rejects(
        harness.poc.consumers.consumePendingPlayer(playFabId),
        (error) => error?.code === "POC_TEST_FLUSH_FAILURE"
    );
    assert.equal(tracked.before.length, 1);
    assert.equal(tracked.delivered.length, 1);
    assert.equal(tracked.delivered[0].snapshot.eliteBall, 12999);
    assert.equal(tracked.delivered[0].metadata.source, "handshake_abort_reconciliation");
    assert.equal(tracked.after.length, 1);
    assert.equal(tracked.after[0].action, "resume_from_canonical_snapshot_after_abort");
    assert.equal(tracked.after[0].outcome, "mutation_failed");
    assert.equal(tracked.after[0].errorCode, "POC_TEST_FLUSH_FAILURE");
    assert.equal(tracked.after[0].canonicalSnapshotDelivered, true);
    assert.equal(tracked.after[0].requiresSnapshotReload, false);
});

test("snapshot callback failure invokes the resume callback once and never invokes a second abort", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "ONLINE_SNAPSHOT_FAILURE_PLAYER";
    const snapshotFailure = Object.assign(new Error("simulated delivery failure"), {
        code: "POC_TEST_SNAPSHOT_DELIVERY_FAILURE"
    });
    const tracked = registerTrackedSession(harness, playFabId, {
        onSnapshot: async () => { throw snapshotFailure; }
    });
    await harness.poc.enqueueValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "ONLINE_SNAPSHOT_FAILURE_PAYMENT",
        sku: "seabyss_diamond_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }));

    await assert.rejects(
        harness.poc.consumers.consumePendingPlayer(playFabId),
        (error) => error?.code === "POC_TEST_SNAPSHOT_DELIVERY_FAILURE"
    );
    assert.equal(tracked.before.length, 1);
    assert.equal(tracked.delivered.length, 1);
    assert.equal(tracked.after.length, 1);
    assert.equal(tracked.after[0].action, "abort_and_resume");
    assert.equal(tracked.after[0].outcome, "snapshot_delivery_failed");
});
