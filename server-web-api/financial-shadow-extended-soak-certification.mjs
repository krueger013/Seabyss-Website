import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    CANARY_ENTITY_ID,
    CANARY_PLAYFAB_ID,
    PRODUCTION_TITLE_ID,
    SANDBOX_TITLE_ID,
    createCanaryE2eHarness,
    loadCanaryE2eConfiguration
} from "./financial-shadow-canary-e2e-certification.mjs";

export const SOAK_SEGMENT_COUNT = 5;
export const SOAK_CYCLES_PER_SEGMENT = 20;
export const SOAK_ELITE_BATCHES_PER_CYCLE = 10;
export const SOAK_EVENTS_PER_BATCH = 10;
export const SOAK_TOTAL_ELITE_BATCHES = SOAK_SEGMENT_COUNT * SOAK_CYCLES_PER_SEGMENT *
    SOAK_ELITE_BATCHES_PER_CYCLE;
export const SOAK_TOTAL_ELITE_MUTATIONS = SOAK_TOTAL_ELITE_BATCHES * SOAK_EVENTS_PER_BATCH;
export const SOAK_LOGICAL_DURATION_MILLISECONDS = 2 * 60 * 60 * 1000;

const LOGICAL_EPOCH_UNIX_MS = Date.UTC(2031, 0, 1);
const CYCLE_LOGICAL_STEP_MS = SOAK_LOGICAL_DURATION_MILLISECONDS /
    (SOAK_SEGMENT_COUNT * SOAK_CYCLES_PER_SEGMENT);
const RETAINED_HISTORY_LIMIT = 1000;
const SOAK_PLAYFAB_READ_ONLY_ENDPOINTS = new Set([
    "Authentication/GetEntityToken",
    "Object/GetObjects",
    "Server/GetUserAccountInfo"
]);

function soakFail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function explicitTrue(value, name) {
    if (!new Set(["1", "true", "yes", "on", "enabled"])
        .has(String(value || "").trim().toLowerCase())) {
        soakFail("SHADOW_SOAK_CONFIGURATION_INVALID", `${name} must be explicitly true.`);
    }
}

function exactSegmentIndex(value) {
    if (!/^[0-4]$/u.test(String(value))) {
        soakFail("SHADOW_SOAK_SEGMENT_REFUSED", "Soak segment index must be between 0 and 4.");
    }
    return Number(value);
}

function withoutPlayer(snapshot) {
    const value = structuredClone(snapshot);
    delete value.playFabId;
    return value;
}

function quantile(values, percentile) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index];
}

function latencySummary(values) {
    return Object.freeze({
        count: values.length,
        p50Milliseconds: quantile(values, 0.50),
        p95Milliseconds: quantile(values, 0.95),
        p99Milliseconds: quantile(values, 0.99),
        maximumMilliseconds: values.length === 0 ? null : Math.max(...values),
        samplesMilliseconds: Object.freeze([...values])
    });
}

export function loadExtendedSoakConfiguration(environment = process.env) {
    explicitTrue(environment.FINANCIAL_SHADOW_EXTENDED_SOAK_ENABLED,
        "FINANCIAL_SHADOW_EXTENDED_SOAK_ENABLED");
    const base = loadCanaryE2eConfiguration(environment);
    if (base.titleId !== SANDBOX_TITLE_ID || base.titleId === PRODUCTION_TITLE_ID ||
        base.canaryPlayFabId !== CANARY_PLAYFAB_ID || base.canaryEntityId !== CANARY_ENTITY_ID) {
        soakFail("SHADOW_SOAK_IDENTITY_REFUSED", "The extended soak is restricted to the isolated canary.");
    }
    return Object.freeze({
        ...base,
        segmentCount: SOAK_SEGMENT_COUNT,
        cyclesPerSegment: SOAK_CYCLES_PER_SEGMENT,
        eliteBatchesPerCycle: SOAK_ELITE_BATCHES_PER_CYCLE,
        eventsPerBatch: SOAK_EVENTS_PER_BATCH,
        totalEliteBatches: SOAK_TOTAL_ELITE_BATCHES,
        totalEliteMutations: SOAK_TOTAL_ELITE_MUTATIONS,
        logicalDurationMilliseconds: SOAK_LOGICAL_DURATION_MILLISECONDS
    });
}

