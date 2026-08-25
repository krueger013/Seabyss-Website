const SAFE_ENTITLEMENT_ACTIONS = Object.freeze(new Set([
    "manual_review_no_automatic_clawback",
    "no_entitlement_change",
    "revoke_non_consumable_after_review",
    "suspend_future_entitlement_after_review"
]));

function noOp() {}

function canonical(value, name, maximumLength = 255) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} must be a canonical non-empty string.`);
    }
    return value;
}

function canonicalIdentity(value, name) {
    const identity = canonical(value, name, 160);
    if (/\s/u.test(identity)) {
        throw new TypeError(`${name} must not contain whitespace.`);
    }
    return identity;
}

function serviceError(code, message) {
    const error = new Error(message);
    error.name = "PaymentReversalServiceError";
    error.code = code;
    return error;
}

function isFullCancellationType(type) {
    return type === "refund" || type === "order_canceled";
}

function metric(metrics, event, labels = {}) {
    try {
        metrics?.record?.(event, { labels });
    } catch {
        // Observability is deliberately outside the financial transaction.
    }
}

export function createPaymentReversalService({
    ledger,
    policy = ({ type }) => ({
        supportAction: type === "chargeback"
            ? "urgent_account_financial_review"
            : "flag_account_financial_review",
        entitlementAction: "manual_review_no_automatic_clawback"
    }),
    metrics = null,
    logger = { info: noOp, warn: noOp, error: noOp }
} = {}) {
    if (!ledger || typeof ledger.createReversal !== "function" ||
        typeof ledger.requireTransaction !== "function" ||
        typeof ledger.lookupReversals !== "function" ||
        typeof ledger.transitionReversal !== "function" || typeof policy !== "function") {
        throw new TypeError("Payment reversal service is not configured.");
    }

    async function record({
        provider,
        providerTransactionId,
        reversalEventId,
        type,
        amountMinor,
        currency,
        occurredAtUnixMs,
        reason = null,
        source = "provider_webhook",
        expectedPlayFabId = null,
        disputeLifecycle = null
    } = {}) {
        const original = await ledger.requireTransaction({ provider, providerTransactionId });
        if (expectedPlayFabId !== null) {
            const expected = canonicalIdentity(expectedPlayFabId, "expected PlayFabId");
            if (original.playFabId !== expected) {
                throw serviceError(
                    "REVERSAL_USER_MISMATCH",
                    "Reversal user does not own the original payment transaction."
                );
            }
        }

        async function originalReversals() {
            const items = [];
            let cursor = "0";
            do {
                const page = await ledger.lookupReversals({
                    provider: original.provider,
                    providerTransactionId: original.providerTransactionId
                }, { cursor, limit: 200 });
                items.push(...page.items);
                cursor = page.nextCursor;
            } while (cursor);
            return items;
        }

        async function correlateFullCancellation() {
            if (!isFullCancellationType(type) || amountMinor !== original.amountMinor ||
                currency !== original.currency) {
                return null;
            }
            const matches = (await originalReversals()).filter((entry) =>
                isFullCancellationType(entry.type) &&
                entry.amountMinor === original.amountMinor &&
                entry.currency === original.currency
            );
            if (matches.length > 1) {
                throw serviceError(
                    "AMBIGUOUS_FULL_CANCELLATION",
                    "Original payment has multiple full-cancellation reversals."
                );
            }
            if (matches.length === 0) return null;
            logger.info?.({
                event: "reversal_correlated",
                provider: original.provider,
                providerTransactionId: original.providerTransactionId,
                reversalEventId,
                correlatedReversalEventId: matches[0].reversalEventId,
                reversalType: type
            });
            return Object.freeze({
                status: matches[0].reversalEventId === reversalEventId
                    ? "existing"
                    : "correlated_existing",
                record: matches[0]
            });
        }

        async function applyDisputeUpdate(lifecycle) {
            const action = canonical(lifecycle?.action, "dispute action", 40);
            const status = canonical(lifecycle?.status, "dispute status", 80);
            const disputeType = canonical(lifecycle?.disputeType, "dispute type", 80);
            if (action !== "updating") return null;
            if (amountMinor !== original.amountMinor || currency !== original.currency) {
                throw serviceError(
                    "DISPUTE_ECONOMIC_MISMATCH",
                    "Dispute update economics differ from the original payment."
                );
            }
            const matches = (await originalReversals()).filter((entry) =>
                entry.type === "chargeback"
            );
            if (matches.length !== 1) {
                throw serviceError(
                    matches.length === 0
                        ? "DISPUTE_REVERSAL_NOT_FOUND"
                        : "AMBIGUOUS_DISPUTE_REVERSAL",
                    "Dispute update cannot identify exactly one original chargeback case."
                );
            }
            const reversal = matches[0];
            const resolves = status === "won" ||
                disputeType === "chargeback_reversal" ||
                disputeType === "representment_reversal" ||
                disputeType === "reimbursement";
            const target = resolves ? "ResolvedNoClawback" : "UnderReview";
            if (reversal.status === target) {
                return Object.freeze({ status: "lifecycle_existing", record: reversal });
            }
            if (reversal.status === "ResolvedNoClawback") {
                throw serviceError(
                    "DISPUTE_LIFECYCLE_CONFLICT",
                    "A resolved dispute cannot return to an unresolved financial state."
                );
            }
            let current = reversal;
            if (target === "ResolvedNoClawback" && current.status === "Failed") {
                current = (await ledger.transitionReversal({
                    provider: current.provider,
                    reversalEventId: current.reversalEventId
                }, {
                    toStatus: "UnderReview",
                    actor: canonical(source, "reversal source", 160),
                    reason: "Dispute lifecycle recovery before resolution.",
                    details: { incomingReversalEventId: reversalEventId }
                })).record;
            }
            const transitioned = await ledger.transitionReversal({
                provider: current.provider,
                reversalEventId: current.reversalEventId
            }, {
                toStatus: target,
                actor: canonical(source, "reversal source", 160),
                reason,
                details: {
                    incomingReversalEventId: reversalEventId,
                    disputeAction: action,
                    disputeStatus: status,
                    disputeType
                }
            });
            return Object.freeze({ status: "lifecycle_updated", record: transitioned.record });
        }

        if (disputeLifecycle?.action === "updating") {
            metric(metrics, "reversal_received", { provider: original.provider, type });
            return applyDisputeUpdate(disputeLifecycle);
        }
        const correlated = await correlateFullCancellation();
        if (correlated) return correlated;
        const decision = await policy(Object.freeze({
            type,
            transaction: original,
            amountMinor,
            currency,
            reason
        }));
        const entitlementAction = canonical(
            decision?.entitlementAction,
            "reversal entitlement action"
        );
        if (!SAFE_ENTITLEMENT_ACTIONS.has(entitlementAction)) {
            throw new Error("Automatic consumable clawback is prohibited by payment policy.");
        }
        const supportAction = canonical(decision?.supportAction, "reversal support action");
        metric(metrics, "reversal_received", { provider: original.provider, type });
        let result;
        try {
            result = await ledger.createReversal({
                provider: original.provider,
                providerTransactionId: original.providerTransactionId,
                reversalEventId,
                type,
                amountMinor,
                currency,
                occurredAtUnixMs,
                reason,
                supportAction,
                entitlementAction,
                createdBy: canonical(source, "reversal source", 160)
            });
        } catch (error) {
            if (error?.code === "REVERSAL_AMOUNT_EXCEEDED") {
                const racedCorrelation = await correlateFullCancellation();
                if (racedCorrelation) return racedCorrelation;
            }
            throw error;
        }
        logger.info?.({
            event: "reversal_recorded",
            provider: original.provider,
            providerTransactionId: original.providerTransactionId,
            reversalEventId,
            reversalType: type,
            replay: result.status === "existing"
        });
        return result;
    }

    return Object.freeze({ record });
}

export { SAFE_ENTITLEMENT_ACTIONS };
