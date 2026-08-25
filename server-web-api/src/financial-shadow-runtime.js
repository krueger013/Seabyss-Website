import { createHash } from "node:crypto";
import {
    applyFinancialShadowObservation,
    compareFinancialShadowSnapshot,
    createFinancialShadowInitialSnapshot,
    createFinancialShadowMetrics,
    createFinancialShadowSnapshotCache,
    validateFinancialShadowObservation
} from "./financial-shadow-model.js";
import {
    applyServerEconomyPocHighValueOperation,
    createServerEconomyPocHighValueOperation
} from "./server-economy-poc-domain-model.js";
import {
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";

const RETIRED_FILTER_BYTES = 4096;
const MAXIMUM_OPERATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000;

function nowValue(nowMilliseconds) {
    return serverEconomyPocNonNegative(nowMilliseconds(), "Financial Shadow clock");
}

function deliveryId(playFabId, operationId) {
    return `shadow_${createHash("sha256").update(JSON.stringify([playFabId, operationId]), "utf8").digest("hex")}`;
}

function initialDiagnostics() {
    return {
        shadowCompareCount: 0,
        shadowMatchCount: 0,
        shadowMismatchCount: 0,
        shadowMismatchDiamonds: 0,
        shadowMismatchElite: 0,
        shadowMismatchPremium: 0,
        shadowOperationCount: 0,
        shadowOperationLagTotalMs: 0,
        shadowOperationLagMaximumMs: 0,
        compactedObservationCount: 0
    };
}

function initialState(playFabId, nowUnixMs) {
    return {
        schemaVersion: 1,
        playFabId,
        stateVersion: -1,
        nextSessionEpoch: 0,
        snapshot: createFinancialShadowInitialSnapshot(playFabId, nowUnixMs),
        bootstrap: null,
        diagnostics: initialDiagnostics(),
        presence: null,
        observations: [],
        deliveries: [],
        retiredReplayFilter: Buffer.alloc(RETIRED_FILTER_BYTES).toString("base64")
    };
}

function presenceCurrent(state, nowUnixMs) {
    return state.presence && state.presence.expiresAtUnixMs > nowUnixMs ? state.presence : null;
}

function assertPresence(state, { serverId, sessionId, sessionEpoch }, nowUnixMs) {
    const current = presenceCurrent(state, nowUnixMs);
    if (!current || current.ownerServerId !== serverId || current.sessionId !== sessionId ||
        current.sessionEpoch !== sessionEpoch || current.fencingEpoch !== sessionEpoch) {
        serverEconomyPocFail(
            "FINANCIAL_SHADOW_STALE_PRESENCE",
            "Financial Shadow presence is absent, expired, owned by another server, or fenced.",
            { retryable: true, statusCode: 409 }
        );
    }
    return current;
}

function exactIdentity(value, name, maximum = 200) {
    return serverEconomyPocId(value, name, maximum);
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function canonicalExternalOperation(operation, playFabId) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        serverEconomyPocFail("FINANCIAL_SHADOW_EXTERNAL_OPERATION_INVALID", "Canonical POC operation is required.", { statusCode: 400 });
    }
    let canonical;
    try {
        canonical = createServerEconomyPocHighValueOperation(operation);
    } catch {
        serverEconomyPocFail("FINANCIAL_SHADOW_EXTERNAL_OPERATION_INVALID", "Canonical POC operation is malformed.", { statusCode: 400 });
    }
    const actual = JSON.stringify(stableValue(operation));
    const expected = JSON.stringify(stableValue(canonical));
    if (canonical.playFabId !== playFabId || actual !== expected ||
        operation.immutableHash !== canonical.immutableHash) {
        serverEconomyPocFail(
            "FINANCIAL_SHADOW_EXTERNAL_OPERATION_INVALID",
            "POC operation has extra, missing, negative, or non-canonical/tampered members.",
            { statusCode: 400 }
        );
    }
    return canonical;
}

function validateDiagnostics(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.values(value).some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
        serverEconomyPocFail("FINANCIAL_SHADOW_STATE_CORRUPT", "Financial Shadow diagnostics are malformed.");
    }
}

