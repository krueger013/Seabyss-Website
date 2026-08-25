import {
    SERVER_ECONOMY_POC_PREMIUM_TIERS,
    SERVER_ECONOMY_POC_SCHEMA_VERSION,
    createServerEconomyPocAmmoEvent,
    createServerEconomyPocInitialSnapshot,
    applyServerEconomyPocAmmoBatch,
    serverEconomyPocClone,
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";

function tier(value) {
    if (typeof value === "string" && Object.hasOwn(SERVER_ECONOMY_POC_PREMIUM_TIERS, value)) {
        return SERVER_ECONOMY_POC_PREMIUM_TIERS[value];
    }
    if (Number.isSafeInteger(value) && value >= 1 && value <= 3) return value;
    serverEconomyPocFail("POC_INVALID_PREMIUM", "Premium tier must be bronze, silver, gold, or 1..3.", { statusCode: 400 });
}

function premiumEffect(value) {
    if (value === undefined || value === null) return null;
    const normalized = {
        tier: tier(value.tier),
        durationSeconds: serverEconomyPocPositive(value.durationSeconds, "premium.durationSeconds")
    };
    if (normalized.durationSeconds > 10 * 366 * 24 * 60 * 60) {
        serverEconomyPocFail("POC_INVALID_PREMIUM", "Premium duration exceeds the POC safety bound.", { statusCode: 400 });
    }
    return normalized;
}

export function createServerEconomyPocHighValueOperation({
    playFabId,
    operationId,
    eventId,
    diamonds = 0,
    eliteBall = 0,
    premium = null,
    reason = "xsolla_entitlement",
    createdAtUnixMs
} = {}) {
    const normalizedPremium = premiumEffect(premium);
    const immutable = {
        schemaVersion: SERVER_ECONOMY_POC_SCHEMA_VERSION,
        kind: "xsolla_entitlement",
        playFabId: serverEconomyPocId(playFabId, "playFabId", 160),
        operationId: serverEconomyPocId(operationId, "operationId", 200),
        eventId: serverEconomyPocId(eventId, "eventId", 200),
        reason: serverEconomyPocId(reason, "reason", 160),
        diamonds: serverEconomyPocNonNegative(diamonds, "diamonds"),
        eliteBall: serverEconomyPocNonNegative(eliteBall, "eliteBall"),
        premium: normalizedPremium,
        createdAtUnixMs: serverEconomyPocNonNegative(createdAtUnixMs, "createdAtUnixMs")
    };
    if (immutable.diamonds === 0 && immutable.eliteBall === 0 && immutable.premium === null) {
        serverEconomyPocFail("POC_EMPTY_HIGH_VALUE_OPERATION", "High-value operation has no economic effect.", { statusCode: 400 });
    }
    return serverEconomyPocReadonly({
        ...immutable,
        immutableHash: serverEconomyPocDigest(immutable)
    });
}

export function applyServerEconomyPocHighValueOperation(
    snapshot,
    operation,
    sequence,
    nowUnixMs,
    fencingEpoch
) {
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
    let premium = serverEconomyPocClone(snapshot.premium);
    if (operation.premium !== null) {
        const durationMilliseconds = operation.premium.durationSeconds * 1000;
        const currentlyActive = premium.tier > 0 && premium.expiresAtUnixMs > nowUnixMs;
        const premiumBase = currentlyActive ? premium.expiresAtUnixMs : nowUnixMs;
        const expiresAtUnixMs = premiumBase + durationMilliseconds;
        if (!Number.isSafeInteger(durationMilliseconds) || !Number.isSafeInteger(expiresAtUnixMs)) {
            serverEconomyPocFail("POC_PREMIUM_OVERFLOW", "Premium expiration is not representable.");
        }
        premium = {
            tier: currentlyActive ? Math.max(premium.tier, operation.premium.tier) : operation.premium.tier,
            activatedAtUnixMs: currentlyActive ? premium.activatedAtUnixMs : nowUnixMs,
            expiresAtUnixMs
        };
    }
    const next = {
        ...serverEconomyPocClone(snapshot),
        revision: snapshot.revision + 1,
        fencingEpoch,
        diamonds,
        eliteBall,
        premium,
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
            premiumAdded: operation.premium,
            premium: next.premium,
            revision: next.revision
        }
    });
}

export {
    applyServerEconomyPocAmmoBatch,
    createServerEconomyPocAmmoEvent,
    createServerEconomyPocInitialSnapshot,
    validateServerEconomyPocSnapshot
};
