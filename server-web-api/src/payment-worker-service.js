function noOp() {}

function safeError(error) {
    const message = error instanceof Error ? error.message : "Unknown payment worker service error";
    return message.replace(/[\r\n\t]+/gu, " ").slice(0, 1000);
}

function canonicalToken(value, name, maximumLength = 160) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} must be a canonical non-empty string.`);
    }
    return value;
}

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return value;
}

function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function recordMetric(metrics, event, labels = {}, fields = {}) {
    try {
        metrics?.record?.(event, { labels, fields });
    } catch {
        // Observability must never change financial processing semantics.
    }
}

export function computePaymentWorkerServiceBackoff({
    attempt,
    baseMilliseconds,
    maximumMilliseconds,
    jitterRatio = 0.2,
    randomValue = 0.5
} = {}) {
    positiveInteger(attempt, "backoff attempt");
    positiveInteger(baseMilliseconds, "backoff base");
    positiveInteger(maximumMilliseconds, "backoff maximum");
    if (baseMilliseconds > maximumMilliseconds || typeof jitterRatio !== "number" ||
        !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1 ||
        typeof randomValue !== "number" || !Number.isFinite(randomValue) ||
        randomValue < 0 || randomValue > 1) {
        throw new TypeError("Payment worker service backoff is invalid.");
    }
    const exponent = Math.min(attempt - 1, 52);
    const exponential = Math.min(maximumMilliseconds, baseMilliseconds * (2 ** exponent));
    const factor = 1 - jitterRatio + (2 * jitterRatio * randomValue);
    return Math.max(1, Math.min(maximumMilliseconds, Math.round(exponential * factor)));
}

export function createPaymentWorkerService({
    worker,
    ledger,
    serviceId = `payments-worker-service-${process.pid}`,
    pollIntervalMilliseconds = 1_000,
    retryBackoffBaseMilliseconds = 250,
    retryBackoffMaximumMilliseconds = 30_000,
    retryJitterRatio = 0.2,
    maximumTransactionsPerBatch = 1,
    maximumRetries = 12,
    defaultDrainTimeoutMilliseconds = 30_000,
    nowMilliseconds = () => Date.now(),
    random = Math.random,
    metrics = null,
    logger = { info: noOp, warn: noOp, error: noOp }
} = {}) {
    if (!worker || typeof worker.processPending !== "function" ||
        typeof worker.health !== "function" || !ledger ||
        typeof ledger.requireTransaction !== "function" ||
        typeof ledger.transition !== "function" || typeof nowMilliseconds !== "function" ||
        typeof random !== "function") {
        throw new TypeError("Payment worker service is not configured.");
    }
    const owner = canonicalToken(serviceId, "serviceId");
    positiveInteger(pollIntervalMilliseconds, "poll interval");
    positiveInteger(retryBackoffBaseMilliseconds, "retry backoff base");
    positiveInteger(retryBackoffMaximumMilliseconds, "retry backoff maximum");
    if (retryBackoffBaseMilliseconds > retryBackoffMaximumMilliseconds ||
        typeof retryJitterRatio !== "number" || !Number.isFinite(retryJitterRatio) ||
        retryJitterRatio < 0 || retryJitterRatio > 1) {
        throw new TypeError("Payment worker service retry policy is invalid.");
    }
    positiveInteger(maximumTransactionsPerBatch, "maximum transactions per batch");
    positiveInteger(maximumRetries, "maximum retries");
    nonNegativeInteger(defaultDrainTimeoutMilliseconds, "default drain timeout");

    let state = "stopped";
    let loopPromise = null;
    let stopRequested = false;
    let wakeRequested = false;
    let wakeCurrentWait = null;
    let consecutiveFailures = 0;
    let lastLoopStartedAtUnixMs = null;
    let lastLoopSucceededAtUnixMs = null;
    let lastProgressAtUnixMs = null;
    let lastErrorAtUnixMs = null;
    let lastErrorCode = null;
    let lastDelayMilliseconds = null;
    let backoffUntilUnixMs = null;
    let lastBatch = Object.freeze({ total: 0, completed: 0, failed: 0, busy: 0 });
    let exhaustedRetries = 0;
    let drainTimedOut = false;

    function randomUnit() {
        const value = random();
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new TypeError("Payment worker service random source returned an invalid value.");
        }
        return value;
    }

    function delayForFailure() {
        return computePaymentWorkerServiceBackoff({
            attempt: consecutiveFailures,
            baseMilliseconds: retryBackoffBaseMilliseconds,
            maximumMilliseconds: retryBackoffMaximumMilliseconds,
            jitterRatio: retryJitterRatio,
            randomValue: randomUnit()
        });
    }

    function summarize(results) {
        const summary = { total: results.length, completed: 0, failed: 0, busy: 0 };
        for (const result of results) {
            if (result?.status === "completed" || result?.status === "already_completed") {
                summary.completed += 1;
            } else if (result?.status === "failed") {
                summary.failed += 1;
            } else if (result?.status === "busy" || result?.status === "player_busy") {
                summary.busy += 1;
            }
        }
        return Object.freeze(summary);
    }

    async function moveExhaustedRetriesToManualReview(results) {
        for (const result of results) {
            if (result?.status !== "failed" || typeof result.provider !== "string" ||
                typeof result.providerTransactionId !== "string") continue;
            const identity = {
                provider: result.provider,
                providerTransactionId: result.providerTransactionId
            };
            const transaction = await ledger.requireTransaction(identity);
            if (transaction.state !== "Failed" ||
                (result.permanent !== true && transaction.retryCount < maximumRetries)) continue;
            try {
                await ledger.transition(identity, {
                    toState: "ManualReview",
                    expectedVersion: transaction.version,
                    actor: owner,
                    reason: "worker_retry_exhausted",
                    details: {
                        retryCount: transaction.retryCount,
                        errorCode: result.errorCode || "WORKER_ERROR",
                        permanent: result.permanent === true
                    },
                    lastError: transaction.lastError
                });
                exhaustedRetries += 1;
                recordMetric(metrics, "transaction_failed", {
                    component: "worker_service",
                    reason: "retry_exhausted"
                }, { retryCount: transaction.retryCount, state: "ManualReview" });
                logger.error?.({
                    event: "payment_worker_retry_exhausted",
                    retryCount: transaction.retryCount,
                    errorCode: result.errorCode || "WORKER_ERROR"
                });
            } catch (error) {
                if (error?.code !== "VERSION_CONFLICT" && error?.code !== "INVALID_STATE") {
                    throw error;
                }
            }
        }
    }

    function waitForWakeOrDelay(milliseconds) {
        if (wakeRequested || stopRequested) {
            wakeRequested = false;
            return Promise.resolve("wake");
        }
        return new Promise((resolve) => {
            let settled = false;
            const finish = (reason) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (wakeCurrentWait === wake) wakeCurrentWait = null;
                wakeRequested = false;
                resolve(reason);
            };
            const wake = () => finish("wake");
            const timer = setTimeout(() => finish("timeout"), milliseconds);
            timer.unref?.();
            wakeCurrentWait = wake;
        });
    }

    async function runLoop() {
        try {
            while (!stopRequested) {
                lastLoopStartedAtUnixMs = nowMilliseconds();
                state = consecutiveFailures > 0 ? "backing_off" : "running";
                let delay = pollIntervalMilliseconds;
                try {
                    const results = await worker.processPending({
                        maximumTransactions: maximumTransactionsPerBatch
                    });
                    if (!Array.isArray(results)) {
                        throw new TypeError("Payment worker batch returned an invalid result.");
                    }
                    lastBatch = summarize(results);
                    await moveExhaustedRetriesToManualReview(results);
                    recordMetric(metrics, "worker_loop_success", {
                        component: "worker_service"
                    }, { total: lastBatch.total, completed: lastBatch.completed });
                    lastLoopSucceededAtUnixMs = nowMilliseconds();
                    if (lastBatch.completed > 0) lastProgressAtUnixMs = lastLoopSucceededAtUnixMs;
                    if (lastBatch.failed > 0) {
                        consecutiveFailures += 1;
                        lastErrorAtUnixMs = lastLoopSucceededAtUnixMs;
                        lastErrorCode = "TRANSACTION_FAILURE";
                        const retryAfter = results.reduce((maximum, result) =>
                            Number.isSafeInteger(result?.retryAfterMilliseconds) &&
                                result.retryAfterMilliseconds > 0
                                ? Math.max(maximum, result.retryAfterMilliseconds)
                                : maximum, 0);
                        delay = Math.min(retryBackoffMaximumMilliseconds,
                            Math.max(delayForFailure(), retryAfter));
                        state = "backing_off";
                        recordMetric(metrics, "grant_retry", { component: "worker_service" }, {
                            failed: lastBatch.failed,
                            consecutiveFailures
                        });
                    } else {
                        consecutiveFailures = 0;
                        lastErrorCode = null;
                        state = "running";
                    }
                } catch (error) {
                    consecutiveFailures += 1;
                    lastErrorAtUnixMs = nowMilliseconds();
                    lastErrorCode = error?.code || "WORKER_SERVICE_ERROR";
                    lastBatch = Object.freeze({ total: 0, completed: 0, failed: 0, busy: 0 });
                    delay = delayForFailure();
                    state = "backing_off";
                    recordMetric(metrics, "worker_loop_failure", {
                        component: "worker_service"
                    }, { consecutiveFailures });
                    recordMetric(metrics, "transaction_failed", {
                        component: "worker_service",
                        reason: "loop_error"
                    }, { consecutiveFailures });
                    logger.error?.({
                        event: "payment_worker_service_loop_failed",
                        errorCode: lastErrorCode,
                        message: safeError(error),
                        consecutiveFailures
                    });
                }
                if (stopRequested) break;
                lastDelayMilliseconds = delay;
                backoffUntilUnixMs = nowMilliseconds() + delay;
                await waitForWakeOrDelay(delay);
                backoffUntilUnixMs = null;
            }
        } finally {
            wakeCurrentWait = null;
            backoffUntilUnixMs = null;
            state = "stopped";
            loopPromise = null;
        }
    }

    function start() {
        if (loopPromise) return Object.freeze({ status: "already_running" });
        stopRequested = false;
        wakeRequested = false;
        drainTimedOut = false;
        state = "starting";
        loopPromise = Promise.resolve().then(runLoop);
        logger.info?.({ event: "payment_worker_service_started", serviceId: owner });
        return Object.freeze({ status: "started" });
    }

    function wake() {
        if (!loopPromise || stopRequested) return Object.freeze({ status: "not_running" });
        wakeRequested = true;
        wakeCurrentWait?.();
        return Object.freeze({ status: "woken" });
    }

    async function stop({ drainTimeoutMilliseconds = defaultDrainTimeoutMilliseconds } = {}) {
        nonNegativeInteger(drainTimeoutMilliseconds, "drain timeout");
        if (!loopPromise) return Object.freeze({ status: "already_stopped", timedOut: false });
        stopRequested = true;
        state = "draining";
        wakeCurrentWait?.();
        const activeLoop = loopPromise;
        if (drainTimeoutMilliseconds === 0) {
            drainTimedOut = true;
            recordMetric(metrics, "worker_stalled", {
                component: "worker_service",
                reason: "drain_timeout"
            });
            return Object.freeze({ status: "draining", timedOut: true });
        }
        let timer;
        const timedOut = await Promise.race([
            activeLoop.then(() => false),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(true), drainTimeoutMilliseconds);
                timer.unref?.();
            })
        ]);
        if (timer) clearTimeout(timer);
        drainTimedOut = timedOut;
        if (timedOut) {
            recordMetric(metrics, "worker_stalled", {
                component: "worker_service",
                reason: "drain_timeout"
            });
            logger.warn?.({ event: "payment_worker_service_drain_timeout" });
            return Object.freeze({ status: "draining", timedOut: true });
        }
        logger.info?.({ event: "payment_worker_service_stopped", serviceId: owner });
        return Object.freeze({ status: "stopped", timedOut: false });
    }

    function health() {
        let workerHealth;
        try {
            workerHealth = worker.health();
        } catch (error) {
            workerHealth = { healthy: false, errorCode: error?.code || "WORKER_HEALTH_ERROR" };
        }
        const healthy = state === "running" && consecutiveFailures === 0 &&
            lastLoopSucceededAtUnixMs !== null && workerHealth?.healthy === true;
        return Object.freeze({
            healthy,
            serviceId: owner,
            state,
            running: loopPromise !== null,
            draining: state === "draining",
            drainTimedOut,
            consecutiveFailures,
            lastLoopStartedAtUnixMs,
            lastLoopSucceededAtUnixMs,
            lastProgressAtUnixMs,
            lastErrorAtUnixMs,
            lastErrorCode,
            lastDelayMilliseconds,
            backoffUntilUnixMs,
            lastBatch,
            exhaustedRetries,
            worker: workerHealth
        });
    }

    return Object.freeze({ start, wake, stop, health });
}
