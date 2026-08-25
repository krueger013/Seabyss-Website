import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const RECOGNIZED_XSOLLA_NOTIFICATION_TYPES = Object.freeze([
    "user_validation",
    "payment",
    "create_subscription",
    "update_subscription",
    "cancel_subscription",
    "refund",
    "partial_refund",
    "order_paid",
    "order_canceled",
    "dispute"
]);

const recognizedNotificationTypes = new Set(RECOGNIZED_XSOLLA_NOTIFICATION_TYPES);
const noOpNotificationTypes = new Set(
    RECOGNIZED_XSOLLA_NOTIFICATION_TYPES.filter((type) => type !== "user_validation")
);
const defaultEventTtlSeconds = 90 * 24 * 60 * 60;
const defaultClaimTtlSeconds = 300;
const defaultConcurrentWaitMilliseconds = 5000;
const defaultConcurrentPollMilliseconds = 10;
const maximumSafeIntegerText = String(Number.MAX_SAFE_INTEGER);
const xsollaEventIdentifierPaths = Object.freeze([
    Object.freeze(["order", "id"]),
    Object.freeze(["transaction", "id"]),
    Object.freeze(["billing", "transaction", "id"]),
    Object.freeze(["subscription", "subscription_id"]),
    Object.freeze(["purchase", "subscription", "subscription_id"]),
    Object.freeze(["billing", "purchase", "subscription", "subscription_id"])
]);

function isJsonDigit(value) {
    return value >= "0" && value <= "9";
}

function isUnsafeJsonIntegerToken(token) {
    const unsignedToken = token.startsWith("-")
        ? token.slice(1)
        : token;
    if (unsignedToken.length !== maximumSafeIntegerText.length) {
        return unsignedToken.length > maximumSafeIntegerText.length;
    }

    return unsignedToken > maximumSafeIntegerText;
}

function preserveUnsafeJsonIntegerTokens(jsonText) {
    let output = "";
    let index = 0;

    while (index < jsonText.length) {
        const character = jsonText[index];

        if (character === "\"") {
            const stringStart = index;
            index += 1;
            while (index < jsonText.length) {
                if (jsonText[index] === "\\") {
                    index += 2;
                    continue;
                }
                if (jsonText[index] === "\"") {
                    index += 1;
                    break;
                }
                index += 1;
            }
            output += jsonText.slice(stringStart, index);
            continue;
        }

        const startsNumber = character === "-"
            ? isJsonDigit(jsonText[index + 1])
            : isJsonDigit(character);
        if (!startsNumber) {
            output += character;
            index += 1;
            continue;
        }

        const numberStart = index;
        if (character === "-") {
            index += 1;
        }
        if (jsonText[index] === "0") {
            index += 1;
        } else {
            while (isJsonDigit(jsonText[index])) {
                index += 1;
            }
        }

        let integerToken = true;
        if (jsonText[index] === ".") {
            integerToken = false;
            index += 1;
            while (isJsonDigit(jsonText[index])) {
                index += 1;
            }
        }

        if (jsonText[index] === "e" || jsonText[index] === "E") {
            integerToken = false;
            index += 1;
            if (jsonText[index] === "+" || jsonText[index] === "-") {
                index += 1;
            }
            while (isJsonDigit(jsonText[index])) {
                index += 1;
            }
        }

        const token = jsonText.slice(numberStart, index);
        output += integerToken && isUnsafeJsonIntegerToken(token)
            ? `"${token}"`
            : token;
    }

    return output;
}

function applyLosslessXsollaEventIdentifiers(payload, losslessPayload) {
    for (const path of xsollaEventIdentifierPaths) {
        let payloadContainer = payload;
        let losslessContainer = losslessPayload;
        for (let index = 0; index < path.length - 1; index += 1) {
            payloadContainer = payloadContainer?.[path[index]];
            losslessContainer = losslessContainer?.[path[index]];
        }

        if (
            !payloadContainer ||
            typeof payloadContainer !== "object" ||
            !losslessContainer ||
            typeof losslessContainer !== "object"
        ) {
            continue;
        }

        const fieldName = path[path.length - 1];
        const parsedValue = payloadContainer[fieldName];
        const losslessValue = losslessContainer[fieldName];
        if (
            typeof parsedValue === "number" &&
            !Number.isSafeInteger(parsedValue) &&
            typeof losslessValue === "string"
        ) {
            payloadContainer[fieldName] = losslessValue;
        }
    }

    return payload;
}

