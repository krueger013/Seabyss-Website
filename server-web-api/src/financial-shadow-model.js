import {
    createServerEconomyPocInitialSnapshot,
    serverEconomyPocClone,
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";

const OBSERVATION_FIELDS = Object.freeze([
    "clientBeforeSnapshot", "clientSnapshot", "contextId", "effect", "eventId", "kind",
    "occurredAtUnixMs", "operationId", "reason", "schemaVersion", "sessionEpoch", "sessionId"
]);
const CLIENT_SNAPSHOT_FIELDS = Object.freeze([
    "ammoAppliedThroughSequence", "diamonds", "eliteBall", "fencingEpoch",
    "highValueAppliedThroughSequence", "premium", "revision", "schemaVersion", "updatedAtUnixMs"
]);
const PREMIUM_FIELDS = Object.freeze(["activatedAtUnixMs", "expiresAtUnixMs", "tier"]);
const PREMIUM_EFFECT_FIELDS = Object.freeze(["durationSeconds", "effectiveAtUnixMs", "tier"]);
const KINDS = Object.freeze([
    "diamonds_delta", "elite_ball_delta", "premium_observation", "snapshot_observation"
]);

function exact(value, fields, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", `${name} has unknown or missing members.`, { statusCode: 400 });
    }
}

function signed(value, name) {
    if (!Number.isSafeInteger(value) || value === 0) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", `${name} must be a non-zero safe integer.`, { statusCode: 400 });
    }
    return value;
}

function nullableTime(value, name) {
    if (value === null) return null;
    return serverEconomyPocNonNegative(value, name);
}

function premium(value) {
    exact(value, PREMIUM_FIELDS, "premium");
    if (!Number.isSafeInteger(value.tier) || value.tier < 0 || value.tier > 3) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "premium.tier is invalid.", { statusCode: 400 });
    }
    const normalized = {
        tier: value.tier,
        activatedAtUnixMs: nullableTime(value.activatedAtUnixMs, "premium.activatedAtUnixMs"),
        expiresAtUnixMs: nullableTime(value.expiresAtUnixMs, "premium.expiresAtUnixMs")
    };
    if (normalized.tier === 0 && (normalized.activatedAtUnixMs !== null || normalized.expiresAtUnixMs !== null) ||
        normalized.tier > 0 && (normalized.activatedAtUnixMs === null || normalized.expiresAtUnixMs === null ||
            normalized.expiresAtUnixMs <= normalized.activatedAtUnixMs)) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "premium state is inconsistent.", { statusCode: 400 });
    }
    return serverEconomyPocReadonly(normalized);
}

function premiumEffect(value) {
    exact(value, PREMIUM_EFFECT_FIELDS, "Premium effect");
    if (!Number.isSafeInteger(value.tier) || value.tier < 1 || value.tier > 3 ||
        !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds <= 0 ||
        value.durationSeconds > 10 * 366 * 24 * 60 * 60) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "Premium semantic grant is invalid.", { statusCode: 400 });
    }
    return serverEconomyPocReadonly({
        tier: value.tier,
        durationSeconds: value.durationSeconds,
        effectiveAtUnixMs: serverEconomyPocNonNegative(value.effectiveAtUnixMs, "premium.effectiveAtUnixMs")
    });
}

function effect(kind, value) {
    if (kind === "diamonds_delta") {
        exact(value, ["diamondsDelta"], "diamonds effect");
        return serverEconomyPocReadonly({ diamondsDelta: signed(value.diamondsDelta, "diamondsDelta") });
    }
    if (kind === "elite_ball_delta") {
        exact(value, ["eliteBallDelta", "eventCount"], "elite ball effect");
        const count = value.eventCount;
        if (!Number.isSafeInteger(count) || count <= 0 || count > 500) {
            serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "eventCount must be between 1 and 500.", { statusCode: 400 });
        }
        return serverEconomyPocReadonly({
            eliteBallDelta: signed(value.eliteBallDelta, "eliteBallDelta"),
            eventCount: count
        });
    }
    if (kind === "premium_observation") return premiumEffect(value);
    exact(value, [], "snapshot observation effect");
    return Object.freeze({});
}

export function validateFinancialShadowClientSnapshot(value, playFabId) {
    exact(value, CLIENT_SNAPSHOT_FIELDS, "clientSnapshot");
    const complete = { ...serverEconomyPocClone(value), playFabId: serverEconomyPocId(playFabId, "playFabId", 160) };
    validateServerEconomyPocSnapshot(complete, playFabId);
    return serverEconomyPocReadonly(complete);
}