export function createPlayFabFetchObserver({
    fetchImpl,
    titleId = SANDBOX_TITLE_ID,
    monotonicMilliseconds = () => performance.now()
} = {}) {
    if (typeof fetchImpl !== "function" || typeof monotonicMilliseconds !== "function" ||
        titleId !== SANDBOX_TITLE_ID || titleId === PRODUCTION_TITLE_ID) {
        throw new TypeError("PlayFab fetch observer is restricted to Sandbox 1D0C16.");
    }
    const endpoints = new Map();
    const expectedHost = `${SANDBOX_TITLE_ID.toLowerCase()}.playfabapi.com`;

    function entry(endpoint) {
        if (!endpoints.has(endpoint)) endpoints.set(endpoint, {
            requests: 0, success: 0, clientErrors: 0, serverErrors: 0,
            rateLimited: 0, networkFailures: 0, retries: 0, retryPending: false, durations: []
        });
        return endpoints.get(endpoint);
    }

    async function observedFetch(input, init) {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input?.url);
        const playFabHost = url.hostname.toLowerCase().endsWith(".playfabapi.com");
        if (playFabHost && url.hostname.toLowerCase() !== expectedHost) {
            soakFail("SHADOW_SOAK_PLAYFAB_TITLE_REFUSED", "A non-Sandbox PlayFab host was refused.");
        }
        if (!playFabHost) return fetchImpl(input, init);
        const endpoint = url.pathname.replace(/^\/+|\/+$/gu, "");
        if (!SOAK_PLAYFAB_READ_ONLY_ENDPOINTS.has(endpoint)) {
            soakFail("SHADOW_SOAK_PLAYFAB_ENDPOINT_REFUSED",
                `PlayFab endpoint ${endpoint} is outside the soak read-only whitelist.`);
        }
        const metric = entry(endpoint);
        if (metric.retryPending) {
            metric.retries += 1;
            metric.retryPending = false;
        }
        metric.requests += 1;
        const started = monotonicMilliseconds();
        try {
            const response = await fetchImpl(input, init);
            const status = Number(response?.status || 0);
            if (status >= 200 && status < 400) metric.success += 1;
            else if (status >= 400 && status < 500) metric.clientErrors += 1;
            else if (status >= 500) metric.serverErrors += 1;
            if (status === 429) metric.rateLimited += 1;
            if (status === 429 || status >= 500) metric.retryPending = true;
            return response;
        } catch (error) {
            metric.networkFailures += 1;
            metric.retryPending = true;
            throw error;
        } finally {
            metric.durations.push(Math.max(0, monotonicMilliseconds() - started));
        }
    }

    function snapshot() {
        return Object.freeze({
            titleId: SANDBOX_TITLE_ID,
            productionRefused: true,
            includesHeaders: false,
            includesBodies: false,
            endpoints: Object.freeze(Object.fromEntries([...endpoints.entries()].sort()
                .map(([endpoint, metric]) => [endpoint, Object.freeze({
                    requests: metric.requests,
                    success: metric.success,
                    clientErrors: metric.clientErrors,
                    serverErrors: metric.serverErrors,
                    rateLimited: metric.rateLimited,
                    networkFailures: metric.networkFailures,
                    retries: metric.retries,
                    latency: latencySummary(metric.durations)
                })])))
        });
    }

    return Object.freeze({ fetch: observedFetch, snapshot });
}

export function createRedisCommandObserver({
    monotonicMilliseconds = () => performance.now()
} = {}) {
    if (typeof monotonicMilliseconds !== "function") {
        throw new TypeError("Redis command observer requires a monotonic clock.");
    }
    const commands = new Map();
    const wrappedMethods = new WeakMap();
    function metric(command) {
        const normalized = String(command || "UNKNOWN").trim().toUpperCase();
        if (!commands.has(normalized)) commands.set(normalized, { count: 0, failures: 0, durations: [] });
        return commands.get(normalized);
    }
    async function observed(command, call) {
        const value = metric(command);
        value.count += 1;
        const started = monotonicMilliseconds();
        try { return await call(); }
        catch (error) { value.failures += 1; throw error; }
        finally { value.durations.push(Math.max(0, monotonicMilliseconds() - started)); }
    }
    function decorate(client) {
        if (!client || typeof client !== "object") throw new TypeError("Redis client is required.");
        return new Proxy(client, {
            get(target, property) {
                const original = Reflect.get(target, property, target);
                if (typeof original !== "function") return original;
                if (wrappedMethods.has(original)) return wrappedMethods.get(original);
                const name = String(property);
                const directCommand = new Map([
                    ["get", "GET"], ["set", "SET"], ["eval", "EVAL"], ["ping", "PING"]
                ]).get(name);
                let wrapped;
                if (name === "sendCommand") {
                    wrapped = (...args) => observed(args?.[0]?.[0] || "UNKNOWN",
                        () => original.apply(target, args));
                } else if (directCommand) {
                    wrapped = (...args) => observed(directCommand, () => original.apply(target, args));
                } else {
                    wrapped = original.bind(target);
                }
                wrappedMethods.set(original, wrapped);
                return wrapped;
            }
        });
    }
    function snapshot() {
        return Object.freeze({
            includesArguments: false,
            includesValues: false,
            commands: Object.freeze(Object.fromEntries([...commands.entries()].sort()
                .map(([command, value]) => [command, Object.freeze({
                    count: value.count,
                    failures: value.failures,
                    latency: latencySummary(value.durations)
                })])))
        });
    }
    return Object.freeze({ decorate, snapshot });
}

