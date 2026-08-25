import { createHash } from "node:crypto";
import { parseXsollaMinorUnits } from "./xsolla-economic-contract.js";

const SUPPORTED_NOTIFICATIONS = Object.freeze(new Set([
    "refund",
    "partial_refund",
    "order_canceled",
    "dispute"
]));
const DISPUTE_ACTIONS = Object.freeze(new Set(["adding", "updating"]));
const DISPUTE_STATUSES = Object.freeze(new Set([
    "new",
    "accepted",
    "no_actions_required",
    "won",
    "lost"
]));
const FINANCIAL_DISPUTE_TYPES = Object.freeze(new Set([
    "chargeback",
    "1st_time_chargeback",
    "2nd_time_chargeback",
    "arbitration"
]));
const INT64_MAXIMUM = 9223372036854775807n;

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasOwn(container, key) {
    return isPlainObject(container) && Object.prototype.hasOwnProperty.call(container, key);
}

export class XsollaReversalEventError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "XsollaReversalEventError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new XsollaReversalEventError(code, message);
}

function canonicalToken(value, name, maximumLength = 255) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_FIELD", `${name} must be a canonical non-empty token.`);
    }
    return value;
}

function canonicalText(value, name, maximumLength = 500) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_FIELD", `${name} must be bounded single-line text.`);
    }
    return value;
}

function canonicalUser(value) {
    return canonicalToken(value, "user identity", 160);
}

function canonicalPositiveInt64(value, name) {
    let text;
    if (typeof value === "string") text = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
    else if (typeof value === "bigint") text = String(value);
    else fail("INVALID_INT64", `${name} must be a lossless positive int64.`);
    if (!/^[1-9][0-9]*$/u.test(text)) {
        fail("INVALID_INT64", `${name} must be a canonical positive int64.`);
    }
    try {
        if (BigInt(text) > INT64_MAXIMUM) {
            fail("INVALID_INT64", `${name} exceeds signed int64.`);
        }
    } catch (error) {
        if (error instanceof XsollaReversalEventError) throw error;
        fail("INVALID_INT64", `${name} must be a canonical positive int64.`);
    }
    return text;
}

function canonicalNonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        fail("INVALID_FIELD", `${name} must be a non-negative safe integer.`);
    }
    return value;
}

function canonicalCurrency(value) {
    if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) {
        fail("INVALID_MONEY", "currency must be an uppercase ISO-4217 code.");
    }
    return value;
}

function exactPositiveMoney(container, name) {
    if (!isPlainObject(container) || !hasOwn(container, "amount") ||
        !hasOwn(container, "currency")) {
        fail("MISSING_MONEY", `${name} must contain amount and currency.`);
    }
    const amountMinor = parseXsollaMinorUnits(container.amount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        fail("INVALID_MONEY", `${name} amount must be exact, positive, and fit safe minor units.`);
    }
    return Object.freeze({
        amountMinor,
        currency: canonicalCurrency(container.currency)
    });
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function exactRfc3339(value, name) {
    if (typeof value !== "string") {
        fail("INVALID_TIMESTAMP", `${name} must be an RFC 3339 timestamp with timezone.`);
    }
    const match = value.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u
    );
    if (!match) {
        fail("INVALID_TIMESTAMP", `${name} must be an RFC 3339 timestamp with timezone.`);
    }
    const [, yearText, monthText, dayText, hourText, minuteText, secondText,
        fractionText = "", zone, sign, offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    const second = Number(secondText);
    if (year < 1970 || month < 1 || month > 12 || day < 1 ||
        day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
        fail("INVALID_TIMESTAMP", `${name} contains an invalid calendar value.`);
    }
    let offsetMinutes = 0;
    if (zone !== "Z") {
        const offsetHour = Number(offsetHourText);
        const offsetMinute = Number(offsetMinuteText);
        if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
            fail("INVALID_TIMESTAMP", `${name} contains an invalid UTC offset.`);
        }
        offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === "+" ? 1 : -1);
    }
    const milliseconds = Number((fractionText + "000").slice(0, 3));
    const occurredAtUnixMs = Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute,
        second,
        milliseconds
    ) - offsetMinutes * 60_000;
    if (!Number.isSafeInteger(occurredAtUnixMs) || occurredAtUnixMs < 0) {
        fail("INVALID_TIMESTAMP", `${name} is outside the supported Unix range.`);
    }
    return Object.freeze({
        occurredAtUnixMs,
        canonical: new Date(occurredAtUnixMs).toISOString()
    });
}

function optionalProviderTimestamp(value, name) {
    if (value === undefined || value === null) return null;
    try {
        return exactRfc3339(value, name);
    } catch (error) {
        if (typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
            throw error;
        }
        // Some Xsolla refund payloads use a provider-local timestamp without timezone.
        // It is stable identity evidence, but it must not be invented as a Unix instant.
        exactRfc3339(`${value.replace(" ", "T")}Z`, name);
        return Object.freeze({
            occurredAtUnixMs: undefined,
            canonical: `provider-local:${value}`
        });
    }
}