export function validateFinancialShadowObservation(value, playFabId) {
    exact(value, OBSERVATION_FIELDS, "Financial Shadow observation");
    if (value.schemaVersion !== 1 || !KINDS.includes(value.kind)) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "Observation schemaVersion or kind is invalid.", { statusCode: 400 });
    }
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    const normalized = {
        schemaVersion: 1,
        playFabId: player,
        sessionId: serverEconomyPocId(value.sessionId, "sessionId", 200),
        sessionEpoch: value.sessionEpoch,
        operationId: serverEconomyPocId(value.operationId, "operationId", 200),
        eventId: serverEconomyPocId(value.eventId, "eventId", 200),
        kind: value.kind,
        reason: serverEconomyPocId(value.reason, "reason", 120),
        contextId: serverEconomyPocId(value.contextId, "contextId", 200),
        occurredAtUnixMs: serverEconomyPocNonNegative(value.occurredAtUnixMs, "occurredAtUnixMs"),
        effect: effect(value.kind, value.effect),
        clientBeforeSnapshot: validateFinancialShadowClientSnapshot(value.clientBeforeSnapshot, player),
        clientSnapshot: validateFinancialShadowClientSnapshot(value.clientSnapshot, player)
    };
    if (!Number.isSafeInteger(normalized.sessionEpoch) || normalized.sessionEpoch <= 0) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "sessionEpoch is invalid.", { statusCode: 400 });
    }
    return serverEconomyPocReadonly({
        ...normalized,
        immutableHash: serverEconomyPocDigest({
            schemaVersion: normalized.schemaVersion,
            playFabId: normalized.playFabId,
            operationId: normalized.operationId,
            eventId: normalized.eventId,
            kind: normalized.kind,
            reason: normalized.reason,
            contextId: normalized.contextId,
            occurredAtUnixMs: normalized.occurredAtUnixMs,
            effect: normalized.effect,
            clientBeforeSnapshot: normalized.clientBeforeSnapshot,
            clientSnapshot: normalized.clientSnapshot
        })
    });
}

function safeAdd(current, delta, code) {
    const next = current + delta;
    if (!Number.isSafeInteger(next) || next < 0) {
        serverEconomyPocFail(code, "Shadow observation would underflow or overflow the modeled state.", { statusCode: 409 });
    }
    return next;
}

function applyPremiumGrant(current, grant) {
    const durationMilliseconds = grant.durationSeconds * 1000;
    const active = current.tier > 0 && current.expiresAtUnixMs > grant.effectiveAtUnixMs;
    const base = active ? current.expiresAtUnixMs : grant.effectiveAtUnixMs;
    const expiresAtUnixMs = base + durationMilliseconds;
    if (!Number.isSafeInteger(durationMilliseconds) || !Number.isSafeInteger(expiresAtUnixMs)) {
        serverEconomyPocFail("FINANCIAL_SHADOW_PREMIUM_RANGE", "Premium semantic grant overflows modeled UTC time.", { statusCode: 409 });
    }
    return {
        tier: active ? Math.max(current.tier, grant.tier) : grant.tier,
        activatedAtUnixMs: active ? current.activatedAtUnixMs : grant.effectiveAtUnixMs,
        expiresAtUnixMs
    };
}

export function applyFinancialShadowObservation(currentSnapshot, observation, nowUnixMs, fencingEpoch) {
    validateServerEconomyPocSnapshot(currentSnapshot, observation.playFabId);
    const next = serverEconomyPocClone(currentSnapshot);
    if (observation.kind === "diamonds_delta") {
        next.diamonds = safeAdd(next.diamonds, observation.effect.diamondsDelta, "FINANCIAL_SHADOW_DIAMONDS_RANGE");
    } else if (observation.kind === "elite_ball_delta") {
        next.eliteBall = safeAdd(next.eliteBall, observation.effect.eliteBallDelta, "FINANCIAL_SHADOW_ELITE_RANGE");
        next.ammoAppliedThroughSequence += observation.effect.eventCount;
    } else if (observation.kind === "premium_observation") {
        next.premium = applyPremiumGrant(next.premium, observation.effect);
    }
    next.revision += 1;
    next.fencingEpoch = fencingEpoch;
    next.updatedAtUnixMs = Math.max(next.updatedAtUnixMs, nowUnixMs);
    validateServerEconomyPocSnapshot(next, observation.playFabId);
    return serverEconomyPocReadonly(next);
}

function compareField(fields, path, expected, observed) {
    if (JSON.stringify(expected) === JSON.stringify(observed)) return;
    fields.push(Object.freeze({ path, expected: serverEconomyPocClone(expected), observed: serverEconomyPocClone(observed) }));
}

