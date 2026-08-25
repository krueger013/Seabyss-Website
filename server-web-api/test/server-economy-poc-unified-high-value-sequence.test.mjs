import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    createCanonicalMemoryServerEconomyPocHarness,
    createCanonicalServerEconomyPoc
} from "../src/server-economy-poc-canonical.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocPlayerLeases
} from "../src/server-economy-poc-memory-stores.js";
import { createServerEconomyPocInitialSnapshot } from "../src/server-economy-poc-model.js";
import {
    createValidatedServerEconomyPocReceiptProjectionForTests as receipt
} from "../src/server-economy-poc-receipt-mapper.js";
import { createRedisCompatibleServerEconomyPocOperationInbox } from "../src/server-economy-poc-redis-stores.js";

const PLAYER = "UNIFIED_SEQUENCE_PLAYER";

function gameplay(operationId, eventId, diamondsDelta = 1) {
    return {
        playFabId: PLAYER,
        sessionId: "UNIFIED_SEQUENCE_SESSION",
        sessionEpoch: 1,
        operationId,
        eventId,
        diamondsDelta,
        reason: "quest_reward",
        contextId: `CONTEXT_${eventId}`
    };
}

function payment(providerTransactionId, sku = "seabyss_diamond_pack_1") {
    return receipt({
        playFabId: PLAYER,
        providerTransactionId,
        sku,
        effectiveAtUnixMs: 1_000_000
    });
}

async function allRecords(poc) {
    return (await poc.engine.stores.operationInbox.scanAfter({
        playFabId: PLAYER,
        afterSequence: 0,
        limit: 100
    })).entries;
}

function recreate(harness) {
    return createCanonicalServerEconomyPoc({
        snapshotStore: harness.stores.snapshotStore,
        walStore: harness.stores.walStore,
        operationInbox: harness.stores.operationInbox,
        playerLeases: harness.stores.leases,
        sequenceLeases: harness.stores.leases,
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
        nowMilliseconds: () => harness.clock.now
    });
}

test("gameplay seq1, gameplay seq2, xsd2 payment seq3 share one domain", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const first = await harness.poc.trustedDiamonds.enqueue(gameplay("GAMEPLAY_1", "EVENT_1"));
    const second = await harness.poc.trustedDiamonds.enqueue(gameplay("GAMEPLAY_2", "EVENT_2"));
    const third = await harness.poc.enqueueValidatedXsollaReceipt(payment("XSD2_TX_3"));
    assert.deepEqual(
        [first.submitted.record.sequence, second.submitted.record.sequence, third.submitted.record.sequence],
        [1, 2, 3]
    );
});

test("xsd2 payment seq1, gameplay seq2, xsd2 payment seq3 share one domain", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const first = await harness.poc.enqueueValidatedXsollaReceipt(payment("XSD2_TX_1"));
    const second = await harness.poc.trustedDiamonds.enqueue(gameplay("GAMEPLAY_2", "EVENT_2"));
    const third = await harness.poc.enqueueValidatedXsollaReceipt(payment("XSD2_TX_3"));
    assert.deepEqual(
        [first.submitted.record.sequence, second.submitted.record.sequence, third.submitted.record.sequence],
        [1, 2, 3]
    );
});

test("ten concurrent gameplay/payment producers allocate unique monotonic sequences", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const submitted = await Promise.all(Array.from({ length: 10 }, (_, index) => index % 2 === 0
        ? harness.poc.trustedDiamonds.enqueue(gameplay(`GAMEPLAY_${index}`, `EVENT_${index}`))
        : harness.poc.enqueueValidatedXsollaReceipt(payment(`XSD2_TX_${index}`))));
    assert.deepEqual(
        submitted.map((value) => value.submitted.record.sequence).sort((left, right) => left - right),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    );
    assert.equal(new Set(submitted.map((value) => value.submitted.record.sequence)).size, 10);
});

test("runtime restart continues the durable shared sequence", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const first = await harness.poc.enqueueValidatedXsollaReceipt(payment("RESTART_TX_1"));
    const restarted = recreate(harness);
    const second = await restarted.trustedDiamonds.enqueue(gameplay("RESTART_GAMEPLAY_2", "RESTART_EVENT_2"));
    assert.equal(first.submitted.record.sequence, 1);
    assert.equal(second.submitted.record.sequence, 2);
});

test("xsd2 replay keeps its original sequence and allocates nothing", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const projection = payment("XSD2_REPLAY_TX");
    const first = await harness.poc.enqueueValidatedXsollaReceipt(projection);
    const replay = await harness.poc.enqueueValidatedXsollaReceipt(projection);
    const page = await harness.poc.engine.stores.operationInbox.scanAfter({
        playFabId: PLAYER,
        afterSequence: 0,
        limit: 10
    });
    assert.equal(first.submitted.record.sequence, 1);
    assert.equal(replay.submitted.status, "existing");
    assert.equal(replay.submitted.record.sequence, 1);
    assert.equal(page.nextSequence, 1);
    assert.equal(page.entries.length, 1);
});

test("same operationId with another payload is a proof mismatch and allocates nothing", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    await harness.poc.trustedDiamonds.enqueue(gameplay("PAYLOAD_BOUND", "PAYLOAD_EVENT", 25));
    await assert.rejects(
        harness.poc.trustedDiamonds.enqueue(gameplay("PAYLOAD_BOUND", "PAYLOAD_EVENT", 26)),
        { code: "POC_OPERATION_IDEMPOTENCY_CONFLICT" }
    );
    assert.equal((await allRecords(harness.poc)).length, 1);
});