export function buildEliteSoakObservation({
    runId,
    segmentIndex,
    cycleIndex,
    batchIndex,
    session,
    before,
    logicalNowUnixMs
} = {}) {
    const segment = exactSegmentIndex(segmentIndex);
    if (!Number.isSafeInteger(cycleIndex) || cycleIndex < 0 || cycleIndex >= SOAK_CYCLES_PER_SEGMENT ||
        !Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= SOAK_ELITE_BATCHES_PER_CYCLE ||
        typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(runId) ||
        !session || !before || !Number.isSafeInteger(logicalNowUnixMs)) {
        throw new TypeError("Elite soak observation input is invalid.");
    }
    const delta = batchIndex % 2 === 0 ? SOAK_EVENTS_PER_BATCH : -SOAK_EVENTS_PER_BATCH;
    const suffix = `${runId}_S${segment}_C${cycleIndex}_B${batchIndex}`;
    const expected = structuredClone(before);
    expected.eliteBall += delta;
    expected.ammoAppliedThroughSequence += SOAK_EVENTS_PER_BATCH;
    expected.revision += 1;
    expected.fencingEpoch = session.sessionEpoch;
    expected.updatedAtUnixMs = Math.max(expected.updatedAtUnixMs, logicalNowUnixMs);
    if (!Number.isSafeInteger(expected.eliteBall) || expected.eliteBall < 0) {
        soakFail("SHADOW_SOAK_ELITE_RANGE", "Elite soak delta would underflow.");
    }
    return Object.freeze({
        expected,
        mutationCount: SOAK_EVENTS_PER_BATCH,
        observation: Object.freeze({
            schemaVersion: 1,
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
            operationId: `SOAK_OP_${suffix}`,
            eventId: `SOAK_EVENT_${suffix}`,
            kind: "elite_ball_delta",
            reason: "extended_shadow_soak",
            contextId: `SOAK_CONTEXT_${suffix}`,
            occurredAtUnixMs: logicalNowUnixMs,
            effect: Object.freeze({ eliteBallDelta: delta, eventCount: SOAK_EVENTS_PER_BATCH }),
            clientBeforeSnapshot: withoutPlayer(before),
            clientSnapshot: withoutPlayer(expected)
        })
    });
}

function bootstrapObservation(configuration, session, snapshot, logicalNowUnixMs) {
    const suffix = `${configuration.runId}_BOOTSTRAP`;
    return Object.freeze({
        schemaVersion: 1,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        operationId: `SOAK_OP_${suffix}`,
        eventId: `SOAK_EVENT_${suffix}`,
        kind: "snapshot_observation",
        reason: "extended_shadow_soak_bootstrap",
        contextId: `SOAK_CONTEXT_${suffix}`,
        occurredAtUnixMs: logicalNowUnixMs,
        effect: Object.freeze({}),
        clientBeforeSnapshot: withoutPlayer(snapshot),
        clientSnapshot: withoutPlayer(snapshot)
    });
}

function queueSummary(state) {
    const counts = { Pending: 0, Claimed: 0, Acked: 0 };
    for (const delivery of state?.deliveries || []) counts[delivery.state] += 1;
    return Object.freeze({
        ...counts,
        retainedDeliveries: state?.deliveries?.length || 0,
        retainedObservations: state?.observations?.length || 0,
        compactedObservations: state?.diagnostics?.compactedObservationCount || 0
    });
}

