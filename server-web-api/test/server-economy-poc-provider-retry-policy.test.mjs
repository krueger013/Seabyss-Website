import test from "node:test";
import assert from "node:assert/strict";

import { createCanonicalServerEconomyPoc } from "../src/server-economy-poc-canonical.js";
import { createMemoryServerEconomyPocGameplayResolutionStore } from
    "../src/server-economy-poc-gameplay-resolution-store.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocPlayerLeases,
    createMemoryServerEconomyPocSnapshotStore,
    createMemoryServerEconomyPocWalStore
} from "../src/server-economy-poc-memory-stores.js";
import { createServerEconomyPocInitialSnapshot } from "../src/server-economy-poc-model.js";
import {
    classifyServerEconomyPocProviderFailure,
    computeServerEconomyPocProviderRetryBackoff
} from "../src/server-economy-poc-provider-retry-policy.js";

const PLAYER = "POC_RETRY_PLAYER";
const SPEND_OPERATION_ID = "diamonds-canary-v1:spend-10";

function dto(operationId, eventId, diamondsDelta) {
    return {
        playFabId: PLAYER,
        sessionId: "LOCAL_RETRY_SESSION",
        sessionEpoch: 1,
        operationId,
        eventId,
        diamondsDelta,
        reason: "local_retry_test",
        contextId: "sandbox:local_retry_test"
    };
}

function providerError(code, classification, cause = null, extra = {}) {
    return Object.assign(new Error(code), {
        code,
        classification,
        retryable: classification === "NOT_APPLIED" || code === "POC_STALE_WRITER",
        cause,
        ...extra
    });
}

async function createHarness({
    spendFailures = [],
    maximumAttempts = 3,
    backoffBaseMilliseconds = 100,
    backoffMaximumMilliseconds = 10_000,
    initialLeaseEpoch = 0
} = {}) {
    const clock = { now: 1_000 };
    const nowMilliseconds = () => clock.now;
    const leases = createMemoryServerEconomyPocPlayerLeases({ nowMilliseconds });
    for (let epoch = 1; epoch <= initialLeaseEpoch; epoch += 1) {
        const token = `LOCAL_BOOTSTRAP_TOKEN_${epoch}`;
        const acquired = await leases.acquire({
            playFabId: PLAYER,
            owner: "local_bootstrap",
            token,
            ttlMilliseconds: 1_000
        });
        assert.equal(acquired.lease.epoch, epoch);
        await leases.release({ playFabId: PLAYER, token, epoch });
    }
    const baseSnapshotStore = createMemoryServerEconomyPocSnapshotStore({ leases, nowMilliseconds });
    await baseSnapshotStore.seed({
        ...createServerEconomyPocInitialSnapshot(PLAYER, clock.now),
        revision: 1,
        fencingEpoch: 1
    });
    const providerAttempts = [];
    let providerUpdates = 0;
    const failures = [...spendFailures];
    const snapshotStore = Object.freeze({
        ...baseSnapshotStore,
        async compareAndSet(input) {
            if (input.operationProof?.operationId === SPEND_OPERATION_ID) {
                providerAttempts.push(Object.freeze({
                    operationId: input.operationProof.operationId,
                    immutableHash: input.operationProof.immutableHash,
                    sequence: input.operationProof.sequence,
                    fencingEpoch: input.fencingEpoch,
                    leaseToken: input.leaseToken,
                    expectedRevision: input.expectedRevision,
                    nextBalance: input.nextSnapshot.diamonds
                }));
                const nextFailure = failures.shift();
                if (nextFailure) throw nextFailure();
            }
            const result = await baseSnapshotStore.compareAndSet(input);
            if (input.operationProof?.operationId === SPEND_OPERATION_ID && result.status === "updated") {
                providerUpdates += 1;
            }
            return result;
        }
    });
    const walStore = createMemoryServerEconomyPocWalStore({ leases });
    const operationInbox = createMemoryServerEconomyPocOperationInbox({ leases, nowMilliseconds });
    const resolutionStore = createMemoryServerEconomyPocGameplayResolutionStore({
        assertPlayerFence: (input) => leases.assertCurrentSync({
            playFabId: input.playFabId,
            token: input.token,
            epoch: input.epoch
        })
    });
    let tokenOrdinal = 0;
    const poc = createCanonicalServerEconomyPoc({
        snapshotStore,
        walStore,
        operationInbox,
        playerLeases: leases,
        gameplayResolutionStore: resolutionStore,
        gameplayTokenFactory: () => `LOCAL_RETRY_TOKEN_${++tokenOrdinal}`,
        providerRetryMaximumAttempts: maximumAttempts,
        providerRetryBackoffBaseMilliseconds: backoffBaseMilliseconds,
        providerRetryBackoffMaximumMilliseconds: backoffMaximumMilliseconds,
        providerRetryJitterRatio: 0,
        providerRetryRandom: () => 0.5,
        authorizeGameplay: async ({ playFabId }) => ({ authorized: true, playFabId }),
        authorizeSession: async (input) => ({
            authorized: true,
            playFabId: input.playFabId,
            sessionId: input.sessionId,
            sessionEpoch: input.sessionEpoch,
            principal: Object.freeze({ kind: "local_retry_test" })
        }),
        nowMilliseconds
    });
    await poc.trustedDiamonds.execute(dto(
        "diamonds-canary-v1:grant-25",
        "diamonds-canary-v1:event-grant-25",
        25
    ));
    assert.deepEqual(
        { diamonds: (await poc.readSnapshot(PLAYER)).diamonds, revision: (await poc.readSnapshot(PLAYER)).revision },
        { diamonds: 25, revision: 2 }
    );
    await poc.trustedDiamonds.enqueue(dto(
        SPEND_OPERATION_ID,
        "diamonds-canary-v1:event-spend-10",
        -10
    ));
    return {
        poc,
        clock,
        leases,
        snapshotStore: baseSnapshotStore,
        operationInbox,
        resolutionStore,
        providerAttempts,
        providerUpdateCount: () => providerUpdates
    };
}

