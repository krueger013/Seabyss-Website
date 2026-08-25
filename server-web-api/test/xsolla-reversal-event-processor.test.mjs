import assert from "node:assert/strict";
import test from "node:test";

import {
    XsollaReversalEventError,
    createXsollaReversalEventProcessor,
    parseXsollaReversalEvent
} from "../src/xsolla-reversal-event-processor.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentReversalService } from "../src/payment-reversal-service.js";

const USER = "46789223F9CB1BB9";

function refundPayload(notificationType = "refund", overrides = {}) {
    return {
        notification_type: notificationType,
        settings: { project_id: 310966 },
        user: { id: USER },
        purchase: { total: { amount: "3.99", currency: "USD" } },
        transaction: { id: "706956443" },
        refund_details: {
            code: 4,
            reason: "Potential fraud",
            author: "support@xsolla.com",
            date: "2026-08-23T01:02:03Z"
        },
        ...overrides
    };
}

function cancellationPayload(overrides = {}) {
    return {
        notification_type: "order_canceled",
        order: {
            id: "2126372470",
            currency_type: "real",
            currency: "USD",
            amount: "3.99"
        },
        user: { external_id: USER },
        billing: {
            notification_type: "refund",
            purchase: { total: { amount: "3.99", currency: "USD" } },
            transaction: { id: "706956443" },
            refund_details: {
                code: 4,
                reason: "Canceled payment",
                author: "support@xsolla.com",
                date: "2026-08-23T01:02:03-04:00"
            }
        },
        ...overrides
    };
}

function disputePayload(overrides = {}) {
    return {
        notification_type: "dispute",
        action: "adding",
        user: { id: USER },
        transaction: {
            id: "706956443",
            total: { amount: "3.99", currency: "USD" }
        },
        dispute: {
            id: "dp_abc-123",
            incoming_date: "2026-08-23T01:02:03+00:00",
            reason: "not_as_described",
            type: "chargeback",
            status: "new"
        },
        ...overrides
    };
}

function createSpyService() {
    const calls = [];
    return {
        calls,
        service: {
            async record(input) {
                calls.push(structuredClone(input));
                return { status: calls.length === 1 ? "created" : "existing" };
            }
        }
    };
}

async function createRealHarness(transactionId = "706956443") {
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => Date.parse("2026-08-23T06:00:00Z")
    });
    await ledger.createTransaction({
        provider: "xsolla",
        providerTransactionId: transactionId,
        orderId: "2126372470",
        receiptId: `xss2.${transactionId}`,
        playFabId: USER,
        sku: "seabyss_starter_pack_1",
        planVersion: 1,
        planHash: "a".repeat(64),
        amountMinor: 399,
        currency: "USD",
        environment: "sandbox"
    });
    return {
        ledger,
        process: createXsollaReversalEventProcessor({
            reversalService: createPaymentReversalService({ ledger })
        })
    };
}

test("refund is converted to exact minor units and recorded without clawback fields", async () => {
    const spy = createSpyService();
    const process = createXsollaReversalEventProcessor({ reversalService: spy.service });
    assert.equal(await process({
        payload: refundPayload(),
        notificationType: "refund",
        userId: USER
    }), "reversal_recorded");
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0], {
        provider: "xsolla",
        providerTransactionId: "706956443",
        reversalEventId: spy.calls[0].reversalEventId,
        type: "refund",
        amountMinor: 399,
        currency: "USD",
        occurredAtUnixMs: Date.parse("2026-08-23T01:02:03Z"),
        reason: "Potential fraud [code=4; author=support@xsolla.com]",
        expectedPlayFabId: USER,
        source: "xsolla_refund_webhook"
    });
    assert.match(spy.calls[0].reversalEventId, /^xsolla:refund:[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(spy.calls[0], "entitlementAction"), false);
});

test("exact replay derives the same reversal event id and remains service-idempotent", async () => {
    const spy = createSpyService();
    const process = createXsollaReversalEventProcessor({ reversalService: spy.service });
    const event = { payload: refundPayload(), notificationType: "refund", userId: USER };
    await process(event);
    await process(structuredClone(event));
    assert.equal(spy.calls.length, 2);
    assert.equal(spy.calls[0].reversalEventId, spy.calls[1].reversalEventId);
    assert.deepEqual(spy.calls[0], spy.calls[1]);
});

