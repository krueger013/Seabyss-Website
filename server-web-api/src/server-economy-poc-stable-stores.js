import {
    serverEconomyPocClone,
    serverEconomyPocDigest,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function highValueIntent(operation) {
    return {
        schemaVersion: operation.schemaVersion,
        kind: operation.kind,
        playFabId: operation.playFabId,
        operationId: operation.operationId,
        eventId: operation.eventId,
        reason: operation.reason,
        diamonds: operation.diamonds,
        diamondsDelta: operation.diamondsDelta ?? null,
        contextHash: operation.contextHash ?? null,
        eliteBall: operation.eliteBall,
        premium: operation.premium
    };
}

function ammoIntent(event) {
    return {
        schemaVersion: event.schemaVersion,
        kind: event.kind,
        playFabId: event.playFabId,
        eventId: event.eventId,
        reason: event.reason,
        delta: event.delta
    };
}

export function createStableServerEconomyPocOperationInbox(store) {
    for (const method of ["submit", "get", "scanAfter", "claim", "ack", "releaseClaim", "listPlayersWithPending"]) {
        if (typeof store?.[method] !== "function") throw new TypeError(`operationInbox.${method} is required.`);
    }
    async function submit(operation, allocation = null) {
        const existing = await store.get(operation.playFabId, operation.operationId);
        const normalized = {
            ...serverEconomyPocClone(operation),
            effectiveAtUnixMs: existing?.operation?.effectiveAtUnixMs ??
                existing?.operation?.createdAtUnixMs ?? operation.createdAtUnixMs,
            immutableHash: serverEconomyPocDigest(highValueIntent(operation))
        };
        return store.submit(serverEconomyPocReadonly(normalized), allocation);
    }
    return Object.freeze({
        submit,
        get: store.get.bind(store),
        scanAfter: store.scanAfter.bind(store),
        claim: store.claim.bind(store),
        ack: store.ack.bind(store),
        releaseClaim: store.releaseClaim.bind(store),
        listPlayersWithPending: store.listPlayersWithPending.bind(store),
        durable: store.durable === true,
        stableIntentIdentity: true,
        underlying: store
    });
}

export function createStableServerEconomyPocWalStore(store) {
    for (const method of ["append", "scanAfter", "ackThrough", "status", "listPlayersWithPending"]) {
        if (typeof store?.[method] !== "function") throw new TypeError(`walStore.${method} is required.`);
    }
    async function append(event) {
        return store.append(serverEconomyPocReadonly({
            ...serverEconomyPocClone(event),
            immutableHash: serverEconomyPocDigest(ammoIntent(event))
        }));
    }
    return Object.freeze({
        append,
        scanAfter: store.scanAfter.bind(store),
        ackThrough: store.ackThrough.bind(store),
        status: store.status.bind(store),
        listPlayersWithPending: store.listPlayersWithPending.bind(store),
        durable: store.durable === true,
        stableIntentIdentity: true,
        underlying: store
    });
}