async function claimAndAck(runtime, session, { leaveDeliveryId = null, replayOne = false } = {}) {
    const claimed = await runtime.claimInbox({
        playFabId: CANARY_PLAYFAB_ID,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        limit: 100
    });
    let acked = 0;
    let replayed = 0;
    for (const delivery of claimed.deliveries) {
        if (delivery.deliveryId === leaveDeliveryId) continue;
        const input = {
            playFabId: CANARY_PLAYFAB_ID,
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
            deliveryId: delivery.deliveryId,
            deliveryEpoch: delivery.deliveryEpoch
        };
        const result = await runtime.ackDelivery(input);
        if (result.status === "acked") acked += 1;
        if (replayOne && replayed === 0) {
            const replay = await runtime.ackDelivery(input);
            if (replay.status !== "already_acked") {
                soakFail("SHADOW_SOAK_ACK_REPLAY_FAILED", "ACK replay was not idempotent.");
            }
            replayed += 1;
        }
    }
    return Object.freeze({ claimed: claimed.deliveries.length, acked, replayed });
}

function logicalTime(segmentIndex, cycleIndex) {
    return LOGICAL_EPOCH_UNIX_MS +
        ((segmentIndex * SOAK_CYCLES_PER_SEGMENT + cycleIndex) * CYCLE_LOGICAL_STEP_MS);
}

function safeMemory() {
    const value = process.memoryUsage();
    return Object.freeze({ rss: value.rss, heapTotal: value.heapTotal, heapUsed: value.heapUsed,
        external: value.external, arrayBuffers: value.arrayBuffers });
}