async function consume(harness) {
    return harness.poc.gameplay.consumeTrustedGameplayOperation({
        playFabId: PLAYER,
        operationId: SPEND_OPERATION_ID,
        consumer: "local_retry"
    });
}

test("provider failure classifier keeps APPLIED, NOT_APPLIED, UNKNOWN and PROOF_MISMATCH distinct", () => {
    assert.deepEqual(
        classifyServerEconomyPocProviderFailure({ classification: "APPLIED" }),
        {
            classification: "APPLIED", retryable: false, manualReview: false,
            requiresNewLease: false, retryAfterMilliseconds: 0
        }
    );
    const overLimit = providerError("POC_PLAYFAB_NOT_APPLIED", "NOT_APPLIED", {
        code: "OverLimit",
        providerError: "OverLimit",
        providerErrorCode: 1214,
        retryAfterMilliseconds: 1_500
    });
    assert.deepEqual(classifyServerEconomyPocProviderFailure(overLimit), {
        classification: "NOT_APPLIED",
        providerCondition: "OVERLIMIT",
        retryable: true,
        manualReview: false,
        requiresNewLease: true,
        retryAfterMilliseconds: 1_500
    });
    assert.equal(classifyServerEconomyPocProviderFailure(
        providerError("POC_PLAYFAB_AMBIGUOUS_RESULT", "UNKNOWN")
    ).manualReview, true);
    assert.equal(classifyServerEconomyPocProviderFailure(
        providerError("POC_PROVIDER_PROOF_MISMATCH", "PROOF_MISMATCH")
    ).retryable, false);
});

test("backoff is exponential, bounded and honors provider Retry-After", () => {
    assert.equal(computeServerEconomyPocProviderRetryBackoff({
        attempt: 1,
        baseMilliseconds: 100,
        maximumMilliseconds: 1_000,
        jitterRatio: 0,
        randomValue: 0.5
    }), 100);
    assert.equal(computeServerEconomyPocProviderRetryBackoff({
        attempt: 2,
        baseMilliseconds: 100,
        maximumMilliseconds: 1_000,
        jitterRatio: 0,
        randomValue: 0.5,
        retryAfterMilliseconds: 750
    }), 750);
});

