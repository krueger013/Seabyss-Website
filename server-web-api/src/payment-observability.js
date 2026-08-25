export const PAYMENT_METRIC_EVENTS = Object.freeze([
    "webhook_received",
    "webhook_rejected_signature",
    "webhook_invalid_project",
    "checkout_created",
    "checkout_denied",
    "transaction_pending",
    "transaction_completed",
    "transaction_quarantined",
    "transaction_failed",
    "grant_retry",
    "reversal_received",
    "redis_failure",
    "playfab_failure",
    "ledger_failure",
    "duplicate_paid_starter",
    "reconciliation_mismatch",
    "worker_stalled",
    "payment_scanner_findings",
    "worker_loop_success",
    "worker_loop_failure",
    "pending_count",
    "processing_count",
    "completed_count",
    "manual_review_count",
    "playfab_call_latency",
    "playfab_retry",
    "lease_conflict",
    "fencing_reject",
    "profile_cas_conflict",
    "ambiguous_provider_result"
]);

const EVENT_SET = new Set(PAYMENT_METRIC_EVENTS);
const ALLOWED_LABELS = new Set([
    "provider",
    "environment",
    "reason",
    "type",
    "category",
    "component"
]);

function noOp() {}

function canonicalLabel(value, name) {
    if (typeof value !== "string" || value.length === 0 || value.length > 80 ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} metric label is invalid.`);
    }
    return value;
}

function normalizedLabels(labels) {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
        throw new TypeError("Payment metric labels must be an object.");
    }
    const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, value] of entries) {
        if (!ALLOWED_LABELS.has(key)) {
            throw new TypeError(`High-cardinality payment metric label is prohibited: ${key}`);
        }
        canonicalLabel(value, key);
    }
    return Object.fromEntries(entries);
}

function probeResult(value) {
    if (value === true) return { ok: true };
    if (value === false) return { ok: false, reason: "probe_failed" };
    if (value && typeof value === "object" && typeof value.ok === "boolean") return value;
    return { ok: false, reason: "invalid_probe_response" };
}

async function withTimeout(name, probe, timeoutMilliseconds) {
    let timer;
    try {
        const value = await Promise.race([
            Promise.resolve().then(probe),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }),
                    timeoutMilliseconds);
                timer.unref?.();
            })
        ]);
        return { name, ...probeResult(value) };
    } catch (error) {
        return {
            name,
            ok: false,
            reason: error?.code || error?.name || "probe_error"
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function createPaymentMetrics({
    nowMilliseconds = () => Date.now(),
    logger = { info: noOp },
    maximumSeries = 512,
    maximumRecentEvents = 5_000,
    recentWindowMilliseconds = 15 * 60 * 1000
} = {}) {
    if (typeof nowMilliseconds !== "function" || !Number.isSafeInteger(maximumSeries) ||
        maximumSeries <= 0 || !Number.isSafeInteger(maximumRecentEvents) ||
        maximumRecentEvents <= 0 || !Number.isSafeInteger(recentWindowMilliseconds) ||
        recentWindowMilliseconds <= 0) {
        throw new TypeError("Payment metrics configuration is invalid.");
    }
    const counters = new Map();
    const recent = [];

    function trim(now) {
        const oldest = now - recentWindowMilliseconds;
        while (recent.length > 0 && (recent[0].atUnixMs < oldest ||
            recent.length > maximumRecentEvents)) recent.shift();
    }

    function record(event, { value = 1, labels = {}, fields = {} } = {}) {
        if (!EVENT_SET.has(event) || !Number.isSafeInteger(value) || value < 0 ||
            !fields || typeof fields !== "object" || Array.isArray(fields)) {
            throw new TypeError("Payment metric event is invalid.");
        }
        const safeLabels = normalizedLabels(labels);
        const seriesKey = JSON.stringify([event, safeLabels]);
        if (!counters.has(seriesKey) && counters.size >= maximumSeries) {
            throw new Error("Payment metric series capacity reached.");
        }
        counters.set(seriesKey, (counters.get(seriesKey) || 0) + value);
        const atUnixMs = nowMilliseconds();
        recent.push({ event, value, labels: safeLabels, atUnixMs });
        trim(atUnixMs);
        logger.info?.({
            event: "payment_metric",
            metric: event,
            value,
            labels: safeLabels,
            fields,
            atUnixMs
        });
    }

    function snapshot() {
        const now = nowMilliseconds();
        trim(now);
        return Object.freeze({
            generatedAtUnixMs: now,
            counters: Object.freeze([...counters.entries()].map(([key, value]) => {
                const [event, labels] = JSON.parse(key);
                return Object.freeze({ event, labels: Object.freeze(labels), value });
            }))
        });
    }

    function windowCount(event, {
        sinceUnixMs = nowMilliseconds() - recentWindowMilliseconds,
        labels = null
    } = {}) {
        if (!EVENT_SET.has(event) || !Number.isSafeInteger(sinceUnixMs)) {
            throw new TypeError("Payment metric window query is invalid.");
        }
        const safeLabels = labels ? normalizedLabels(labels) : null;
        trim(nowMilliseconds());
        return recent
            .filter((item) => item.event === event && item.atUnixMs >= sinceUnixMs &&
                (!safeLabels || Object.entries(safeLabels)
                    .every(([key, value]) => item.labels[key] === value)))
            .reduce((total, item) => total + item.value, 0);
    }

    return Object.freeze({ record, snapshot, windowCount });
}

export function createPaymentHealthProbes({
    ledger,
    redisProbe,
    playFabProbe,
    worker,
    nowMilliseconds = () => Date.now(),
    timeoutMilliseconds = 2_000
} = {}) {
    if (!ledger || typeof ledger.ping !== "function" || typeof redisProbe !== "function" ||
        typeof playFabProbe !== "function" || !worker || typeof worker.health !== "function" ||
        typeof nowMilliseconds !== "function" || !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0) {
        throw new TypeError("Payment health probes are not configured.");
    }

    function liveness() {
        return Object.freeze({
            status: "alive",
            alive: true,
            checkedAtUnixMs: nowMilliseconds()
        });
    }

    async function readiness() {
        const checks = await Promise.all([
            withTimeout("ledger", () => ledger.ping(), timeoutMilliseconds),
            withTimeout("redis", redisProbe, timeoutMilliseconds),
            withTimeout("playfab", playFabProbe, timeoutMilliseconds),
            withTimeout("worker", async () => {
                const health = worker.health();
                return { ok: health.healthy, details: health };
            }, timeoutMilliseconds)
        ]);
        const ready = checks.every((check) => check.ok);
        return Object.freeze({
            status: ready ? "ready" : "not_ready",
            ready,
            checks: Object.freeze(checks.map(Object.freeze)),
            checkedAtUnixMs: nowMilliseconds()
        });
    }

    return Object.freeze({ liveness, readiness });
}

export function evaluatePaymentAlerts({
    metrics,
    scannerReport,
    readiness,
    certificateExpiresAtUnixMs = null,
    nowMilliseconds = Date.now(),
    windowMilliseconds = 5 * 60 * 1000,
    signatureFailureThreshold = 10,
    pendingThreshold = 1
} = {}) {
    if (!metrics || typeof metrics.windowCount !== "function" || !scannerReport ||
        !readiness || !Number.isSafeInteger(nowMilliseconds) ||
        !Number.isSafeInteger(windowMilliseconds) || windowMilliseconds <= 0) {
        throw new TypeError("Payment alert evaluation input is invalid.");
    }
    const sinceUnixMs = nowMilliseconds - windowMilliseconds;
    const alerts = [];
    const add = (severity, code, value) => alerts.push(Object.freeze({ severity, code, value }));
    const signatureFailures = metrics.windowCount("webhook_rejected_signature", { sinceUnixMs });
    if (signatureFailures >= signatureFailureThreshold) {
        add("critical", "signature_failures_abnormal", signatureFailures);
    }
    if (metrics.windowCount("redis_failure", { sinceUnixMs }) > 0) {
        add("critical", "redis_down_or_degraded", true);
    }
    if (metrics.windowCount("playfab_failure", { sinceUnixMs }) > 0) {
        add("critical", "playfab_down_or_degraded", true);
    }
    if (metrics.windowCount("duplicate_paid_starter", { sinceUnixMs }) > 0) {
        add("critical", "duplicate_paid_starter", true);
    }
    if (metrics.windowCount("reconciliation_mismatch", { sinceUnixMs }) > 0) {
        add("critical", "reconciliation_mismatch", true);
    }
    if ((scannerReport.counts?.pending || 0) >= pendingThreshold) {
        add("warning", "pending_over_threshold", scannerReport.counts.pending);
    }
    if ((scannerReport.counts?.quarantined || 0) > 0) {
        add("critical", "quarantined_transaction", scannerReport.counts.quarantined);
    }
    if ((scannerReport.counts?.expiredLeases || 0) > 0) {
        add("warning", "expired_payment_lease", scannerReport.counts.expiredLeases);
    }
    if ((scannerReport.counts?.unresolvedReversals || 0) > 0) {
        add("warning", "unresolved_reversal", scannerReport.counts.unresolvedReversals);
    }
    const worker = readiness.checks?.find((check) => check.name === "worker");
    if (worker && !worker.ok) add("critical", "worker_stalled", true);
    if (!readiness.ready) add("critical", "payment_readiness_failed", true);
    if (certificateExpiresAtUnixMs !== null) {
        if (!Number.isSafeInteger(certificateExpiresAtUnixMs)) {
            throw new TypeError("Certificate expiration must be Unix milliseconds.");
        }
        const daysRemaining = Math.floor(
            (certificateExpiresAtUnixMs - nowMilliseconds) / (24 * 60 * 60 * 1000)
        );
        if (daysRemaining <= 14) add("critical", "certificate_expiration", daysRemaining);
        else if (daysRemaining <= 30) add("warning", "certificate_expiration", daysRemaining);
    }
    return Object.freeze(alerts);
}
