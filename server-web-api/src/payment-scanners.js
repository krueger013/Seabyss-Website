function canonicalPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return value;
}

function identity(transaction) {
    return Object.freeze({
        provider: transaction.provider,
        providerTransactionId: transaction.providerTransactionId,
        orderId: transaction.orderId,
        receiptId: transaction.receiptId,
        playFabId: transaction.playFabId,
        sku: transaction.sku,
        state: transaction.state,
        updatedAtUnixMs: transaction.updatedAtUnixMs,
        leaseOwner: transaction.leaseOwner,
        leaseExpiresAtUnixMs: transaction.leaseExpiresAtUnixMs
    });
}

function reversalIdentity(reversal) {
    return Object.freeze({
        provider: reversal.provider,
        providerTransactionId: reversal.providerTransactionId,
        reversalEventId: reversal.reversalEventId,
        playFabId: reversal.playFabId,
        type: reversal.type,
        status: reversal.status,
        updatedAtUnixMs: reversal.updatedAtUnixMs,
        supportAction: reversal.supportAction,
        entitlementAction: reversal.entitlementAction
    });
}

function recordMetric(metrics, category, count) {
    try {
        metrics?.record?.("payment_scanner_findings", {
            value: count,
            labels: { category }
        });
        const stateMetric = {
            pending: "pending_count",
            processing: "processing_count",
            completed: "completed_count",
            manualReview: "manual_review_count"
        }[category];
        if (stateMetric) metrics?.record?.(stateMetric, { value: count });
    } catch {
        // Scanner findings remain available even if metrics transport is unavailable.
    }
}

export function createPaymentScanners({
    ledger,
    metrics = null,
    nowMilliseconds = () => Date.now(),
    pendingOlderThanMilliseconds = 15 * 60 * 1000,
    maximumRecords = 10_000
} = {}) {
    if (!ledger || typeof ledger.scanTransactions !== "function" ||
        typeof ledger.scanReversals !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Payment scanners are not configured.");
    }
    canonicalPositiveInteger(pendingOlderThanMilliseconds, "pending age threshold");
    canonicalPositiveInteger(maximumRecords, "scanner record limit");

    async function collect(scan) {
        const items = [];
        let cursor = "0";
        let truncated = false;
        while (items.length < maximumRecords) {
            const remaining = maximumRecords - items.length;
            const page = await scan({ cursor, limit: Math.min(200, remaining) });
            items.push(...page.items);
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
            if (items.length >= maximumRecords) truncated = true;
        }
        return { items, truncated };
    }

    async function scan() {
        const now = nowMilliseconds();
        const [transactionPage, reversalPage] = await Promise.all([
            collect((page) => ledger.scanTransactions(page)),
            collect((page) => ledger.scanReversals(page))
        ]);
        const pending = transactionPage.items
            .filter((record) => record.state === "Pending" &&
                record.updatedAtUnixMs <= now - pendingOlderThanMilliseconds)
            .map(identity);
        const quarantined = transactionPage.items
            .filter((record) => record.state === "Quarantined")
            .map(identity);
        const expiredLeases = transactionPage.items
            .filter((record) => record.leaseToken !== null &&
                record.leaseExpiresAtUnixMs !== null && record.leaseExpiresAtUnixMs <= now)
            .map(identity);
        const orphanReceipts = transactionPage.items
            .filter((record) => record.receiptId !== null && record.state !== "Completed")
            .map(identity);
        const processing = transactionPage.items
            .filter((record) => record.state === "Processing")
            .map(identity);
        const completed = transactionPage.items
            .filter((record) => record.state === "Completed")
            .map(identity);
        const manualReview = transactionPage.items
            .filter((record) => record.state === "ManualReview")
            .map(identity);
        const unresolvedReversals = reversalPage.items
            .filter((record) => record.status !== "ResolvedNoClawback")
            .map(reversalIdentity);
        const findings = Object.freeze({
            pending: Object.freeze(pending),
            quarantined: Object.freeze(quarantined),
            expiredLeases: Object.freeze(expiredLeases),
            orphanReceipts: Object.freeze(orphanReceipts),
            processing: Object.freeze(processing),
            completed: Object.freeze(completed),
            manualReview: Object.freeze(manualReview),
            unresolvedReversals: Object.freeze(unresolvedReversals)
        });
        const counts = Object.freeze(Object.fromEntries(
            Object.entries(findings).map(([category, records]) => [category, records.length])
        ));
        for (const [category, count] of Object.entries(counts)) {
            recordMetric(metrics, category, count);
        }
        return Object.freeze({
            generatedAtUnixMs: now,
            truncated: transactionPage.truncated || reversalPage.truncated,
            counts,
            findings
        });
    }

    return Object.freeze({ scan });
}