export async function runExtendedSoakSegment(configuration, segmentIndex, {
    fetchImpl = globalThis.fetch
} = {}) {
    const segment = exactSegmentIndex(segmentIndex);
    const markerKey = `${configuration.redisPrefix}extended-soak:segment:${segment}`;
    const clock = { now: logicalTime(segment, 0) };
    const playFabObserver = createPlayFabFetchObserver({ fetchImpl });
    const redisObserver = createRedisCommandObserver();
    const originalFetch = globalThis.fetch;
    let harness = null;
    globalThis.fetch = playFabObserver.fetch;
    try {
        harness = await createCanaryE2eHarness(configuration, {
            serverInstanceId: `shadow-soak-${configuration.runId}-segment-${segment}`,
            nowMilliseconds: () => clock.now,
            decorateRedisClient: redisObserver.decorate,
            maximumHistoryEntries: RETAINED_HISTORY_LIMIT
        });
        if (await harness.redis.get(markerKey)) {
            soakFail("SHADOW_SOAK_SEGMENT_ALREADY_COMPLETED", "Soak segment marker already exists.");
        }
        if (segment > 0 && !await harness.redis.get(
            `${configuration.redisPrefix}extended-soak:segment:${segment - 1}`)) {
            soakFail("SHADOW_SOAK_PREVIOUS_SEGMENT_MISSING", "Previous soak segment is not durable.");
        }
        const memoryStart = safeMemory();
        const stateAtStart = await harness.stores.shadowState.read(CANARY_PLAYFAB_ID);
        if (segment === 0 && stateAtStart !== null) {
            soakFail("SHADOW_SOAK_STATE_NOT_FRESH", "Segment zero requires a fresh run prefix.");
        }
        if (segment > 0 && stateAtStart === null) {
            soakFail("SHADOW_SOAK_STATE_LOST", "Durable Shadow state was lost between segments.");
        }

        let currentSession = null;
        let recoveredAcrossSegment = 0;
        let ackReplays = 0;
        let exactStructuralComparisons = 0;
        let initialElite = null;
        let segmentBaseRevision = stateAtStart?.snapshot?.revision ?? null;
        let expectedRevisionDelta = 0;

        for (let cycle = 0; cycle < SOAK_CYCLES_PER_SEGMENT; cycle += 1) {
            clock.now = logicalTime(segment, cycle);
            currentSession = await harness.shadowRuntime.registerPresence({
                playFabId: CANARY_PLAYFAB_ID,
                sessionId: `SOAK_SESSION_${configuration.runId}_S${segment}_C${cycle}`
            });
            if (cycle === 0 && segment > 0) {
                const recovered = await claimAndAck(harness.shadowRuntime, currentSession, { replayOne: true });
                recoveredAcrossSegment += recovered.acked;
                ackReplays += recovered.replayed;
            }
            if (segment === 0 && cycle === 0) {
                const providerSnapshot = await harness.snapshotStore.read(CANARY_PLAYFAB_ID);
                initialElite = providerSnapshot.eliteBall;
                segmentBaseRevision = providerSnapshot.revision;
                const bootstrap = await harness.shadowRuntime.observe(
                    CANARY_PLAYFAB_ID,
                    bootstrapObservation(configuration, currentSession, providerSnapshot, clock.now),
                    { titlePlayerAccountId: CANARY_ENTITY_ID }
                );
                if (!bootstrap.mismatch.economicMatch) {
                    soakFail("SHADOW_SOAK_BOOTSTRAP_MISMATCH", "Provider bootstrap did not economically match.");
                }
                expectedRevisionDelta += 1;
                const bootstrapAck = await claimAndAck(harness.shadowRuntime, currentSession);
                if (bootstrapAck.acked !== 1) {
                    soakFail("SHADOW_SOAK_BOOTSTRAP_ACK_FAILED", "Bootstrap delivery was not ACKed.");
                }
            }
            if (initialElite === null) {
                initialElite = (await harness.shadowRuntime.getSnapshot(CANARY_PLAYFAB_ID)).eliteBall;
            }

            let finalDeliveryId = null;
            for (let batch = 0; batch < SOAK_ELITE_BATCHES_PER_CYCLE; batch += 1) {
                const before = await harness.shadowRuntime.getSnapshot(CANARY_PLAYFAB_ID);
                const built = buildEliteSoakObservation({
                    runId: configuration.runId,
                    segmentIndex: segment,
                    cycleIndex: cycle,
                    batchIndex: batch,
                    session: currentSession,
                    before,
                    logicalNowUnixMs: clock.now
                });
                const result = await harness.shadowRuntime.observe(
                    CANARY_PLAYFAB_ID, built.observation);
                if (!result.mismatch.economicMatch || result.mismatch.structuralFields.length !== 0 ||
                    JSON.stringify(result.modelSnapshot) !== JSON.stringify(built.expected)) {
                    soakFail("SHADOW_SOAK_DRIFT", "Elite batch produced economic or structural drift.");
                }
                exactStructuralComparisons += 1;
                expectedRevisionDelta += 1;
                finalDeliveryId = result.delivery.deliveryId;
            }
            const leaveAcrossBoundary = cycle === SOAK_CYCLES_PER_SEGMENT - 1 &&
                segment < SOAK_SEGMENT_COUNT - 1 ? finalDeliveryId : null;
            const acked = await claimAndAck(harness.shadowRuntime, currentSession, {
                leaveDeliveryId: leaveAcrossBoundary,
                replayOne: cycle === 0 && !(segment > 0)
            });
            ackReplays += acked.replayed;
        }
        // The last cycle starts at T+19 windows. Advance to the exclusive end so
        // five durable segments represent the full declared two-hour interval.
        clock.now = logicalTime(segment + 1, 0);

        const finalSnapshot = await harness.shadowRuntime.getSnapshot(CANARY_PLAYFAB_ID);
        const finalState = await harness.stores.shadowState.read(CANARY_PLAYFAB_ID);
        const queue = queueSummary(finalState);
        if (finalSnapshot.eliteBall !== initialElite ||
            finalState.diagnostics.shadowMismatchCount !== 0 ||
            finalState.diagnostics.shadowMismatchElite !== 0 ||
            exactStructuralComparisons !== SOAK_CYCLES_PER_SEGMENT * SOAK_ELITE_BATCHES_PER_CYCLE ||
            finalSnapshot.revision - segmentBaseRevision !== expectedRevisionDelta) {
            soakFail("SHADOW_SOAK_FINAL_CONSISTENCY_FAILED", "Segment consistency invariant failed.");
        }
        const expectedUnacked = segment < SOAK_SEGMENT_COUNT - 1 ? 1 : 0;
        if (queue.Pending + queue.Claimed !== expectedUnacked ||
            segment > 0 && recoveredAcrossSegment !== 1) {
            soakFail("SHADOW_SOAK_QUEUE_INVARIANT_FAILED", "Cross-segment delivery recovery invariant failed.");
        }
        const providerPendingPlayers = await harness.stores.providerInbox.listPlayersWithPending({ limit: 20 });
        const providerWal = await harness.stores.providerWal.status(CANARY_PLAYFAB_ID);
        const providerLease = await harness.stores.providerLeases.inspect(CANARY_PLAYFAB_ID);
        if (providerPendingPlayers.length !== 0 || providerWal.pendingCount !== 0 || providerLease !== null) {
            soakFail("SHADOW_SOAK_PROVIDER_QUEUE_NOT_EMPTY", "Provider queue, WAL, or lease was not clean.");
        }
        const fetchMetrics = playFabObserver.snapshot();
        // The observer fails before dispatch for every endpoint outside the exact
        // read-only whitelist. Keep this explicit invariant in the evidence.
        const unexpectedPlayFabEndpoints = Object.keys(fetchMetrics.endpoints)
            .filter((endpoint) => !SOAK_PLAYFAB_READ_ONLY_ENDPOINTS.has(endpoint));
        if (unexpectedPlayFabEndpoints.length !== 0) {
            soakFail("SHADOW_SOAK_PROVIDER_WRITE_REFUSED",
                "Load observations attempted a non-read-only PlayFab endpoint.");
        }
        const marker = JSON.stringify({
            schemaVersion: 1,
            segment,
            serverId: harness.policy.serverId,
            finalRevision: finalSnapshot.revision,
            finalElite: finalSnapshot.eliteBall,
            queue,
            completedAtLogicalUnixMs: clock.now
        });
        if (await harness.redis.set(markerKey, marker, { NX: true }) !== "OK") {
            soakFail("SHADOW_SOAK_SEGMENT_MARKER_FAILED", "Segment completion marker was not durable.");
        }
        const memoryEnd = safeMemory();
        return Object.freeze({
            schemaVersion: 1,
            type: "segment_result",
            titleId: SANDBOX_TITLE_ID,
            productionTitleId: PRODUCTION_TITLE_ID,
            canaryPlayFabId: CANARY_PLAYFAB_ID,
            segment,
            serverId: harness.policy.serverId,
            authoritative: false,
            targetPlayFabWritesAllowed: false,
            logicalStartUnixMs: logicalTime(segment, 0),
            logicalEndUnixMs: clock.now,
            cycles: SOAK_CYCLES_PER_SEGMENT,
            eliteBatches: SOAK_CYCLES_PER_SEGMENT * SOAK_ELITE_BATCHES_PER_CYCLE,
            eliteMutations: SOAK_CYCLES_PER_SEGMENT * SOAK_ELITE_BATCHES_PER_CYCLE *
                SOAK_EVENTS_PER_BATCH,
            exactStructuralComparisons,
            expectedRevisionDelta,
            recoveredAcrossSegment,
            ackReplays,
            initialElite,
            finalElite: finalSnapshot.eliteBall,
            finalRevision: finalSnapshot.revision,
            queue,
            provider: Object.freeze({
                pendingPlayers: providerPendingPlayers.length,
                walPending: providerWal.pendingCount,
                leasePresent: providerLease !== null,
                schedulerHealth: harness.providerScheduler.service.health(),
                observedHttp: harness.snapshotStore.httpMetricsSnapshot(),
                fetch: fetchMetrics
            }),
            consistency: Object.freeze({
                unexplainedMismatch: 0,
                lostOperation: 0,
                doubleOperation: 0,
                staleWriterAccepted: 0
            }),
            shadowMetrics: harness.shadowRuntime.metricsSnapshot(),
            redis: redisObserver.snapshot(),
            memory: Object.freeze({ start: memoryStart, end: memoryEnd })
        });
    } finally {
        try { await harness?.close(); } finally { globalThis.fetch = originalFetch; }
    }
}

