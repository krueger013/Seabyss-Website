import {
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const DTO_KEYS = Object.freeze([
    "playFabId", "sessionId", "sessionEpoch", "operationId", "eventId",
    "diamondsDelta", "reason", "contextId"
]);

function validateShape(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !DTO_KEYS.includes(key)) ||
        DTO_KEYS.some((key) => !Object.hasOwn(input, key))) {
        serverEconomyPocFail(
            "POC_TRUSTED_DIAMONDS_DTO_INVALID",
            "Trusted Diamonds DTO has missing or client-controlled financial fields.",
            { statusCode: 400 }
        );
    }
}

/**
 * Unity-facing contract adapter. Session authorization and effective time are
 * server-owned; clients cannot submit balances, revisions, leases or fencing.
 */
export function createServerEconomyPocTrustedDiamondsService({
    engine,
    gameplayGateway,
    authorizeSession,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!engine?.stores?.operationInbox || !gameplayGateway ||
        typeof gameplayGateway.prepare !== "function" ||
        typeof gameplayGateway.consumeTrustedGameplayOperation !== "function" ||
        typeof authorizeSession !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Trusted Diamonds service dependencies are incomplete.");
    }

    async function enqueue(input = {}) {
        validateShape(input);
        const playFabId = serverEconomyPocId(input.playFabId, "playFabId", 160);
        const sessionId = serverEconomyPocId(input.sessionId, "sessionId", 200);
        const sessionEpoch = serverEconomyPocNonNegative(input.sessionEpoch, "sessionEpoch");
        const operationId = serverEconomyPocId(input.operationId, "operationId", 200);
        const eventId = serverEconomyPocId(input.eventId, "eventId", 200);
        const reason = serverEconomyPocId(input.reason, "reason", 80);
        const contextId = serverEconomyPocId(input.contextId, "contextId", 200);
        const authorization = await authorizeSession({
            playFabId,
            sessionId,
            sessionEpoch,
            operationId,
            eventId,
            reason,
            contextId
        });
        if (authorization?.authorized !== true || authorization.playFabId !== playFabId ||
            authorization.sessionId !== sessionId || authorization.sessionEpoch !== sessionEpoch) {
            serverEconomyPocFail("POC_GAMEPLAY_UNAUTHORIZED", "Session does not authorize this financial event.", { statusCode: 403 });
        }
        const operation = await gameplayGateway.prepare({
            principal: authorization.principal,
            playFabId,
            operationId,
            diamondsDelta: input.diamondsDelta,
            reason,
            context: { contextId, sessionId, sessionEpoch, canonicalEventId: eventId },
            effectiveAtUnixMs: serverEconomyPocNonNegative(nowMilliseconds(), "server effective time")
        });
        const canonicalOperation = serverEconomyPocReadonly({
            ...serverEconomyPocClone(operation),
            eventId
        });
        const existing = await engine.stores.operationInbox.get(playFabId, operationId);
        if (!existing && canonicalOperation.diamondsDelta < 0) {
            const snapshot = await engine.readSnapshot(playFabId);
            if (snapshot.diamonds + canonicalOperation.diamondsDelta < 0) {
                serverEconomyPocFail(
                    "POC_INSUFFICIENT_DIAMONDS",
                    "Trusted Diamond spend exceeds the canonical balance.",
                    { statusCode: 409 }
                );
            }
        }
        const submitted = await engine.stores.operationInbox.submit(canonicalOperation);
        return serverEconomyPocReadonly({ operation: canonicalOperation, submitted });
    }

    async function execute(input = {}) {
        const enqueued = await enqueue(input);
        const consumed = await gameplayGateway.consumeTrustedGameplayOperation({
            playFabId: enqueued.operation.playFabId,
            operationId: enqueued.operation.operationId,
            consumer: "gameplay"
        });
        return serverEconomyPocReadonly({ ...enqueued, consumed });
    }

    return Object.freeze({
        enqueue,
        execute,
        dtoKeys: DTO_KEYS,
        serverOwnedFields: Object.freeze(["principal", "effectiveAtUnixMs"]),
        forbiddenClientFields: Object.freeze(["balance", "revision", "leaseToken", "fencingEpoch"])
    });
}
