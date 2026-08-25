import {
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const MAXIMUM_DIAMOND_DELTA = 1_000_000_000;
const FORBIDDEN_CONTEXT_KEYS = new Set([
    "balance", "balances", "mapping", "mappings", "expectedBalance", "resultingBalance"
]);

function safeContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        serverEconomyPocFail("POC_GAMEPLAY_CONTEXT_INVALID", "Trusted gameplay context is required.", { statusCode: 400 });
    }
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_CONTEXT_KEYS.has(key)) {
            serverEconomyPocFail("POC_CLIENT_ECONOMICS_REJECTED", "Balances and mappings are never accepted as gameplay input.", { statusCode: 400 });
        }
    }
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 2048) {
        serverEconomyPocFail("POC_GAMEPLAY_CONTEXT_INVALID", "Gameplay context exceeds its safety bound.", { statusCode: 400 });
    }
    return JSON.parse(serialized);
}

function signedDelta(value) {
    if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > MAXIMUM_DIAMOND_DELTA) {
        serverEconomyPocFail("POC_DIAMOND_DELTA_INVALID", "Diamonds delta is invalid.", { statusCode: 400 });
    }
    return value;
}

function premiumEffect(value) {
    if (value === null || value === undefined) return null;
    if (!["bronze", "silver", "gold"].includes(value.tier) ||
        !Number.isSafeInteger(value.durationSeconds) || value.durationSeconds <= 0 ||
        value.durationSeconds > 10 * 366 * 24 * 60 * 60) {
        serverEconomyPocFail("POC_INVALID_PREMIUM", "Trusted gameplay Premium effect is invalid.", { statusCode: 400 });
    }
    return { tier: value.tier, durationSeconds: value.durationSeconds };
}

/**
 * Internal service contract only. The injected authorizer must bind the
 * authenticated server event to the legacy PlayFabId. No HTTP route is wired.
 */
export function createServerEconomyPocGameplayGateway({
    engine,
    authorize,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!engine?.stores?.operationInbox || typeof engine.processHighValueOperation !== "function" ||
        typeof engine.readSnapshot !== "function" || typeof authorize !== "function" ||
        typeof nowMilliseconds !== "function") {
        throw new TypeError("Trusted gameplay gateway dependencies are incomplete.");
    }

    async function prepare(input = {}) {
        const playFabId = serverEconomyPocId(input.playFabId, "playFabId", 160);
        const operationId = serverEconomyPocId(input.operationId, "operationId", 200);
        const reason = serverEconomyPocId(input.reason, "reason", 80);
        const context = safeContext(input.context);
        const diamonds = signedDelta(input.diamondsDelta);
        const premium = premiumEffect(input.premium);
        const authorized = await authorize({
            principal: input.principal,
            playFabId,
            operationId,
            reason,
            context: serverEconomyPocReadonly(context),
            diamondsDelta: diamonds,
            premium: premium && serverEconomyPocReadonly(premium)
        });
        if (authorized?.authorized !== true || authorized.playFabId !== playFabId) {
            serverEconomyPocFail("POC_GAMEPLAY_UNAUTHORIZED", "Gameplay financial operation is not server-authorized.", { statusCode: 403 });
        }
        const economicIntent = { playFabId, operationId, reason, context, diamonds, premium };
        const intentHash = serverEconomyPocDigest(economicIntent);
        const effectiveAtUnixMs = serverEconomyPocNonNegative(
            input.effectiveAtUnixMs ?? nowMilliseconds(),
            "effectiveAtUnixMs"
        );
        return serverEconomyPocReadonly({
            schemaVersion: 1,
            kind: "trusted_gameplay",
            playFabId,
            operationId,
            eventId: `gameplay_${intentHash}`,
            reason: `gameplay_${reason}_${intentHash.slice(0, 16)}`,
            diamonds,
            eliteBall: 0,
            premium,
            createdAtUnixMs: effectiveAtUnixMs,
            effectiveAtUnixMs,
            contextHash: serverEconomyPocDigest(context),
            immutableHash: serverEconomyPocDigest(economicIntent)
        });
    }

    async function enqueueTrustedGameplayOperation(input = {}) {
        const operation = await prepare(input);
        if (operation.diamonds < 0) {
            const snapshot = await engine.readSnapshot(operation.playFabId);
            if (snapshot.diamonds + operation.diamonds < 0) {
                serverEconomyPocFail("POC_INSUFFICIENT_DIAMONDS", "Trusted Diamond spend exceeds the canonical balance.", { statusCode: 409 });
            }
        }
        const submitted = await engine.stores.operationInbox.submit(operation);
        return serverEconomyPocReadonly({ operation, submitted });
    }

    async function consumeTrustedGameplayOperation({ playFabId, operationId, consumer = "gameplay" } = {}) {
        try {
            return await engine.processHighValueOperation({ playFabId, operationId, consumer });
        } catch (error) {
            const record = await engine.stores.operationInbox.get(playFabId, operationId).catch(() => null);
            const snapshot = await engine.readSnapshot(playFabId).catch(() => null);
            if (record?.operation?.diamonds < 0 && snapshot &&
                snapshot.diamonds + record.operation.diamonds < 0) {
                serverEconomyPocFail("POC_INSUFFICIENT_DIAMONDS", "Trusted Diamond spend exceeds the canonical balance.", { statusCode: 409 });
            }
            throw error;
        }
    }

    async function submitAndConsumeTrustedGameplayOperation(input = {}) {
        const enqueued = await enqueueTrustedGameplayOperation(input);
        const consumed = await consumeTrustedGameplayOperation({
            playFabId: enqueued.operation.playFabId,
            operationId: enqueued.operation.operationId,
            consumer: "gameplay"
        });
        return serverEconomyPocReadonly({ ...enqueued, consumed });
    }

    return Object.freeze({
        prepare,
        enqueueTrustedGameplayOperation,
        consumeTrustedGameplayOperation,
        submitAndConsumeTrustedGameplayOperation,
        maximumDiamondDelta: MAXIMUM_DIAMOND_DELTA,
        wiredToHttp: false,
        serverAuthorizerRequired: true
    });
}
