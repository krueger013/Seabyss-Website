import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createRedisServerEconomyPocPlayerLeases,
    SERVER_ECONOMY_POC_REDIS_PLAYER_LEASE_SCRIPTS
} from "../src/server-economy-poc-redis-player-leases.js";

const PLAYER = "SANDBOX_PLAYER_01";

function digest(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

class PlayerLeaseRedisHarness {
    constructor(now = 1_000) {
        this.now = now;
        this.values = new Map();
        this.expires = new Map();
        this.epochs = new Map();
        this.calls = [];
    }

    advance(milliseconds) {
        this.now += milliseconds;
    }

    purge(key) {
        const expiresAt = this.expires.get(key);
        if (expiresAt !== undefined && expiresAt <= this.now) {
            this.values.delete(key);
            this.expires.delete(key);
        }
    }

    raw(key) {
        this.purge(key);
        return this.values.get(key) ?? null;
    }

    writeLease(key, lease, ttl) {
        this.values.set(key, JSON.stringify(lease));
        this.expires.set(key, this.now + ttl);
    }

    parseLease(key, player) {
        const raw = this.raw(key);
        if (raw === null) return { status: "missing", raw: null, lease: null };
        let lease;
        try { lease = JSON.parse(raw); } catch { return { status: "corrupt", raw, lease: null }; }
        const expected = [
            "acquiredAtUnixMs", "epoch", "expiresAtUnixMs", "owner",
            "playFabId", "schemaVersion", "tokenDigest"
        ];
        if (!lease || typeof lease !== "object" || Array.isArray(lease) ||
            JSON.stringify(Object.keys(lease).sort()) !== JSON.stringify(expected) ||
            lease.schemaVersion !== 1 || lease.playFabId !== player ||
            typeof lease.owner !== "string" || lease.owner.length === 0 ||
            typeof lease.tokenDigest !== "string" || !/^[a-f0-9]{64}$/u.test(lease.tokenDigest) ||
            !Number.isSafeInteger(lease.epoch) || lease.epoch <= 0 ||
            !Number.isSafeInteger(lease.acquiredAtUnixMs) || lease.acquiredAtUnixMs < 0 ||
            !Number.isSafeInteger(lease.expiresAtUnixMs) ||
            lease.expiresAtUnixMs <= lease.acquiredAtUnixMs) {
            return { status: "corrupt", raw, lease: null };
        }
        return { status: "found", raw, lease };
    }

    response(status, raw = null) {
        return [status, raw || ""];
    }

    async sendCommand(command) {
        assert.equal(command[0], "EVAL");
        const marker = command[1].split("\n", 1)[0];
        const keyCount = Number(command[2]);
        const keys = command.slice(3, 3 + keyCount);
        const args = command.slice(3 + keyCount);
        this.calls.push({ marker, keys: [...keys], args: [...args] });

        if (marker.includes("ACQUIRE")) {
            const [player, owner, tokenDigest, ttlRaw, minimumEpochExclusiveRaw] = args;
            const existing = this.parseLease(keys[0], player);
            if (existing.status === "corrupt") return this.response("corrupt");
            if (existing.lease && !this.expires.has(keys[0])) return this.response("corrupt");
            if (existing.lease && existing.lease.expiresAtUnixMs > this.now) {
                if (existing.lease.tokenDigest === tokenDigest) {
                    return existing.lease.owner === owner
                        ? this.response("acquired", existing.raw)
                        : this.response("corrupt");
                }
                return this.response("busy", existing.raw);
            }
            const epoch = Math.max(
                this.epochs.get(keys[1]) || 0,
                Number(minimumEpochExclusiveRaw)
            ) + 1;
            this.epochs.set(keys[1], epoch);
            const ttl = Number(ttlRaw);
            const lease = {
                schemaVersion: 1,
                playFabId: player,
                owner,
                tokenDigest,
                epoch,
                acquiredAtUnixMs: this.now,
                expiresAtUnixMs: this.now + ttl
            };
            this.writeLease(keys[0], lease, ttl);
            return this.response("acquired", JSON.stringify(lease));
        }

        const player = args[0];
        const current = this.parseLease(keys[0], player);
        if (current.status === "corrupt") return this.response("corrupt");
        if (marker.includes("INSPECT")) {
            if (current.lease && !this.expires.has(keys[0])) return this.response("corrupt");
            return current.lease ? this.response("found", current.raw) : this.response("missing");
        }
        if (!current.lease) return this.response("stale");
        const tokenDigest = args[1];
        const epoch = Number(args[2]);
        const active = current.lease.tokenDigest === tokenDigest &&
            current.lease.epoch === epoch && current.lease.expiresAtUnixMs > this.now &&
            (this.expires.get(keys[0]) ?? -1) > this.now;
        if (!active) return this.response("stale", current.raw);

        if (marker.includes("ASSERT_CURRENT")) return this.response("current", current.raw);
        if (marker.includes("RENEW")) {
            const ttl = Number(args[3]);
            current.lease.expiresAtUnixMs = this.now + ttl;
            this.writeLease(keys[0], current.lease, ttl);
            return this.response("renewed", JSON.stringify(current.lease));
        }
        if (marker.includes("RELEASE")) {
            this.values.delete(keys[0]);
            this.expires.delete(keys[0]);
            return this.response("released", current.raw);
        }
        throw new Error(`Unexpected script ${marker}`);
    }
}

function leases(redis = new PlayerLeaseRedisHarness(), overrides = {}) {
    return {
        redis,
        store: createRedisServerEconomyPocPlayerLeases({ redis, ...overrides })
    };
}

describe("Redis server economy POC player leases", () => {
    test("requires a Redis command interface and a canonical untagged prefix", () => {
        assert.throws(() => createRedisServerEconomyPocPlayerLeases(), TypeError);
        assert.throws(() => createRedisServerEconomyPocPlayerLeases({ redis: {} }), TypeError);
        assert.throws(() => createRedisServerEconomyPocPlayerLeases({
            redis: new PlayerLeaseRedisHarness(), prefix: "bad{prefix}:"
        }), TypeError);
    });

    test("acquires epoch one, keeps the epoch key persistent, and never stores the raw token", async () => {
        const { redis, store } = leases();
        const token = "RAW_TOKEN_MUST_NEVER_BE_STORED";
        const acquired = await store.acquire({
            playFabId: PLAYER,
            owner: "WORKER_A",
            token,
            ttlMilliseconds: 2_000
        });
        assert.equal(acquired.status, "acquired");
        assert.equal(acquired.lease.epoch, 1);
        assert.equal(acquired.lease.token, token);
        const call = redis.calls.at(-1);
        assert.equal(call.keys.length, 2);
        assert.equal(call.keys.some((key) => key.includes(PLAYER)), false);
        assert.equal(redis.expires.has(call.keys[0]), true);
        assert.equal(redis.expires.has(call.keys[1]), false);
        const raw = redis.values.get(call.keys[0]);
        assert.doesNotMatch(raw, new RegExp(token, "u"));
        assert.equal(JSON.parse(raw).tokenDigest, digest(token));
        assert.equal(store.storesRawToken, false);
        assert.equal(store.persistentFencingEpoch, true);
    });

    test("same token is idempotent while another token is busy without extending the TTL", async () => {
        const { redis, store } = leases();
        const input = {
            playFabId: PLAYER, owner: "WORKER_A", token: "TOKEN_A", ttlMilliseconds: 5_000
        };
        const first = await store.acquire(input);
        const expiry = first.lease.expiresAtUnixMs;
        redis.advance(100);
        const replay = await store.acquire(input);
        assert.equal(replay.status, "acquired");
        assert.equal(replay.lease.epoch, 1);
        assert.equal(replay.lease.expiresAtUnixMs, expiry);
        const busy = await store.acquire({ ...input, owner: "WORKER_B", token: "TOKEN_B" });
        assert.equal(busy.status, "busy");
        assert.equal(busy.lease.epoch, 1);
        assert.equal(Object.hasOwn(busy.lease, "token"), false);
        assert.equal(busy.lease.tokenDigest, digest("TOKEN_A"));
    });

    test("renews and asserts only the exact token digest and epoch", async () => {
        const { redis, store } = leases();
        const acquired = await store.acquire({
            playFabId: PLAYER, owner: "WORKER_A", token: "TOKEN_A", ttlMilliseconds: 2_000
        });
        redis.advance(500);
        const renewed = await store.renew({
            playFabId: PLAYER,
            token: "TOKEN_A",
            epoch: acquired.lease.epoch,
            ttlMilliseconds: 3_000
        });
        assert.equal(renewed.status, "renewed");
        assert.equal(renewed.lease.expiresAtUnixMs, redis.now + 3_000);
        const current = await store.assertCurrent({
            playFabId: PLAYER, token: "TOKEN_A", epoch: 1
        });
        assert.equal(current.status, "current");
        assert.equal(current.lease.tokenDigest, digest("TOKEN_A"));
        await assert.rejects(store.assertCurrent({
            playFabId: PLAYER, token: "WRONG_TOKEN", epoch: 1
        }), (error) => error.code === "POC_STALE_WRITER" && error.retryable === true);
        await assert.rejects(store.renew({
            playFabId: PLAYER, token: "TOKEN_A", epoch: 2, ttlMilliseconds: 2_000
        }), (error) => error.code === "POC_STALE_WRITER");
    });

    test("expired takeover advances the persistent epoch and fences the old worker", async () => {
        const { redis, store } = leases();
        await store.acquire({
            playFabId: PLAYER, owner: "WORKER_A", token: "TOKEN_A", ttlMilliseconds: 1_000
        });
        redis.advance(1_001);
        await assert.rejects(store.assertCurrent({
            playFabId: PLAYER, token: "TOKEN_A", epoch: 1
        }), (error) => error.code === "POC_STALE_WRITER");
        const takeover = await store.acquire({
            playFabId: PLAYER, owner: "WORKER_B", token: "TOKEN_B", ttlMilliseconds: 1_000
        });
        assert.equal(takeover.lease.epoch, 2);
        await assert.rejects(store.renew({
            playFabId: PLAYER, token: "TOKEN_A", epoch: 1, ttlMilliseconds: 1_000
        }), (error) => error.code === "POC_STALE_WRITER");
        assert.deepEqual(await store.release({
            playFabId: PLAYER, token: "TOKEN_A", epoch: 1
        }), { status: "stale" });
        assert.equal((await store.assertCurrent({
            playFabId: PLAYER, token: "TOKEN_B", epoch: 2
        })).status, "current");
    });

    test("acquire advances atomically above a provider epoch floor without ever decreasing", async () => {
        const { redis, store } = leases();
        const recovered = await store.acquire({
            playFabId: PLAYER,
            owner: "RECOVERY_WORKER",
            token: "RECOVERY_TOKEN",
            ttlMilliseconds: 2_000,
            minimumEpochExclusive: 7
        });
        assert.equal(recovered.lease.epoch, 8);
        assert.equal(redis.calls.at(-1).args.at(-1), "7");
        await store.release({
            playFabId: PLAYER,
            token: "RECOVERY_TOKEN",
            epoch: 8
        });
        const next = await store.acquire({
            playFabId: PLAYER,
            owner: "NEXT_WORKER",
            token: "NEXT_TOKEN",
            ttlMilliseconds: 2_000,
            minimumEpochExclusive: 3
        });
        assert.equal(next.lease.epoch, 9);
        await assert.rejects(store.assertCurrent({
            playFabId: PLAYER,
            token: "RECOVERY_TOKEN",
            epoch: 8
        }), { code: "POC_STALE_WRITER" });
    });
    test("release removes only the live lease while the next acquisition advances the epoch", async () => {
        const { store } = leases();
        const first = await store.acquire({
            playFabId: PLAYER, owner: "WORKER_A", token: "TOKEN_A", ttlMilliseconds: 5_000
        });
        assert.equal((await store.inspect(PLAYER)).epoch, 1);
        assert.equal((await store.release({
            playFabId: PLAYER, token: "TOKEN_A", epoch: first.lease.epoch
        })).status, "released");
        assert.equal(await store.inspect(PLAYER), null);
        const next = await store.acquire({
            playFabId: PLAYER, owner: "WORKER_B", token: "TOKEN_B", ttlMilliseconds: 5_000
        });
        assert.equal(next.lease.epoch, 2);
    });

    test("corrupt JSON, mismatched identity, and a lease without TTL fail closed", async () => {
        const { redis, store } = leases();
        await store.acquire({
            playFabId: PLAYER, owner: "WORKER_A", token: "TOKEN_A", ttlMilliseconds: 5_000
        });
        const leaseKey = redis.calls[0].keys[0];
        redis.values.set(leaseKey, "not-json");
        await assert.rejects(store.inspect(PLAYER), (error) => error.code === "POC_REDIS_LEASE_CORRUPT");

        const valid = {
            schemaVersion: 1,
            playFabId: "OTHER_PLAYER",
            owner: "WORKER_A",
            tokenDigest: digest("TOKEN_A"),
            epoch: 1,
            acquiredAtUnixMs: redis.now,
            expiresAtUnixMs: redis.now + 5_000
        };
        redis.values.set(leaseKey, JSON.stringify(valid));
        await assert.rejects(store.inspect(PLAYER), (error) => error.code === "POC_REDIS_LEASE_CORRUPT");

        valid.playFabId = PLAYER;
        redis.values.set(leaseKey, JSON.stringify(valid));
        redis.expires.delete(leaseKey);
        await assert.rejects(store.inspect(PLAYER), (error) => error.code === "POC_REDIS_LEASE_CORRUPT");
    });

    test("validates identities, epochs, and bounded TTLs before Redis", async () => {
        const { redis, store } = leases();
        await assert.rejects(store.acquire({
            playFabId: " bad", owner: "WORKER", token: "TOKEN", ttlMilliseconds: 1_000
        }), (error) => error.code === "POC_INVALID_ARGUMENT");
        await assert.rejects(store.acquire({
            playFabId: PLAYER, owner: "WORKER", token: "TOKEN", ttlMilliseconds: 999
        }), TypeError);
        await assert.rejects(store.acquire({
            playFabId: PLAYER, owner: "WORKER", token: "TOKEN", ttlMilliseconds: 300_001
        }), TypeError);
        await assert.rejects(store.assertCurrent({
            playFabId: PLAYER, token: "TOKEN", epoch: 0
        }), (error) => error.code === "POC_INVALID_ARGUMENT");
        await assert.rejects(store.acquire({
            playFabId: PLAYER,
            owner: "WORKER",
            token: "TOKEN",
            ttlMilliseconds: 1_000,
            minimumEpochExclusive: -1
        }), (error) => error.code === "POC_INVALID_ARGUMENT");
        assert.equal(redis.calls.length, 0);
    });

    test("exports atomic scripts with a persistent epoch and a read-only assertion", () => {
        const scripts = SERVER_ECONOMY_POC_REDIS_PLAYER_LEASE_SCRIPTS;
        assert.match(scripts.acquire, /redis\.call\('INCR', KEYS\[2\]\)/u);
        assert.match(scripts.acquire, /redis\.call\('SET', KEYS\[1\].*'PX'/su);
        assert.match(scripts.acquire, /current_epoch < minimum_epoch_exclusive/u);
        assert.doesNotMatch(scripts.acquire, /EXPIRE[^\n]*KEYS\[2\]/u);
        assert.match(scripts.assertCurrent, /redis\.call\('PTTL', KEYS\[1\]\)/u);
        assert.doesNotMatch(scripts.assertCurrent, /redis\.call\('(SET|DEL|INCR|EXPIRE|PEXPIRE)'/u);
        assert.match(scripts.renew, /tonumber\(lease\.epoch\) ~= tonumber\(ARGV\[3\]\)/u);
        assert.match(scripts.release, /tonumber\(lease\.epoch\) ~= tonumber\(ARGV\[3\]\)/u);
    });
});
