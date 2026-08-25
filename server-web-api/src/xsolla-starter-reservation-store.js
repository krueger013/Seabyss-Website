import { createHash } from "node:crypto";
import { XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID } from "./xsolla-starter-packs.js";

export const XSOLLA_STARTER_RESERVATION_SCHEMA_VERSION = 1;
export const XSOLLA_STARTER_RESERVATION_DEFAULT_TTL_SECONDS = 15 * 60;

function canonicalString(value, maximumLength = 160) {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximumLength && value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

function canonicalStarterSku(value) {
    const sku = canonicalString(value, 255);
    return sku && Object.hasOwn(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID, sku)
        ? sku
        : null;
}

function canonicalTransactionId(value) {
    const normalized = canonicalString(value);
    if (!normalized || !/^[1-9][0-9]*$/.test(normalized)) {
        return null;
    }
    try {
        return BigInt(normalized) <= 9223372036854775807n ? normalized : null;
    } catch {
        return null;
    }
}

function validateIdentity({ playFabId, xsollaSku } = {}) {
    const user = canonicalString(playFabId);
    const sku = canonicalStarterSku(xsollaSku);
    if (!user || !sku) {
        throw new TypeError("A canonical legacy PlayFabId and Starter SKU are required.");
    }
    return { playFabId: user, xsollaSku: sku };
}

function keySuffix(playFabId, xsollaSku) {
    return createHash("sha256")
        .update(playFabId, "utf8")
        .update("\0", "utf8")
        .update(xsollaSku, "utf8")
        .digest("base64url");
}

function pendingRecord(xsollaSku, reservationId, nowMilliseconds, ttlMilliseconds) {
    return Object.freeze({
        schemaVersion: XSOLLA_STARTER_RESERVATION_SCHEMA_VERSION,
        state: "pending",
        xsollaSku,
        reservationId,
        createdAtUnixMs: nowMilliseconds,
        expiresAtUnixMs: nowMilliseconds + ttlMilliseconds
    });
}

function ownedRecord(xsollaSku, reservationId, transactionId, nowMilliseconds) {
    return Object.freeze({
        schemaVersion: XSOLLA_STARTER_RESERVATION_SCHEMA_VERSION,
        state: "owned",
        xsollaSku,
        reservationId: reservationId || null,
        transactionId,
        settledAtUnixMs: nowMilliseconds
    });
}

function parseRecord(value) {
    let record;
    try {
        record = typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        throw new Error("Starter reservation record is malformed.");
    }
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        record.schemaVersion !== XSOLLA_STARTER_RESERVATION_SCHEMA_VERSION ||
        !canonicalStarterSku(record.xsollaSku)) {
        throw new Error("Starter reservation record is invalid.");
    }
    if (record.state === "pending" && canonicalString(record.reservationId) &&
        Number.isSafeInteger(record.createdAtUnixMs) &&
        Number.isSafeInteger(record.expiresAtUnixMs) &&
        record.expiresAtUnixMs > record.createdAtUnixMs) {
        return record;
    }
    if (record.state === "owned" && canonicalTransactionId(record.transactionId) &&
        (record.reservationId === null || canonicalString(record.reservationId)) &&
        Number.isSafeInteger(record.settledAtUnixMs)) {
        return record;
    }
    throw new Error("Starter reservation record is invalid.");
}

function reserveResult(record, status, existing) {
    return Object.freeze({ status, existing, record: Object.freeze({ ...record }) });
}

function settlementResult(status, record = null) {
    return Object.freeze({
        status,
        record: record ? Object.freeze({ ...record }) : null
    });
}