test("stale allocator lease is fenced before sequence allocation", async () => {
    let now = 1_000_000;
    const leases = createMemoryServerEconomyPocPlayerLeases({ nowMilliseconds: () => now });
    const inbox = createMemoryServerEconomyPocOperationInbox({
        leases,
        nowMilliseconds: () => now,
        requireSequenceAllocationFence: true
    });
    const old = await leases.acquire({
        playFabId: PLAYER,
        owner: "allocator_old",
        token: "allocator_old_token",
        ttlMilliseconds: 15_000
    });
    await leases.release({ playFabId: PLAYER, token: "allocator_old_token", epoch: old.lease.epoch });
    const current = await leases.acquire({
        playFabId: PLAYER,
        owner: "allocator_current",
        token: "allocator_current_token",
        ttlMilliseconds: 15_000
    });
    const operation = {
        playFabId: PLAYER,
        operationId: "STALE_ALLOCATOR_OPERATION",
        immutableHash: "a".repeat(64)
    };
    await assert.rejects(inbox.submit(operation, {
        minimumSequenceExclusive: 0,
        playerLeaseToken: "allocator_old_token",
        playerFencingEpoch: old.lease.epoch
    }), { code: "POC_STALE_WRITER" });
    const applied = await inbox.submit(operation, {
        minimumSequenceExclusive: 0,
        playerLeaseToken: "allocator_current_token",
        playerFencingEpoch: current.lease.epoch
    });
    assert.equal(applied.record.sequence, 1);
});

test("empty Redis allocator anchored to provider cursor 2 returns sequence 3", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const initial = createServerEconomyPocInitialSnapshot(PLAYER, 1_000_000);
    await harness.stores.snapshotStore.seed({
        ...initial,
        revision: 2,
        fencingEpoch: 2,
        diamonds: 15,
        highValueAppliedThroughSequence: 2
    });
    const submitted = await harness.poc.enqueueValidatedXsollaReceipt(payment("CURSOR_FLOOR_TX"));
    assert.equal(submitted.submitted.record.sequence, 3);
    assert.equal((await allRecords(harness.poc))[0].sequence, 3);
});

test("future authoritative xss2 Starter uses the same canonical sequence domain", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const gameplayResult = await harness.poc.trustedDiamonds.enqueue(gameplay("BEFORE_XSS2", "BEFORE_XSS2_EVENT"));
    const starter = await harness.poc.enqueueValidatedXsollaReceipt(
        payment("XSS2_STARTER_TX", "seabyss_starter_pack_1")
    );
    assert.equal(gameplayResult.submitted.record.sequence, 1);
    assert.equal(starter.submitted.record.sequence, 2);
    assert.equal(starter.operation.diamonds, 1000);
});

test("Redis fenced submit carries lease, epoch and provider cursor in one Lua call", async () => {
    const commands = [];
    const redis = {
        async sendCommand(command) {
            commands.push(command);
            assert.equal(command[0], "EVAL");
            assert.match(command[1], /SERVER_ECONOMY_POC_UNIFIED_SEQUENCE_SUBMIT_V1/u);
            assert.equal(command[2], "6");
            assert.match(command[8], /player-lease$/u);
            assert.equal(command[14], "9");
            assert.equal(command[15], "2");
            const operation = JSON.parse(command[10]);
            return ["submitted", JSON.stringify({
                schemaVersion: 1,
                playFabId: operation.playFabId,
                operationId: operation.operationId,
                sequence: 3,
                state: "Pending",
                operation,
                claimEpoch: 0,
                claimOwner: null,
                claimToken: null,
                claimExpiresAtUnixMs: null,
                result: null,
                ackedAtUnixMs: null
            })];
        }
    };
    const inbox = createRedisCompatibleServerEconomyPocOperationInbox({
        redis,
        prefix: "test:unified:sequence:v1:",
        requireSequenceAllocationFence: true
    });
    const operation = {
        playFabId: PLAYER,
        operationId: "REDIS_ATOMIC_SEQUENCE",
        immutableHash: "b".repeat(64)
    };
    const result = await inbox.submit(operation, {
        minimumSequenceExclusive: 2,
        playerLeaseToken: "redis_sequence_token",
        playerFencingEpoch: 9
    });
    assert.equal(result.record.sequence, 3);
    assert.equal(commands.length, 1);
    assert.equal(commands[0][13], createHash("sha256").update("redis_sequence_token", "utf8").digest("hex"));
});

test("fenced Redis inbox fails closed for a new operation without allocation context", async () => {
    const commands = [];
    const redis = {
        async sendCommand(command) {
            commands.push(command);
            if (command[0] === "GET") return null;
            throw new Error("unexpected Redis mutation");
        }
    };
    const inbox = createRedisCompatibleServerEconomyPocOperationInbox({
        redis,
        prefix: "test:unified:sequence:v1:",
        requireSequenceAllocationFence: true
    });
    await assert.rejects(inbox.submit({
        playFabId: PLAYER,
        operationId: "MISSING_ALLOCATION_CONTEXT",
        immutableHash: "c".repeat(64)
    }), { code: "POC_SEQUENCE_ALLOCATION_CONTEXT_REQUIRED" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], "GET");
});
