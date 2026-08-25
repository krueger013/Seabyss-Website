import { createHash } from "node:crypto";

export const SERVER_ECONOMY_POC_SCHEMA_VERSION = 1;
export const SERVER_ECONOMY_POC_PREMIUM_TIERS = Object.freeze({
    bronze: 1,
    silver: 2,
    gold: 3
});

export class ServerEconomyPocError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "ServerEconomyPocError";
        this.code = code;
        this.retryable = options.retryable === true;
        this.statusCode = options.statusCode || 500;
        this.details = options.details || null;
    }
}

export function serverEconomyPocFail(code, message, options) {
    throw new ServerEconomyPocError(code, message, options);
}

export function serverEconomyPocId(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        serverEconomyPocFail("POC_INVALID_ARGUMENT", `${name} is invalid.`, { statusCode: 400 });
    }
    return value;
}

export function serverEconomyPocText(value, name, maximumLength = 512) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        serverEconomyPocFail("POC_INVALID_ARGUMENT", `${name} is invalid.`, { statusCode: 400 });
    }
    return value;
}

export function serverEconomyPocNonNegative(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        serverEconomyPocFail("POC_INVALID_ARGUMENT", `${name} must be a non-negative safe integer.`, { statusCode: 400 });
    }
    return value;
}

export function serverEconomyPocPositive(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        serverEconomyPocFail("POC_INVALID_ARGUMENT", `${name} must be a positive safe integer.`, { statusCode: 400 });
    }
    return value;
}

export function serverEconomyPocClone(value) {
    return structuredClone(value);
}

function freezeDeep(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
    return value;
}

