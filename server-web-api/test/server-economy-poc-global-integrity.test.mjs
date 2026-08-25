import test from "node:test";
import assert from "node:assert/strict";
import {
    createCanonicalMemoryServerEconomyPocHarness,
    createCanonicalServerEconomyPoc
} from "../src/server-economy-poc-canonical.js";
import { createServerEconomyPocAtomicEventInbox } from "../src/server-economy-poc-atomic-event-inbox.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocPlayerLeases,
    createMemoryServerEconomyPocSnapshotStore,
    createMemoryServerEconomyPocWalStore
} from "../src/server-economy-poc-memory-stores.js";
import { createValidatedServerEconomyPocReceiptProjectionForTests as receipt } from "../src/server-economy-poc-receipt-mapper.js";

function dto({ playFabId = "INTEGRITY_PLAYER", operationId, eventId, diamondsDelta }) {
    return {
        playFabId,
        sessionId: "INTEGRITY_SESSION",
        sessionEpoch: 1,
        operationId,
        eventId,
        diamondsDelta,
        reason: "quest_reward",
        contextId: "INTEGRITY_CONTEXT"
    };
}

test("same operationId/eventId with another signed Diamonds effect is a conflict", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    await harness.poc.trustedDiamonds.enqueue(dto({
        operationId: "SIGNED_SPEND",
        eventId: "SIGNED_EVENT",
        diamondsDelta: -1
    }));
    await assert.rejects(
        harness.poc.trustedDiamonds.enqueue(dto({
            operationId: "SIGNED_SPEND",
            eventId: "SIGNED_EVENT",
            diamondsDelta: -2
        })),
        { code: "POC_OPERATION_IDEMPOTENCY_CONFLICT" }
    );
});

test("provider transaction is globally unique across two players", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    const common = {
        providerTransactionId: "GLOBAL_PROVIDER_TX",
        sku: "seabyss_diamond_pack_1",
        effectiveAtUnixMs: harness.clock.now
    };
    await harness.poc.consumeValidatedXsollaReceipt(receipt({ playFabId: "PLAYER_A", ...common }), { preferOnline: false });
    await assert.rejects(
        harness.poc.consumeValidatedXsollaReceipt(receipt({ playFabId: "PLAYER_B", ...common }), { preferOnline: false }),
        { code: "POC_PROVIDER_TRANSACTION_CONFLICT" }
    );
    assert.equal((await harness.poc.readSnapshot("PLAYER_A")).diamonds, 500);
    assert.equal((await harness.poc.readSnapshot("PLAYER_B")).diamonds, 0);
});

test("event index hashes tuple identity without delimiter or maximum-length collisions", async () => {
    const harness = createCanonicalMemoryServerEconomyPocHarness();
    await harness.poc.trustedDiamonds.enqueue(dto({
        playFabId: "A:B",
        operationId: "OP_COLON_1",
        eventId: "C",
        diamondsDelta: 1
    }));
    await harness.poc.trustedDiamonds.enqueue(dto({
        playFabId: "A",
        operationId: "OP_COLON_2",
        eventId: "B:C",
        diamondsDelta: 1
    }));
    await harness.poc.trustedDiamonds.enqueue(dto({
        playFabId: "P".repeat(160),
        operationId: "OP_MAXIMUM",
        eventId: "E".repeat(200),
        diamondsDelta: 1
    }));
});

test("durable inbox fails closed without atomic durable event index", () => {
    const noop = async () => null;
    const durableInbox = {
        durable: true,
        submit: noop,
        get: noop,
        scanAfter: noop,
        claim: noop,
        ack: noop,
        releaseClaim: noop,
        listPlayersWithPending: noop
    };
    assert.throws(
        () => createServerEconomyPocAtomicEventInbox(durableInbox),
        /requires an injected atomic durable eventIndexStore/u
    );
});

test("general canonical constructor fails closed without explicit gameplay resolution store", () => {
    const nowMilliseconds = () => 1000;
    const leases = createMemoryServerEconomyPocPlayerLeases({ nowMilliseconds });
    assert.throws(() => createCanonicalServerEconomyPoc({
        snapshotStore: createMemoryServerEconomyPocSnapshotStore({ leases, nowMilliseconds }),
        walStore: createMemoryServerEconomyPocWalStore({ leases }),
        operationInbox: createMemoryServerEconomyPocOperationInbox({ leases, nowMilliseconds }),
        playerLeases: leases,
        nowMilliseconds
    }), /gameplayResolutionStore/u);
});