export function createMemoryXsollaStarterReservationStore({
    ttlSeconds = XSOLLA_STARTER_RESERVATION_DEFAULT_TTL_SECONDS,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 ||
        typeof nowMilliseconds !== "function") {
        throw new TypeError("Starter reservation TTL and clock are invalid.");
    }
    const ttlMilliseconds = ttlSeconds * 1000;
    const records = new Map();

    function readActive(key) {
        const record = records.get(key) || null;
        const now = nowMilliseconds();
        if (record?.state === "pending" && now >= record.expiresAtUnixMs) {
            records.delete(key);
            return null;
        }
        return record;
    }

    return Object.freeze({
        async reserve({ playFabId, xsollaSku, reservationId } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const reservation = canonicalString(reservationId);
            if (!reservation) {
                throw new TypeError("A canonical server reservation ID is required.");
            }
            const key = keySuffix(identity.playFabId, identity.xsollaSku);
            const existing = readActive(key);
            if (existing?.state === "owned") {
                return reserveResult(existing, "owned", true);
            }
            if (existing?.state === "pending") {
                return reserveResult(
                    existing,
                    existing.reservationId === reservation ? "reserved" : "pending",
                    true
                );
            }
            const now = nowMilliseconds();
            if (!Number.isSafeInteger(now) || now < 0) {
                throw new Error("Starter reservation clock is invalid.");
            }
            const record = pendingRecord(identity.xsollaSku, reservation, now, ttlMilliseconds);
            records.set(key, record);
            return reserveResult(record, "reserved", false);
        },

        async read({ playFabId, xsollaSku } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const record = readActive(keySuffix(identity.playFabId, identity.xsollaSku));
            return record ? Object.freeze({ ...record }) : null;
        },

        async release({ playFabId, xsollaSku, reservationId } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const reservation = canonicalString(reservationId);
            if (!reservation) {
                throw new TypeError("A canonical server reservation ID is required.");
            }
            const key = keySuffix(identity.playFabId, identity.xsollaSku);
            const record = readActive(key);
            if (!record || record.state !== "pending" ||
                record.reservationId !== reservation) {
                return false;
            }
            records.delete(key);
            return true;
        },

        async settlePaid({
            playFabId,
            xsollaSku,
            reservationId = null,
            transactionId,
            requireReservation = true
        } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const transaction = canonicalTransactionId(transactionId);
            const reservation = reservationId === null
                ? null
                : canonicalString(reservationId);
            if (!transaction || (reservationId !== null && !reservation) ||
                typeof requireReservation !== "boolean") {
                throw new TypeError("Starter paid-settlement identifiers are invalid.");
            }
            const key = keySuffix(identity.playFabId, identity.xsollaSku);
            const existing = readActive(key);
            if (existing?.state === "owned") {
                return settlementResult(
                    existing.transactionId === transaction ? "replayed" : "duplicate_paid",
                    existing
                );
            }
            if (existing?.state === "pending") {
                if (!reservation || existing.reservationId !== reservation) {
                    return settlementResult("pending_conflict", existing);
                }
                const record = ownedRecord(
                    identity.xsollaSku,
                    reservation,
                    transaction,
                    nowMilliseconds()
                );
                records.set(key, record);
                return settlementResult("accepted", record);
            }
            if (requireReservation) {
                return settlementResult("reservation_missing");
            }
            const record = ownedRecord(
                identity.xsollaSku,
                reservation,
                transaction,
                nowMilliseconds()
            );
            records.set(key, record);
            return settlementResult("accepted_unreserved", record);
        }
    });
}

const redisReleaseScript = `
local existing = redis.call("GET", KEYS[1])
if existing == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
`;

const redisSettleScript = `
local existing = redis.call("GET", KEYS[1])
if not existing then
    if ARGV[1] == "1" then
        return {"reservation_missing", ""}
    end
    redis.call("SET", KEYS[1], ARGV[4])
    return {"accepted_unreserved", ARGV[4]}
end
local ok, decoded = pcall(cjson.decode, existing)
if not ok or type(decoded) ~= "table" then
    return {"invalid", existing}
end
if decoded.state == "owned" then
    if tostring(decoded.transactionId) == ARGV[3] then
        return {"replayed", existing}
    end
    return {"duplicate_paid", existing}
end
if decoded.state ~= "pending" then
    return {"invalid", existing}
end
if ARGV[2] == "" or tostring(decoded.reservationId) ~= ARGV[2] then
    return {"pending_conflict", existing}
end
redis.call("SET", KEYS[1], ARGV[4])
return {"accepted", ARGV[4]}
`;