function asRawBuffer(rawBody) {
    return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function asNonEmptyString(value) {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.trim();
    return normalized ? normalized : null;
}

function asStrictProjectId(value) {
    if (typeof value === "string") {
        return value.length <= 160 && value === value.trim() && /^[1-9][0-9]*$/.test(value)
            ? value
            : null;
    }
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (typeof value === "bigint") {
        return value > 0n ? String(value) : null;
    }
    return null;
}

function asStrictUserId(value) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= 160 &&
        value === value.trim() &&
        !/\s/.test(value)
        ? value
        : null;
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeProviderId(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
        return null;
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        return null;
    }

    const normalized = String(value).trim();
    if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
        return null;
    }

    return normalized;
}

function xsollaError(res, status, code, message) {
    res.status(status).json({
        error: {
            code,
            message
        }
    });
}

function projectIdsFromPayload(payload) {
    return [
        payload?.settings?.project_id,
        payload?.billing?.settings?.project_id
    ]
        .filter((value) => value !== undefined && value !== null)
        .map(asStrictProjectId);
}

function expectedUserId(payload, notificationType) {
    const value = notificationType === "order_paid" || notificationType === "order_canceled"
        ? payload?.user?.external_id
        : payload?.user?.id;
    return asStrictUserId(value);
}

function safeTimestamp(now) {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime())
        ? value.toISOString()
        : new Date().toISOString();
}

function identifierHash(value) {
    const normalized = asNonEmptyString(value);
    return normalized
        ? createHash("sha256").update(normalized, "utf8").digest("hex")
        : null;
}

function logContext(payload, notificationType, eventId, userId, now, result) {
    const projectIds = projectIdsFromPayload(payload);
    return {
        timestamp: safeTimestamp(now),
        notificationType: notificationType || "unknown",
        projectId: projectIds[0] || "unknown",
        userIdHash: identifierHash(userId),
        eventIdHash: identifierHash(eventId),
        result
    };
}

export function computeXsollaSignature(rawBody, webhookSecret) {
    const body = asRawBuffer(rawBody);
    if (!body) {
        throw new TypeError("Xsolla signature input must be a Buffer.");
    }
    if (typeof webhookSecret !== "string" || webhookSecret.length === 0) {
        throw new TypeError("Xsolla webhook secret is required.");
    }

    return createHash("sha1")
        .update(body)
        .update(webhookSecret, "utf8")
        .digest("hex");
}

export function verifyXsollaSignature(rawBody, authorizationHeader, webhookSecret) {
    const body = asRawBuffer(rawBody);
    const secret = typeof webhookSecret === "string" ? webhookSecret : "";
    const match = typeof authorizationHeader === "string"
        ? authorizationHeader.match(/^Signature ([a-f0-9]{40})$/)
        : null;
    if (!body || !secret || !match) {
        return false;
    }

    try {
        const provided = Buffer.from(match[1], "hex");
        const expected = Buffer.from(computeXsollaSignature(body, secret), "hex");
        return provided.length === expected.length && timingSafeEqual(provided, expected);
    } catch {
        return false;
    }
}

export function parseXsollaPayload(rawBody) {
    const body = asRawBuffer(rawBody);
    if (!body) {
        throw new TypeError("Xsolla JSON input must be a Buffer.");
    }

    const jsonText = body.toString("utf8");
    const payload = JSON.parse(jsonText);
    const losslessPayload = JSON.parse(
        preserveUnsafeJsonIntegerTokens(jsonText)
    );

    return applyLosslessXsollaEventIdentifiers(
        payload,
        losslessPayload
    );
}