test("exact replay creates one reversal in the real ledger service", async () => {
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => Date.parse("2026-08-23T06:00:00Z")
    });
    await ledger.createTransaction({
        provider: "xsolla",
        providerTransactionId: "706956443",
        orderId: "2126372470",
        receiptId: "xss2.706956443",
        playFabId: USER,
        sku: "seabyss_starter_pack_1",
        planVersion: 1,
        planHash: "a".repeat(64),
        amountMinor: 399,
        currency: "USD",
        environment: "sandbox"
    });
    const process = createXsollaReversalEventProcessor({
        reversalService: createPaymentReversalService({ ledger })
    });
    const event = {
        payload: refundPayload(),
        notificationType: "refund",
        userId: USER
    };
    await process(event);
    await process(structuredClone(event));
    const reversals = await ledger.lookupReversals({
        providerTransactionId: "706956443"
    });
    assert.equal(reversals.items.length, 1);
    assert.equal(reversals.items[0].status, "PendingReview");
    assert.equal(reversals.items[0].entitlementAction,
        "manual_review_no_automatic_clawback");
    assert.equal(reversals.items[0].amountMinor, 399);
});

test("webhook user must own the original ledger transaction", async () => {
    const { ledger, process } = await createRealHarness();
    const otherUser = "AAAAAAAAAAAAAAAA";
    await assert.rejects(() => process({
        payload: refundPayload("refund", { user: { id: otherUser } }),
        notificationType: "refund",
        userId: otherUser
    }), (error) => error?.code === "REVERSAL_USER_MISMATCH");
    const reversals = await ledger.lookupReversals({
        providerTransactionId: "706956443"
    });
    assert.equal(reversals.items.length, 0);
});

test("full refund and order cancellation correlate to one financial reversal", async () => {
    const { ledger, process } = await createRealHarness();
    await Promise.all([
        process({
            payload: refundPayload(),
            notificationType: "refund",
            userId: USER
        }),
        process({
            payload: cancellationPayload(),
            notificationType: "order_canceled",
            userId: USER
        })
    ]);
    const reversals = await ledger.lookupReversals({
        providerTransactionId: "706956443"
    });
    const transaction = await ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: "706956443"
    });
    assert.equal(reversals.items.length, 1);
    assert.equal(transaction.reversedAmountMinor, 399);
    assert.ok(["refund", "order_canceled"].includes(reversals.items[0].type));
});

test("dispute updates transition one case without adding monetary reversals", async () => {
    const { ledger, process } = await createRealHarness();
    await process({
        payload: disputePayload(),
        notificationType: "dispute",
        userId: USER
    });
    const lost = disputePayload({
        action: "updating",
        dispute: { ...disputePayload().dispute, status: "lost" }
    });
    await process({ payload: lost, notificationType: "dispute", userId: USER });
    let reversals = await ledger.lookupReversals({
        providerTransactionId: "706956443"
    });
    assert.equal(reversals.items.length, 1);
    assert.equal(reversals.items[0].status, "UnderReview");

    const won = disputePayload({
        action: "updating",
        dispute: {
            ...disputePayload().dispute,
            type: "chargeback_reversal",
            status: "won"
        }
    });
    await process({ payload: won, notificationType: "dispute", userId: USER });
    await process({ payload: structuredClone(won), notificationType: "dispute", userId: USER });
    reversals = await ledger.lookupReversals({
        providerTransactionId: "706956443"
    });
    const transaction = await ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: "706956443"
    });
    assert.equal(reversals.items.length, 1);
    assert.equal(reversals.items[0].status, "ResolvedNoClawback");
    assert.equal(reversals.items[0].entitlementAction,
        "manual_review_no_automatic_clawback");
    assert.equal(transaction.reversedAmountMinor, 399);
});

test("out-of-order and non-financial dispute additions fail closed", async () => {
    const { process } = await createRealHarness();
    const update = disputePayload({
        action: "updating",
        dispute: { ...disputePayload().dispute, status: "lost" }
    });
    await assert.rejects(() => process({
        payload: update,
        notificationType: "dispute",
        userId: USER
    }), (error) => error?.code === "DISPUTE_REVERSAL_NOT_FOUND");
    const retrieval = disputePayload({
        dispute: { ...disputePayload().dispute, type: "retrieval" }
    });
    assert.throws(() => parseXsollaReversalEvent({
        payload: retrieval,
        notificationType: "dispute",
        userId: USER
    }), (error) => error?.code === "NON_FINANCIAL_DISPUTE");
});

