import {
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const AMMO_PROOF_FIELDS = Object.freeze([
    "batchDigest",
    "eventCount",
    "firstSequence",
    "playFabId",
    "schemaVersion",
    "throughSequence"
]);

function eventIdentity(entry, playFabId) {
    if (entry?.playFabId !== playFabId) {
        serverEconomyPocFail("POC_AMMO_PROOF_CORRUPT", "Ammo proof batch contains another player.");
    }
    return Object.freeze({
        sequence: serverEconomyPocPositive(entry?.sequence, "ammo sequence"),
        eventId: serverEconomyPocId(entry?.eventId, "eventId", 200),
        immutableHash: serverEconomyPocId(entry?.immutableHash, "immutableHash", 128)
    });
}

export function createServerEconomyPocAmmoBatchProof({
    playFabId,
    entries
} = {}) {
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 500) {
        serverEconomyPocFail("POC_AMMO_PROOF_CORRUPT", "Ammo provider proof requires 1 to 500 events.");
    }
    const identities = entries.map((entry) => eventIdentity(entry, player));
    const firstSequence = identities[0].sequence;
    for (let index = 0; index < identities.length; index += 1) {
        if (identities[index].sequence !== firstSequence + index) {
            serverEconomyPocFail("POC_AMMO_PROOF_CORRUPT", "Ammo provider proof sequences are not contiguous.");
        }
    }
    return serverEconomyPocReadonly({
        schemaVersion: 1,
        playFabId: player,
        firstSequence,
        throughSequence: identities.at(-1).sequence,
        eventCount: identities.length,
        batchDigest: serverEconomyPocDigest(identities)
    });
}

export function validateServerEconomyPocAmmoBatchProof(value, expectedPlayFabId = null) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(AMMO_PROOF_FIELDS)) {
        serverEconomyPocFail("POC_AMMO_PROOF_CORRUPT", "Ammo provider proof has an invalid schema.");
    }
    const player = serverEconomyPocId(value.playFabId, "playFabId", 160);
    if (value.schemaVersion !== 1 ||
        expectedPlayFabId !== null && player !== serverEconomyPocId(expectedPlayFabId, "playFabId", 160) ||
        !Number.isSafeInteger(value.firstSequence) || value.firstSequence <= 0 ||
        !Number.isSafeInteger(value.throughSequence) || value.throughSequence < value.firstSequence ||
        !Number.isSafeInteger(value.eventCount) || value.eventCount <= 0 || value.eventCount > 500 ||
        value.throughSequence - value.firstSequence + 1 !== value.eventCount ||
        typeof value.batchDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.batchDigest)) {
        serverEconomyPocFail("POC_AMMO_PROOF_CORRUPT", "Ammo provider proof is malformed.");
    }
    return serverEconomyPocReadonly({
        schemaVersion: 1,
        playFabId: player,
        firstSequence: value.firstSequence,
        throughSequence: value.throughSequence,
        eventCount: value.eventCount,
        batchDigest: value.batchDigest
    });
}

export function sameServerEconomyPocAmmoBatchProof(left, right) {
    if (!left || !right) return false;
    const a = validateServerEconomyPocAmmoBatchProof(left);
    const b = validateServerEconomyPocAmmoBatchProof(right);
    return a.schemaVersion === b.schemaVersion &&
        a.playFabId === b.playFabId &&
        a.firstSequence === b.firstSequence &&
        a.throughSequence === b.throughSequence &&
        a.eventCount === b.eventCount &&
        a.batchDigest === b.batchDigest;
}
