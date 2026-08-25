import {
    serverEconomyPocId,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";

export const DIAMONDS_DOMAIN_TARGET_ADAPTER_VERSION = "diamonds-target-poc-v1";

const READ_KEYS = Object.freeze(["playFabId"]);
const MUTATION_KEYS = Object.freeze([
    "contextId",
    "delta",
    "eventId",
    "operationId",
    "playFabId",
    "reason",
    "sessionEpoch",
    "sessionId"
]);

function exactObject(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        const error = new TypeError(`${name} must contain only the exact trusted contract fields.`);
        error.code = "DIAMONDS_TARGET_SCHEMA_INVALID";
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function delta(value) {
    if (!Number.isSafeInteger(value) || value === 0) {
        const error = new TypeError("Diamonds delta must be a non-zero safe integer.");
        error.code = "DIAMONDS_TARGET_DELTA_INVALID";
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function sessionEpoch(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        const error = new TypeError("Diamonds session epoch must be a positive safe integer.");
        error.code = "DIAMONDS_TARGET_SESSION_INVALID";
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function snapshotResult(snapshot) {
    validateServerEconomyPocSnapshot(snapshot, snapshot.playFabId);
    return serverEconomyPocReadonly({
        status: "Read",
        playFabId: snapshot.playFabId,
        balance: snapshot.diamonds,
        revision: snapshot.revision,
        fencingEpoch: snapshot.fencingEpoch,
        highValueAppliedThroughSequence: snapshot.highValueAppliedThroughSequence,
        objectName: "SeabyssEconomyStateV1"
    });
}

function mutationResult(executed) {
    const consumed = executed?.consumed;
    const snapshot = consumed?.snapshot;
    if (!consumed || !snapshot) {
        const error = new Error("Canonical Diamonds runtime returned an incomplete result.");
        error.code = "DIAMONDS_TARGET_PROTOCOL_INVALID";
        throw error;
    }
    validateServerEconomyPocSnapshot(snapshot, executed.operation?.playFabId);
    const terminal = consumed.result?.status;
    const replay = consumed.status === "already_acked";
    let status;
    if (terminal === "rejected_insufficient_funds" || consumed.status === "rejected_insufficient_funds") {
        status = "Insufficient";
    } else if (replay) {
        status = "AlreadyApplied";
    } else if (terminal === "applied" || consumed.status === "applied") {
        status = "Applied";
    } else {
        const error = new Error("Canonical Diamonds runtime returned a non-terminal result.");
        error.code = "DIAMONDS_TARGET_PROTOCOL_INVALID";
        throw error;
    }
    return serverEconomyPocReadonly({
        status,
        replay,
        playFabId: snapshot.playFabId,
        operationId: executed.operation.operationId,
        eventId: executed.operation.eventId,
        delta: executed.operation.diamondsDelta,
        balance: snapshot.diamonds,
        revision: snapshot.revision,
        fencingEpoch: snapshot.fencingEpoch,
        providerConfirmed: true
    });
}

function insufficientPreflightResult(snapshot, operation) {
    validateServerEconomyPocSnapshot(snapshot, operation.playFabId);
    return serverEconomyPocReadonly({
        status: "Insufficient",
        replay: false,
        playFabId: snapshot.playFabId,
        operationId: operation.operationId,
        eventId: operation.eventId,
        delta: operation.diamondsDelta,
        balance: snapshot.diamonds,
        revision: snapshot.revision,
        fencingEpoch: snapshot.fencingEpoch,
        providerConfirmed: true,
        providerWriteAttempted: false,
        preflightRejected: true
    });
}

/**
 * Narrow Diamonds adapter over the certified Redis inbox/lease/fencing and
 * PlayFab SeabyssEconomyStateV1 CAS runtime. It intentionally accepts no
 * caller-supplied balance, revision, reward plan, lease, fence, or proof.
 */
export function createDiamondsDomainTargetAdapter({ canonicalRuntime } = {}) {
    if (typeof canonicalRuntime?.readSnapshot !== "function" ||
        typeof canonicalRuntime?.trustedDiamonds?.execute !== "function") {
        throw new TypeError("Diamonds Target adapter requires the canonical server economy runtime.");
    }

    async function read(input = {}) {
        exactObject(input, READ_KEYS, "Diamonds Target read");
        const playFabId = serverEconomyPocId(input.playFabId, "playFabId", 160);
        return snapshotResult(await canonicalRuntime.readSnapshot(playFabId));
    }

    async function mutate(input = {}) {
        exactObject(input, MUTATION_KEYS, "Diamonds Target mutation");
        const trusted = {
            playFabId: serverEconomyPocId(input.playFabId, "playFabId", 160),
            sessionId: serverEconomyPocId(input.sessionId, "sessionId", 200),
            sessionEpoch: sessionEpoch(input.sessionEpoch),
            operationId: serverEconomyPocId(input.operationId, "operationId", 200),
            eventId: serverEconomyPocId(input.eventId, "eventId", 200),
            diamondsDelta: delta(input.delta),
            reason: serverEconomyPocId(input.reason, "reason", 80),
            contextId: serverEconomyPocId(input.contextId, "contextId", 200)
        };
        if (trusted.diamondsDelta < 0) {
            const snapshot = await canonicalRuntime.readSnapshot(trusted.playFabId);
            validateServerEconomyPocSnapshot(snapshot, trusted.playFabId);
            const candidate = snapshot.diamonds + trusted.diamondsDelta;
            if (!Number.isSafeInteger(candidate) || candidate < 0) {
                return insufficientPreflightResult(snapshot, trusted);
            }
        }
        return mutationResult(await canonicalRuntime.trustedDiamonds.execute(trusted));
    }

    return Object.freeze({
        read,
        mutate,
        adapterVersion: DIAMONDS_DOMAIN_TARGET_ADAPTER_VERSION,
        domain: "Diamonds",
        providerObjectName: "SeabyssEconomyStateV1",
        resultStatuses: Object.freeze(["Applied", "AlreadyApplied", "Insufficient"]),
        trustedGameServerInputFields: Object.freeze([...MUTATION_KEYS]),
        forbiddenCallerFields: Object.freeze([
            "balance", "revision", "rewards", "rewardPlan", "leaseToken",
            "fencingEpoch", "providerProof", "expectedProfileVersion"
        ])
    });
}
