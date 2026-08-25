import {
    createMemoryServerEconomyPocEventIndex
} from "./server-economy-poc-global-identity-stores.js";
import { serverEconomyPocDigest, serverEconomyPocId } from "./server-economy-poc-model.js";

const memoryIndexes = new WeakMap();

function defaultIndex(store) {
    if (store.durable === true) {
        throw new TypeError("Durable operationInbox requires an injected atomic durable eventIndexStore.");
    }
    if (!memoryIndexes.has(store)) memoryIndexes.set(store, createMemoryServerEconomyPocEventIndex());
    return memoryIndexes.get(store);
}

export function createServerEconomyPocAtomicEventInbox(store, { eventIndexStore = null } = {}) {
    for (const method of ["submit", "get", "scanAfter", "claim", "ack", "releaseClaim", "listPlayersWithPending"]) {
        if (typeof store?.[method] !== "function") throw new TypeError(`operationInbox.${method} is required.`);
    }
    const index = eventIndexStore || defaultIndex(store);
    if (typeof index?.claim !== "function" || store.durable === true && index.durable !== true) {
        throw new TypeError("Atomic event index must match operation inbox durability.");
    }

    async function submit(operation, allocation = null) {
        const playFabId = serverEconomyPocId(operation?.playFabId, "playFabId", 160);
        const operationId = serverEconomyPocId(operation?.operationId, "operationId", 200);
        const eventId = serverEconomyPocId(operation?.eventId, "eventId", 200);
        await index.claim({
            identity: `event_${serverEconomyPocDigest({ playFabId, eventId })}`,
            intent: { playFabId, eventId, operationId }
        });
        return store.submit(operation, allocation);
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
        atomicEventIndex: true,
        eventIndexStore: index,
        underlying: store
    });
}