test("provider rejection before mutation schedules retry and preserves Pending operation identity", async () => {
    const harness = await createHarness({
        spendFailures: [() => providerError(
            "POC_PLAYFAB_NOT_APPLIED",
            "NOT_APPLIED",
            { code: "PROVIDER_REJECTED_BEFORE_WRITE" }
        )]
    });
    await assert.rejects(consume(harness), (error) =>
        error.code === "POC_PROVIDER_RETRY_SCHEDULED" && error.retryable === true);
    const resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    const operation = await harness.operationInbox.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(resolution.state, "RetryScheduled");
    assert.equal(resolution.providerAttemptCount, 1);
    assert.equal(operation.state, "Pending");
    assert.equal(operation.operation.operationId, SPEND_OPERATION_ID);
    assert.equal(harness.providerAttempts.length, 1);
});

test("timeout plus unchanged readback retries later with a fresh context and completes 25 to 15", async () => {
    const harness = await createHarness({
        initialLeaseEpoch: 5,
        spendFailures: [() => providerError(
            "POC_PLAYFAB_NOT_APPLIED",
            "NOT_APPLIED",
            { code: "ETIMEDOUT" }
        )]
    });
    const beforeOperation = await harness.operationInbox.get(PLAYER, SPEND_OPERATION_ID);
    await assert.rejects(consume(harness), { code: "POC_PROVIDER_RETRY_SCHEDULED" });
    const scheduled = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(scheduled.providerAttemptHistory.length, 1);
    assert.equal(scheduled.providerAttemptHistory[0].state, "RetryScheduled");
    assert.ok(scheduled.providerAttemptHistory[0].fencingEpoch > 5);
    const callsBeforeBackoffProbe = harness.providerAttempts.length;
    await assert.rejects(consume(harness), { code: "POC_PROVIDER_RETRY_BACKOFF" });
    assert.equal(harness.providerAttempts.length, callsBeforeBackoffProbe);
    harness.clock.now = scheduled.nextAttemptAtUnixMs;
    const applied = await consume(harness);
    assert.equal(applied.status, "applied");
    const after = await harness.poc.readSnapshot(PLAYER);
    assert.deepEqual({ diamonds: after.diamonds, revision: after.revision }, { diamonds: 15, revision: 3 });
    const operation = await harness.operationInbox.get(PLAYER, SPEND_OPERATION_ID);
    const resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(operation.state, "Acked");
    assert.equal(resolution.state, "Acked");
    assert.equal(operation.operation.immutableHash, beforeOperation.operation.immutableHash);
    assert.deepEqual(
        resolution.providerAttemptHistory.map((attempt) => attempt.state),
        ["RetryScheduled", "Acked"]
    );
    assert.ok(resolution.providerAttemptHistory[1].fencingEpoch >
        resolution.providerAttemptHistory[0].fencingEpoch);
    assert.notEqual(
        resolution.providerAttemptHistory[1].attemptId,
        resolution.providerAttemptHistory[0].attemptId
    );
    assert.notEqual(
        resolution.providerAttemptHistory[1].leaseTokenDigest,
        resolution.providerAttemptHistory[0].leaseTokenDigest
    );
    assert.ok(resolution.providerAttemptHistory.every((attempt) =>
        attempt.operationId === SPEND_OPERATION_ID &&
        attempt.operationImmutableHash === beforeOperation.operation.immutableHash &&
        attempt.sequence === 2 &&
        /^[0-9a-f]{64}$/u.test(attempt.leaseTokenDigest)));
    assert.ok(harness.providerAttempts.every((attempt) =>
        attempt.operationId === SPEND_OPERATION_ID &&
        attempt.immutableHash === harness.providerAttempts[0].immutableHash &&
        attempt.sequence === 2));
    assert.equal(JSON.stringify(resolution).includes("LOCAL_RETRY_TOKEN_"), false);
    const exactProof = await harness.snapshotStore.verifyHighValueOperationProof({
        playFabId: PLAYER,
        proof: harness.providerAttempts.at(-1) && {
            schemaVersion: 1,
            playFabId: PLAYER,
            sequence: 2,
            operationId: SPEND_OPERATION_ID,
            eventId: "diamonds-canary-v1:event-spend-10",
            immutableHash: harness.providerAttempts.at(-1).immutableHash
        }
    });
    assert.equal(exactProof.verified, true);
    assert.equal(harness.providerUpdateCount(), 1);
    const callsBeforeReplay = harness.providerAttempts.length;
    const replay = await consume(harness);
    assert.equal(replay.status, "already_acked");
    assert.equal(harness.providerAttempts.length, callsBeforeReplay);
    assert.equal(harness.providerUpdateCount(), 1);
    assert.deepEqual(
        { diamonds: (await harness.poc.readSnapshot(PLAYER)).diamonds,
            revision: (await harness.poc.readSnapshot(PLAYER)).revision },
        { diamonds: 15, revision: 3 }
    );
});