function validateState(state, playFabId) {
    let filter;
    try { filter = Buffer.from(state?.retiredReplayFilter || "", "base64"); } catch { filter = null; }
    if (!state || state.schemaVersion !== 1 || state.playFabId !== playFabId ||
        !Number.isSafeInteger(state.stateVersion) || state.stateVersion < 0 ||
        !Number.isSafeInteger(state.nextSessionEpoch) || state.nextSessionEpoch < 0 ||
        !Array.isArray(state.observations) || !Array.isArray(state.deliveries) ||
        !filter || filter.length !== RETIRED_FILTER_BYTES ||
        state.bootstrap !== null && (typeof state.bootstrap !== "object" || Array.isArray(state.bootstrap))) {
        serverEconomyPocFail("FINANCIAL_SHADOW_STATE_CORRUPT", "Financial Shadow state is malformed.");
    }
    validateDiagnostics(state.diagnostics);
    validateServerEconomyPocSnapshot(state.snapshot, playFabId);
    return state;
}

function bloomIndexes(namespace, value) {
    const digest = createHash("sha256").update(`${namespace}\u0000${value}`, "utf8").digest();
    const bits = RETIRED_FILTER_BYTES * 8;
    return [digest.readUInt32BE(0) % bits, digest.readUInt32BE(4) % bits, digest.readUInt32BE(8) % bits];
}

function bloomHas(buffer, namespace, value) {
    return bloomIndexes(namespace, value).every((index) =>
        (buffer[Math.floor(index / 8)] & (1 << (index % 8))) !== 0);
}

function bloomAdd(buffer, namespace, value) {
    for (const index of bloomIndexes(namespace, value)) buffer[Math.floor(index / 8)] |= 1 << (index % 8);
}

function assertNotRetired(state, operationId, eventId) {
    const filter = Buffer.from(state.retiredReplayFilter, "base64");
    if (bloomHas(filter, "operation", operationId) || bloomHas(filter, "event", eventId)) {
        serverEconomyPocFail(
            "FINANCIAL_SHADOW_RETIRED_REPLAY",
            "Shadow operation/event was compacted and is rejected fail-closed.",
            { statusCode: 409 }
        );
    }
}

function compactAcknowledged(state, historyLimit, metrics) {
    const target = Math.max(1, Math.floor(historyLimit * 0.75));
    if (state.observations.length < historyLimit && state.deliveries.length < historyLimit) return;
    const filter = Buffer.from(state.retiredReplayFilter, "base64");
    while ((state.observations.length >= target || state.deliveries.length >= target)) {
        const index = state.deliveries.findIndex((delivery) => delivery.state === "Acked");
        if (index < 0) break;
        const [delivery] = state.deliveries.splice(index, 1);
        const recordIndex = state.observations.findIndex((record) => record.deliveryId === delivery.deliveryId);
        if (recordIndex >= 0) {
            const [record] = state.observations.splice(recordIndex, 1);
            bloomAdd(filter, "operation", record.operationId);
            bloomAdd(filter, "event", record.eventId);
            state.diagnostics.compactedObservationCount += 1;
        }
    }
    state.retiredReplayFilter = filter.toString("base64");
    if (state.observations.length >= historyLimit || state.deliveries.length >= historyLimit) {
        serverEconomyPocFail("FINANCIAL_SHADOW_HISTORY_FULL", "Unacknowledged Shadow history reached its configured bound.", { statusCode: 503 });
    }
    metrics.increment("financial_shadow_history_compaction_total");
}

function operationLag(at, occurredAt) {
    if (occurredAt > at + MAXIMUM_FUTURE_SKEW_MS || at - occurredAt > MAXIMUM_OPERATION_AGE_MS) {
        serverEconomyPocFail("FINANCIAL_SHADOW_OPERATION_TIME_INVALID", "Shadow operation timestamp is outside the safe observation window.", { statusCode: 400 });
    }
    return Math.max(0, at - occurredAt);
}

function normalizeExpiredPremium(snapshot, nowUnixMs) {
    if (snapshot.premium.tier === 0 || snapshot.premium.expiresAtUnixMs > nowUnixMs) {
        return serverEconomyPocReadonly(snapshot);
    }
    const normalized = serverEconomyPocClone(snapshot);
    normalized.premium = {
        tier: 0,
        activatedAtUnixMs: null,
        expiresAtUnixMs: null
    };
    validateServerEconomyPocSnapshot(normalized, snapshot.playFabId);
    return serverEconomyPocReadonly(normalized);
}

function comparisonDomains(kind) {
    if (kind === "diamonds_delta") return ["Diamonds"];
    if (kind === "elite_ball_delta") return ["Elite"];
    if (kind === "premium_observation") return ["Premium"];
    return ["Diamonds", "Elite", "Premium"];
}

