import { randomUUID } from "node:crypto";
import { createServerEconomyPocGameplayGateway } from "./server-economy-poc-gameplay-gateway.js";
import { createMemoryServerEconomyPocGameplayResolutionStore } from "./server-economy-poc-gameplay-resolution-store.js";
import {
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";
import { createServerEconomyPocHighValueProviderProof } from "./server-economy-poc-provider-proof.js";
import {
    classifyServerEconomyPocProviderFailure,
    computeServerEconomyPocProviderRetryBackoff
} from "./server-economy-poc-provider-retry-policy.js";

const TIER = Object.freeze({ bronze: 1, silver: 2, gold: 3 });

export function createStrictServerEconomyPocGameplayGateway({
    engine,
    authorize,
    gameplayResolutionStore,
    nowMilliseconds = () => Date.now(),
    tokenFactory = () => randomUUID(),
    workerId = "server-economy-poc-gameplay",
    maximumCasAttempts = 8,
    providerRetryMaximumAttempts = 3,
    providerRetryBackoffBaseMilliseconds = 250,
    providerRetryBackoffMaximumMilliseconds = 30_000,
    providerRetryJitterRatio = 0.2,
    providerRetryRandom = Math.random
} = {}) {
    const resolutionStore = gameplayResolutionStore;
    for (const method of [
        "prepare", "get", "beginProviderAttempt", "recordProviderFailure", "markManualReview", "markSnapshotApplied", "markAcked"
    ]) {
        if (typeof resolutionStore?.[method] !== "function") throw new TypeError(`gameplayResolutionStore.${method} is required.`);
    }
    const base = createServerEconomyPocGameplayGateway({ engine, authorize, nowMilliseconds });
    const ttlMilliseconds = engine.configuration?.leaseTtlMilliseconds || 15_000;
    const claimTtlMilliseconds = engine.configuration?.claimTtlMilliseconds || 15_000;

    if ((engine.stores.snapshotStore.durable === true || engine.stores.operationInbox.durable === true) &&
        resolutionStore.durable !== true) {
        throw new TypeError("Durable canonical POC requires a durable gameplayResolutionStore.");
    }
    serverEconomyPocPositive(providerRetryMaximumAttempts, "provider retry maximum attempts");
    serverEconomyPocPositive(providerRetryBackoffBaseMilliseconds, "provider retry backoff base");
    serverEconomyPocPositive(providerRetryBackoffMaximumMilliseconds, "provider retry backoff maximum");
    if (providerRetryBackoffBaseMilliseconds > providerRetryBackoffMaximumMilliseconds ||
        typeof providerRetryJitterRatio !== "number" || !Number.isFinite(providerRetryJitterRatio) ||
        providerRetryJitterRatio < 0 || providerRetryJitterRatio > 1 ||
        typeof providerRetryRandom !== "function") {
        throw new TypeError("Provider retry policy is invalid.");
    }

    function policyError(code, message, cause, details = {}) {
        const error = new Error(message);
        error.code = code;
        error.cause = cause;
        Object.assign(error, details);
        return error;
    }

    async function assertEarlierOperationsAcked(record) {
        if (record.sequence <= 1) return;
        let cursor = 0;
        for (;;) {
            const page = await engine.stores.operationInbox.scanAfter({
                playFabId: record.playFabId,
                afterSequence: cursor,
                limit: 100
            });
            const earlier = page.entries.filter((entry) => entry.sequence < record.sequence);
            if (earlier.some((entry) => entry.state !== "Acked")) {
                serverEconomyPocFail(
                    "POC_OPERATION_ORDER_BLOCKED",
                    "An earlier gameplay operation is not durably ACKed.",
                    { retryable: true, statusCode: 409 }
                );
            }
            if (page.entries.length === 0 || page.entries.at(-1).sequence >= record.sequence - 1) return;
            cursor = page.entries.at(-1).sequence;
        }
    }

    async function assertProviderAttemptEligible(playFabId, operationId) {
        const proof = await resolutionStore.get(playFabId, operationId);
        if (!proof) return null;
        if (proof.state === "ManualReview") {
            throw policyError(
                "POC_PROVIDER_MANUAL_REVIEW",
                "Provider operation requires ManualReview.",
                null,
                { retryable: false, manualReview: true, classification: proof.lastProviderClassification }
            );
        }
        if (proof.state === "RetryScheduled") {
            const nextAttemptAtUnixMs = serverEconomyPocNonNegative(
                proof.nextAttemptAtUnixMs,
                "next provider attempt timestamp"
            );
            const current = serverEconomyPocNonNegative(nowMilliseconds(), "provider retry clock");
            if (nextAttemptAtUnixMs > current) {
                throw policyError(
                    "POC_PROVIDER_RETRY_BACKOFF",
                    "Provider operation is not due for retry.",
                    null,
                    {
                        retryable: true,
                        classification: proof.lastProviderClassification,
                        retryAfterMilliseconds: nextAttemptAtUnixMs - current,
                        nextAttemptAtUnixMs,
                        operationId
                    }
                );
            }
        }
        return proof;
    }

    async function handleProviderFailure({ error, playFabId, operationId, lease, prepared, attempt }) {
        const policy = classifyServerEconomyPocProviderFailure(error);
        const attemptedAtUnixMs = serverEconomyPocNonNegative(
            nowMilliseconds(),
            "provider attempt timestamp"
        );
        const errorCode = typeof error?.code === "string" && error.code.length > 0
            ? error.code : "POC_PROVIDER_ERROR";
        if (policy.classification === "STALE_WRITER") {
            throw policyError(errorCode, "Provider attempt lost its lease and must be reacquired.", error, {
                retryable: true,
                requiresNewLease: true,
                classification: policy.classification,
                retryAfterMilliseconds: policy.retryAfterMilliseconds
            });
        }
        if (policy.retryable === true) {
            const failedAttempt = Number(prepared?.record?.providerAttemptCount || 0) + 1;
            const delay = computeServerEconomyPocProviderRetryBackoff({
                attempt: failedAttempt,
                baseMilliseconds: providerRetryBackoffBaseMilliseconds,
                maximumMilliseconds: providerRetryBackoffMaximumMilliseconds,
                jitterRatio: providerRetryJitterRatio,
                randomValue: providerRetryRandom(),
                retryAfterMilliseconds: policy.retryAfterMilliseconds
            });
            const transition = await resolutionStore.recordProviderFailure({
                playFabId,
                operationId,
                attemptId: attempt.attemptId,
                token: lease.token,
                epoch: lease.epoch,
                classification: policy.classification,
                errorCode,
                attemptedAtUnixMs,
                nextAttemptAtUnixMs: attemptedAtUnixMs + delay,
                maximumAttempts: providerRetryMaximumAttempts
            });
            if (transition.status === "manual_review") {
                throw policyError(
                    "POC_PROVIDER_RETRY_BUDGET_EXHAUSTED",
                    "Provider retry budget was exhausted.",
                    error,
                    {
                        retryable: false,
                        manualReview: true,
                        classification: policy.classification,
                        providerAttemptCount: transition.record.providerAttemptCount,
                        operationId
                    }
                );
            }
            throw policyError("POC_PROVIDER_RETRY_SCHEDULED", "Provider retry was durably scheduled.", error, {
                retryable: true,
                classification: policy.classification,
                providerCondition: policy.providerCondition,
                providerAttemptCount: transition.record.providerAttemptCount,
                retryAfterMilliseconds: delay,
                nextAttemptAtUnixMs: transition.record.nextAttemptAtUnixMs,
                operationId
            });
        }
        if (policy.manualReview === true) {
            await resolutionStore.markManualReview({
                playFabId,
                operationId,
                attemptId: attempt.attemptId,
                token: lease.token,
                epoch: lease.epoch,
                classification: policy.classification,
                errorCode,
                attemptedAtUnixMs
            });
            throw policyError("POC_PROVIDER_MANUAL_REVIEW", "Provider result requires ManualReview.", error, {
                retryable: false,
                manualReview: true,
                classification: policy.classification,
                operationId
            });
        }
        throw error;
    }

    async function prepare(input = {}) {
        const source = await base.prepare(input);
        return serverEconomyPocReadonly({
            ...source,
            diamondsDelta: source.diamonds,
            diamonds: source.diamonds > 0 ? source.diamonds : 0,
            premium: source.premium === null ? null : { ...source.premium, tier: TIER[source.premium.tier] }
        });
    }

    async function enqueueTrustedGameplayOperation(input = {}) {
        const operation = await prepare(input);
        return serverEconomyPocReadonly({
            operation,
            submitted: await engine.stores.operationInbox.submit(operation)
        });
    }

    async function acquire(playFabId) {
        const token = serverEconomyPocId(tokenFactory(), "player lease token", 255);
        const acquired = await engine.stores.playerLeases.acquire({ playFabId, owner: workerId, token, ttlMilliseconds });
        if (acquired?.status !== "acquired") {
            serverEconomyPocFail("POC_PLAYER_BUSY", "Another canonical consumer owns this player.", { retryable: true, statusCode: 409 });
        }
        return { token, epoch: acquired.lease.epoch };
    }

    async function renew(playFabId, lease) {
        const renewed = await engine.stores.playerLeases.renew({
            playFabId, token: lease.token, epoch: lease.epoch, ttlMilliseconds
        });
        if (renewed?.status !== "renewed") {
            serverEconomyPocFail("POC_STALE_WRITER", "Gameplay worker lost its player lease.", { retryable: true });
        }
    }

    function buildResolution(snapshot, record, epoch) {
        const delta = record.operation.diamondsDelta;
        if (!Number.isSafeInteger(delta) || delta === 0) {
            serverEconomyPocFail("POC_DIAMOND_DELTA_INVALID", "Durable gameplay Diamonds delta is invalid.");
        }
        const candidate = snapshot.diamonds + delta;
        const applied = Number.isSafeInteger(candidate) && candidate >= 0;
        const result = serverEconomyPocReadonly({
            status: applied ? "applied" : "rejected_insufficient_funds",
            operationId: record.operationId,
            eventId: record.operation.eventId,
            sequence: record.sequence,
            diamondsDelta: delta,
            diamonds: applied ? candidate : snapshot.diamonds
        });
        const next = {
            ...serverEconomyPocClone(snapshot),
            revision: snapshot.revision + 1,
            fencingEpoch: epoch,
            diamonds: result.diamonds,
            highValueAppliedThroughSequence: record.sequence,
            updatedAtUnixMs: Math.max(snapshot.updatedAtUnixMs,
                serverEconomyPocNonNegative(nowMilliseconds(), "processing clock"))
        };
        validateServerEconomyPocSnapshot(next, record.playFabId);
        return { result, next: serverEconomyPocReadonly(next) };
    }

    function resultFromProof(proof) {
        return serverEconomyPocReadonly({
            status: proof.outcome,
            operationId: proof.operationId,
            sequence: proof.sequence,
            diamondsDelta: proof.diamondsDelta,
            diamonds: proof.diamondsAfter
        });
    }

    async function consumeTrustedGameplayOperation({ playFabId, operationId, consumer = "gameplay" } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const id = serverEconomyPocId(operationId, "operationId", 200);
        serverEconomyPocId(consumer, "consumer", 40);
        let record = await engine.stores.operationInbox.get(player, id);
        if (!record) serverEconomyPocFail("POC_OPERATION_NOT_FOUND", "Gameplay operation is absent.", { statusCode: 404 });
        if (record.state === "Acked") {
            return serverEconomyPocReadonly({ status: "already_acked", result: record.result, snapshot: await engine.readSnapshot(player) });
        }
        const lease = await acquire(player);
        const claimToken = serverEconomyPocId(tokenFactory(), "claim token", 255);
        let claim;
        let acked = false;
        try {
            claim = await engine.stores.operationInbox.claim({
                playFabId: player, operationId: id, owner: workerId,
                token: claimToken, ttlMilliseconds: claimTtlMilliseconds
            });
            if (claim?.status === "acked") {
                acked = true;
                return serverEconomyPocReadonly({ status: "already_acked", result: claim.record.result, snapshot: await engine.readSnapshot(player) });
            }
            if (claim?.status !== "claimed") {
                serverEconomyPocFail("POC_OPERATION_BUSY", "Gameplay operation is already claimed.", { retryable: true, statusCode: 409 });
            }
            record = claim.record;
            await assertProviderAttemptEligible(player, id);
            await assertEarlierOperationsAcked(record);
            let snapshot = await engine.readSnapshot(player);
            let result;
            let providerAttempt = null;
            for (let attempt = 0; attempt < maximumCasAttempts; attempt += 1) {
                if (record.sequence <= snapshot.highValueAppliedThroughSequence) {
                    const proof = await resolutionStore.get(player, id);
                    if (!proof || proof.sequence !== record.sequence || proof.diamondsAfter !== snapshot.diamonds) {
                        serverEconomyPocFail("POC_GAMEPLAY_RECONCILIATION_FAILED", "Applied gameplay sequence has no matching durable resolution proof.");
                    }
                    await renew(player, lease);
                    if (!providerAttempt) {
                        providerAttempt = (await resolutionStore.beginProviderAttempt({
                            playFabId: player,
                            operationId: id,
                            operationImmutableHash: record.operation.immutableHash,
                            sequence: record.sequence,
                            token: lease.token,
                            epoch: lease.epoch,
                            startedAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "provider attempt clock")
                        })).attempt;
                    }
                    result = resultFromProof(proof);
                    await resolutionStore.markSnapshotApplied({
                        playFabId: player, operationId: id, token: lease.token,
                        epoch: lease.epoch, attemptId: providerAttempt.attemptId,
                        completedAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "provider attempt clock"),
                        snapshotRevision: snapshot.revision
                    });
                    break;
                }
                if (record.sequence !== snapshot.highValueAppliedThroughSequence + 1) {
                    serverEconomyPocFail("POC_OPERATION_ORDER_BLOCKED", "An earlier high-value operation must be consumed first.", { retryable: true, statusCode: 409 });
                }
                await renew(player, lease);
                const resolution = buildResolution(snapshot, record, lease.epoch);
                const prepared = await resolutionStore.prepare({
                    playFabId: player,
                    operationId: id,
                    sequence: record.sequence,
                    expectedRevision: snapshot.revision,
                    diamondsBefore: snapshot.diamonds,
                    diamondsDelta: record.operation.diamondsDelta,
                    diamondsAfter: resolution.result.diamonds,
                    outcome: resolution.result.status
                });
                if (!providerAttempt) {
                    providerAttempt = (await resolutionStore.beginProviderAttempt({
                        playFabId: player,
                        operationId: id,
                        operationImmutableHash: record.operation.immutableHash,
                        sequence: record.sequence,
                        token: lease.token,
                        epoch: lease.epoch,
                        startedAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "provider attempt clock")
                    })).attempt;
                }
                let cas;
                try {
                    cas = await engine.stores.snapshotStore.compareAndSet({
                        playFabId: player, expectedRevision: snapshot.revision,
                        leaseToken: lease.token, fencingEpoch: lease.epoch,
                        nextSnapshot: resolution.next,
                        operationProof: createServerEconomyPocHighValueProviderProof({
                            playFabId: player,
                            sequence: record.sequence,
                            operation: record.operation
                        })
                    });
                } catch (error) {
                    await handleProviderFailure({
                        error, playFabId: player, operationId: id, lease, prepared,
                        attempt: providerAttempt
                    });
                }
                if (cas?.status === "version_conflict") {
                    snapshot = cas.snapshot;
                    continue;
                }
                if (cas?.status !== "updated") {
                    serverEconomyPocFail("POC_SNAPSHOT_PROTOCOL", "Gameplay CAS returned an invalid result.", { retryable: true });
                }
                snapshot = cas.snapshot;
                result = resolution.result;
                await resolutionStore.markSnapshotApplied({
                    playFabId: player, operationId: id, token: lease.token,
                    epoch: lease.epoch, attemptId: providerAttempt.attemptId,
                    completedAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "provider attempt clock"),
                    snapshotRevision: snapshot.revision
                });
                break;
            }
            if (!result) serverEconomyPocFail("POC_SNAPSHOT_CAS_EXHAUSTED", "Gameplay CAS retries were exhausted.", { retryable: true });
            await renew(player, lease);
            const acknowledged = await engine.stores.operationInbox.ack({
                playFabId: player, operationId: id, claimToken,
                claimEpoch: record.claimEpoch, playerLeaseToken: lease.token,
                playerFencingEpoch: lease.epoch, result
            });
            if (acknowledged?.status !== "acked") {
                serverEconomyPocFail("POC_INBOX_ACK_FAILED", "Gameplay ACK failed after canonical CAS.", { retryable: true });
            }
            await resolutionStore.markAcked({
                playFabId: player, operationId: id, token: lease.token, epoch: lease.epoch,
                attemptId: providerAttempt.attemptId,
                completedAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "provider attempt clock"),
            });
            acked = true;
            return serverEconomyPocReadonly({ status: result.status, result, snapshot });
        } finally {
            if (claim?.status === "claimed" && !acked) {
                await engine.stores.operationInbox.releaseClaim({
                    playFabId: player, operationId: id, claimToken,
                    claimEpoch: claim.record.claimEpoch
                }).catch(() => {});
            }
            await engine.stores.playerLeases.release({
                playFabId: player, token: lease.token, epoch: lease.epoch
            }).catch(() => {});
        }
    }

    async function submitAndConsumeTrustedGameplayOperation(input = {}) {
        const enqueued = await enqueueTrustedGameplayOperation(input);
        const consumed = await consumeTrustedGameplayOperation({
            playFabId: enqueued.operation.playFabId,
            operationId: enqueued.operation.operationId
        });
        return serverEconomyPocReadonly({ ...enqueued, consumed });
    }

    return Object.freeze({
        ...base,
        prepare,
        enqueueTrustedGameplayOperation,
        consumeTrustedGameplayOperation,
        submitAndConsumeTrustedGameplayOperation,
        resolutionStore,
        snapshotSchemaPollution: false,
        insufficientFundsTerminal: true,
        numericPremiumTiers: true,
        providerRetryPolicy: Object.freeze({
            maximumAttempts: providerRetryMaximumAttempts,
            backoffBaseMilliseconds: providerRetryBackoffBaseMilliseconds,
            backoffMaximumMilliseconds: providerRetryBackoffMaximumMilliseconds,
            jitterRatio: providerRetryJitterRatio,
            immediateLoop: false
        })
    });
}