for (const [label, errorFactory, expectedClassification] of [
    ["changed revision without proof", () => providerError(
        "POC_PLAYFAB_AMBIGUOUS_RESULT", "UNKNOWN"
    ), "UNKNOWN"],
    ["conflicting proof", () => providerError(
        "POC_PROVIDER_PROOF_MISMATCH", "PROOF_MISMATCH"
    ), "PROOF_MISMATCH"]
]) {
    test(`${label} enters ManualReview without blind retry`, async () => {
        const harness = await createHarness({ spendFailures: [errorFactory] });
        await assert.rejects(consume(harness), (error) =>
            error.code === "POC_PROVIDER_MANUAL_REVIEW" &&
            error.classification === expectedClassification && error.retryable === false);
        assert.equal((await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID)).state, "ManualReview");
        const providerCalls = harness.providerAttempts.length;
        await assert.rejects(consume(harness), { code: "POC_PROVIDER_MANUAL_REVIEW" });
        assert.equal(harness.providerAttempts.length, providerCalls);
    });
}

test("OverLimit is retry scheduled with provider backoff only after NOT_APPLIED proof", async () => {
    const harness = await createHarness({
        backoffBaseMilliseconds: 100,
        spendFailures: [() => providerError("POC_PLAYFAB_NOT_APPLIED", "NOT_APPLIED", {
            code: "OverLimit",
            providerError: "OverLimit",
            providerErrorCode: 1214,
            retryAfterMilliseconds: 2_000
        })]
    });
    await assert.rejects(consume(harness), (error) =>
        error.code === "POC_PROVIDER_RETRY_SCHEDULED" &&
        error.providerCondition === "OVERLIMIT" && error.retryAfterMilliseconds === 2_000);
    const resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(resolution.nextAttemptAtUnixMs, harness.clock.now + 2_000);
});

test("a stale attempt is replaced by a strictly newer authorized epoch", async () => {
    const harness = await createHarness({
        initialLeaseEpoch: 5,
        spendFailures: [() => providerError("POC_STALE_WRITER", "STALE_WRITER")]
    });
    await assert.rejects(consume(harness), (error) =>
        error.code === "POC_STALE_WRITER" && error.requiresNewLease === true);
    const afterStale = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(afterStale.state, "Prepared");
    assert.equal(afterStale.providerAttemptCount, 0);
    assert.equal(afterStale.providerAttemptHistory.length, 1);
    assert.equal(afterStale.providerAttemptHistory[0].state, "Active");
    const staleEpoch = afterStale.providerAttemptHistory[0].fencingEpoch;
    assert.ok(staleEpoch > 5);
    const applied = await consume(harness);
    assert.equal(applied.status, "applied");
    assert.equal(harness.providerAttempts.length, 2);
    assert.ok(harness.providerAttempts[1].fencingEpoch > staleEpoch);
    const resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.deepEqual(resolution.providerAttemptHistory.map((attempt) => attempt.state), ["Stale", "Acked"]);
    assert.ok(resolution.providerAttemptHistory[1].fencingEpoch > resolution.providerAttemptHistory[0].fencingEpoch);
    assert.equal(
        resolution.providerAttemptHistory[0].staleByAttemptId,
        resolution.providerAttemptHistory[1].attemptId
    );
    await assert.rejects(
        harness.resolutionStore.markSnapshotApplied({
            playFabId: PLAYER,
            operationId: SPEND_OPERATION_ID,
            token: harness.providerAttempts[0].leaseToken,
            epoch: staleEpoch,
            attemptId: resolution.providerAttemptHistory[0].attemptId,
            completedAtUnixMs: harness.clock.now,
            snapshotRevision: 3
        }),
        { code: "POC_STALE_WRITER" }
    );
    assert.equal(harness.providerUpdateCount(), 1);
    assert.equal((await harness.poc.readSnapshot(PLAYER)).diamonds, 15);
});

