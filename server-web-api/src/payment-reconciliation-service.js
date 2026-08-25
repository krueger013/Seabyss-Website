import { randomUUID } from "node:crypto";

function clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
}

function canonical(value, name, maximumLength = 500, allowSpaces = false) {
    const invalidWhitespace = allowSpaces ? /[\r\n\t\u0000-\u001f\u007f]/u : /\s/u;
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || invalidWhitespace.test(value)) {
        throw new TypeError(`${name} must be a canonical bounded string.`);
    }
    return value;
}

function pagination({ cursor = "0", limit = 50 } = {}) {
    const offset = Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) ||
        limit < 1 || limit > 200) {
        throw new TypeError("Admin audit pagination is invalid.");
    }
    return { offset, limit };
}

export function createMemoryPaymentAdminAuditSink({ maximumEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
        throw new TypeError("Admin audit capacity is invalid.");
    }
    const entries = [];
    return Object.freeze({
        async write(entry) {
            if (entries.length >= maximumEntries) {
                throw new Error("Admin payment audit capacity reached; archive before continuing.");
            }
            const record = Object.freeze({ id: randomUUID(), ...clone(entry) });
            entries.push(record);
            return clone(record);
        },
        async list(query = {}, options = {}) {
            const { offset, limit } = pagination(options);
            const filtered = entries.filter((entry) =>
                (!query.operator || entry.operator === query.operator) &&
                (!query.action || entry.action === query.action) &&
                (!query.provider || entry.provider === query.provider) &&
                (!query.providerTransactionId ||
                    entry.providerTransactionId === query.providerTransactionId));
            const items = filtered.slice(offset, offset + limit).map(clone);
            return {
                items,
                nextCursor: offset + items.length < filtered.length
                    ? String(offset + items.length)
                    : null
            };
        }
    });
}

export function createPaymentReconciliationService({
    ledger,
    workerService,
    auditSink,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!ledger || typeof ledger.lookup !== "function" ||
        typeof ledger.requireTransaction !== "function" ||
        typeof ledger.appendAudit !== "function" || !workerService ||
        typeof workerService.wake !== "function" || !auditSink ||
        typeof auditSink.write !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Payment reconciliation service is not configured.");
    }

    async function audit({ operator, action, reason, query = null, transaction = null, result }) {
        return auditSink.write({
            schemaVersion: 1,
            operator: canonical(operator, "admin operator", 160),
            action: canonical(action, "admin action", 100),
            reason: canonical(reason, "admin reason", 500, true),
            provider: transaction?.provider || null,
            providerTransactionId: transaction?.providerTransactionId || null,
            query: clone(query),
            result: clone(result),
            atUnixMs: nowMilliseconds()
        });
    }

    async function lookup({ operator, reason, query, cursor = "0", limit = 50 } = {}) {
        const result = await ledger.lookup(query, { cursor, limit });
        await audit({
            operator,
            action: "payment_lookup",
            reason,
            query,
            result: { count: result.items.length, nextCursor: result.nextCursor }
        });
        return result;
    }

    async function safeRetry({
        operator,
        reason,
        provider,
        providerTransactionId
    } = {}) {
        const transaction = await ledger.requireTransaction({ provider, providerTransactionId });
        const identity = {
            provider: transaction.provider,
            providerTransactionId: transaction.providerTransactionId
        };
        const unsafeStates = [
            "Completed",
            "Processing",
            "Quarantined",
            "DuplicatePaid",
            "RefundRequired",
            "ManualReview"
        ];
        if (unsafeStates.includes(transaction.state)) {
            let refusal = { status: "refused", state: transaction.state };
            if (transaction.state === "Processing") {
                const activeLease = transaction.leaseExpiresAtUnixMs !== null &&
                    transaction.leaseExpiresAtUnixMs > nowMilliseconds();
                refusal = {
                    status: "refused",
                    state: "Processing",
                    reason: activeLease ? "active_lease" : "processing_state"
                };
            }
            await audit({
                operator,
                action: "payment_retry_refused",
                reason,
                transaction,
                result: refusal
            });
            return Object.freeze(refusal);
        }
        const hasFinancialReversal = transaction.reversalStatus !== "None" ||
            transaction.reversedAmountMinor > 0 || transaction.reversalIds.length > 0;
        if (hasFinancialReversal) {
            const refusal = {
                status: "refused",
                state: transaction.state,
                reason: "financial_reversal"
            };
            await audit({
                operator,
                action: "payment_retry_refused",
                reason,
                transaction,
                result: refusal
            });
            return Object.freeze(refusal);
        }
        if (!["Pending", "Failed"].includes(transaction.state)) {
            const refusal = {
                status: "refused",
                state: transaction.state,
                reason: "ineligible_state"
            };
            await audit({
                operator,
                action: "payment_retry_refused",
                reason,
                transaction,
                result: refusal
            });
            return Object.freeze(refusal);
        }

        const adminOperator = canonical(operator, "admin operator", 160);
        const adminReason = canonical(reason, "admin reason", 500, true);
        await audit({
            operator: adminOperator,
            action: "payment_retry_requested",
            reason: adminReason,
            transaction,
            result: { previousState: transaction.state }
        });
        await ledger.appendAudit(identity, {
            actor: adminOperator,
            action: "admin_retry_requested",
            reason: adminReason,
            details: { previousState: transaction.state }
        });

        try {
            const wakeResult = await workerService.wake();
            const workerStatus = wakeResult?.status || "invalid_response";
            const result = workerStatus === "woken"
                ? Object.freeze({
                    status: "scheduled",
                    state: transaction.state,
                    workerStatus
                })
                : Object.freeze({
                    status: "deferred",
                    state: transaction.state,
                    workerStatus,
                    reason: "worker_not_running"
                });
            await audit({
                operator: adminOperator,
                action: "payment_retry_finished",
                reason: adminReason,
                transaction,
                result: { status: result.status, workerStatus }
            });
            return result;
        } catch (error) {
            await audit({
                operator: adminOperator,
                action: "payment_retry_failed",
                reason: adminReason,
                transaction,
                result: { errorCode: error?.code || "WORKER_SERVICE_ERROR" }
            });
            throw error;
        }
    }

    return Object.freeze({ lookup, safeRetry });
}