function stableDigest(value) {
    return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function stableEventId(notificationType, identity) {
    return `xsolla:${notificationType}:${stableDigest(identity)}`;
}

function resolveUser(payload, eventUserId, notificationType) {
    const payloadValue = notificationType === "order_canceled"
        ? payload?.user?.external_id
        : payload?.user?.id;
    const payloadUser = canonicalUser(payloadValue);
    if (eventUserId !== undefined && canonicalUser(eventUserId) !== payloadUser) {
        fail("AMBIGUOUS_USER", "Webhook envelope and payload user identities differ.");
    }
    return payloadUser;
}

function assertNoConflictingTransactionId(payload, expected, expectedPath) {
    const candidates = [
        ["transaction.id", payload?.transaction?.id],
        ["billing.transaction.id", payload?.billing?.transaction?.id]
    ].filter(([, value]) => value !== undefined && value !== null);
    for (const [path, value] of candidates) {
        const parsed = canonicalPositiveInt64(value, path);
        if (path !== expectedPath && parsed !== expected) {
            fail("AMBIGUOUS_TRANSACTION", "Webhook contains conflicting transaction identities.");
        }
    }
}

function refundDetails(container, name, { requireDate = false } = {}) {
    if (container === undefined || container === null) {
        if (requireDate) {
            fail(
                "AMBIGUOUS_PARTIAL_REFUND",
                `${name}.date is required to distinguish partial refunds.`
            );
        }
        return Object.freeze({ code: null, reason: null, author: null, timestamp: null });
    }
    if (!isPlainObject(container)) {
        fail("INVALID_REFUND_DETAILS", `${name} must be an object when present.`);
    }
    const code = hasOwn(container, "code")
        ? canonicalNonNegativeInteger(container.code, `${name}.code`)
        : null;
    const reason = hasOwn(container, "reason")
        ? canonicalText(container.reason, `${name}.reason`)
        : null;
    const author = hasOwn(container, "author")
        ? canonicalText(container.author, `${name}.author`, 255)
        : null;
    const timestamp = hasOwn(container, "date")
        ? optionalProviderTimestamp(container.date, `${name}.date`)
        : null;
    if (requireDate && !timestamp) {
        fail(
            "AMBIGUOUS_PARTIAL_REFUND",
            `${name}.date is required to distinguish partial refunds.`
        );
    }
    return Object.freeze({ code, reason, author, timestamp });
}

function describedReason(details, fallback, suffix) {
    const fields = [];
    if (details.code !== null) fields.push(`code=${details.code}`);
    if (details.author !== null) fields.push(`author=${details.author}`);
    if (suffix) fields.push(suffix);
    return `${details.reason || fallback}${fields.length ? ` [${fields.join("; ")}]` : ""}`;
}

function optionalOrderId(payload) {
    const values = [payload?.order?.id, payload?.purchase?.order?.id]
        .filter((value) => value !== undefined && value !== null)
        .map((value) => canonicalPositiveInt64(value, "order.id"));
    if (new Set(values).size > 1) {
        fail("AMBIGUOUS_ORDER", "Webhook contains conflicting order identities.");
    }
    return values[0] || null;
}

function parseRefund(payload, notificationType, userId) {
    const providerTransactionId = canonicalPositiveInt64(
        payload?.transaction?.id,
        "transaction.id"
    );
    assertNoConflictingTransactionId(payload, providerTransactionId, "transaction.id");
    const money = exactPositiveMoney(payload?.purchase?.total, "purchase.total");
    const details = refundDetails(payload?.refund_details, "refund_details", {
        requireDate: notificationType === "partial_refund"
    });
    const orderId = optionalOrderId(payload);
    const identity = {
        notificationType,
        providerTransactionId,
        orderId,
        userId,
        amountMinor: money.amountMinor,
        currency: money.currency,
        refund: {
            code: details.code,
            reason: details.reason,
            author: details.author,
            date: details.timestamp?.canonical || null
        }
    };
    return Object.freeze({
        providerTransactionId,
        reversalEventId: stableEventId(notificationType, identity),
        type: "refund",
        ...money,
        ...(details.timestamp?.occurredAtUnixMs === undefined
            ? {}
            : { occurredAtUnixMs: details.timestamp.occurredAtUnixMs }),
        reason: describedReason(details,
            notificationType === "partial_refund" ? "Xsolla partial refund" : "Xsolla refund"),
        expectedPlayFabId: userId
    });
}

function parseCancellation(payload, userId) {
    const providerTransactionId = canonicalPositiveInt64(
        payload?.billing?.transaction?.id,
        "billing.transaction.id"
    );
    assertNoConflictingTransactionId(
        payload,
        providerTransactionId,
        "billing.transaction.id"
    );
    const orderId = canonicalPositiveInt64(payload?.order?.id, "order.id");
    const money = exactPositiveMoney(payload?.billing?.purchase?.total, "billing.purchase.total");
    const orderMoney = exactPositiveMoney({
        amount: payload?.order?.amount,
        currency: payload?.order?.currency
    }, "order");
    if (payload?.order?.currency_type !== "real" ||
        orderMoney.amountMinor !== money.amountMinor || orderMoney.currency !== money.currency) {
        fail("AMBIGUOUS_MONEY", "Canceled order and billing totals must be identical real currency.");
    }
    if (payload?.billing?.notification_type !== "refund") {
        fail("INVALID_ENVELOPE", "Canceled order billing notification must be refund.");
    }
    const details = refundDetails(payload?.billing?.refund_details, "billing.refund_details");
    const identity = {
        notificationType: "order_canceled",
        providerTransactionId,
        orderId,
        userId,
        amountMinor: money.amountMinor,
        currency: money.currency,
        refund: {
            code: details.code,
            reason: details.reason,
            author: details.author,
            date: details.timestamp?.canonical || null
        }
    };
    return Object.freeze({
        providerTransactionId,
        reversalEventId: stableEventId("order_canceled", identity),
        type: "order_canceled",
        ...money,
        ...(details.timestamp?.occurredAtUnixMs === undefined
            ? {}
            : { occurredAtUnixMs: details.timestamp.occurredAtUnixMs }),
        reason: describedReason(details, "Xsolla order cancellation", `order=${orderId}`),
        expectedPlayFabId: userId
    });
}

function parseDispute(payload, userId) {
    const providerTransactionId = canonicalPositiveInt64(
        payload?.transaction?.id,
        "transaction.id"
    );
    assertNoConflictingTransactionId(payload, providerTransactionId, "transaction.id");
    // The current payment-reversal service intentionally exposes only record().
    // Therefore an omitted provider amount cannot be recovered through it and is rejected.
    const money = exactPositiveMoney(payload?.transaction?.total, "transaction.total");
    if (!isPlainObject(payload?.dispute)) {
        fail("INVALID_DISPUTE", "dispute details are required.");
    }
    const action = canonicalToken(payload?.action, "dispute action", 40);
    const status = canonicalToken(payload.dispute.status, "dispute status", 80);
    if (!DISPUTE_ACTIONS.has(action) || !DISPUTE_STATUSES.has(status)) {
        fail("INVALID_DISPUTE", "dispute action or status is unsupported.");
    }
    const disputeType = canonicalToken(payload.dispute.type, "dispute type", 80);
    if (action === "adding" &&
        (!FINANCIAL_DISPUTE_TYPES.has(disputeType) || status === "won")) {
        fail(
            "NON_FINANCIAL_DISPUTE",
            "A new monetary chargeback requires an adverse financial dispute type and status."
        );
    }
    const reason = canonicalToken(payload.dispute.reason, "dispute reason", 160);
    const timestamp = exactRfc3339(payload.dispute.incoming_date, "dispute.incoming_date");
    const disputeId = hasOwn(payload.dispute, "id")
        ? canonicalToken(payload.dispute.id, "dispute.id", 160)
        : null;
    const identity = {
        notificationType: "dispute",
        providerTransactionId,
        userId,
        disputeId,
        action,
        status,
        disputeType,
        reason,
        incomingDate: timestamp.canonical,
        amountMinor: money.amountMinor,
        currency: money.currency
    };
    return Object.freeze({
        providerTransactionId,
        reversalEventId: stableEventId("dispute", identity),
        type: "chargeback",
        ...money,
        occurredAtUnixMs: timestamp.occurredAtUnixMs,
        reason: `${reason} [type=${disputeType}; action=${action}; status=${status}]`,
        expectedPlayFabId: userId,
        disputeLifecycle: Object.freeze({
            action,
            status,
            disputeType,
            disputeId
        })
    });
}

export function parseXsollaReversalEvent({ payload, notificationType, userId } = {}) {
    if (!isPlainObject(payload) || !SUPPORTED_NOTIFICATIONS.has(notificationType) ||
        payload.notification_type !== notificationType) {
        fail("UNSUPPORTED_NOTIFICATION", "Xsolla reversal notification envelope is invalid.");
    }
    const canonicalUserId = resolveUser(payload, userId, notificationType);
    if (notificationType === "refund" || notificationType === "partial_refund") {
        return parseRefund(payload, notificationType, canonicalUserId);
    }
    if (notificationType === "order_canceled") {
        return parseCancellation(payload, canonicalUserId);
    }
    return parseDispute(payload, canonicalUserId);
}

export function createXsollaReversalEventProcessor({ reversalService } = {}) {
    if (!reversalService || typeof reversalService.record !== "function") {
        throw new TypeError("Xsolla reversal processor requires a reversal service.");
    }
    return async function processXsollaReversalEvent(event = {}) {
        const reversal = parseXsollaReversalEvent(event);
        await reversalService.record({
            provider: "xsolla",
            ...reversal,
            source: `xsolla_${event.notificationType}_webhook`
        });
        return "reversal_recorded";
    };
}
