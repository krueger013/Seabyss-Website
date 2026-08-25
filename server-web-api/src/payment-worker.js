import { createHash, randomUUID } from "node:crypto";
import { PaymentLedgerError } from "./payment-ledger.js";

function noOp() {}

function clone(value) {
    return value === null || value === undefined ? value : structuredClone(value);
}

function canonicalWorkerToken(value, name, maximumLength = 160) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} must be a canonical non-empty string.`);
    }
    return value;
}

function canonicalPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return value;
}

function safeError(error) {
    const message = error instanceof Error ? error.message : "Unknown payment worker failure";
    return message.replace(/[\r\n\t]+/gu, " ").slice(0, 1000);
}

function operationId(provider, providerTransactionId, checkpointName) {
    const identityHash = createHash("sha256")
        .update(provider, "utf8")
        .update("\0", "utf8")
        .update(providerTransactionId, "utf8")
        .digest("base64url");
    return `payment:${identityHash}:${checkpointName}:v1`;
}

function recordMetric(metrics, event, labels = {}, fields = {}) {
    try {
        metrics?.record?.(event, { labels, fields });
    } catch {
        // Metrics must never change financial processing semantics.
    }
}

export class PaymentWorkerCrash extends Error {
    constructor(stage, message = `Simulated worker crash at ${stage}`) {
        super(message);
        this.name = "PaymentWorkerCrash";
        this.stage = stage;
    }
}

export function createCasProfileStep({
    name,
    profileStore,
    mutate,
    maximumAttempts = 5
} = {}) {
    const stepName = canonicalWorkerToken(name, "CAS checkpoint name", 80);
    if (!/^[a-z0-9][a-z0-9_.-]*$/u.test(stepName) ||
        !profileStore || typeof profileStore.read !== "function" ||
        typeof profileStore.compareAndSet !== "function" || typeof mutate !== "function") {
        throw new TypeError("CAS profile checkpoint is not configured.");
    }
    canonicalPositiveInteger(maximumAttempts, "maximum CAS attempts");

    return Object.freeze({
        name: stepName,
        async run(context) {
            for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
                const snapshot = await profileStore.read(context.transaction.playFabId);
                if (!snapshot || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 ||
                    !("profile" in snapshot)) {
                    throw new Error("Profile store returned an invalid versioned snapshot.");
                }
                const nextProfile = await mutate(clone(snapshot.profile), Object.freeze({
                    ...context,
                    casAttempt: attempt,
                    profileVersion: snapshot.version
                }));
                const result = await profileStore.compareAndSet({
                    playFabId: context.transaction.playFabId,
                    expectedVersion: snapshot.version,
                    profile: clone(nextProfile),
                    operationId: context.operationId,
                    fencingToken: context.playerLeaseEpoch
                });
                if (result?.applied === true) {
                    return {
                        status: "applied",
                        version: result.version,
                        attempts: attempt
                    };
                }
                if (result?.reason === "already_applied") {
                    return {
                        status: "already_applied",
                        version: result.version,
                        attempts: attempt
                    };
                }
                if (result?.reason !== "version_conflict") {
                    throw new Error("Profile CAS returned an invalid result.");
                }
            }
            throw new Error(`Profile CAS conflict exceeded ${maximumAttempts} attempts.`);
        }
    });
}

export function createPaymentWorker({
    ledger,
    steps,
    workerId = `payments-worker-${process.pid}`,
    leaseTtlMilliseconds = 30_000,
    leaseRenewIntervalMilliseconds = 10_000,
    playerLeaseWaitMilliseconds = 2_000,
    playerLeasePollMilliseconds = 10,
    nowMilliseconds = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    faultInjector = async () => {},
    metrics = null,
    completeAfterCheckpoints = true,
    logger = { info: noOp, warn: noOp, error: noOp },
    stalledAfterMilliseconds = 120_000
} = {}) {
    if (!ledger || typeof ledger.acquireLease !== "function" ||
        typeof ledger.acquireResourceLease !== "function" ||
        typeof ledger.beginStep !== "function" ||
        typeof ledger.recordStepApplied !== "function" ||
        typeof ledger.recordCheckpoint !== "function" || typeof ledger.transition !== "function" ||
        typeof ledger.scanTransactions !== "function" || !Array.isArray(steps) ||
        steps.some((step) => !step || typeof step.run !== "function") ||
        typeof nowMilliseconds !== "function" || typeof sleep !== "function" ||
        typeof faultInjector !== "function" ||
        typeof completeAfterCheckpoints !== "boolean") {
        throw new TypeError("Payment worker is not configured.");
    }
    const owner = canonicalWorkerToken(workerId, "workerId");
    canonicalPositiveInteger(leaseTtlMilliseconds, "lease TTL");
    if (!Number.isSafeInteger(leaseRenewIntervalMilliseconds) ||
        leaseRenewIntervalMilliseconds < 0 ||
        leaseRenewIntervalMilliseconds >= leaseTtlMilliseconds ||
        !Number.isSafeInteger(playerLeaseWaitMilliseconds) || playerLeaseWaitMilliseconds < 0 ||
        !Number.isSafeInteger(playerLeasePollMilliseconds) || playerLeasePollMilliseconds < 0 ||
        !Number.isSafeInteger(stalledAfterMilliseconds) || stalledAfterMilliseconds <= 0) {
        throw new TypeError("Payment worker lease timing is invalid.");
    }

    const normalizedSteps = steps.map((step) => Object.freeze({
        name: canonicalWorkerToken(step.name, "checkpoint name", 80),
        run: step.run,
        reward: clone(step.reward ?? null)
    }));
    if (new Set(normalizedSteps.map((step) => step.name)).size !== normalizedSteps.length ||
        normalizedSteps.some((step) => !/^[a-z0-9][a-z0-9_.-]*$/u.test(step.name))) {
        throw new TypeError("Payment worker checkpoint names must be unique canonical identifiers.");
    }

    const activeJobs = new Map();
    let lastStartedAtUnixMs = null;
    let lastCompletedAtUnixMs = null;
    let lastErrorAtUnixMs = null;

    function jobKey(transaction) {
        return `${transaction.provider}\0${transaction.providerTransactionId}`;
    }

    async function processTransaction(input) {
        const transaction = await ledger.requireTransaction(input);
        if (transaction.state === "Completed") {
            return Object.freeze({ status: "already_completed", transaction });
        }
        if (["Quarantined", "DuplicatePaid", "RefundRequired", "ManualReview"].includes(
            transaction.state
        )) {
            return Object.freeze({ status: "unsafe_state", transaction });
        }

        const key = jobKey(transaction);
        const startedAt = nowMilliseconds();
        lastStartedAtUnixMs = startedAt;
        activeJobs.set(key, startedAt);
        const transactionToken = randomUUID();
        const playerToken = randomUUID();
        let transactionLeaseHeld = false;
        let playerLeaseHeld = false;
        let simulatedCrash = false;
        let heartbeatTimer = null;
        let heartbeatPromise = null;
        let heartbeatError = null;
        let currentTransaction = transaction;
        let playerLease = null;

        const identity = {
            provider: transaction.provider,
            providerTransactionId: transaction.providerTransactionId
        };
        const playerResource = {
            resourceType: "playfab-profile",
            resourceId: transaction.playFabId
        };

        async function performHeartbeatRenewal() {
            try {
                if (transactionLeaseHeld) {
                    const renewed = await ledger.renewLease(identity, {
                        token: transactionToken,
                        ttlMilliseconds: leaseTtlMilliseconds
                    });
                    currentTransaction = renewed.record;
                }
                if (playerLeaseHeld) {
                    const renewed = await ledger.renewResourceLease({
                        ...playerResource,
                        token: playerToken,
                        ttlMilliseconds: leaseTtlMilliseconds
                    });
                    playerLease = renewed.lease;
                }
            } catch (error) {
                heartbeatError ||= error;
            }
        }

        function renewBoth() {
            if (heartbeatPromise) return heartbeatPromise;
            if (heartbeatError) return Promise.resolve();
            const renewal = performHeartbeatRenewal();
            heartbeatPromise = renewal;
            void renewal.then(() => {
                if (heartbeatPromise === renewal) heartbeatPromise = null;
            });
            return renewal;
        }

        function startHeartbeat() {
            if (leaseRenewIntervalMilliseconds === 0 || heartbeatTimer) return;
            heartbeatTimer = setInterval(() => {
                void renewBoth().catch((error) => { heartbeatError ||= error; });
            }, leaseRenewIntervalMilliseconds);
            heartbeatTimer.unref?.();
        }

        async function stopHeartbeat() {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            const inFlight = heartbeatPromise;
            if (inFlight) {
                await inFlight.catch((error) => { heartbeatError ||= error; });
            }
        }

        try {
            const acquired = await ledger.acquireLease(identity, {
                owner,
                token: transactionToken,
                ttlMilliseconds: leaseTtlMilliseconds
            });
            if (acquired.status === "busy") {
                recordMetric(metrics, "lease_conflict", { component: "transaction" });
                return Object.freeze({ status: "busy", transaction: acquired.record });
            }
            transactionLeaseHeld = true;
            currentTransaction = acquired.record;
            startHeartbeat();

            const playerDeadline = nowMilliseconds() + playerLeaseWaitMilliseconds;
            while (!playerLeaseHeld) {
                const acquiredPlayer = await ledger.acquireResourceLease({
                    ...playerResource,
                    owner,
                    token: playerToken,
                    ttlMilliseconds: leaseTtlMilliseconds
                });
                if (acquiredPlayer.status === "acquired") {
                    playerLeaseHeld = true;
                    playerLease = acquiredPlayer.lease;
                    break;
                }
                if (nowMilliseconds() >= playerDeadline) {
                    recordMetric(metrics, "lease_conflict", { component: "player" });
                    return Object.freeze({ status: "player_busy", transaction: currentTransaction });
                }
                await sleep(playerLeasePollMilliseconds);
                if (heartbeatError) throw heartbeatError;
            }

            await faultInjector("after_lease", { transaction: clone(currentTransaction) });
            const processing = await ledger.transition(identity, {
                toState: "Processing",
                leaseToken: transactionToken,
                actor: owner,
                reason: "offline_worker_attempt",
                details: {
                    transactionLeaseEpoch: currentTransaction.leaseEpoch,
                    playerLeaseEpoch: playerLease.epoch
                },
                incrementRetry: true
            });
            currentTransaction = processing.record;
            if (currentTransaction.retryCount > 1) {
                recordMetric(metrics, "grant_retry", { provider: transaction.provider });
            }

            for (const step of normalizedSteps) {
                if (heartbeatError) throw heartbeatError;
                const checkpointOperationId = operationId(
                    transaction.provider,
                    transaction.providerTransactionId,
                    step.name
                );
                const existingCheckpoint = currentTransaction.checkpoints[step.name];
                if (existingCheckpoint) {
                    const verified = await ledger.recordCheckpoint(identity, {
                        name: step.name,
                        operationId: checkpointOperationId,
                        result: existingCheckpoint.result,
                        leaseToken: transactionToken,
                        actor: owner,
                        requireAppliedStep: true
                    });
                    currentTransaction = verified.record;
                    continue;
                }
                const assertLeaseOwnership = async () => {
                    await renewBoth();
                    if (heartbeatError) throw heartbeatError;
                    return Object.freeze({
                        transactionLeaseEpoch: currentTransaction.leaseEpoch,
                        playerLeaseEpoch: playerLease.epoch
                    });
                };
                const context = Object.freeze({
                    transaction: Object.freeze(clone(currentTransaction)),
                    operationId: checkpointOperationId,
                    transactionLeaseEpoch: currentTransaction.leaseEpoch,
                    playerLeaseEpoch: playerLease.epoch,
                    workerId: owner,
                    assertLeaseOwnership
                });
                const begun = await ledger.beginStep(identity, {
                    name: step.name,
                    operationId: checkpointOperationId,
                    reward: step.reward,
                    expectedState: null,
                    transactionLeaseEpoch: currentTransaction.leaseEpoch,
                    playerLeaseEpoch: playerLease.epoch,
                    leaseToken: transactionToken,
                    actor: owner
                });
                currentTransaction = begun.record;
                const journalEntry = currentTransaction.stepJournal?.[step.name];
                if (!journalEntry || journalEntry.operationId !== checkpointOperationId) {
                    throw new Error("Payment step journal returned invalid evidence.");
                }
                await faultInjector("after_step_pending", { step: step.name, ...context });
                if (journalEntry.status === "StepApplied") {
                    const checkpointed = await ledger.recordCheckpoint(identity, {
                        name: step.name,
                        operationId: checkpointOperationId,
                        result: journalEntry.result,
                        leaseToken: transactionToken,
                        actor: owner,
                        requireAppliedStep: true
                    });
                    currentTransaction = checkpointed.record;
                    await faultInjector("after_checkpoint", { step: step.name, ...context });
                    continue;
                }
                if (journalEntry.status !== "StepPending") {
                    throw new Error("Payment step journal is not executable.");
                }
                await faultInjector("before_checkpoint_effect", { step: step.name, ...context });
                const result = await step.run(context);
                await faultInjector("after_effect_before_checkpoint", {
                    step: step.name,
                    result: clone(result),
                    ...context
                });
                if (heartbeatError) throw heartbeatError;
                const applied = await ledger.recordStepApplied(identity, {
                    name: step.name,
                    operationId: checkpointOperationId,
                    result,
                    leaseToken: transactionToken,
                    actor: owner
                });
                currentTransaction = applied.record;
                await faultInjector("after_step_applied_before_checkpoint", {
                    step: step.name,
                    result: clone(result),
                    ...context
                });
                const checkpointed = await ledger.recordCheckpoint(identity, {
                    name: step.name,
                    operationId: checkpointOperationId,
                    result,
                    leaseToken: transactionToken,
                    actor: owner,
                    requireAppliedStep: true
                });
                currentTransaction = checkpointed.record;
                await faultInjector("after_checkpoint", { step: step.name, ...context });
            }

            if (!completeAfterCheckpoints) {
                await faultInjector("before_checkpoints_pending", {
                    transaction: clone(currentTransaction)
                });
                const pending = await ledger.transition(identity, {
                    toState: "Pending",
                    leaseToken: transactionToken,
                    actor: owner,
                    reason: "checkpoints_completed_pending_followup",
                    details: { checkpoints: normalizedSteps.map((step) => step.name) }
                });
                currentTransaction = pending.record;
                recordMetric(metrics, "transaction_pending", { provider: transaction.provider });
                logger.info?.({
                    event: "transaction_pending",
                    provider: transaction.provider,
                    providerTransactionId: transaction.providerTransactionId
                });
                return Object.freeze({
                    status: "checkpoints_pending",
                    transaction: currentTransaction
                });
            }

            await faultInjector("before_complete", { transaction: clone(currentTransaction) });
            const completed = await ledger.transition(identity, {
                toState: "Completed",
                leaseToken: transactionToken,
                actor: owner,
                reason: "all_checkpoints_completed",
                details: { checkpoints: normalizedSteps.map((step) => step.name) }
            });
            currentTransaction = completed.record;
            lastCompletedAtUnixMs = nowMilliseconds();
            recordMetric(metrics, "transaction_completed", { provider: transaction.provider });
            logger.info?.({
                event: "transaction_completed",
                provider: transaction.provider,
                providerTransactionId: transaction.providerTransactionId
            });
            return Object.freeze({ status: "completed", transaction: currentTransaction });
        } catch (error) {
            if (error instanceof PaymentWorkerCrash) {
                simulatedCrash = true;
                throw error;
            }
            lastErrorAtUnixMs = nowMilliseconds();
            const message = safeError(error);
            recordMetric(metrics, "transaction_failed", { provider: transaction.provider });
            if (error?.code === "LEASE_LOST") {
                recordMetric(metrics, "fencing_reject", { component: "worker" });
            }
            logger.error?.({
                event: "transaction_failed",
                provider: transaction.provider,
                providerTransactionId: transaction.providerTransactionId,
                errorCode: error?.code || "WORKER_ERROR",
                message
            });
            if (transactionLeaseHeld && error?.code !== "LEASE_LOST") {
                try {
                    const failed = await ledger.transition(identity, {
                        toState: "Failed",
                        leaseToken: transactionToken,
                        actor: owner,
                        reason: "worker_error",
                        details: { errorCode: error?.code || "WORKER_ERROR" },
                        lastError: message
                    });
                    currentTransaction = failed.record;
                } catch (transitionError) {
                    logger.error?.({
                        event: "transaction_failure_persist_failed",
                        provider: transaction.provider,
                        providerTransactionId: transaction.providerTransactionId,
                        errorCode: transitionError?.code || "STORE_ERROR"
                    });
                }
            }
            throw error;
        } finally {
            await stopHeartbeat();
            activeJobs.delete(key);
            if (!simulatedCrash) {
                if (playerLeaseHeld) {
                    try {
                        await ledger.releaseResourceLease({
                            ...playerResource,
                            token: playerToken
                        });
                    } catch (error) {
                        if (error?.code !== "LEASE_LOST") logger.warn?.({
                            event: "player_lease_release_failed",
                            errorCode: error?.code || "STORE_ERROR"
                        });
                    }
                }
                if (transactionLeaseHeld) {
                    try {
                        await ledger.releaseLease(identity, { token: transactionToken });
                    } catch (error) {
                        if (error?.code !== "LEASE_LOST") logger.warn?.({
                            event: "transaction_lease_release_failed",
                            errorCode: error?.code || "STORE_ERROR"
                        });
                    }
                }
            }
        }
    }

    async function processPending({ maximumTransactions = 100 } = {}) {
        canonicalPositiveInteger(maximumTransactions, "maximumTransactions");
        const results = [];
        let cursor = "0";
        while (results.length < maximumTransactions) {
            const page = await ledger.scanTransactions({ cursor, limit: Math.min(200, maximumTransactions) });
            for (const transaction of page.items) {
                if (!["Pending", "Failed", "Processing"].includes(transaction.state)) continue;
                if (transaction.state === "Processing" &&
                    transaction.leaseExpiresAtUnixMs > nowMilliseconds()) continue;
                try {
                    results.push(await processTransaction(transaction));
                } catch (error) {
                    results.push(Object.freeze({
                        status: "failed",
                        provider: transaction.provider,
                        providerTransactionId: transaction.providerTransactionId,
                        errorCode: error?.code || "WORKER_ERROR",
                        permanent: error?.permanent === true,
                        retryAfterMilliseconds: Number.isSafeInteger(error?.retryAfterMilliseconds) &&
                            error.retryAfterMilliseconds > 0 ? error.retryAfterMilliseconds : null
                    }));
                }
                if (results.length >= maximumTransactions) break;
            }
            if (!page.nextCursor || results.length >= maximumTransactions) break;
            cursor = page.nextCursor;
        }
        return Object.freeze(results);
    }

    function health() {
        const now = nowMilliseconds();
        const oldestActiveAt = activeJobs.size > 0 ? Math.min(...activeJobs.values()) : null;
        const stalled = oldestActiveAt !== null && now - oldestActiveAt > stalledAfterMilliseconds;
        return Object.freeze({
            healthy: !stalled,
            workerId: owner,
            activeJobs: activeJobs.size,
            oldestActiveAtUnixMs: oldestActiveAt,
            lastStartedAtUnixMs,
            lastCompletedAtUnixMs,
            lastErrorAtUnixMs,
            stalled
        });
    }

    return Object.freeze({ processTransaction, processPending, health });
}