test("optional Xsolla refund details are compatible without ambiguous partials", () => {
    const full = refundPayload();
    delete full.refund_details;
    const parsedFull = parseXsollaReversalEvent({
        payload: full,
        notificationType: "refund",
        userId: USER
    });
    assert.equal(parsedFull.reason, "Xsolla refund");
    assert.equal(Object.hasOwn(parsedFull, "occurredAtUnixMs"), false);

    const canceled = cancellationPayload();
    delete canceled.billing.refund_details;
    const parsedCanceled = parseXsollaReversalEvent({
        payload: canceled,
        notificationType: "order_canceled",
        userId: USER
    });
    assert.equal(parsedCanceled.reason, "Xsolla order cancellation [order=2126372470]");
    assert.equal(Object.hasOwn(parsedCanceled, "occurredAtUnixMs"), false);

    const partial = refundPayload("partial_refund");
    delete partial.refund_details.date;
    assert.throws(() => parseXsollaReversalEvent({
        payload: partial,
        notificationType: "partial_refund",
        userId: USER
    }), (error) => error?.code === "AMBIGUOUS_PARTIAL_REFUND");

    partial.refund_details.date = "2026-08-23 01:02:03";
    const localDate = parseXsollaReversalEvent({
        payload: partial,
        notificationType: "partial_refund",
        userId: USER
    });
    assert.equal(Object.hasOwn(localDate, "occurredAtUnixMs"), false);
    assert.equal(localDate.reversalEventId, parseXsollaReversalEvent({
        payload: structuredClone(partial),
        notificationType: "partial_refund",
        userId: USER
    }).reversalEventId);
});

test("distinct partial refunds derive distinct stable ids and exact amounts", () => {
    const first = parseXsollaReversalEvent({
        notificationType: "partial_refund",
        userId: USER,
        payload: refundPayload("partial_refund", {
            purchase: { total: { amount: "1.25", currency: "USD" } }
        })
    });
    const secondPayload = refundPayload("partial_refund", {
        purchase: { total: { amount: "2.00", currency: "USD" } },
        refund_details: {
            ...refundPayload().refund_details,
            date: "2026-08-23T01:03:03Z"
        }
    });
    const second = parseXsollaReversalEvent({
        notificationType: "partial_refund",
        userId: USER,
        payload: secondPayload
    });
    assert.equal(first.type, "refund");
    assert.equal(first.amountMinor, 125);
    assert.equal(second.amountMinor, 200);
    assert.notEqual(first.reversalEventId, second.reversalEventId);
    assert.match(first.reversalEventId, /^xsolla:partial_refund:[a-f0-9]{64}$/u);
});

test("combined order cancellation uses order identity and billing transaction", async () => {
    const spy = createSpyService();
    const process = createXsollaReversalEventProcessor({ reversalService: spy.service });
    await process({
        payload: cancellationPayload(),
        notificationType: "order_canceled",
        userId: USER
    });
    assert.equal(spy.calls[0].providerTransactionId, "706956443");
    assert.equal(spy.calls[0].type, "order_canceled");
    assert.equal(spy.calls[0].amountMinor, 399);
    assert.equal(spy.calls[0].currency, "USD");
    assert.equal(spy.calls[0].occurredAtUnixMs, Date.parse("2026-08-23T05:02:03Z"));
    assert.match(spy.calls[0].reversalEventId, /^xsolla:order_canceled:[a-f0-9]{64}$/u);
});

test("dispute is mapped to chargeback with stable action/status identity", async () => {
    const spy = createSpyService();
    const process = createXsollaReversalEventProcessor({ reversalService: spy.service });
    await process({
        payload: disputePayload(),
        notificationType: "dispute",
        userId: USER
    });
    assert.equal(spy.calls[0].providerTransactionId, "706956443");
    assert.equal(spy.calls[0].type, "chargeback");
    assert.equal(spy.calls[0].amountMinor, 399);
    assert.equal(spy.calls[0].reason,
        "not_as_described [type=chargeback; action=adding; status=new]");
    const update = disputePayload({
        action: "updating",
        dispute: { ...disputePayload().dispute, status: "lost" }
    });
    const parsedUpdate = parseXsollaReversalEvent({
        payload: update,
        notificationType: "dispute",
        userId: USER
    });
    assert.notEqual(parsedUpdate.reversalEventId, spy.calls[0].reversalEventId);
});

