import { createHash } from "node:crypto";
import {
    mapValidatedXsollaReceiptToServerEconomyPocOperation
} from "./server-economy-poc-receipt-mapper.js";
import { serverEconomyPocReadonly } from "./server-economy-poc-model.js";

function providerIdentity(providerTransactionId) {
    return createHash("sha256")
        .update(`xsolla\u0000${providerTransactionId}`, "utf8")
        .digest("hex");
}

/** Provider transaction alone owns the durable operation/event identity. */
export function mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(projection) {
    const mapped = mapValidatedXsollaReceiptToServerEconomyPocOperation(projection);
    const identity = providerIdentity(mapped.providerTransactionId);
    return serverEconomyPocReadonly({
        ...mapped,
        operationId: `poc_xsolla_${identity}`,
        eventId: `xsolla_${identity}`,
        identitySource: "provider_transaction"
    });
}

export async function enqueueFinalValidatedXsollaReceipt({ engine, projection } = {}) {
    if (typeof engine?.enqueueAuthoritativeHighValueOperation !== "function") {
        throw new TypeError("Authoritative POC engine is required.");
    }
    const operation = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(projection);
    const submitted = await engine.enqueueAuthoritativeHighValueOperation(operation);
    return serverEconomyPocReadonly({ operation, submitted });
}
