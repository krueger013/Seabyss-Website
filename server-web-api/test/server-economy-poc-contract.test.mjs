import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalMemoryServerEconomyPocHarness } from "../src/server-economy-poc-canonical.js";
import { createMemoryServerEconomyPocGameplayResolutionStore } from "../src/server-economy-poc-gameplay-resolution-store.js";

const SNAPSHOT_KEYS = Object.freeze([
    "ammoAppliedThroughSequence",
    "diamonds",
    "eliteBall",
    "fencingEpoch",
    "highValueAppliedThroughSequence",
    "playFabId",
    "premium",
    "revision",
    "schemaVersion",
    "updatedAtUnixMs"
]);

function dto(operationId, eventId, diamondsDelta) {
    return {
        playFabId: "CONTRACT_PLAYER",
        sessionId: "CONTRACT_SESSION",
        sessionEpoch: 1,
        operationId,
        eventId,
        diamondsDelta,
        reason: "quest_reward",
        contextId: "CONTRACT_CONTEXT"
    };
}

test("every gameplay grant/spend snapshot has the exact 10-field Unity V1 contract", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    await harness.poc.trustedDiamonds.execute(dto("GRANT", "EVENT_GRANT", 10));
    assert.deepEqual(Object.keys(await harness.poc.readSnapshot("CONTRACT_PLAYER")).sort(), SNAPSHOT_KEYS);
    await harness.poc.trustedDiamonds.execute(dto("SPEND", "EVENT_SPEND", -7));
    assert.deepEqual(Object.keys(await harness.poc.readSnapshot("CONTRACT_PLAYER")).sort(), SNAPSHOT_KEYS);
    const rejected = await harness.poc.trustedDiamonds.execute(dto("REJECT", "EVENT_REJECT", -7));
    assert.equal(rejected.consumed.status, "rejected_insufficient_funds");
    const snapshot = await harness.poc.readSnapshot("CONTRACT_PLAYER");
    assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS);
    assert.equal(JSON.stringify(snapshot).includes("GameplayResolution"), false);
    assert.equal(JSON.stringify(snapshot).includes("lastGameplay"), false);
});

test("separate resolution proof reconciles crash after snapshot before ACK", async () => {
    const durableProof = createMemoryServerEconomyPocGameplayResolutionStore();
    let failOnce = true;
    const crashyProof = Object.freeze({
        ...durableProof,
        async markSnapshotApplied(input) {
            const value = await durableProof.markSnapshotApplied(input);
            if (failOnce) {
                failOnce = false;
                throw Object.assign(new Error("simulated crash after provider"), { code: "POC_TEST_CRASH" });
            }
            return value;
        }
    });
    const harness = createCanonicalMemoryServerEconomyPocHarness({
        gameplayResolutionStore: crashyProof
    });
    await assert.rejects(
        harness.poc.trustedDiamonds.execute(dto("CRASH_GRANT", "EVENT_CRASH", 25)),
        { code: "POC_TEST_CRASH" }
    );
    assert.equal((await harness.poc.readSnapshot("CONTRACT_PLAYER")).diamonds, 25);
    const recovered = await harness.poc.trustedDiamonds.execute(dto("CRASH_GRANT", "EVENT_CRASH", 25));
    assert.equal(recovered.consumed.status, "applied");
    assert.equal((await harness.poc.readSnapshot("CONTRACT_PLAYER")).diamonds, 25);
    assert.equal((await durableProof.get("CONTRACT_PLAYER", "CRASH_GRANT")).state, "Acked");
    assert.deepEqual(Object.keys(await harness.poc.readSnapshot("CONTRACT_PLAYER")).sort(), SNAPSHOT_KEYS);
});