test("three stale recoveries keep monotonic attempts and only the latest attempt mutates", async () => {
    const stale = () => providerError("POC_STALE_WRITER", "STALE_WRITER");
    const harness = await createHarness({
        initialLeaseEpoch: 5,
        spendFailures: [stale, stale, stale]
    });
    const operationBefore = await harness.operationInbox.get(PLAYER, SPEND_OPERATION_ID);
    for (let recovery = 0; recovery < 3; recovery += 1) {
        await assert.rejects(consume(harness), (error) =>
            error.code === "POC_STALE_WRITER" && error.requiresNewLease === true);
        assert.equal((await harness.poc.readSnapshot(PLAYER)).diamonds, 25);
    }
    const applied = await consume(harness);
    assert.equal(applied.status, "applied");
    const epochs = harness.providerAttempts.map((attempt) => attempt.fencingEpoch);
    assert.equal(epochs.length, 4);
    assert.equal(new Set(epochs).size, 4);
    assert.ok(epochs.every((epoch, index) => index === 0 || epoch > epochs[index - 1]));
    const resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.deepEqual(
        resolution.providerAttemptHistory.map((attempt) => attempt.state),
        ["Stale", "Stale", "Stale", "Acked"]
    );
    const historyEpochs = resolution.providerAttemptHistory.map((attempt) => attempt.fencingEpoch);
    assert.ok(historyEpochs.every((epoch, index) => index === 0 || epoch > historyEpochs[index - 1]));
    assert.ok(resolution.providerAttemptHistory.every((attempt) =>
        attempt.operationId === SPEND_OPERATION_ID &&
        attempt.operationImmutableHash === operationBefore.operation.immutableHash &&
        attempt.sequence === operationBefore.sequence));
    assert.equal(new Set(resolution.providerAttemptHistory.map((attempt) => attempt.attemptId)).size, 4);
    assert.equal(harness.providerUpdateCount(), 1);
    assert.deepEqual(
        { diamonds: (await harness.poc.readSnapshot(PLAYER)).diamonds,
            revision: (await harness.poc.readSnapshot(PLAYER)).revision },
        { diamonds: 15, revision: 3 }
    );
});

test("retry budget exhaustion becomes durable ManualReview and never creates a new operationId", async () => {
    const safeFailure = () => providerError(
        "POC_PLAYFAB_NOT_APPLIED",
        "NOT_APPLIED",
        { code: "ETIMEDOUT" }
    );
    const harness = await createHarness({
        maximumAttempts: 2,
        spendFailures: [safeFailure, safeFailure, safeFailure]
    });
    const immutableBefore = (await harness.operationInbox.get(PLAYER, SPEND_OPERATION_ID)).operation.immutableHash;
    await assert.rejects(consume(harness), { code: "POC_PROVIDER_RETRY_SCHEDULED" });
    let resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    harness.clock.now = resolution.nextAttemptAtUnixMs;
    await assert.rejects(consume(harness), (error) =>
        error.code === "POC_PROVIDER_RETRY_BUDGET_EXHAUSTED" &&
        error.manualReview === true && error.providerAttemptCount === 2);
    resolution = await harness.resolutionStore.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(resolution.state, "ManualReview");
    assert.equal(resolution.providerAttemptHistory.length, 2);
    const providerCalls = harness.providerAttempts.length;
    await assert.rejects(consume(harness), { code: "POC_PROVIDER_MANUAL_REVIEW" });
    assert.equal(harness.providerAttempts.length, providerCalls);
    const operation = await harness.operationInbox.get(PLAYER, SPEND_OPERATION_ID);
    assert.equal(operation.operationId, SPEND_OPERATION_ID);
    assert.equal(operation.operation.immutableHash, immutableBefore);
    assert.ok(harness.providerAttempts.every((attempt) => attempt.operationId === SPEND_OPERATION_ID));
});