function recordDurableComparison(state, mismatch, lag, domains) {
    const value = state.diagnostics;
    value.shadowCompareCount += 1;
    value.shadowOperationCount += 1;
    value.shadowOperationLagTotalMs += lag;
    value.shadowOperationLagMaximumMs = Math.max(value.shadowOperationLagMaximumMs, lag);
    if (mismatch.economicMatch) value.shadowMatchCount += 1;
    else value.shadowMismatchCount += 1;
    if (domains.includes("Diamonds") && !mismatch.domainMatches.Diamonds) value.shadowMismatchDiamonds += 1;
    if (domains.includes("Elite") && !mismatch.domainMatches.Elite) value.shadowMismatchElite += 1;
    if (domains.includes("Premium") && !mismatch.domainMatches.Premium) value.shadowMismatchPremium += 1;
}

function recordProcessComparison(metrics, mismatch, lag, kind, domains) {
    metrics.increment("shadow_compare_count");
    metrics.increment("shadow_operation_count");
    metrics.observe("shadow_operation_lag", lag);
    metrics.increment("shadow_operation_lag_total_ms", lag);
    metrics.increment("financial_shadow_compare_total");
    metrics.observe("financial_shadow_operation_lag_ms", lag, { kind });
    if (mismatch.economicMatch) {
        metrics.increment("shadow_match_count");
        metrics.increment("financial_shadow_match_total");
    } else {
        metrics.increment("shadow_mismatch_count");
        metrics.increment("financial_shadow_mismatch_total", 1, { severity: mismatch.severity });
    }
    for (const [domain, match] of Object.entries(mismatch.domainMatches).filter(([domain]) => domains.includes(domain))) {
        metrics.increment("shadow_compare_count", 1, { domain });
        metrics.increment(match ? "shadow_match_count" : "shadow_mismatch_count", 1, { domain });
        if (!match) metrics.increment(`shadow_mismatch_${domain.toLowerCase()}`);
    }
}

function bootstrapSnapshot(observation, nowUnixMs) {
    return applyFinancialShadowObservation(
        observation.clientSnapshot,
        observation,
        nowUnixMs,
        observation.sessionEpoch
    );
}

