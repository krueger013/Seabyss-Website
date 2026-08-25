import {
    createMemoryServerEconomyPocProviderTransactionGuard
} from "./server-economy-poc-global-identity-stores.js";

const memoryGuards = new WeakMap();

export function resolveServerEconomyPocProviderTransactionGuard(operationInbox, explicitGuard) {
    if (explicitGuard) {
        if (typeof explicitGuard.claim !== "function" ||
            operationInbox?.durable === true && explicitGuard.durable !== true) {
            throw new TypeError("Provider transaction guard must match inbox durability.");
        }
        return explicitGuard;
    }
    if (operationInbox?.durable === true) {
        throw new TypeError("Durable POC requires an injected atomic global providerTransactionGuard.");
    }
    if (!memoryGuards.has(operationInbox)) {
        memoryGuards.set(operationInbox, createMemoryServerEconomyPocProviderTransactionGuard());
    }
    return memoryGuards.get(operationInbox);
}
