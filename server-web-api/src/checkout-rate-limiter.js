import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const CHECKOUT_RATE_LIMIT_LUA = `
local now = redis.call('TIME')
local seconds = tonumber(now[1])
local window = tonumber(ARGV[4])
local bucket = math.floor(seconds / window)
local userKey = ARGV[1] .. ':user:' .. ARGV[2] .. ':' .. bucket
local ipKey = ARGV[1] .. ':ip:' .. ARGV[3] .. ':' .. bucket
local userCount = redis.call('INCR', userKey)
if userCount == 1 then redis.call('EXPIRE', userKey, window + 1) end
local ipCount = redis.call('INCR', ipKey)
if ipCount == 1 then redis.call('EXPIRE', ipKey, window + 1) end
local userLimit = tonumber(ARGV[5])
local ipLimit = tonumber(ARGV[6])
local allowed = 0
if userCount <= userLimit and ipCount <= ipLimit then allowed = 1 end
local retryAfter = window - (seconds % window)
return { allowed, userCount, ipCount, retryAfter }
`;

function canonicalPlayFabId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 160 &&
        value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

export function normalizeCheckoutIp(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 64 ||
        value !== value.trim()) {
        return null;
    }
    let normalized = value.toLowerCase();
    if (normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4) {
        normalized = normalized.slice(7);
    }
    return isIP(normalized) ? normalized : null;
}

function digest(value) {
    return createHash("sha256").update(value, "utf8").digest("base64url");
}

function validateOptions({ windowSeconds, userLimit, ipLimit, keyPrefix }) {
    if (!Number.isInteger(windowSeconds) || windowSeconds <= 0 ||
        windowSeconds > 3600 || !Number.isInteger(userLimit) || userLimit <= 0 ||
        !Number.isInteger(ipLimit) || ipLimit <= 0 || ipLimit < userLimit ||
        typeof keyPrefix !== "string" || !/^[a-z0-9:_-]{1,80}$/.test(keyPrefix)) {
        throw new TypeError("Checkout rate-limit configuration is invalid.");
    }
}

function validateIdentity({ playFabId, ip } = {}) {
    const player = canonicalPlayFabId(playFabId);
    const address = normalizeCheckoutIp(ip);
    if (!player || !address) {
        throw new TypeError("Checkout rate limiting requires an authenticated user and IP.");
    }
    return Object.freeze({
        userDigest: digest(player),
        ipDigest: digest(address)
    });
}

function resultFromCounts(allowed, userCount, ipCount, retryAfterSeconds, limits) {
    const userExceeded = userCount > limits.userLimit;
    const ipExceeded = ipCount > limits.ipLimit;
    return Object.freeze({
        allowed,
        reason: userExceeded && ipExceeded
            ? "user_and_ip"
            : userExceeded ? "user" : ipExceeded ? "ip" : null,
        retryAfterSeconds,
        userRemaining: Math.max(0, limits.userLimit - userCount),
        ipRemaining: Math.max(0, limits.ipLimit - ipCount)
    });
}

export class CheckoutRateLimitUnavailableError extends Error {
    constructor(message = "Checkout rate limiting is unavailable.") {
        super(message);
        this.name = "CheckoutRateLimitUnavailableError";
        this.code = "CHECKOUT_RATE_LIMIT_UNAVAILABLE";
    }
}

export function createMemoryCheckoutRateLimiter({
    windowSeconds = 60,
    userLimit = 4,
    ipLimit = 20,
    keyPrefix = "seabyss:checkout:rate:v1",
    nowMilliseconds = () => Date.now()
} = {}) {
    validateOptions({ windowSeconds, userLimit, ipLimit, keyPrefix });
    if (typeof nowMilliseconds !== "function") {
        throw new TypeError("Checkout rate-limit clock is invalid.");
    }
    const counts = new Map();
    const windowMilliseconds = windowSeconds * 1000;
    const limits = Object.freeze({ userLimit, ipLimit });

    return Object.freeze({
        backend: "memory",
        async consume(identity) {
            const normalized = validateIdentity(identity);
            const now = nowMilliseconds();
            if (!Number.isSafeInteger(now) || now < 0) {
                throw new CheckoutRateLimitUnavailableError();
            }
            const bucket = Math.floor(now / windowMilliseconds);
            const userKey = `${keyPrefix}:user:${normalized.userDigest}:${bucket}`;
            const ipKey = `${keyPrefix}:ip:${normalized.ipDigest}:${bucket}`;
            const userCount = (counts.get(userKey) || 0) + 1;
            const ipCount = (counts.get(ipKey) || 0) + 1;
            counts.set(userKey, userCount);
            counts.set(ipKey, ipCount);
            const retryAfterSeconds = Math.max(
                1,
                Math.ceil((windowMilliseconds - (now % windowMilliseconds)) / 1000)
            );
            return resultFromCounts(
                userCount <= userLimit && ipCount <= ipLimit,
                userCount,
                ipCount,
                retryAfterSeconds,
                limits
            );
        }
    });
}

export function createRedisCheckoutRateLimiter({
    redisClient,
    windowSeconds = 60,
    userLimit = 4,
    ipLimit = 20,
    keyPrefix = "seabyss:checkout:rate:v1"
} = {}) {
    validateOptions({ windowSeconds, userLimit, ipLimit, keyPrefix });
    if (!redisClient || typeof redisClient.eval !== "function") {
        throw new TypeError("An atomic Redis client is required for checkout rate limiting.");
    }
    const limits = Object.freeze({ userLimit, ipLimit });

    return Object.freeze({
        backend: "redis",
        async consume(identity) {
            const normalized = validateIdentity(identity);
            let raw;
            try {
                raw = await redisClient.eval(CHECKOUT_RATE_LIMIT_LUA, {
                    keys: [],
                    arguments: [
                        keyPrefix,
                        normalized.userDigest,
                        normalized.ipDigest,
                        String(windowSeconds),
                        String(userLimit),
                        String(ipLimit)
                    ]
                });
            } catch {
                throw new CheckoutRateLimitUnavailableError();
            }
            if (!Array.isArray(raw) || raw.length !== 4) {
                throw new CheckoutRateLimitUnavailableError();
            }
            const values = raw.map(Number);
            const [allowed, userCount, ipCount, retryAfterSeconds] = values;
            if (!values.every(Number.isSafeInteger) ||
                (allowed !== 0 && allowed !== 1) || userCount <= 0 || ipCount <= 0 ||
                retryAfterSeconds <= 0 || retryAfterSeconds > windowSeconds) {
                throw new CheckoutRateLimitUnavailableError();
            }
            return resultFromCounts(
                allowed === 1,
                userCount,
                ipCount,
                retryAfterSeconds,
                limits
            );
        }
    });
}

/** Production never falls back to a process-local limiter. */
export function createCheckoutRateLimiter({
    environment = "development",
    redisClient = null,
    ...options
} = {}) {
    if (!new Set(["development", "test", "production"]).has(environment)) {
        throw new TypeError("Checkout rate-limit environment is invalid.");
    }
    if (redisClient) {
        return createRedisCheckoutRateLimiter({ redisClient, ...options });
    }
    if (environment === "production") {
        throw new CheckoutRateLimitUnavailableError(
            "Production checkout requires atomic Redis rate limiting."
        );
    }
    return createMemoryCheckoutRateLimiter(options);
}