export function createRedisXsollaStarterReservationStore(redisClient, {
    prefix = "seabyss:xsolla:starter-reservation:v1:",
    ttlSeconds = XSOLLA_STARTER_RESERVATION_DEFAULT_TTL_SECONDS,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!redisClient || typeof redisClient.set !== "function" ||
        typeof redisClient.get !== "function" || typeof redisClient.eval !== "function" ||
        !canonicalString(prefix, 512) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0 ||
        typeof nowMilliseconds !== "function") {
        throw new TypeError("Redis Starter reservation store is not configured.");
    }
    const ttlMilliseconds = ttlSeconds * 1000;
    const keyFor = (playFabId, xsollaSku) => prefix + keySuffix(playFabId, xsollaSku);

    return Object.freeze({
        async reserve({ playFabId, xsollaSku, reservationId } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const reservation = canonicalString(reservationId);
            if (!reservation) {
                throw new TypeError("A canonical server reservation ID is required.");
            }
            const now = nowMilliseconds();
            const record = pendingRecord(identity.xsollaSku, reservation, now, ttlMilliseconds);
            const key = keyFor(identity.playFabId, identity.xsollaSku);
            const serialized = JSON.stringify(record);
            const written = await redisClient.set(key, serialized, { NX: true, EX: ttlSeconds });
            if (written === "OK") {
                return reserveResult(record, "reserved", false);
            }
            const existingText = await redisClient.get(key);
            if (existingText === null) {
                return this.reserve({ playFabId, xsollaSku, reservationId });
            }
            const existing = parseRecord(existingText);
            if (existing.state === "owned") {
                return reserveResult(existing, "owned", true);
            }
            return reserveResult(
                existing,
                existing.reservationId === reservation ? "reserved" : "pending",
                true
            );
        },

        async read({ playFabId, xsollaSku } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const serialized = await redisClient.get(keyFor(identity.playFabId, identity.xsollaSku));
            return serialized === null ? null : Object.freeze({ ...parseRecord(serialized) });
        },

        async release({ playFabId, xsollaSku, reservationId } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const reservation = canonicalString(reservationId);
            if (!reservation) {
                throw new TypeError("A canonical server reservation ID is required.");
            }
            const key = keyFor(identity.playFabId, identity.xsollaSku);
            const existing = await redisClient.get(key);
            if (existing === null) {
                return false;
            }
            const parsed = parseRecord(existing);
            if (parsed.state !== "pending" || parsed.reservationId !== reservation) {
                return false;
            }
            return Number(await redisClient.eval(redisReleaseScript, {
                keys: [key],
                arguments: [existing]
            })) === 1;
        },

        async settlePaid({
            playFabId,
            xsollaSku,
            reservationId = null,
            transactionId,
            requireReservation = true
        } = {}) {
            const identity = validateIdentity({ playFabId, xsollaSku });
            const transaction = canonicalTransactionId(transactionId);
            const reservation = reservationId === null
                ? null
                : canonicalString(reservationId);
            if (!transaction || (reservationId !== null && !reservation) ||
                typeof requireReservation !== "boolean") {
                throw new TypeError("Starter paid-settlement identifiers are invalid.");
            }
            const now = nowMilliseconds();
            const owned = ownedRecord(identity.xsollaSku, reservation, transaction, now);
            const result = await redisClient.eval(redisSettleScript, {
                keys: [keyFor(identity.playFabId, identity.xsollaSku)],
                arguments: [
                    requireReservation ? "1" : "0",
                    reservation || "",
                    transaction,
                    JSON.stringify(owned)
                ]
            });
            if (!Array.isArray(result) || result.length < 2 ||
                typeof result[0] !== "string" || result[0] === "invalid") {
                throw new Error("Redis Starter paid settlement returned an invalid result.");
            }
            return settlementResult(
                result[0],
                result[1] ? parseRecord(result[1]) : null
            );
        }
    });
}
