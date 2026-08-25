import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const PROOF_FIELDS = Object.freeze([
    "eventId",
    "immutableHash",
    "operationId",
    "playFabId",
    "schemaVersion",
    "sequence"
]);

export function createServerEconomyPocHighValueProviderProof({
    playFabId,
    sequence,
    operation
} = {}) {
    const proof = {
        schemaVersion: 1,
        playFabId: serverEconomyPocId(playFabId, "playFabId", 160),
        sequence: serverEconomyPocPositive(sequence, "high-value proof sequence"),
        operationId: serverEconomyPocId(operation?.operationId, "operationId", 200),
        eventId: serverEconomyPocId(operation?.eventId, "eventId", 200),
        immutableHash: serverEconomyPocId(operation?.immutableHash, "immutableHash", 128)
    };
    return serverEconomyPocReadonly(proof);
}

export function validateServerEconomyPocHighValueProviderProof(value, expectedPlayFabId = null) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(PROOF_FIELDS)) {
        serverEconomyPocFail("POC_PROVIDER_PROOF_CORRUPT", "High-value provider proof has an invalid schema.");
    }
    const proof = createServerEconomyPocHighValueProviderProof({
        playFabId: value.playFabId,
        sequence: value.sequence,
        operation: value
    });
    if (value.schemaVersion !== 1 ||
        expectedPlayFabId !== null && proof.playFabId !== serverEconomyPocId(expectedPlayFabId, "playFabId", 160)) {
        serverEconomyPocFail("POC_PROVIDER_PROOF_CORRUPT", "High-value provider proof is malformed or belongs to another player.");
    }
    return proof;
}

export function sameServerEconomyPocHighValueProviderProof(left, right) {
    if (!left || !right) return false;
    const a = validateServerEconomyPocHighValueProviderProof(left);
    const b = validateServerEconomyPocHighValueProviderProof(right);
    return a.schemaVersion === b.schemaVersion &&
        a.playFabId === b.playFabId &&
        a.sequence === b.sequence &&
        a.operationId === b.operationId &&
        a.eventId === b.eventId &&
        a.immutableHash === b.immutableHash;
}