test("dispute without provider money fails closed because record-only service cannot look it up", () => {
    const payload = disputePayload();
    delete payload.transaction.total;
    assert.throws(() => parseXsollaReversalEvent({
        payload,
        notificationType: "dispute",
        userId: USER
    }), (error) => error instanceof XsollaReversalEventError && error.code === "MISSING_MONEY");
});

test("negative, zero, fractional-minor, and unsafe monetary amounts are rejected", () => {
    for (const amount of [-1, "0", "1.001", "90071992547409.92"]) {
        assert.throws(() => parseXsollaReversalEvent({
            payload: refundPayload("refund", {
                purchase: { total: { amount, currency: "USD" } }
            }),
            notificationType: "refund",
            userId: USER
        }), XsollaReversalEventError);
    }
});

test("ambiguous user, transaction, order, and currency evidence is rejected", () => {
    assert.throws(() => parseXsollaReversalEvent({
        payload: refundPayload(),
        notificationType: "refund",
        userId: "A_DIFFERENT_USER"
    }), (error) => error.code === "AMBIGUOUS_USER");
    assert.throws(() => parseXsollaReversalEvent({
        payload: refundPayload("refund", {
            billing: { transaction: { id: "999" } }
        }),
        notificationType: "refund",
        userId: USER
    }), (error) => error.code === "AMBIGUOUS_TRANSACTION");
    assert.throws(() => parseXsollaReversalEvent({
        payload: refundPayload("refund", {
            order: { id: "1" },
            purchase: {
                order: { id: "2" },
                total: { amount: "3.99", currency: "USD" }
            }
        }),
        notificationType: "refund",
        userId: USER
    }), (error) => error.code === "AMBIGUOUS_ORDER");
    assert.throws(() => parseXsollaReversalEvent({
        payload: cancellationPayload({
            order: {
                ...cancellationPayload().order,
                currency: "EUR"
            }
        }),
        notificationType: "order_canceled",
        userId: USER
    }), (error) => error.code === "AMBIGUOUS_MONEY");
});

test("malformed envelopes, refund details, timestamp, dispute status, and users fail closed", () => {
    assert.throws(() => parseXsollaReversalEvent({
        payload: refundPayload(),
        notificationType: "payment",
        userId: USER
    }), (error) => error.code === "UNSUPPORTED_NOTIFICATION");
    const noDate = refundPayload("partial_refund");
    delete noDate.refund_details.date;
    assert.throws(() => parseXsollaReversalEvent({
        payload: noDate,
        notificationType: "partial_refund",
        userId: USER
    }), (error) => error.code === "AMBIGUOUS_PARTIAL_REFUND");
    const invalidDate = refundPayload();
    invalidDate.refund_details.date = "2026-02-30T01:02:03Z";
    assert.throws(() => parseXsollaReversalEvent({
        payload: invalidDate,
        notificationType: "refund",
        userId: USER
    }), (error) => error.code === "INVALID_TIMESTAMP");
    const invalidDispute = disputePayload();
    invalidDispute.dispute.status = "mystery";
    assert.throws(() => parseXsollaReversalEvent({
        payload: invalidDispute,
        notificationType: "dispute",
        userId: USER
    }), (error) => error.code === "INVALID_DISPUTE");
    const badUser = refundPayload();
    badUser.user.id = ` ${USER}`;
    assert.throws(() => parseXsollaReversalEvent({
        payload: badUser,
        notificationType: "refund"
    }), XsollaReversalEventError);
});

test("signed int64 maximum survives as a string and unsafe JSON numbers fail", () => {
    const maximum = parseXsollaReversalEvent({
        payload: refundPayload("refund", {
            transaction: { id: "9223372036854775807" }
        }),
        notificationType: "refund",
        userId: USER
    });
    assert.equal(maximum.providerTransactionId, "9223372036854775807");
    for (const id of ["9223372036854775808", 9007199254740992, 0, "01", -1]) {
        assert.throws(() => parseXsollaReversalEvent({
            payload: refundPayload("refund", { transaction: { id } }),
            notificationType: "refund",
            userId: USER
        }), (error) => error instanceof XsollaReversalEventError &&
            error.code === "INVALID_INT64");
    }
});

test("processor construction requires record and recording errors are not swallowed", async () => {
    assert.throws(() => createXsollaReversalEventProcessor(), TypeError);
    const process = createXsollaReversalEventProcessor({
        reversalService: {
            async record() {
                throw new Error("ledger unavailable");
            }
        }
    });
    await assert.rejects(() => process({
        payload: refundPayload(),
        notificationType: "refund",
        userId: USER
    }), /ledger unavailable/u);
});