export function compareFinancialShadowSnapshot(
    modelSnapshot,
    clientSnapshot,
    comparedDomains = ["Diamonds", "Elite", "Premium"]
) {
    validateServerEconomyPocSnapshot(modelSnapshot);
    validateServerEconomyPocSnapshot(clientSnapshot, modelSnapshot.playFabId);
    const scope = new Set(comparedDomains);
    if ([...scope].some(domain => !["Diamonds", "Elite", "Premium"].includes(domain))) {
        serverEconomyPocFail("FINANCIAL_SHADOW_SCHEMA_INVALID", "Comparison domain scope is invalid.");
    }
    const structuralFields = [];
    for (const path of [
        "schemaVersion", "revision", "fencingEpoch", "highValueAppliedThroughSequence",
        "ammoAppliedThroughSequence", "updatedAtUnixMs"
    ]) compareField(structuralFields, path, modelSnapshot[path], clientSnapshot[path]);
    const economicFields = [];
    if (scope.has("Diamonds")) compareField(economicFields, "diamonds", modelSnapshot.diamonds, clientSnapshot.diamonds);
    if (scope.has("Elite")) compareField(economicFields, "eliteBall", modelSnapshot.eliteBall, clientSnapshot.eliteBall);
    if (scope.has("Premium")) compareField(economicFields, "premium", modelSnapshot.premium, clientSnapshot.premium);
    const domainMatches = {
        Diamonds: !economicFields.some((field) => field.path === "diamonds"),
        Elite: !economicFields.some((field) => field.path === "eliteBall"),
        Premium: !economicFields.some((field) => field.path === "premium")
    };
    let severity = "none";
    if (!domainMatches.Premium ||
        Math.abs(modelSnapshot.diamonds - clientSnapshot.diamonds) >= 100 ||
        Math.abs(modelSnapshot.eliteBall - clientSnapshot.eliteBall) >= 1000) severity = "critical";
    else if (economicFields.length > 0) severity = "warning";
    return serverEconomyPocReadonly({
        severity,
        economicMatch: economicFields.length === 0,
        domainMatches,
        fields: [...economicFields, ...structuralFields],
        economicFields,
        structuralFields,
        mismatchDigest: serverEconomyPocDigest({ economicFields, structuralFields })
    });
}

export function createFinancialShadowInitialSnapshot(playFabId, nowUnixMs = 0) {
    return createServerEconomyPocInitialSnapshot(playFabId, nowUnixMs);
}

export function createFinancialShadowMetrics() {
    const counters = new Map();
    const timings = new Map();
    function increment(name, value = 1, labels = {}) {
        if (typeof name !== "string" || !Number.isFinite(value)) return;
        const key = `${name}:${JSON.stringify(Object.entries(labels).sort())}`;
        counters.set(key, (counters.get(key) || 0) + value);
    }
    function observe(name, value, labels = {}) {
        if (typeof name !== "string" || !Number.isFinite(value)) return;
        const key = `${name}:${JSON.stringify(Object.entries(labels).sort())}`;
        const previous = timings.get(key) || { count: 0, total: 0, maximum: 0 };
        timings.set(key, {
            count: previous.count + 1,
            total: previous.total + value,
            maximum: Math.max(previous.maximum, value)
        });
    }
    function snapshot() {
        return serverEconomyPocReadonly({
            counters: Object.fromEntries([...counters.entries()].sort()),
            timings: Object.fromEntries([...timings.entries()].sort())
        });
    }
    function count(name) { return counters.get(`${name}:[]`) || 0; }
    function timing(name) { return timings.get(`${name}:[]`) || { count: 0, total: 0, maximum: 0 }; }
    function contractSnapshot() {
        return serverEconomyPocReadonly({
            shadow_compare_count: count("shadow_compare_count"),
            shadow_match_count: count("shadow_match_count"),
            shadow_mismatch_count: count("shadow_mismatch_count"),
            shadow_mismatch_diamonds: count("shadow_mismatch_diamonds"),
            shadow_mismatch_elite: count("shadow_mismatch_elite"),
            shadow_mismatch_premium: count("shadow_mismatch_premium"),
            shadow_operation_count: count("shadow_operation_count"),
            shadow_operation_lag: timing("shadow_operation_lag"),
            shadow_snapshot_count: count("shadow_snapshot_count"),
            shadow_snapshot_latency: timing("shadow_snapshot_latency")
        });
    }
    return Object.freeze({ increment, observe, snapshot, contractSnapshot });
}

export function createFinancialShadowSnapshotCache({
    ttlMilliseconds = 2000,
    maximumEntries = 1000,
    nowMilliseconds = () => Date.now(),
    metrics = createFinancialShadowMetrics()
} = {}) {
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0 ||
        !Number.isSafeInteger(maximumEntries) || maximumEntries <= 0 ||
        typeof nowMilliseconds !== "function") throw new TypeError("Financial Shadow cache configuration is invalid.");
    const values = new Map();
    function get(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const entry = values.get(player);
        if (!entry || entry.expiresAtUnixMs <= nowMilliseconds()) {
            if (entry) values.delete(player);
            metrics.increment("financial_shadow_cache_miss_total");
            return null;
        }
        metrics.increment("financial_shadow_cache_hit_total");
        return serverEconomyPocReadonly(entry.snapshot);
    }
    function set(playFabId, snapshot) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        validateServerEconomyPocSnapshot(snapshot, player);
        if (values.size >= maximumEntries && !values.has(player)) values.delete(values.keys().next().value);
        values.set(player, { snapshot: serverEconomyPocReadonly(snapshot), expiresAtUnixMs: nowMilliseconds() + ttlMilliseconds });
    }
    function invalidate(playFabId) { values.delete(serverEconomyPocId(playFabId, "playFabId", 160)); }
    return Object.freeze({ get, set, invalidate, size: () => values.size });
}
