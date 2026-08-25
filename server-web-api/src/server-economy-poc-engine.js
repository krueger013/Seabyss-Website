import { randomUUID } from "node:crypto";
import {
    applyServerEconomyPocAmmoBatch,
    applyServerEconomyPocHighValueOperation,
    createServerEconomyPocAmmoEvent,
    createServerEconomyPocHighValueOperation
} from "./server-economy-poc-domain-model.js";
import {
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";
import { createServerEconomyPocHighValueProviderProof } from "./server-economy-poc-provider-proof.js";
import {
    createServerEconomyPocAmmoBatchProof,
    sameServerEconomyPocAmmoBatchProof
} from "./server-economy-poc-ammo-proof.js";
import { createNoopServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";

function requireMethods(value, name, methods) {
    if (!value || methods.some((method) => typeof value[method] !== "function")) {
        throw new TypeError(`${name} does not implement the server economy POC interface.`);
    }
}

function safeMetric(metrics, method, ...args) {
    try { metrics[method](...args); } catch {
        // Financial state must never depend on telemetry availability.
    }
}

export class ServerEconomyPocSimulatedCrash extends Error {
    constructor(point) {
        super(`Simulated server economy POC crash at ${point}.`);
        this.name = "ServerEconomyPocSimulatedCrash";
        this.code = "POC_SIMULATED_CRASH";
        this.simulatedCrash = true;
        this.point = point;
    }
}

export function createServerEconomyPocEngine({
    snapshotStore,
    walStore,
    operationInbox,
    playerLeases,
    metrics = createNoopServerEconomyPocMetrics(),
    workerId = `server-economy-poc-${randomUUID()}`,
    leaseTtlMilliseconds = 15_000,
    claimTtlMilliseconds = 15_000,
    ammoBatchSize = 100,
    maximumCasAttempts = 8,
    nowMilliseconds = () => Date.now(),
    monotonicMilliseconds = () => performance.now(),
    tokenFactory = () => randomUUID(),
    hooks = {}
} = {}) {
    requireMethods(snapshotStore, "snapshotStore", [
        "read", "compareAndSet", "verifyHighValueOperationProof", "readAmmoBatchProof"
    ]);
    requireMethods(walStore, "walStore", ["append", "scanAfter", "ackThrough", "status", "listPlayersWithPending"]);
    requireMethods(operationInbox, "operationInbox", [
        "submit", "get", "scanAfter", "claim", "ack", "releaseClaim", "listPlayersWithPending"
    ]);
    requireMethods(playerLeases, "playerLeases", ["acquire", "renew", "release"]);
    requireMethods(metrics, "metrics", ["increment", "observe"]);
    serverEconomyPocId(workerId, "workerId", 160);
    for (const [name, value, minimum, maximum] of [
        ["leaseTtlMilliseconds", leaseTtlMilliseconds, 1000, 300_000],
        ["claimTtlMilliseconds", claimTtlMilliseconds, 1000, 300_000],
        ["ammoBatchSize", ammoBatchSize, 1, 500],
        ["maximumCasAttempts", maximumCasAttempts, 1, 100]
    ]) {
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
            throw new TypeError(`${name} is invalid.`);
        }
    }
    if (typeof nowMilliseconds !== "function" || typeof monotonicMilliseconds !== "function" ||
        typeof tokenFactory !== "function" || !hooks || typeof hooks !== "object") {
        throw new TypeError("Server economy POC runtime dependencies are invalid.");
    }

    const now = () => serverEconomyPocNonNegative(nowMilliseconds(), "engine clock");
    const elapsed = (started) => Math.max(0, monotonicMilliseconds() - started);

    async function readSnapshot(playFabId) {
        const started = monotonicMilliseconds();
        const snapshot = await snapshotStore.read(serverEconomyPocId(playFabId, "playFabId", 160));
        safeMetric(metrics, "increment", "snapshot_read_total");
        safeMetric(metrics, "observe", "snapshot_read_duration_ms", elapsed(started));
        return serverEconomyPocReadonly(snapshot);
    }
    function providerProof(record) {
        return createServerEconomyPocHighValueProviderProof({
            playFabId: record.playFabId,
            sequence: record.sequence,
            operation: record.operation
        });
    }

    async function recoverAppliedHighValue(record, snapshot) {
        const proof = providerProof(record);
        const verification = await snapshotStore.verifyHighValueOperationProof({
            playFabId: record.playFabId,
            proof
        });
        if (verification?.verified !== true) {
            safeMetric(metrics, "increment", "sequence_rollback_reject_total", 1, { domain: "high_value" });
            serverEconomyPocFail(
                "POC_PROVIDER_PROOF_MISMATCH",
                "High-value cursor cannot ACK this operation without its exact provider-side proof.",
                { statusCode: 409 }
            );
        }
        safeMetric(metrics, "increment", "crash_recovery_total", 1, { domain: "high_value" });
        return serverEconomyPocReadonly({
            status: "recovered_after_snapshot",
            operationId: record.operationId,
            eventId: record.operation.eventId,

            sequence: record.sequence,
            revision: snapshot.revision
        });
    }
    async function assertEarlierOperationsAcked(record) {
        if (record.sequence <= 1) return;
        let cursor = 0;
        for (;;) {
            const page = await operationInbox.scanAfter({
                playFabId: record.playFabId,
                afterSequence: cursor,
                limit: 100
            });
            const earlier = page.entries.filter((entry) => entry.sequence < record.sequence);
            if (earlier.some((entry) => entry.state !== "Acked")) {
                serverEconomyPocFail(
                    "POC_OPERATION_ORDER_BLOCKED",
                    "An earlier high-value operation is not durably ACKed.",
                    { retryable: true, statusCode: 409 }
                );
            }
            if (page.entries.length === 0 || page.entries.at(-1).sequence >= record.sequence - 1) return;
            cursor = page.entries.at(-1).sequence;
        }
    }

    async function reconcileAppliedAmmo(playFabId, snapshot) {
        const cursor = snapshot.ammoAppliedThroughSequence;
        if (cursor === 0) return;
        const proof = await snapshotStore.readAmmoBatchProof(playFabId);
        if (!proof || proof.throughSequence !== cursor) {
            safeMetric(metrics, "increment", "sequence_rollback_reject_total", 1, { domain: "elite_ball" });
            serverEconomyPocFail(
                "POC_AMMO_PROOF_MISMATCH",
                "Ammo cursor cannot be reconciled without its exact provider-side batch proof.",
                { statusCode: 409 }
            );
        }
        const page = await walStore.scanAfter({
            playFabId,
            afterSequence: proof.firstSequence - 1,
            limit: proof.eventCount
        });
        let candidate = null;
        try {
            candidate = createServerEconomyPocAmmoBatchProof({
                playFabId,
                entries: page.entries
            });
        } catch {
            // Missing, reused, truncated, or non-contiguous ranges are never safe to ACK.
        }
        if (page.entries.length !== proof.eventCount ||
            !sameServerEconomyPocAmmoBatchProof(candidate, proof)) {
            safeMetric(metrics, "increment", "sequence_rollback_reject_total", 1, { domain: "elite_ball" });
            serverEconomyPocFail(
                "POC_AMMO_PROOF_MISMATCH",
                "Durable WAL range differs from the exact ammo batch persisted by the provider.",
                { statusCode: 409 }
            );
        }
        safeMetric(metrics, "increment", "crash_recovery_total", 1, { domain: "elite_ball" });
    }

    async function enqueueXsollaHighValueOperation(input = {}) {
        const started = monotonicMilliseconds();
        const operation = createServerEconomyPocHighValueOperation({
            ...input,
            createdAtUnixMs: now()
        });
        const submitted = await operationInbox.submit(operation);
        safeMetric(metrics, "increment", submitted.status === "submitted"
            ? "operation_inbox_submit_total" : "operation_inbox_replay_total");
        safeMetric(metrics, "observe", "operation_enqueue_duration_ms", elapsed(started));
        return submitted;
    }

    async function appendEliteBallDelta(input = {}) {
        const started = monotonicMilliseconds();
        const event = createServerEconomyPocAmmoEvent({ ...input, createdAtUnixMs: now() });
        const appended = await walStore.append(event);
        safeMetric(metrics, "increment", appended.status === "appended"
            ? "wal_append_total" : "wal_append_replay_total");
        safeMetric(metrics, "observe", "wal_append_duration_ms", elapsed(started));
        return appended;
    }

    async function acquirePlayer(playFabId) {
        const token = serverEconomyPocId(tokenFactory(), "player lease token", 255);
        const result = await playerLeases.acquire({
            playFabId,
            owner: workerId,
            token,
            ttlMilliseconds: leaseTtlMilliseconds
        });
        if (result?.status !== "acquired" || !Number.isSafeInteger(result?.lease?.epoch)) {
            safeMetric(metrics, "increment", "player_lease_conflict_total");
            serverEconomyPocFail("POC_PLAYER_BUSY", "Another server economy consumer owns this player.", { retryable: true, statusCode: 409 });
        }
        safeMetric(metrics, "increment", "player_lease_acquired_total");
        return { token, epoch: result.lease.epoch };
    }

    async function renewPlayer(playFabId, lease) {
        const result = await playerLeases.renew({
            playFabId,
            token: lease.token,
            epoch: lease.epoch,
            ttlMilliseconds: leaseTtlMilliseconds
        });
        if (result?.status !== "renewed") {
            safeMetric(metrics, "increment", "stale_writer_reject_total");
            serverEconomyPocFail("POC_STALE_WRITER", "Player lease renewal was fenced.", { retryable: true });
        }
    }

    async function providerCas(input, domain) {
        const started = monotonicMilliseconds();
        safeMetric(metrics, "increment", "provider_call_total", 1, { domain });
        const result = await snapshotStore.compareAndSet(input);
        safeMetric(metrics, "observe", "provider_call_duration_ms", elapsed(started), { domain });
        if (result?.status === "updated") safeMetric(metrics, "increment", "snapshot_write_total", 1, { domain });
        return result;
    }

    async function processHighValueOperation({ playFabId, operationId, consumer = "offline" } = {}) {
        const started = monotonicMilliseconds();
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const id = serverEconomyPocId(operationId, "operationId", 200);
        serverEconomyPocId(consumer, "consumer", 40);
        let record = await operationInbox.get(player, id);
        if (!record) serverEconomyPocFail("POC_OPERATION_NOT_FOUND", "High-value operation was not found.", { statusCode: 404 });
        if (record.state === "Acked") {
            safeMetric(metrics, "increment", "operation_ack_replay_total", 1, { consumer });
            return serverEconomyPocReadonly({ status: "already_acked", result: record.result, snapshot: await readSnapshot(player) });
        }
        const lease = await acquirePlayer(player);
        const claimToken = serverEconomyPocId(tokenFactory(), "claim token", 255);
        let claim = null;
        let crashed = false;
        let acked = false;
        try {
            claim = await operationInbox.claim({
                playFabId: player,
                operationId: id,
                owner: workerId,
                token: claimToken,
                ttlMilliseconds: claimTtlMilliseconds
            });
            if (claim?.status === "acked") {
                acked = true;
                return serverEconomyPocReadonly({ status: "already_acked", result: claim.record.result, snapshot: await readSnapshot(player) });
            }
            if (claim?.status !== "claimed") {
                serverEconomyPocFail("POC_OPERATION_BUSY", "High-value operation is already claimed.", { retryable: true, statusCode: 409 });
            }
            record = claim.record;
            safeMetric(metrics, "increment", "operation_inbox_claim_total", 1, { consumer });
            await assertEarlierOperationsAcked(record);
            if (typeof hooks.afterInboxClaim === "function") {
                await hooks.afterInboxClaim({ playFabId: player, operationId: id, lease: { ...lease }, claim: serverEconomyPocClone(record) });
            }
            let snapshot = await readSnapshot(player);
            let result;
            if (record.sequence <= snapshot.highValueAppliedThroughSequence) {
                result = await recoverAppliedHighValue(record, snapshot);
            } else {
                if (record.sequence !== snapshot.highValueAppliedThroughSequence + 1) {
                    serverEconomyPocFail("POC_OPERATION_ORDER_BLOCKED", "An earlier high-value operation must be consumed first.", { retryable: true, statusCode: 409 });
                }
                let applied = false;
                for (let attempt = 1; attempt <= maximumCasAttempts; attempt += 1) {
                    await renewPlayer(player, lease);
                    const mutation = applyServerEconomyPocHighValueOperation(
                        snapshot,
                        record.operation,
                        record.sequence,
                        now(),
                        lease.epoch
                    );
                    const cas = await providerCas({
                        playFabId: player,
                        expectedRevision: snapshot.revision,
                        leaseToken: lease.token,
                        fencingEpoch: lease.epoch,
                        nextSnapshot: mutation.snapshot,
                        operationProof: providerProof(record)
                    }, "high_value");
                    if (cas.status === "updated") {
                        snapshot = cas.snapshot;
                        result = mutation.result;
                        applied = true;
                        break;
                    }
                    if (cas.status !== "version_conflict") {
                        serverEconomyPocFail("POC_SNAPSHOT_PROTOCOL", "Snapshot store returned an invalid CAS result.", { retryable: true });
                    }
                    snapshot = cas.snapshot;
                    if (record.sequence <= snapshot.highValueAppliedThroughSequence) {
                        result = await recoverAppliedHighValue(record, snapshot);
                        applied = true;
                        break;
                    }
                }
                if (!applied) serverEconomyPocFail("POC_SNAPSHOT_CAS_EXHAUSTED", "High-value snapshot CAS retries were exhausted.", { retryable: true });
                if (typeof hooks.afterSnapshotCas === "function") {
                    await hooks.afterSnapshotCas({ domain: "high_value", playFabId: player, operationId: id, snapshot: serverEconomyPocClone(snapshot) });
                }
            }
            if (typeof hooks.beforeInboxAck === "function") {
                await hooks.beforeInboxAck({ playFabId: player, operationId: id, result: serverEconomyPocClone(result) });
            }
            await renewPlayer(player, lease);
            const acknowledged = await operationInbox.ack({
                playFabId: player,
                operationId: id,
                claimToken,
                claimEpoch: record.claimEpoch,
                playerLeaseToken: lease.token,
                playerFencingEpoch: lease.epoch,
                result
            });
            if (acknowledged?.status !== "acked") {
                serverEconomyPocFail("POC_INBOX_ACK_FAILED", "Operation inbox ACK failed after snapshot CAS.", { retryable: true });
            }
            acked = true;
            safeMetric(metrics, "increment", "operation_inbox_ack_total", 1, { consumer });
            safeMetric(metrics, "increment", "high_value_completed_total", 1, { consumer });
            safeMetric(metrics, "observe", "high_value_operation_duration_ms", elapsed(started), { consumer });
            return serverEconomyPocReadonly({ status: result.status, result, snapshot });
        } catch (error) {
            crashed = error?.simulatedCrash === true;
            if (crashed) safeMetric(metrics, "increment", "simulated_crash_total", 1, { domain: "high_value" });
            if (error?.code === "POC_STALE_WRITER" || error?.code === "POC_STALE_INBOX_CLAIM") {
                safeMetric(metrics, "increment", "stale_writer_reject_total");
            }
            throw error;
        } finally {
            if (!crashed && claim?.status === "claimed" && !acked) {
                await operationInbox.releaseClaim({
                    playFabId: player,
                    operationId: id,
                    claimToken,
                    claimEpoch: claim.record.claimEpoch
                }).catch(() => {});
            }
            if (!crashed) {
                await playerLeases.release({ playFabId: player, token: lease.token, epoch: lease.epoch }).catch(() => {});
            }
        }
    }

    async function nextPendingOperation(playFabId) {
        let cursor = 0;
        for (;;) {
            const page = await operationInbox.scanAfter({ playFabId, afterSequence: cursor, limit: 100 });
            const pending = page.entries.find((entry) => entry.state !== "Acked");
            if (pending) return pending;
            if (page.entries.length === 0 || page.entries.at(-1).sequence >= page.nextSequence) return null;
            cursor = page.entries.at(-1).sequence;
        }
    }

    async function processNextHighValue(playFabId, { consumer = "offline" } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const record = await nextPendingOperation(player);
        if (!record) return Object.freeze({ status: "empty" });
        return processHighValueOperation({ playFabId: player, operationId: record.operationId, consumer });
    }

    async function drainHighValue(playFabId, { consumer = "offline", maximumOperations = 100 } = {}) {
        const maximum = serverEconomyPocPositive(maximumOperations, "maximumOperations");
        const results = [];
        for (let index = 0; index < maximum; index += 1) {
            const result = await processNextHighValue(playFabId, { consumer });
            if (result.status === "empty") break;
            results.push(result);
        }
        return Object.freeze(results);
    }

    async function flushEliteBall(playFabId, { batchSize = ammoBatchSize, consumer = "offline" } = {}) {
        const started = monotonicMilliseconds();
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const maximum = serverEconomyPocPositive(batchSize, "batchSize");
        if (maximum > 500) serverEconomyPocFail("POC_INVALID_ARGUMENT", "batchSize exceeds 500.", { statusCode: 400 });
        const lease = await acquirePlayer(player);
        let crashed = false;
        try {
            let snapshot = await readSnapshot(player);
            await renewPlayer(player, lease);
            const walStatus = await walStore.status(player);
            if (walStatus.nextSequence < snapshot.ammoAppliedThroughSequence ||
                walStatus.ackedThroughSequence > walStatus.nextSequence) {
                safeMetric(metrics, "increment", "sequence_rollback_reject_total", 1, { domain: "elite_ball" });
                serverEconomyPocFail(
                    "POC_WAL_SEQUENCE_ROLLBACK",
                    "Durable WAL sequence regressed behind the provider snapshot cursor.",
                    { statusCode: 409 }
                );
            }
            await reconcileAppliedAmmo(player, snapshot);
            await walStore.ackThrough({
                playFabId: player,
                throughSequence: snapshot.ammoAppliedThroughSequence,
                leaseToken: lease.token,
                fencingEpoch: lease.epoch
            });
            for (let attempt = 1; attempt <= maximumCasAttempts; attempt += 1) {
                const page = await walStore.scanAfter({
                    playFabId: player,
                    afterSequence: snapshot.ammoAppliedThroughSequence,
                    limit: maximum
                });
                if (page.entries.length === 0) {
                    safeMetric(metrics, "increment", "ammo_flush_empty_total", 1, { consumer });
                    return serverEconomyPocReadonly({ status: "empty", snapshot });
                }
                await renewPlayer(player, lease);
                const mutation = applyServerEconomyPocAmmoBatch(
                    snapshot,
                    page.entries,
                    now(),
                    lease.epoch
                );
                const cas = await providerCas({
                    playFabId: player,
                    expectedRevision: snapshot.revision,
                    leaseToken: lease.token,
                    fencingEpoch: lease.epoch,
                    nextSnapshot: mutation.snapshot,
                    ammoProof: createServerEconomyPocAmmoBatchProof({ playFabId: player, entries: page.entries })
                }, "elite_ball_flush");
                if (cas.status === "version_conflict") {
                    snapshot = cas.snapshot;
                    continue;
                }
                if (cas.status !== "updated") {
                    serverEconomyPocFail("POC_SNAPSHOT_PROTOCOL", "Snapshot store returned an invalid CAS result.", { retryable: true });
                }
                snapshot = cas.snapshot;
                if (typeof hooks.afterSnapshotCas === "function") {
                    await hooks.afterSnapshotCas({ domain: "elite_ball_flush", playFabId: player, snapshot: serverEconomyPocClone(snapshot) });
                }
                await renewPlayer(player, lease);
                await walStore.ackThrough({
                    playFabId: player,
                    throughSequence: mutation.result.throughSequence,
                    leaseToken: lease.token,
                    fencingEpoch: lease.epoch
                });
                safeMetric(metrics, "increment", "ammo_flush_total", 1, { consumer });
                safeMetric(metrics, "increment", "ammo_event_flushed_total", page.entries.length, { consumer });
                safeMetric(metrics, "observe", "ammo_flush_duration_ms", elapsed(started), { consumer });
                return serverEconomyPocReadonly({ status: "flushed", result: mutation.result, snapshot });
            }
            serverEconomyPocFail("POC_SNAPSHOT_CAS_EXHAUSTED", "Ammo snapshot CAS retries were exhausted.", { retryable: true });
        } catch (error) {
            crashed = error?.simulatedCrash === true;
            if (crashed) safeMetric(metrics, "increment", "simulated_crash_total", 1, { domain: "elite_ball_flush" });
            if (error?.code === "POC_STALE_WRITER") safeMetric(metrics, "increment", "stale_writer_reject_total");
            throw error;
        } finally {
            if (!crashed) {
                await playerLeases.release({ playFabId: player, token: lease.token, epoch: lease.epoch }).catch(() => {});
            }
        }
    }

    return Object.freeze({
        enqueueXsollaHighValueOperation,
        appendEliteBallDelta,
        processHighValueOperation,
        processNextHighValue,
        drainHighValue,
        flushEliteBall,
        readSnapshot,
        stores: Object.freeze({ snapshotStore, walStore, operationInbox, playerLeases }),
        configuration: Object.freeze({ leaseTtlMilliseconds, claimTtlMilliseconds, ammoBatchSize, maximumCasAttempts })
    });
}