export function getXsollaEventId(payload) {
    const notificationType = asNonEmptyString(payload?.notification_type);
    if (!notificationType) {
        return null;
    }

    if (notificationType === "order_paid" || notificationType === "order_canceled") {
        const orderId = normalizeProviderId(payload?.order?.id);
        return orderId ? `${notificationType}:order:${orderId}` : null;
    }

    if (notificationType === "partial_refund") {
        const transactionId = normalizeProviderId(
            payload?.transaction?.id ?? payload?.billing?.transaction?.id
        );
        const refundDate = asNonEmptyString(payload?.refund_details?.date);
        const amount = payload?.purchase?.total?.amount;
        const currency = payload?.purchase?.total?.currency;
        if (!transactionId || !refundDate ||
            (typeof amount !== "string" && typeof amount !== "number") ||
            typeof currency !== "string") {
            return null;
        }
        const variant = createHash("sha256").update(JSON.stringify({
            transactionId,
            refundDate,
            amount: String(amount),
            currency,
            code: payload?.refund_details?.code,
            reason: payload?.refund_details?.reason,
            author: payload?.refund_details?.author
        })).digest("hex");
        return `partial_refund:transaction:${transactionId}:${variant}`;
    }

    if (notificationType === "dispute") {
        const transactionId = normalizeProviderId(payload?.transaction?.id);
        const action = asNonEmptyString(payload?.action);
        const disputeDate = asNonEmptyString(payload?.dispute?.incoming_date);
        const status = asNonEmptyString(payload?.dispute?.status);
        if (!transactionId || !action || !disputeDate || !status) return null;
        const variant = createHash("sha256").update(JSON.stringify({
            transactionId,
            action,
            disputeDate,
            status,
            id: payload?.dispute?.id ?? null,
            type: payload?.dispute?.type ?? null,
            reason: payload?.dispute?.reason ?? null
        })).digest("hex");
        return `dispute:transaction:${transactionId}:${variant}`;
    }

    if (notificationType === "payment" || notificationType === "refund") {
        const transactionId = normalizeProviderId(
            payload?.transaction?.id ?? payload?.billing?.transaction?.id
        );
        return transactionId ? `${notificationType}:transaction:${transactionId}` : null;
    }

    if (
        notificationType === "create_subscription" ||
        notificationType === "update_subscription" ||
        notificationType === "cancel_subscription"
    ) {
        const subscriptionId = normalizeProviderId(
            payload?.subscription?.subscription_id ??
            payload?.purchase?.subscription?.subscription_id ??
            payload?.billing?.purchase?.subscription?.subscription_id
        );
        return subscriptionId ? `${notificationType}:subscription:${subscriptionId}` : null;
    }

    return null;
}

function isPayloadHash(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function processedState(record) {
    return Object.freeze({ ...record, state: "processed" });
}

function parseStoredEventState(serialized) {
    if (typeof serialized !== "string" || !serialized) {
        throw new Error("Xsolla idempotence record is invalid.");
    }
    const value = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Xsolla idempotence record is invalid.");
    }
    if (value.state === "processing") {
        if (typeof value.claimToken !== "string" || !value.claimToken ||
            !isPayloadHash(value.payloadHash)) {
            throw new Error("Xsolla processing claim is invalid.");
        }
        return value;
    }
    if (value.state === "processed" || value.state === undefined) {
        if (!isPayloadHash(value.payloadHash)) {
            throw new Error("Xsolla processed record payload hash is invalid.");
        }
        return processedState(value);
    }
    throw new Error("Xsolla idempotence state is invalid.");
}

function validateClaim(claim) {
    if (typeof claim?.claimToken !== "string" || !claim.claimToken ||
        !isPayloadHash(claim?.payloadHash)) {
        throw new TypeError("Xsolla event claim is invalid.");
    }
}

