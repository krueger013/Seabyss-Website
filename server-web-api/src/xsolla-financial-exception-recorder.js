import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";

const SUPPORTED_STATES = new Set(["Quarantined", "DuplicatePaid"]);

function canonicalToken(value, name, maximumLength = 255) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function recordMetric(metrics, event, options) {
    try {
        metrics?.record?.(event, options);
    } catch {
        // Observability must never change financial state.
    }
}

export function createXsollaFinancialExceptionRecorder({
    ledger,
    resolveStarterRewardPlan = getStarterRewardPlan,
    metrics = null,
    logger = { warn() {} }
} = {}) {
    if (!ledger || typeof ledger.createTransaction !== "function" ||
        typeof ledger.appendAudit !== "function" ||
        typeof resolveStarterRewardPlan !== "function") {
        throw new TypeError("Xsolla financial exception recorder is not configured.");
    }

    return async function recordXsollaFinancialException({
        state,
        reason,
        errorCode = null,
        reconciliationCaseKey = null,
        playFabId,
        transactionId,
        product,
        productPlan,
        environment,
        createdAtUtc,
        notificationType
    } = {}) {
        if (!SUPPORTED_STATES.has(state) || !product || !productPlan ||
            product.xsollaSku !== productPlan.sku ||
            product.productType !== productPlan.productType) {
            throw new TypeError("Xsolla financial exception identity is invalid.");
        }
        const safeReason = canonicalToken(reason, "Financial exception reason", 80);
        const safeErrorCode = errorCode === null
            ? null
            : canonicalToken(errorCode, "Economic mismatch code", 80);
        const safeCaseKey = reconciliationCaseKey === null
            ? null
            : canonicalToken(reconciliationCaseKey, "Reconciliation case key", 255);
        const createdAtUnixMs = Date.parse(createdAtUtc);
        if (!Number.isSafeInteger(createdAtUnixMs) || createdAtUnixMs < 0) {
            throw new TypeError("Xsolla financial exception timestamp is invalid.");
        }
        const planHash = product.productType === "starter_pack"
            ? resolveStarterRewardPlan(product.xsollaSku, productPlan.planVersion).rewardPlanHash
            : productPlan.planHash;

        const created = await ledger.createTransaction({
            provider: "xsolla",
            providerTransactionId: transactionId,
            orderId: transactionId,
            receiptId: null,
            playFabId,
            sku: product.xsollaSku,
            planVersion: productPlan.planVersion,
            planHash,
            amountMinor: productPlan.unitAmountMinor,
            currency: productPlan.currency,
            environment,
            createdAtUnixMs,
            state,
            createdBy: "xsolla_webhook",
            creationReason: safeReason
        });
        if (created.record.state !== state) {
            throw new Error("Existing payment ledger state conflicts with the financial exception.");
        }
        if (created.status === "created") {
            await ledger.appendAudit({
                provider: "xsolla",
                providerTransactionId: transactionId
            }, {
                actor: "xsolla_webhook",
                action: state === "Quarantined"
                    ? "economic_mismatch_quarantined"
                    : "duplicate_paid_reconciliation",
                reason: safeReason,
                details: {
                    errorCode: safeErrorCode,
                    reconciliationCaseKey: safeCaseKey,
                    notificationType: canonicalToken(notificationType, "Notification type", 80)
                }
            });
            recordMetric(metrics,
                state === "Quarantined" ? "transaction_quarantined" : "duplicate_paid_starter",
                { labels: { provider: "xsolla", environment, reason: safeReason } });
        }
        logger.warn?.("Xsolla financial exception recorded.", {
            event: state === "Quarantined" ? "transaction_quarantined" : "duplicate_paid_starter",
            provider: "xsolla",
            providerTransactionId: transactionId,
            playFabId,
            sku: product.xsollaSku,
            state,
            reason: safeReason,
            replay: created.status === "existing"
        });
        return created;
    };
}
