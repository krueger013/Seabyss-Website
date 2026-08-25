import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";

test("replays without provider timestamps adopt the first immutable ledger timestamp", async () => {
    let now = 1_000;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => now
    });
    const input = {
        provider: "xsolla",
        providerTransactionId: "2119500001",
        orderId: "order-2119500001",
        receiptId: "receipt-2119500001",
        playFabId: "4DF88C225D91FE06",
        sku: "seabyss_diamond_pack_1",
        planVersion: 1,
        planHash: "e".repeat(64),
        amountMinor: 199,
        currency: "USD",
        environment: "sandbox"
    };
    const first = await ledger.createTransaction(input);
    now = 2_000;
    const replay = await ledger.createTransaction(input);
    assert.equal(first.status, "created");
    assert.equal(replay.status, "existing");
    assert.equal(replay.record.createdAtUnixMs, 1_000);

    const reversal = {
        provider: "xsolla",
        providerTransactionId: "2119500001",
        reversalEventId: "refund-without-provider-time",
        type: "refund",
        amountMinor: 100,
        currency: "USD",
        reason: "provider omitted event timestamp"
    };
    const firstReversal = await ledger.createReversal(reversal);
    now = 3_000;
    const replayedReversal = await ledger.createReversal(reversal);
    assert.equal(firstReversal.status, "created");
    assert.equal(replayedReversal.status, "existing");
    assert.equal(replayedReversal.record.occurredAtUnixMs, 2_000);
});