export function createMemoryXsollaEventStore(options = {}) {
    const ttlSeconds = Number.isInteger(options.ttlSeconds) && options.ttlSeconds > 0
        ? options.ttlSeconds
        : defaultEventTtlSeconds;
    const claimTtlSeconds = Number.isInteger(options.claimTtlSeconds) &&
        options.claimTtlSeconds > 0
        ? options.claimTtlSeconds
        : defaultClaimTtlSeconds;
    const nowMilliseconds = typeof options.nowMilliseconds === "function"
        ? options.nowMilliseconds
        : () => Date.now();
    const records = new Map();

    function active(eventId) {
        const current = records.get(eventId);
        if (current && current.expiresAtMilliseconds <= nowMilliseconds()) {
            records.delete(eventId);
            return null;
        }
        return current || null;
    }

    return {
        async hasProcessed(eventId) {
            return active(eventId)?.value?.state === "processed";
        },
        async markProcessed(eventId, record) {
            if (active(eventId)) {
                return false;
            }
            records.set(eventId, {
                value: processedState(record),
                expiresAtMilliseconds: nowMilliseconds() + ttlSeconds * 1000
            });
            return true;
        },
        async read(eventId) {
            return active(eventId)?.value || null;
        },
        async claim(eventId, claim) {
            validateClaim(claim);
            const existing = active(eventId);
            if (existing) {
                return { acquired: false, existing: existing.value };
            }
            const value = Object.freeze({
                state: "processing",
                claimToken: claim.claimToken,
                payloadHash: claim.payloadHash
            });
            records.set(eventId, {
                value,
                expiresAtMilliseconds: nowMilliseconds() + claimTtlSeconds * 1000
            });
            return { acquired: true, existing: null };
        },
        async complete(eventId, claimToken, record) {
            const existing = active(eventId);
            if (!existing || existing.value.state !== "processing" ||
                existing.value.claimToken !== claimToken ||
                existing.value.payloadHash !== record?.payloadHash) {
                return false;
            }
            records.set(eventId, {
                value: processedState(record),
                expiresAtMilliseconds: nowMilliseconds() + ttlSeconds * 1000
            });
            return true;
        },
        async release(eventId, claimToken) {
            const existing = active(eventId);
            if (!existing || existing.value.state !== "processing" ||
                existing.value.claimToken !== claimToken) {
                return false;
            }
            records.delete(eventId);
            return true;
        }
    };
}

const redisClaimScript = `
local existing = redis.call("GET", KEYS[1])
if existing then
    return {0, existing}
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return {1, ""}
`;

const redisCompleteScript = `
local existing = redis.call("GET", KEYS[1])
if existing == ARGV[1] then
    redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
    return 1
end
return 0
`;

const redisReleaseScript = `
local existing = redis.call("GET", KEYS[1])
if existing == ARGV[1] then
    redis.call("DEL", KEYS[1])
    return 1
end
return 0
`;

export function createRedisXsollaEventStore(redisClient, options = {}) {
    if (!redisClient) {
        return null;
    }
    const prefix = options.prefix || "seabyss:xsolla:webhook:v1:";
    const ttlSeconds = Number.isInteger(options.ttlSeconds) && options.ttlSeconds > 0
        ? options.ttlSeconds
        : defaultEventTtlSeconds;
    const claimTtlSeconds = Number.isInteger(options.claimTtlSeconds) &&
        options.claimTtlSeconds > 0
        ? options.claimTtlSeconds
        : defaultClaimTtlSeconds;
    const ownedClaims = new Map();
    const keyFor = (eventId) => {
        if (typeof eventId !== "string" || !eventId) {
            throw new TypeError("Xsolla event ID must be a non-empty string.");
        }
        return prefix + encodeURIComponent(eventId);
    };

    return {
        async hasProcessed(eventId) {
            const serialized = await redisClient.get(keyFor(eventId));
            return serialized !== null && parseStoredEventState(serialized).state === "processed";
        },
        async markProcessed(eventId, record) {
            const result = await redisClient.set(
                keyFor(eventId),
                JSON.stringify(processedState(record)),
                { NX: true, EX: ttlSeconds }
            );
            return result === "OK";
        },
        async read(eventId) {
            const serialized = await redisClient.get(keyFor(eventId));
            return serialized === null ? null : parseStoredEventState(serialized);
        },
        async claim(eventId, claim) {
            validateClaim(claim);
            const value = JSON.stringify({
                state: "processing",
                claimToken: claim.claimToken,
                payloadHash: claim.payloadHash
            });
            const result = await redisClient.eval(redisClaimScript, {
                keys: [keyFor(eventId)],
                arguments: [value, String(claimTtlSeconds)]
            });
            if (!Array.isArray(result) || result.length < 1) {
                throw new Error("Redis Xsolla claim returned an invalid result.");
            }
            if (Number(result[0]) === 1) {
                ownedClaims.set(eventId, value);
                return { acquired: true, existing: null };
            }
            if (Number(result[0]) !== 0 || typeof result[1] !== "string") {
                throw new Error("Redis Xsolla claim returned an invalid result.");
            }
            return { acquired: false, existing: parseStoredEventState(result[1]) };
        },
        async complete(eventId, claimToken, record) {
            const expected = ownedClaims.get(eventId);
            if (!expected || JSON.parse(expected).claimToken !== claimToken) {
                return false;
            }
            const value = JSON.stringify(processedState(record));
            const result = await redisClient.eval(redisCompleteScript, {
                keys: [keyFor(eventId)],
                arguments: [expected, value, String(ttlSeconds)]
            });
            if (Number(result) === 1) {
                ownedClaims.delete(eventId);
                return true;
            }
            return false;
        },
        async release(eventId, claimToken) {
            const expected = ownedClaims.get(eventId);
            if (!expected || JSON.parse(expected).claimToken !== claimToken) {
                return false;
            }
            const result = await redisClient.eval(redisReleaseScript, {
                keys: [keyFor(eventId)],
                arguments: [expected]
            });
            if (Number(result) === 1) {
                ownedClaims.delete(eventId);
                return true;
            }
            return false;
        }
    };
}