export function serverEconomyPocReadonly(value) {
    return freezeDeep(serverEconomyPocClone(value));
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort()
            .map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

export function serverEconomyPocDigest(value) {
    return createHash("sha256")
        .update(JSON.stringify(canonicalize(value)), "utf8")
        .digest("hex");
}

export function createServerEconomyPocInitialSnapshot(playFabId, nowUnixMs = 0) {
    serverEconomyPocId(playFabId, "playFabId", 160);
    serverEconomyPocNonNegative(nowUnixMs, "nowUnixMs");
    return serverEconomyPocReadonly({
        schemaVersion: SERVER_ECONOMY_POC_SCHEMA_VERSION,
        playFabId,
        revision: 0,
        fencingEpoch: 0,
        diamonds: 0,
        eliteBall: 0,
        premium: {
            tier: 0,
            activatedAtUnixMs: null,
            expiresAtUnixMs: null
        },
        highValueAppliedThroughSequence: 0,
        ammoAppliedThroughSequence: 0,
        updatedAtUnixMs: nowUnixMs
    });
}

export function validateServerEconomyPocSnapshot(value, expectedPlayFabId = null) {
    const exactRootKeys = "ammoAppliedThroughSequence,diamonds,eliteBall,fencingEpoch,highValueAppliedThroughSequence,playFabId,premium,revision,schemaVersion,updatedAtUnixMs";
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== exactRootKeys) {
        serverEconomyPocFail("POC_SNAPSHOT_CORRUPT", "Server economy snapshot members are not the exact V1 contract.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        value.schemaVersion !== SERVER_ECONOMY_POC_SCHEMA_VERSION) {
        serverEconomyPocFail("POC_SNAPSHOT_CORRUPT", "Server economy snapshot schema is invalid.");
    }
    const playFabId = serverEconomyPocId(value.playFabId, "snapshot.playFabId", 160);
    if (expectedPlayFabId !== null && playFabId !== expectedPlayFabId) {
        serverEconomyPocFail("POC_IDENTITY_MISMATCH", "Server economy snapshot belongs to another player.");
    }
    for (const [name, amount] of [
        ["revision", value.revision],
        ["fencingEpoch", value.fencingEpoch],
        ["diamonds", value.diamonds],
        ["eliteBall", value.eliteBall],
        ["highValueAppliedThroughSequence", value.highValueAppliedThroughSequence],
        ["ammoAppliedThroughSequence", value.ammoAppliedThroughSequence],
        ["updatedAtUnixMs", value.updatedAtUnixMs]
    ]) serverEconomyPocNonNegative(amount, `snapshot.${name}`);
    const premium = value.premium;
    if (!premium || typeof premium !== "object" || Array.isArray(premium) ||
        !Number.isSafeInteger(premium.tier) || premium.tier < 0 || premium.tier > 3) {
        serverEconomyPocFail("POC_SNAPSHOT_CORRUPT", "Premium snapshot is invalid.");
    }
    if (Object.keys(premium).sort().join(",") !== "activatedAtUnixMs,expiresAtUnixMs,tier") {
        serverEconomyPocFail("POC_SNAPSHOT_CORRUPT", "Premium snapshot members are not the exact V1 contract.");
    }

    if (premium.tier === 0) {
        if (premium.activatedAtUnixMs !== null || premium.expiresAtUnixMs !== null) {
            serverEconomyPocFail("POC_SNAPSHOT_CORRUPT", "Inactive Premium timestamps are invalid.");
        }
    } else {
        serverEconomyPocNonNegative(premium.activatedAtUnixMs, "premium.activatedAtUnixMs");
        serverEconomyPocPositive(premium.expiresAtUnixMs, "premium.expiresAtUnixMs");
        if (premium.expiresAtUnixMs <= premium.activatedAtUnixMs) {
            serverEconomyPocFail("POC_SNAPSHOT_CORRUPT", "Premium expiration is invalid.");
        }
    }
    return value;
}

function premiumTier(value) {
    if (typeof value === "string" && Object.hasOwn(SERVER_ECONOMY_POC_PREMIUM_TIERS, value)) {
        return SERVER_ECONOMY_POC_PREMIUM_TIERS[value];
    }
    if (Number.isSafeInteger(value) && value >= 1 && value <= 3) return value;
    serverEconomyPocFail("POC_INVALID_PREMIUM", "Premium tier must be bronze, silver, gold, or 1..3.", { statusCode: 400 });
}

export function createServerEconomyPocXsollaOperation({
    playFabId,
    operationId,
    eventId,
    diamonds,
    eliteBall,
    premium,
    reason = "xsolla_entitlement",
    createdAtUnixMs
} = {}) {
    const immutable = {
        schemaVersion: SERVER_ECONOMY_POC_SCHEMA_VERSION,
        kind: "xsolla_entitlement",
        playFabId: serverEconomyPocId(playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(operationId, "operationId", 200),
        eventId: serverEconomyPocId(eventId, "eventId", 200),
        reason: serverEconomyPocId(reason, "reason", 160),
        diamonds: serverEconomyPocPositive(diamonds, "diamonds"),
        eliteBall: serverEconomyPocPositive(eliteBall, "eliteBall"),
        premium: {
            tier: premiumTier(premium?.tier),
            durationSeconds: serverEconomyPocPositive(premium?.durationSeconds, "premium.durationSeconds")
        },
        createdAtUnixMs: serverEconomyPocNonNegative(createdAtUnixMs, "createdAtUnixMs")
    };
    const maximumDurationSeconds = 10 * 366 * 24 * 60 * 60;
    if (immutable.premium.durationSeconds > maximumDurationSeconds) {
        serverEconomyPocFail("POC_INVALID_PREMIUM", "Premium duration exceeds the POC safety bound.", { statusCode: 400 });
    }
    return serverEconomyPocReadonly({
        ...immutable,
        immutableHash: serverEconomyPocDigest(immutable)
    });
}

export function createServerEconomyPocAmmoEvent({
    playFabId,
    eventId,
    delta,
    reason,
    createdAtUnixMs
} = {}) {
    const immutable = {
        schemaVersion: SERVER_ECONOMY_POC_SCHEMA_VERSION,
        kind: "elite_ball_delta",
        playFabId: serverEconomyPocId(playFabId, "playFabId", 160),
        eventId: serverEconomyPocId(eventId, "eventId", 200),
        reason: serverEconomyPocId(reason, "reason", 160),
        delta,
        createdAtUnixMs: serverEconomyPocNonNegative(createdAtUnixMs, "createdAtUnixMs")
    };
    if (!Number.isSafeInteger(delta) || delta === 0) {
        serverEconomyPocFail("POC_INVALID_AMMO_DELTA", "Elite Ball delta must be a non-zero safe integer.", { statusCode: 400 });
    }
    return serverEconomyPocReadonly({
        ...immutable,
        immutableHash: serverEconomyPocDigest(immutable)
    });
}

export function applyServerEconomyPocXsollaOperation(snapshot, operation, sequence, nowUnixMs, fencingEpoch) {
    validateServerEconomyPocSnapshot(snapshot, operation.playFabId);
    serverEconomyPocPositive(sequence, "operation sequence");
    serverEconomyPocNonNegative(nowUnixMs, "nowUnixMs");
    serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
    if (sequence !== snapshot.highValueAppliedThroughSequence + 1) {
        serverEconomyPocFail("POC_OPERATION_ORDER_CONFLICT", "High-value operations must be applied in sequence.", { retryable: true });
    }
    const diamonds = snapshot.diamonds + operation.diamonds;
    const eliteBall = snapshot.eliteBall + operation.eliteBall;
    if (!Number.isSafeInteger(diamonds) || !Number.isSafeInteger(eliteBall)) {
        serverEconomyPocFail("POC_BALANCE_OVERFLOW", "High-value operation would overflow a balance.");
    }
    const durationMilliseconds = operation.premium.durationSeconds * 1000;
    if (!Number.isSafeInteger(durationMilliseconds)) {
        serverEconomyPocFail("POC_PREMIUM_OVERFLOW", "Premium duration is not representable.");
    }
    const currentlyActive = snapshot.premium.tier > 0 && snapshot.premium.expiresAtUnixMs > nowUnixMs;
    const premiumBase = currentlyActive ? snapshot.premium.expiresAtUnixMs : nowUnixMs;
    const expiresAtUnixMs = premiumBase + durationMilliseconds;
    if (!Number.isSafeInteger(expiresAtUnixMs)) {
        serverEconomyPocFail("POC_PREMIUM_OVERFLOW", "Premium expiration is not representable.");
    }
    const next = {
        ...serverEconomyPocClone(snapshot),
        revision: snapshot.revision + 1,
        fencingEpoch,
        diamonds,
        eliteBall,
        premium: {
            tier: currentlyActive
                ? Math.max(snapshot.premium.tier, operation.premium.tier)
                : operation.premium.tier,
            activatedAtUnixMs: currentlyActive ? snapshot.premium.activatedAtUnixMs : nowUnixMs,
            expiresAtUnixMs
        },
        highValueAppliedThroughSequence: sequence,
        updatedAtUnixMs: nowUnixMs
    };
    validateServerEconomyPocSnapshot(next, operation.playFabId);
    return serverEconomyPocReadonly({
        snapshot: next,
        result: {
            status: "applied",
            operationId: operation.operationId,
            eventId: operation.eventId,
            sequence,
            diamondsAdded: operation.diamonds,
            eliteBallAdded: operation.eliteBall,
            premium: next.premium,
            revision: next.revision
        }
    });
}

export function applyServerEconomyPocAmmoBatch(snapshot, events, nowUnixMs, fencingEpoch) {
    validateServerEconomyPocSnapshot(snapshot);
    serverEconomyPocNonNegative(nowUnixMs, "nowUnixMs");
    serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
    if (!Array.isArray(events) || events.length === 0) {
        serverEconomyPocFail("POC_EMPTY_AMMO_BATCH", "Ammo flush requires at least one event.");
    }
    let eliteBall = snapshot.eliteBall;
    let expectedSequence = snapshot.ammoAppliedThroughSequence + 1;
    let aggregateDelta = 0;
    let requestedAggregateDelta = 0;
    const rejectedEventIds = [];
    for (const event of events) {
        if (event.playFabId !== snapshot.playFabId || event.sequence !== expectedSequence ||
            !Number.isSafeInteger(event.delta) || event.delta === 0) {
            serverEconomyPocFail("POC_WAL_SEQUENCE_CONFLICT", "Ammo WAL is not contiguous or valid.");
        }
        const candidate = eliteBall + event.delta;
        requestedAggregateDelta += event.delta;
        if (!Number.isSafeInteger(candidate) || !Number.isSafeInteger(requestedAggregateDelta)) {
            serverEconomyPocFail("POC_BALANCE_OVERFLOW", "Ammo batch would overflow a balance.");
        }
        if (candidate < 0) {
            rejectedEventIds.push(event.eventId);
            expectedSequence += 1;
            continue;
        }
        eliteBall = candidate;
        aggregateDelta += event.delta;
        if (!Number.isSafeInteger(aggregateDelta)) {
            serverEconomyPocFail("POC_BALANCE_OVERFLOW", "Ammo batch aggregate would overflow.");
        }
        expectedSequence += 1;
    }
    const throughSequence = events.at(-1).sequence;
    const next = {
        ...serverEconomyPocClone(snapshot),
        revision: snapshot.revision + 1,
        fencingEpoch,
        eliteBall,
        ammoAppliedThroughSequence: throughSequence,
        updatedAtUnixMs: nowUnixMs
    };
    validateServerEconomyPocSnapshot(next, snapshot.playFabId);
    return serverEconomyPocReadonly({
        snapshot: next,
        result: {
            status: "flushed",
            eventCount: events.length,
            aggregateDelta,
            requestedAggregateDelta,
            rejectedEventIds,
            rejectedEventCount: rejectedEventIds.length,
            throughSequence,
            eliteBall,
            revision: next.revision
        }
    });
}
