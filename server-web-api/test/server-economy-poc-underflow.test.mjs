import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalMemoryServerEconomyPocHarness } from "../src/server-economy-poc-canonical.js";
import { createValidatedServerEconomyPocReceiptProjectionForTests as receipt } from "../src/server-economy-poc-receipt-mapper.js";

test("insufficient ammo spend is terminal no-op and never poisons later WAL events", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const playFabId = "AMMO_UNDERFLOW_PLAYER";
    await harness.poc.consumeValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "AMMO_UNDERFLOW_SEED",
        sku: "seabyss_starter_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }), { preferOnline: false });
    await harness.poc.engine.appendEliteBallDelta({
        playFabId,
        eventId: "AMMO_TOO_EXPENSIVE",
        delta: -14000,
        reason: "combat_spend"
    });
    await harness.poc.engine.appendEliteBallDelta({
        playFabId,
        eventId: "AMMO_LATER_GRANT",
        delta: 5,
        reason: "quest_reward"
    });
    const first = await harness.poc.engine.flushEliteBall(playFabId, { batchSize: 10 });
    assert.equal(first.status, "flushed");
    assert.equal(first.result.rejectedEventCount, 1);
    assert.deepEqual(first.result.rejectedEventIds, ["AMMO_TOO_EXPENSIVE"]);
    assert.equal(first.result.throughSequence, 2);
    assert.equal(first.snapshot.eliteBall, 13005);
    assert.equal((await harness.stores.walStore.status(playFabId)).pendingCount, 0);

    await harness.poc.engine.appendEliteBallDelta({
        playFabId,
        eventId: "AMMO_LATER_SPEND",
        delta: -1,
        reason: "combat_spend"
    });
    const later = await harness.poc.engine.flushEliteBall(playFabId, { batchSize: 10 });
    assert.equal(later.status, "flushed");
    assert.equal(later.result.rejectedEventCount, 0);
    assert.equal(later.snapshot.eliteBall, 13004);
    assert.equal(later.result.throughSequence, 3);
});