export async function hasProcessedXsollaEvent(eventStore, eventId) {
    if (!eventStore || typeof eventId !== "string" || !eventId ||
        typeof eventStore.hasProcessed !== "function") {
        return false;
    }
    return Boolean(await eventStore.hasProcessed(eventId));
}

export async function markXsollaEventProcessed(eventStore, eventId, record) {
    if (!eventStore || typeof eventId !== "string" || !eventId ||
        typeof eventStore.markProcessed !== "function") {
        return false;
    }
    return Boolean(await eventStore.markProcessed(eventId, record));
}

export async function claimXsollaEvent(eventStore, eventId, claim) {
    if (!eventStore || typeof eventStore.claim !== "function" ||
        typeof eventId !== "string" || !eventId) {
        throw new TypeError("Xsolla atomic event claim is unavailable.");
    }
    validateClaim(claim);
    return eventStore.claim(eventId, claim);
}

export async function readXsollaEventState(eventStore, eventId) {
    if (!eventStore || typeof eventStore.read !== "function" ||
        typeof eventId !== "string" || !eventId) {
        throw new TypeError("Xsolla atomic event read is unavailable.");
    }
    return eventStore.read(eventId);
}

export async function completeXsollaEvent(eventStore, eventId, claimToken, record) {
    if (!eventStore || typeof eventStore.complete !== "function") {
        throw new TypeError("Xsolla atomic event completion is unavailable.");
    }
    return Boolean(await eventStore.complete(eventId, claimToken, record));
}

export async function releaseXsollaEvent(eventStore, eventId, claimToken) {
    if (!eventStore || typeof eventStore.release !== "function") {
        throw new TypeError("Xsolla atomic event release is unavailable.");
    }
    return Boolean(await eventStore.release(eventId, claimToken));
}

export class XsollaInvalidUserError extends Error {
    constructor() {
        super("Xsolla event references an invalid user.");
        this.name = "XsollaInvalidUserError";
    }
}

