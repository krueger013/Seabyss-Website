import test from "node:test";
import assert from "node:assert/strict";
import {
    createCanonicalMemoryServerEconomyPocHarness,
    createCanonicalServerEconomyPoc
} from "../src/server-economy-poc-canonical.js";
import { ServerEconomyPocSimulatedCrash } from "../src/server-economy-poc-engine.js";
import { createValidatedServerEconomyPocReceiptProjectionForTests as receipt } from "../src/server-economy-poc-receipt-mapper.js";
import { SERVER_ECONOMY_POC_REDIS_SAFETY } from "../src/server-economy-poc-redis-poc-only.js";

test("WAL cursor reconciles a process restart after snapshot CAS before ACK", async () => {
    let crash = true;
    const harness = createCanonicalMemoryServerEconomyPocHarness({
        hooks: {
            afterSnapshotCas({ domain }) {
                if (domain === "elite_ball_flush" && crash) {
                    crash = false;
                    throw new ServerEconomyPocSimulatedCrash("ammo_after_snapshot_before_ack");
                }
            }
        }
    });
    const playFabId = "WAL_RESTART_PLAYER";
    await harness.poc.consumeValidatedXsollaReceipt(receipt({
        playFabId,
        providerTransactionId: "WAL_SEED",
        sku: "seabyss_starter_pack_1",
        effectiveAtUnixMs: harness.clock.now
    }), { preferOnline: false });
    for (let index = 0; index < 40; index += 1) {
        await harness.poc.engine.appendEliteBallDelta({
            playFabId,
            eventId: `WAL_SHOT_${index}`,
            delta: -1,
            reason: "combat_shot"
        });
    }
    await assert.rejects(
        harness.poc.engine.flushEliteBall(playFabId, { batchSize: 40 }),
        { code: "POC_SIMULATED_CRASH" }
    );
    assert.equal((await harness.poc.readSnapshot(playFabId)).eliteBall, 12960);
    assert.equal((await harness.stores.walStore.status(playFabId)).pendingCount, 40);

    harness.clock.now += 20_000;
    const resumed = createCanonicalServerEconomyPoc({
        snapshotStore: harness.stores.snapshotStore,
        walStore: harness.stores.walStore,
        operationInbox: harness.stores.operationInbox,
        playerLeases: harness.stores.leases,
        metrics: harness.metrics,
        authorizeGameplay: async ({ playFabId: id }) => ({ authorized: true, playFabId: id }),
        gameplayResolutionStore: harness.stores.gameplayResolutionStore,
        nowMilliseconds: () => harness.clock.now
    });
    const result = await resumed.engine.flushEliteBall(playFabId, { batchSize: 40 });
    assert.equal(result.status, "empty");
    assert.equal((await resumed.readSnapshot(playFabId)).eliteBall, 12960);
    assert.equal((await harness.stores.walStore.status(playFabId)).pendingCount, 0);
});

test("standalone Redis adapter is explicitly fail-closed as POC-only", () => {
    assert.equal(SERVER_ECONOMY_POC_REDIS_SAFETY.productionReady, false);
    assert.equal(SERVER_ECONOMY_POC_REDIS_SAFETY.redisClusterCompatible, false);
    assert.match(SERVER_ECONOMY_POC_REDIS_SAFETY.reason, /not one atomic provider transaction/u);
});