export function createFinancialShadowRuntime({
    stateStore,
    policy,
    metrics = createFinancialShadowMetrics(),
    cache = null,
    nowMilliseconds = () => Date.now(),
    monotonicMilliseconds = () => performance.now(),
    presenceLeaseTtlMilliseconds = 15_000,
    maximumCasAttempts = 12,
    maximumHistoryEntries = 2000,
    allowOfflineSourceAttestedProjection = false,
    offlineSourceAttestedPlayFabId = null
} = {}) {
    if (policy?.enabled !== true || policy.authoritative !== false || policy.targetPlayFabWritesAllowed !== false) {
        throw new TypeError("Financial Shadow runtime requires an enabled non-authoritative policy.");
    }
    if (!stateStore || typeof stateStore.read !== "function" || typeof stateStore.compareAndSet !== "function" ||
        typeof stateStore.ping !== "function" || typeof metrics?.increment !== "function" ||
        typeof metrics?.observe !== "function" || typeof metrics?.snapshot !== "function" ||
        typeof metrics?.contractSnapshot !== "function" || typeof nowMilliseconds !== "function" ||
        typeof monotonicMilliseconds !== "function" ||
        typeof allowOfflineSourceAttestedProjection !== "boolean") {
        throw new TypeError("Financial Shadow runtime dependencies are incomplete.");
    }
    const ttl = serverEconomyPocPositive(presenceLeaseTtlMilliseconds, "presence lease TTL");
    if (allowOfflineSourceAttestedProjection === true &&
        (policy.shadowEnvironment !== "sandbox" || !(policy.allowlist instanceof Set) ||
        policy.allowlist.size !== 1 || typeof offlineSourceAttestedPlayFabId !== "string" ||
        !policy.allowlist.has(offlineSourceAttestedPlayFabId))) {
        throw new TypeError(
            "Offline source-attested projection requires one exact Sandbox canary allowlist identity."
        );
    }

    const casLimit = serverEconomyPocPositive(maximumCasAttempts, "maximum CAS attempts");
    const historyLimit = serverEconomyPocPositive(maximumHistoryEntries, "maximum history entries");
    if (ttl < 1000 || ttl > 300_000 || casLimit > 100 || historyLimit < 2 || historyLimit > 100_000) {
        throw new TypeError("Financial Shadow runtime bounds are unsafe.");
    }
    const serverId = exactIdentity(policy.serverId, "Financial Shadow serverId", 160);
    const snapshotCache = cache || createFinancialShadowSnapshotCache({ nowMilliseconds, metrics });

    async function readState(playFabId) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const stored = await stateStore.read(player);
        return stored ? validateState(stored, player) : null;
    }

    async function mutate(playFabId, mutator) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        for (let attempt = 1; attempt <= casLimit; attempt += 1) {
            const stored = await readState(player);
            const current = stored || initialState(player, nowValue(nowMilliseconds));
            const outcome = await mutator(serverEconomyPocClone(current));
            if (outcome?.noChange === true) return outcome.result;
            const next = outcome?.state;
            if (!next || typeof next !== "object") throw new TypeError("Financial Shadow mutation returned no state.");
            next.stateVersion = current.stateVersion + 1;
            validateState(next, player);
            const cas = await stateStore.compareAndSet({
                playFabId: player,
                expectedStateVersion: stored?.stateVersion ?? -1,
                nextState: next
            });
            if (cas.status === "updated") {
                metrics.increment("financial_shadow_state_write_total");
                snapshotCache.set(player, cas.state.snapshot);
                return outcome.resultFactory ? outcome.resultFactory(cas.state) : outcome.result;
            }
            if (cas.status !== "version_conflict") {
                serverEconomyPocFail("FINANCIAL_SHADOW_STORE_PROTOCOL", "Financial Shadow store returned an invalid CAS result.");
            }
            metrics.increment("financial_shadow_state_cas_conflict_total");
        }
        serverEconomyPocFail("FINANCIAL_SHADOW_CAS_EXHAUSTED", "Financial Shadow state CAS retries were exhausted.", { retryable: true });
    }

    async function getSnapshot(playFabId) {
        const started = monotonicMilliseconds();
        try {
            const player = exactIdentity(playFabId, "playFabId", 160);
            const cached = snapshotCache.get(player);
            const at = nowValue(nowMilliseconds);
            if (cached) return normalizeExpiredPremium(cached, at);
            const state = await readState(player);
            const snapshot = normalizeExpiredPremium(state?.snapshot || createFinancialShadowInitialSnapshot(player, at), at);
            snapshotCache.set(player, snapshot);
            metrics.increment("financial_shadow_snapshot_read_total");
            return serverEconomyPocReadonly(snapshot);
        } finally {
            const elapsed = Math.max(0, monotonicMilliseconds() - started);
            metrics.increment("shadow_snapshot_count");
            metrics.observe("shadow_snapshot_latency", elapsed);
            metrics.observe("financial_shadow_snapshot_latency_ms", elapsed);
        }
    }

    async function registerPresence({ playFabId, sessionId } = {}) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const session = exactIdentity(sessionId, "sessionId", 200);
        const at = nowValue(nowMilliseconds);
        return mutate(player, (state) => {
            const active = presenceCurrent(state, at);
            if (active && (active.ownerServerId !== serverId || active.sessionId !== session)) {
                serverEconomyPocFail("FINANCIAL_SHADOW_PRESENCE_BUSY", "Another Shadow server/session owns this player presence.", { retryable: true, statusCode: 409 });
            }
            const resumed = Boolean(active);
            const takeover = Boolean(state.presence && !active);
            const epoch = resumed ? active.sessionEpoch : state.nextSessionEpoch + 1;
            state.nextSessionEpoch = Math.max(state.nextSessionEpoch, epoch);
            state.presence = {
                ownerServerId: serverId,
                sessionId: session,
                sessionEpoch: epoch,
                fencingEpoch: epoch,
                heartbeatAtUnixMs: at,
                expiresAtUnixMs: at + ttl
            };
            return { state, resultFactory(saved) {
                metrics.increment(takeover ? "financial_shadow_presence_takeover_total" :
                    resumed ? "financial_shadow_presence_resume_total" : "financial_shadow_presence_register_total");
                return serverEconomyPocReadonly({
                    status: takeover ? "taken_over" : resumed ? "resumed" : "registered",
                    ...serverEconomyPocClone(saved.presence)
                });
            } };
        });
    }

    async function heartbeatPresence({ playFabId, sessionId, sessionEpoch } = {}) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const session = exactIdentity(sessionId, "sessionId", 200);
        const epoch = serverEconomyPocPositive(sessionEpoch, "sessionEpoch");
        const at = nowValue(nowMilliseconds);
        return mutate(player, (state) => {
            assertPresence(state, { serverId, sessionId: session, sessionEpoch: epoch }, at);
            state.presence.heartbeatAtUnixMs = at;
            state.presence.expiresAtUnixMs = at + ttl;
            return { state, resultFactory(saved) {
                metrics.increment("financial_shadow_presence_heartbeat_total");
                return serverEconomyPocReadonly({ status: "renewed", ...serverEconomyPocClone(saved.presence) });
            } };
        });
    }

    function buildDelivery({ player, operationId, eventId, at, modeled, mismatch, type, sourceAttested, payload = {} }) {
        return {
            deliveryId: deliveryId(player, operationId),
            deliveryEpoch: 0,
            state: "Pending",
            type,
            operationId,
            eventId,
            createdAtUnixMs: at,
            claimedBySessionId: null,
            claimedBySessionEpoch: null,
            claimedAtUnixMs: null,
            ackedAtUnixMs: null,
            payload: {
                authoritative: false,
                sourceAttested,
                modelSnapshot: modeled,
                mismatch,
                ...payload
            }
        };
    }

    async function observe(playFabId, input, trustedIdentity = null) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const observation = validateFinancialShadowObservation(input, player);
        const started = monotonicMilliseconds();
        const at = nowValue(nowMilliseconds);
        const lag = operationLag(at, observation.occurredAtUnixMs);
        const result = await mutate(player, (state) => {
            assertPresence(state, { serverId, sessionId: observation.sessionId, sessionEpoch: observation.sessionEpoch }, at);
            const existing = state.observations.find((entry) => entry.operationId === observation.operationId);
            if (existing) {
                if (existing.immutableHash !== observation.immutableHash || existing.eventId !== observation.eventId) {
                    serverEconomyPocFail("FINANCIAL_SHADOW_IDEMPOTENCY_CONFLICT", "operationId is bound to another observation.", { statusCode: 409 });
                }
                const delivery = state.deliveries.find((entry) => entry.deliveryId === existing.deliveryId);
                metrics.increment("financial_shadow_observation_replay_total", 1, { kind: observation.kind });
                return { noChange: true, result: serverEconomyPocReadonly({
                    status: "replayed", authoritative: false, sourceAttested: false,
                    operationId: existing.operationId, eventId: existing.eventId,
                    modelSnapshot: delivery?.payload?.modelSnapshot || normalizeExpiredPremium(state.snapshot, at),
                    mismatch: existing.mismatch,
                    delivery: delivery && serverEconomyPocClone(delivery)
                }) };
            }
            if (state.observations.some((entry) => entry.eventId === observation.eventId)) {
                serverEconomyPocFail("FINANCIAL_SHADOW_EVENT_CONFLICT", "eventId is already bound to another operation.", { statusCode: 409 });
            }
            assertNotRetired(state, observation.operationId, observation.eventId);
            compactAcknowledged(state, historyLimit, metrics);
            const shadowBefore = serverEconomyPocClone(state.snapshot);
            let durableModeled;
            if (state.bootstrap === null) {
                if (observation.kind !== "snapshot_observation") {
                    serverEconomyPocFail("FINANCIAL_SHADOW_BOOTSTRAP_REQUIRED", "First Shadow observation must be an explicit snapshot bootstrap.", { statusCode: 409 });
                }
                durableModeled = bootstrapSnapshot(observation, at);
                state.snapshot = durableModeled;
                state.bootstrap = {
                    status: "client_observed_non_authoritative",
                    sourceAttested: false,
                    bootstrappedAtUnixMs: at,
                    snapshotDigest: createHash("sha256").update(JSON.stringify(durableModeled), "utf8").digest("hex"),
                    titlePlayerAccountDerived: Boolean(trustedIdentity?.titlePlayerAccountId)
                };
            } else {
                durableModeled = applyFinancialShadowObservation(state.snapshot, observation, at, observation.sessionEpoch);
                state.snapshot = durableModeled;
            }
            const modeled = observation.kind === "premium_observation"
                ? durableModeled
                : normalizeExpiredPremium(durableModeled, at);
            const domains = comparisonDomains(observation.kind);
            const mismatch = compareFinancialShadowSnapshot(modeled, observation.clientSnapshot, domains);
            const delivery = buildDelivery({
                player,
                operationId: observation.operationId,
                eventId: observation.eventId,
                at,
                modeled,
                mismatch,
                type: "observation_result",
                sourceAttested: false
            });
            const record = {
                operationId: observation.operationId,
                eventId: observation.eventId,
                immutableHash: observation.immutableHash,
                kind: observation.kind,
                observedAtUnixMs: at,
                deliveryId: delivery.deliveryId,
                mismatch,
                evidence: {
                    schemaVersion: 1,
                    user: {
                        playFabId: player,
                        titlePlayerAccountDerived: Boolean(trustedIdentity?.titlePlayerAccountId)
                    },
                    source: "unity_shadow_telemetry",
                    sourceAttested: false,
                    operation: {
                        operationId: observation.operationId,
                        eventId: observation.eventId,
                        kind: observation.kind,
                        reason: observation.reason,
                        contextId: observation.contextId,
                        occurredAtUnixMs: observation.occurredAtUnixMs,
                        effect: serverEconomyPocClone(observation.effect)
                    },
                    legacy: {
                        before: serverEconomyPocClone(observation.clientBeforeSnapshot),
                        after: serverEconomyPocClone(observation.clientSnapshot)
                    },
                    shadow: {
                        before: shadowBefore,
                        after: serverEconomyPocClone(modeled)
                    }
                }
            };
            state.observations.push(record);
            state.deliveries.push(delivery);
            recordDurableComparison(state, mismatch, lag, domains);
            return { state, resultFactory(saved) {
                recordProcessComparison(metrics, mismatch, lag, observation.kind, domains);
                metrics.increment("financial_shadow_observation_total", 1, { kind: observation.kind });
                if (observation.kind === "elite_ball_delta") {
                    metrics.increment("financial_shadow_elite_events_observed_total", observation.effect.eventCount);
                    metrics.increment("financial_shadow_elite_batch_total");
                }
                return serverEconomyPocReadonly({
                    status: "observed", authoritative: false, sourceAttested: false,
                    operationId: observation.operationId, eventId: observation.eventId,
                    modelSnapshot: modeled, mismatch,
                    delivery: saved.deliveries.find((entry) => entry.deliveryId === delivery.deliveryId)
                });
            } };
        });
        metrics.observe("financial_shadow_observe_duration_ms", Math.max(0, monotonicMilliseconds() - started), { kind: observation.kind });
        return result;
    }

    async function projectExternalPocOperation({ playFabId, operation, sequence } = {}) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        if (!(policy.allowlist instanceof Set) || !policy.allowlist.has(player)) {
            serverEconomyPocFail(
                "FINANCIAL_SHADOW_PLAYER_FORBIDDEN",
                "External Shadow projection is restricted to the configured allowlist.",
                { statusCode: 403 }
            );
        }
        const trustedOperation = canonicalExternalOperation(operation, player);
        return mutate(player, (state) => {
            const at = nowValue(nowMilliseconds);
            const presence = presenceCurrent(state, at);
            if (state.bootstrap === null) {
                serverEconomyPocFail("FINANCIAL_SHADOW_BOOTSTRAP_REQUIRED", "External Shadow projection requires explicit bootstrap.", { statusCode: 409 });
            }
            const activelyOwnedElsewhere = presence && presence.ownerServerId !== serverId;
            const offlineProjectionAllowed = !presence && allowOfflineSourceAttestedProjection === true &&
                player === offlineSourceAttestedPlayFabId &&
                state.bootstrap?.titlePlayerAccountDerived === true;
            if (activelyOwnedElsewhere || !presence && !offlineProjectionAllowed) {
                serverEconomyPocFail("FINANCIAL_SHADOW_EXTERNAL_PLAYER_OFFLINE", "External Shadow projection requires an active owned presence.", { retryable: true, statusCode: 409 });
            }
            const existing = state.observations.find((entry) => entry.operationId === trustedOperation.operationId);
            if (existing) {
                if (existing.immutableHash !== trustedOperation.immutableHash) {
                    serverEconomyPocFail("FINANCIAL_SHADOW_IDEMPOTENCY_CONFLICT", "External operationId is bound to another projection.", { statusCode: 409 });
                }
                return { noChange: true, result: serverEconomyPocReadonly({ status: "replayed", deliveryId: existing.deliveryId }) };
            }
            if (state.observations.some((entry) => entry.eventId === trustedOperation.eventId)) {
                serverEconomyPocFail("FINANCIAL_SHADOW_EVENT_CONFLICT", "External eventId is already bound to another projection.", { statusCode: 409 });
            }
            assertNotRetired(state, trustedOperation.operationId, trustedOperation.eventId);
            compactAcknowledged(state, historyLimit, metrics);
            let projectionFencingEpoch = presence?.fencingEpoch;
            if (!presence) {
                const expiredPresenceEpoch = Number.isSafeInteger(state.presence?.fencingEpoch)
                    ? state.presence.fencingEpoch : 0;
                projectionFencingEpoch = Math.max(
                    state.nextSessionEpoch,
                    state.snapshot.fencingEpoch,
                    expiredPresenceEpoch
                ) + 1;
                state.nextSessionEpoch = projectionFencingEpoch;
                state.presence = null;
            }
            const shadowBefore = normalizeExpiredPremium(state.snapshot, at);
            const effectiveAt = serverEconomyPocNonNegative(trustedOperation.createdAtUnixMs, "external effective time");
            const applied = applyServerEconomyPocHighValueOperation(
                state.snapshot,
                trustedOperation,
                serverEconomyPocPositive(sequence, "external operation sequence"),
                effectiveAt,
                projectionFencingEpoch
            );
            const durableSnapshot = serverEconomyPocClone(applied.snapshot);
            durableSnapshot.updatedAtUnixMs = Math.max(state.snapshot.updatedAtUnixMs, at);
            validateServerEconomyPocSnapshot(durableSnapshot, player);
            state.snapshot = serverEconomyPocReadonly(durableSnapshot);
            const modeled = normalizeExpiredPremium(state.snapshot, at);
            const mismatch = compareFinancialShadowSnapshot(modeled, modeled);
            const delivery = buildDelivery({
                player,
                operationId: trustedOperation.operationId,
                eventId: trustedOperation.eventId,
                at,
                modeled,
                mismatch,
                type: "financial_operation",
                sourceAttested: true,
                payload: {
                    operation: serverEconomyPocClone(trustedOperation),
                    projectionResult: applied.result,
                    consumptionMode: presence ? "online" : "offline"
                }
            });
            state.observations.push({
                operationId: trustedOperation.operationId,
                eventId: trustedOperation.eventId,
                immutableHash: trustedOperation.immutableHash,
                kind: "external_poc_operation",
                observedAtUnixMs: at,
                deliveryId: delivery.deliveryId,
                mismatch,
                evidence: {
                    schemaVersion: 1,
                    user: { playFabId: player, titlePlayerAccountDerived: true },
                    source: "canonical_poc_shadow_mirror",
                    sourceAttested: true,
                    consumptionMode: presence ? "online" : "offline",
                    operation: {
                        operationId: trustedOperation.operationId,
                        eventId: trustedOperation.eventId,
                        kind: trustedOperation.kind,
                        reason: trustedOperation.reason,
                        occurredAtUnixMs: trustedOperation.createdAtUnixMs,
                        effect: { diamonds: trustedOperation.diamonds, eliteBall: trustedOperation.eliteBall, premium: trustedOperation.premium }
                    },
                    legacy: { before: null, after: null },
                    shadow: { before: shadowBefore, after: serverEconomyPocClone(modeled) }
                }
            });
            state.deliveries.push(delivery);
            return { state, resultFactory(saved) {
                metrics.increment("financial_shadow_external_projection_total");
                metrics.increment(presence
                    ? "financial_shadow_external_online_projection_total"
                    : "financial_shadow_external_offline_projection_total");
                return serverEconomyPocReadonly({
                    status: "projected", delivery: saved.deliveries.find((entry) => entry.deliveryId === delivery.deliveryId),
                    modelSnapshot: modeled,
                    consumptionMode: presence ? "online" : "offline"
                });
            } };
        });
    }

    async function claimInbox({ playFabId, sessionId, sessionEpoch, limit = 20 } = {}) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const session = exactIdentity(sessionId, "sessionId", 200);
        const epoch = serverEconomyPocPositive(sessionEpoch, "sessionEpoch");
        const maximum = serverEconomyPocPositive(limit, "inbox limit");
        if (maximum > 100) throw new TypeError("Financial Shadow inbox limit exceeds 100.");
        const at = nowValue(nowMilliseconds);
        return mutate(player, (state) => {
            assertPresence(state, { serverId, sessionId: session, sessionEpoch: epoch }, at);
            const candidates = state.deliveries.filter((entry) => entry.state !== "Acked").slice(0, maximum);
            let changed = false;
            for (const entry of candidates) {
                if (entry.state !== "Claimed" || entry.claimedBySessionId !== session || entry.claimedBySessionEpoch !== epoch) {
                    entry.state = "Claimed";
                    entry.deliveryEpoch += 1;
                    entry.claimedBySessionId = session;
                    entry.claimedBySessionEpoch = epoch;
                    entry.claimedAtUnixMs = at;
                    changed = true;
                }
            }
            const resultFactory = (saved) => serverEconomyPocReadonly({
                status: "claimed",
                deliveries: saved.deliveries.filter((entry) => candidates.some((candidate) => candidate.deliveryId === entry.deliveryId))
            });
            if (!changed) return { noChange: true, result: resultFactory(state) };
            return { state, resultFactory(saved) {
                metrics.increment("financial_shadow_delivery_claim_total", candidates.length);
                return resultFactory(saved);
            } };
        });
    }

    async function ackDelivery({ playFabId, sessionId, sessionEpoch, deliveryId: rawDeliveryId, deliveryEpoch } = {}) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const session = exactIdentity(sessionId, "sessionId", 200);
        const epoch = serverEconomyPocPositive(sessionEpoch, "sessionEpoch");
        const id = exactIdentity(rawDeliveryId, "deliveryId", 200);
        const claimEpoch = serverEconomyPocPositive(deliveryEpoch, "deliveryEpoch");
        const at = nowValue(nowMilliseconds);
        return mutate(player, (state) => {
            assertPresence(state, { serverId, sessionId: session, sessionEpoch: epoch }, at);
            const delivery = state.deliveries.find((entry) => entry.deliveryId === id);
            if (!delivery) serverEconomyPocFail("FINANCIAL_SHADOW_DELIVERY_NOT_FOUND", "Shadow delivery does not exist.", { statusCode: 404 });
            const identityMatches = delivery.deliveryEpoch === claimEpoch &&
                delivery.claimedBySessionId === session && delivery.claimedBySessionEpoch === epoch;
            if (delivery.state === "Acked") {
                if (!identityMatches) serverEconomyPocFail("FINANCIAL_SHADOW_STALE_ACK", "ACK belongs to a stale delivery claim.", { statusCode: 409 });
                metrics.increment("financial_shadow_delivery_ack_replay_total");
                return { noChange: true, result: serverEconomyPocReadonly({ status: "already_acked", deliveryId: id, deliveryEpoch: claimEpoch }) };
            }
            if (delivery.state !== "Claimed" || !identityMatches) {
                serverEconomyPocFail("FINANCIAL_SHADOW_STALE_ACK", "ACK belongs to an absent or stale delivery claim.", { statusCode: 409 });
            }
            delivery.state = "Acked";
            delivery.ackedAtUnixMs = at;
            return { state, resultFactory() {
                metrics.increment("financial_shadow_delivery_ack_total");
                return serverEconomyPocReadonly({ status: "acked", deliveryId: id, deliveryEpoch: claimEpoch });
            } };
        });
    }

    async function diagnostics(playFabId) {
        const player = exactIdentity(playFabId, "playFabId", 160);
        const state = await readState(player);
        return serverEconomyPocReadonly({
            schemaVersion: 1,
            authoritative: false,
            sourceAttested: false,
            durable: state ? state.diagnostics : initialDiagnostics(),
            bootstrap: state?.bootstrap || { status: "required", sourceAttested: false },
            process: metrics.contractSnapshot(),
            cache: { entryCount: snapshotCache.size() }
        });
    }

    async function health() {
        const durable = stateStore.durable === true;
        const redis = await stateStore.ping().catch(() => false);
        return serverEconomyPocReadonly({
            healthy: durable && redis,
            enabled: true,
            authoritative: false,
            targetPlayFabWritesAllowed: false,
            durable,
            redis,
            serverId
        });
    }

    return Object.freeze({
        getSnapshot,
        registerPresence,
        heartbeatPresence,
        observe,
        projectExternalPocOperation,
        claimInbox,
        ackDelivery,
        diagnostics,
        health,
        metricsSnapshot: () => metrics.snapshot(),
        contractMetricsSnapshot: () => metrics.contractSnapshot(),
        stores: Object.freeze({ stateStore }),
        authoritative: false,
        targetPlayFabWritesAllowed: false,
        sourceAttested: false,
        distributedPresence: stateStore.durable === true,
        durableAck: stateStore.durable === true,
        offlineSourceAttestedProjection: allowOfflineSourceAttestedProjection === true,
        eliteBatchMaximumEvents: 500,
        serverId
    });
}
