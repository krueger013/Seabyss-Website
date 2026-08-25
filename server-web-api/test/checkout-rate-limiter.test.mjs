import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    CHECKOUT_RATE_LIMIT_LUA,
    CheckoutRateLimitUnavailableError,
    createCheckoutRateLimiter,
    createMemoryCheckoutRateLimiter,
    createRedisCheckoutRateLimiter,
    normalizeCheckoutIp
} from "../src/checkout-rate-limiter.js";

const playFabId = "46789223F9CB1BB9";

describe("checkout user and IP rate limiting", () => {
    test("memory limiter atomically enforces the user budget under concurrency", async () => {
        const limiter = createMemoryCheckoutRateLimiter({
            windowSeconds: 60,
            userLimit: 3,
            ipLimit: 20,
            nowMilliseconds: () => 12_000
        });
        const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
            limiter.consume({ playFabId, ip: `203.0.113.${index + 1}` })
        ));
        assert.equal(results.filter((result) => result.allowed).length, 3);
        assert.equal(results.filter((result) => result.reason === "user").length, 7);
        assert.equal(results.at(-1).userRemaining, 0);
    });

    test("separately enforces shared IP budget across authenticated users", async () => {
        const limiter = createMemoryCheckoutRateLimiter({
            windowSeconds: 60,
            userLimit: 2,
            ipLimit: 3,
            nowMilliseconds: () => 1_000
        });
        const results = [];
        for (let index = 0; index < 4; index += 1) {
            results.push(await limiter.consume({
                playFabId: `PLAYER000000000${index}`,
                ip: "198.51.100.20"
            }));
        }
        assert.deepEqual(results.map((result) => result.allowed), [true, true, true, false]);
        assert.equal(results[3].reason, "ip");
    });

    test("normalizes IPv4-mapped addresses and expires stale fixed windows", async () => {
        let now = 59_000;
        const limiter = createMemoryCheckoutRateLimiter({
            windowSeconds: 60,
            userLimit: 1,
            ipLimit: 2,
            nowMilliseconds: () => now
        });
        assert.equal(normalizeCheckoutIp("::ffff:203.0.113.8"), "203.0.113.8");
        assert.equal(normalizeCheckoutIp("2001:DB8::1"), "2001:db8::1");
        assert.equal(
            (await limiter.consume({ playFabId, ip: "::ffff:203.0.113.8" })).allowed,
            true
        );
        assert.equal(
            (await limiter.consume({ playFabId, ip: "203.0.113.8" })).allowed,
            false
        );
        now = 60_000;
        assert.equal(
            (await limiter.consume({ playFabId, ip: "203.0.113.8" })).allowed,
            true
        );
    });

    test("rejects fake or malformed identities before consuming a budget", async () => {
        const limiter = createMemoryCheckoutRateLimiter();
        for (const identity of [
            { playFabId: " PLAYER", ip: "203.0.113.9" },
            { playFabId, ip: "not-an-ip" },
            { playFabId, ip: "203.0.113.9:443" },
            { ip: "203.0.113.9", claimedPlayFabId: playFabId }
        ]) {
            await assert.rejects(limiter.consume(identity), TypeError);
        }
    });

    test("uses one Redis Lua operation with hashed user and IP identifiers", async () => {
        const calls = [];
        const redisClient = {
            async eval(script, options) {
                calls.push({ script, options });
                return [1, 1, 2, 47];
            }
        };
        const limiter = createRedisCheckoutRateLimiter({
            redisClient,
            windowSeconds: 60,
            userLimit: 4,
            ipLimit: 20
        });
        const result = await limiter.consume({ playFabId, ip: "203.0.113.10" });
        assert.equal(result.allowed, true);
        assert.equal(result.retryAfterSeconds, 47);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].script, CHECKOUT_RATE_LIMIT_LUA);
        assert.deepEqual(calls[0].options.keys, []);
        assert.equal(calls[0].options.arguments.includes(playFabId), false);
        assert.equal(calls[0].options.arguments.includes("203.0.113.10"), false);
        assert.equal(calls[0].options.arguments[3], "60");
        assert.equal(calls[0].options.arguments[4], "4");
        assert.equal(calls[0].options.arguments[5], "20");
    });

    test("fails closed in production without Redis and on ambiguous Redis outcomes", async () => {
        assert.throws(
            () => createCheckoutRateLimiter({ environment: "production" }),
            CheckoutRateLimitUnavailableError
        );
        assert.equal(
            createCheckoutRateLimiter({ environment: "test" }).backend,
            "memory"
        );

        for (const evalImpl of [
            async () => { throw new Error("redis unavailable"); },
            async () => [1, 1],
            async () => [2, 1, 1, 10],
            async () => [1, 0, 1, 10]
        ]) {
            const limiter = createRedisCheckoutRateLimiter({
                redisClient: { eval: evalImpl }
            });
            await assert.rejects(
                limiter.consume({ playFabId, ip: "203.0.113.11" }),
                CheckoutRateLimitUnavailableError
            );
        }
    });
});