function parseChildResult(stdout) {
    const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const value = JSON.parse(lines[index]);
            if (value?.type === "segment_result") return value;
        } catch {}
    }
    soakFail("SHADOW_SOAK_CHILD_RESULT_MISSING", "Soak child emitted no segment result.");
}

function runSegmentProcess(segmentIndex, environment) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "segment", String(segmentIndex)], {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) {
                try { resolve(parseChildResult(stdout)); } catch (error) { reject(error); }
                return;
            }
            const error = new Error("Extended soak segment process failed.");
            error.code = (() => {
                try { return JSON.parse(stderr.trim().split(/\r?\n/u).at(-1))?.code; }
                catch { return "SHADOW_SOAK_CHILD_FAILED"; }
            })();
            reject(error);
        });
    });
}

export function summarizeExtendedSoakSegments(results) {
    if (!Array.isArray(results) || results.length !== SOAK_SEGMENT_COUNT ||
        results.some((result, index) => result?.segment !== index ||
            result.titleId !== SANDBOX_TITLE_ID || result.canaryPlayFabId !== CANARY_PLAYFAB_ID)) {
        soakFail("SHADOW_SOAK_RESULT_SET_INVALID", "Five ordered Sandbox segment results are required.");
    }
    const totalBatches = results.reduce((sum, value) => sum + value.eliteBatches, 0);
    const totalMutations = results.reduce((sum, value) => sum + value.eliteMutations, 0);
    const serverIds = new Set(results.map((value) => value.serverId));
    const final = results.at(-1);
    const pass = totalBatches === SOAK_TOTAL_ELITE_BATCHES &&
        totalMutations === SOAK_TOTAL_ELITE_MUTATIONS &&
        serverIds.size === SOAK_SEGMENT_COUNT &&
        final.logicalEndUnixMs - results[0].logicalStartUnixMs === SOAK_LOGICAL_DURATION_MILLISECONDS &&
        results.every((value, index) => value.initialElite === value.finalElite &&
            value.exactStructuralComparisons === value.eliteBatches &&
            value.targetPlayFabWritesAllowed === false &&
            value.logicalStartUnixMs === logicalTime(index, 0) &&
            value.logicalEndUnixMs === logicalTime(index + 1, 0) &&
            value.recoveredAcrossSegment === (index === 0 ? 0 : 1) &&
            value.queue.Pending + value.queue.Claimed ===
                (index === SOAK_SEGMENT_COUNT - 1 ? 0 : 1) &&
            value.provider.pendingPlayers === 0 && value.provider.walPending === 0 &&
            value.provider.leasePresent === false &&
            value.consistency?.unexplainedMismatch === 0 &&
            value.consistency?.lostOperation === 0 &&
            value.consistency?.doubleOperation === 0 &&
            value.consistency?.staleWriterAccepted === 0) &&
        final.queue.Pending === 0 && final.queue.Claimed === 0 &&
        final.provider.pendingPlayers === 0 && final.provider.walPending === 0 &&
        final.provider.leasePresent === false;
    if (!pass) soakFail("SHADOW_SOAK_SUMMARY_FAILED", "Extended soak aggregate invariant failed.");
    return Object.freeze({
        schemaVersion: 1,
        type: "extended_soak_result",
        verdict: "PASS",
        titleId: SANDBOX_TITLE_ID,
        productionUntouched: true,
        canaryPlayFabId: CANARY_PLAYFAB_ID,
        authoritative: false,
        segmentCount: results.length,
        distinctServerInstances: serverIds.size,
        cycles: SOAK_SEGMENT_COUNT * SOAK_CYCLES_PER_SEGMENT,
        logicalDurationMilliseconds: SOAK_LOGICAL_DURATION_MILLISECONDS,
        eliteBatches: totalBatches,
        eliteMutations: totalMutations,
        finalQueue: final.queue,
        segmentDigests: Object.freeze(results.map((value) => createHash("sha256")
            .update(JSON.stringify(value)).digest("hex"))),
        segments: Object.freeze(results)
    });
}

export async function runExtendedSoakParent(configuration, environment = process.env) {
    const results = [];
    for (let segment = 0; segment < SOAK_SEGMENT_COUNT; segment += 1) {
        results.push(await runSegmentProcess(segment, environment));
    }
    return summarizeExtendedSoakSegments(results);
}

async function main() {
    const configuration = loadExtendedSoakConfiguration();
    const [action = "parent", argument] = process.argv.slice(2);
    if (action === "segment") {
        process.stdout.write(JSON.stringify(await runExtendedSoakSegment(
            configuration, exactSegmentIndex(argument))) + "\n");
        return;
    }
    if (action === "parent") {
        process.stdout.write(JSON.stringify(await runExtendedSoakParent(configuration)) + "\n");
        return;
    }
    soakFail("SHADOW_SOAK_ACTION_REFUSED", "Extended soak action must be parent or segment.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) ===
    fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`))) {
    main().catch((error) => {
        process.stderr.write(JSON.stringify({
            status: "failed",
            code: error?.code || "SHADOW_SOAK_FAILED"
        }) + "\n");
        process.exitCode = 1;
    });
}