export function createXsollaWebhookHandler({
    webhookSecret,
    projectId,
    eventStore = null,
    validateUser = null,
    processEvent = null,
    logger = console,
    now = () => new Date(),
    concurrentWaitMilliseconds = defaultConcurrentWaitMilliseconds,
    concurrentPollMilliseconds = defaultConcurrentPollMilliseconds
}) {
    const expectedProjectId = asStrictProjectId(projectId);
    const secretConfigured = typeof webhookSecret === "string" && webhookSecret.length > 0;
    const claimWait = Number.isInteger(concurrentWaitMilliseconds) &&
        concurrentWaitMilliseconds > 0
        ? concurrentWaitMilliseconds
        : defaultConcurrentWaitMilliseconds;
    const claimPoll = Number.isInteger(concurrentPollMilliseconds) &&
        concurrentPollMilliseconds > 0
        ? concurrentPollMilliseconds
        : defaultConcurrentPollMilliseconds;

    return async function xsollaWebhookHandler(req, res) {
        if (!secretConfigured || !expectedProjectId) {
            logger.error("Xsolla webhook rejected because server configuration is incomplete.", {
                timestamp: safeTimestamp(now),
                secretConfigured,
                projectIdConfigured: Boolean(expectedProjectId),
                result: "configuration_missing"
            });
            xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
            return;
        }

        const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
        if (!verifyXsollaSignature(rawBody, req.get("authorization"), webhookSecret)) {
            logger.warn("Xsolla webhook rejected.", {
                timestamp: safeTimestamp(now),
                result: "invalid_signature"
            });
            xsollaError(res, 400, "INVALID_SIGNATURE", "Invalid signature");
            return;
        }

        let payload;
        try {
            payload = parseXsollaPayload(rawBody);
        } catch {
            logger.warn("Xsolla webhook rejected.", {
                timestamp: safeTimestamp(now),
                result: "invalid_json"
            });
            xsollaError(res, 400, "INVALID_PARAMETER", "Invalid JSON");
            return;
        }

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            xsollaError(res, 400, "INVALID_PARAMETER", "Invalid payload");
            return;
        }

        const notificationType = asNonEmptyString(payload.notification_type);
        if (!notificationType) {
            xsollaError(res, 400, "INVALID_PARAMETER", "Invalid notification type");
            return;
        }

        const payloadProjectIds = projectIdsFromPayload(payload);
        if (!payloadProjectIds.length || payloadProjectIds.some((value) =>
            !value || value !== expectedProjectId
        )) {
            logger.warn("Xsolla webhook rejected.", logContext(
                payload,
                notificationType,
                getXsollaEventId(payload),
                null,
                now,
                "invalid_project"
            ));
            xsollaError(res, 400, "INVALID_PARAMETER", "Invalid project");
            return;
        }

        const recognized = recognizedNotificationTypes.has(notificationType);
        const userId = recognized ? expectedUserId(payload, notificationType) : null;
        const eventId = getXsollaEventId(payload);
        if (recognized && !userId) {
            logger.warn("Xsolla webhook rejected.", logContext(
                payload,
                notificationType,
                eventId,
                null,
                now,
                "invalid_user"
            ));
            xsollaError(res, 400, "INVALID_USER", "Invalid user");
            return;
        }

        if (notificationType === "user_validation") {
            if (typeof validateUser !== "function") {
                logger.error("Xsolla user validation is unavailable.", logContext(
                    payload, notificationType, eventId, userId, now,
                    "user_validation_unavailable"
                ));
                xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
                return;
            }
            let userExists;
            try {
                userExists = await validateUser(userId);
            } catch {
                logger.error("Xsolla user validation is unavailable.", logContext(
                    payload, notificationType, eventId, userId, now,
                    "user_validation_unavailable"
                ));
                xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
                return;
            }
            if (typeof userExists !== "boolean") {
                logger.error("Xsolla user validation is unavailable.", logContext(
                    payload, notificationType, eventId, userId, now,
                    "user_validation_unavailable"
                ));
                xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
                return;
            }
            if (!userExists) {
                logger.warn("Xsolla user validation rejected an unknown user.", logContext(
                    payload, notificationType, eventId, userId, now, "invalid_user"
                ));
                xsollaError(res, 400, "INVALID_USER", "Invalid user");
                return;
            }
            logger.info("Xsolla user validation succeeded.", logContext(
                payload, notificationType, eventId, userId, now, "user_validated"
            ));
            res.status(204).end();
            return;
        }

        if (!recognized) {
            logger.warn("Xsolla webhook notification type is not recognized.", logContext(
                payload, notificationType, eventId, null, now,
                "ignored_unknown_notification"
            ));
            res.status(204).end();
            return;
        }

        if (!eventId) {
            logger.warn("Xsolla webhook rejected.", logContext(
                payload, notificationType, null, userId, now,
                "invalid_event_identifier"
            ));
            xsollaError(res, 400, "INVALID_PARAMETER", "Invalid event identifier");
            return;
        }

        if (!eventStore || !noOpNotificationTypes.has(notificationType)) {
            logger.error("Xsolla webhook idempotence store is unavailable.", logContext(
                payload, notificationType, eventId, userId, now,
                "idempotence_store_unavailable"
            ));
            xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
            return;
        }

        const payloadHash = createHash("sha256").update(rawBody).digest("hex");
        const claimToken = randomUUID();
        const claimDeadline = Date.now() + claimWait;
        try {
            while (true) {
                const claim = await claimXsollaEvent(eventStore, eventId, {
                    claimToken,
                    payloadHash
                });
                if (claim?.acquired === true) {
                    break;
                }
                const existing = claim?.existing || await readXsollaEventState(
                    eventStore,
                    eventId
                );
                if (!existing || typeof existing !== "object") {
                    if (Date.now() >= claimDeadline) {
                        throw new Error("Xsolla concurrent claim did not resolve.");
                    }
                    await wait(claimPoll);
                    continue;
                }
                if (existing.payloadHash !== payloadHash) {
                    logger.warn("Xsolla webhook rejected conflicting payload.", logContext(
                        payload, notificationType, eventId, userId, now,
                        "conflicting_event_payload"
                    ));
                    xsollaError(res, 400, "INVALID_PARAMETER", "Conflicting event payload");
                    return;
                }
                if (existing.state === "processed") {
                    logger.info("Xsolla webhook duplicate acknowledged.", logContext(
                        payload, notificationType, eventId, userId, now, "duplicate"
                    ));
                    res.status(204).end();
                    return;
                }
                if (existing.state !== "processing" || Date.now() >= claimDeadline) {
                    throw new Error("Xsolla concurrent claim did not resolve.");
                }
                await wait(claimPoll);
            }
        } catch {
            logger.error("Xsolla webhook atomic claim is unavailable.", logContext(
                payload, notificationType, eventId, userId, now,
                "idempotence_claim_unavailable"
            ));
            xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
            return;
        }

        const processedAt = safeTimestamp(now);
        let processingResult = "validated_no_business_handler";
        if (typeof processEvent === "function") {
            try {
                processingResult = await processEvent({
                    payload,
                    notificationType,
                    eventId,
                    userId,
                    processedAt
                });
                if (typeof processingResult !== "string" ||
                    !/^[a-z0-9_]+$/.test(processingResult)) {
                    throw new Error("Xsolla event processor returned an invalid result.");
                }
            } catch (error) {
                try {
                    await releaseXsollaEvent(eventStore, eventId, claimToken);
                } catch {
                    // The tokenized claim expires safely if Redis is unavailable.
                }
                if (error instanceof XsollaInvalidUserError) {
                    logger.warn("Xsolla payment rejected for an unknown user.", logContext(
                        payload, notificationType, eventId, userId, now, "invalid_user"
                    ));
                    xsollaError(res, 400, "INVALID_USER", "Invalid user");
                    return;
                }
                logger.error("Xsolla webhook business processing failed.", logContext(
                    payload, notificationType, eventId, userId, now,
                    "business_processing_failed"
                ));
                xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
                return;
            }
        }

        try {
            const completed = await completeXsollaEvent(eventStore, eventId, claimToken, {
                notificationType,
                eventId,
                processedAt,
                payloadHash,
                result: processingResult
            });
            if (!completed) {
                throw new Error("Xsolla event claim could not be promoted.");
            }
        } catch {
            try {
                await releaseXsollaEvent(eventStore, eventId, claimToken);
            } catch {
                // A completed record cannot be deleted by the tokenized release operation.
            }
            logger.error("Xsolla webhook idempotence write is unavailable.", logContext(
                payload, notificationType, eventId, userId, now,
                "idempotence_write_unavailable"
            ));
            xsollaError(res, 500, "WEBHOOK_UNAVAILABLE", "Webhook unavailable");
            return;
        }

        logger.info("Xsolla webhook processed.", logContext(
            payload, notificationType, eventId, userId, now, processingResult
        ));
        res.status(204).end();
    };
}
