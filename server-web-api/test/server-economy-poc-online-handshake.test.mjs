import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalMemoryServerEconomyPocHarness } from "../src/server-economy-poc-canonical.js";
import { createValidatedServerEconomyPocReceiptProjectionForTests as receipt } from "../src/server-economy-poc-receipt-mapper.js";

test("online payment flushes WAL before CAS and publishes only the final hot-state snapshot", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "ONLINE_HANDSHAKE_PLAYER";
    await harness.poc.consumeValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "ONLINE_STARTER_SEED",
        sku: "seabyss_starter_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }), { preferOnline: false });

    const order = [];
    const delivered = [];
    const session = harness.poc.registerOnlineSession({
        playFabId,
        sessionId: "ONLINE_HANDSHAKE_SESSION",
        beforeAuthoritativeMutation: async () => {
            order.push("pause_and_drain");
            return { acknowledged: true, hotStateDrained: true };
        },
        onSnapshot: async (snapshot) => {
            order.push("snapshot");
            delivered.push(snapshot);
        },
        afterAuthoritativeMutation: async () => order.push("resume")
    });
    await harness.poc.appendOnlineEliteBallDelta({
        playFabId,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        eventId: "ONLINE_SHOT_BEFORE_PAYMENT",
        delta: -1,
        reason: "online_combat"
    });
    await harness.poc.enqueueValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "ONLINE_DIAMOND_PAYMENT",
        sku: "seabyss_diamond_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }));
    const tick = await harness.poc.offlineTick();
    assert.equal(tick.highValue[0].consumer, "online");
    assert.deepEqual(order, ["pause_and_drain", "snapshot", "resume"]);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].eliteBall, 12999);
    assert.equal(delivered[0].diamonds, 1500);
    assert.equal((await harness.poc.readSnapshot(playFabId)).eliteBall, 12999);
    assert.equal((await harness.stores.walStore.status(playFabId)).pendingCount, 0);
});

test("online registration fails closed without hot-state handshake callback", () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    assert.throws(() => harness.poc.registerOnlineSession({
        playFabId: "ONLINE_HANDSHAKE_PLAYER",
        sessionId: "MISSING_HANDSHAKE",
        onSnapshot: async () => {}
    }), TypeError);
});
