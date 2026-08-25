import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createMemoryXsollaStarterReservationStore,
    createRedisXsollaStarterReservationStore
} from "../src/xsolla-starter-reservation-store.js";

const playFabId = "4DF88C225D91FE06";
const xsollaSku = "seabyss_starter_pack_1";

describe("Xsolla Starter reservation store", () => {
    test("admits exactly one of ten concurrent reservations", async () => {
        const store = createMemoryXsollaStarterReservationStore();
        const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
            store.reserve({
                playFabId,
                xsollaSku,
                reservationId: `reservation-${index}`
            })
        ));
        assert.equal(results.filter((result) =>
            result.status === "reserved" && result.existing === false
        ).length, 1);
        assert.equal(results.filter((result) => result.status === "pending").length, 9);
        assert.equal((await store.read({ playFabId, xsollaSku })).state, "pending");
    });

    test("is idempotent for the same reservation and token-checks release", async () => {
        const store = createMemoryXsollaStarterReservationStore();
        const input = { playFabId, xsollaSku, reservationId: "reservation-a" };
        assert.equal((await store.reserve(input)).existing, false);
        const replay = await store.reserve(input);
        assert.equal(replay.status, "reserved");
        assert.equal(replay.existing, true);
        assert.equal(await store.release({ ...input, reservationId: "reservation-b" }), false);
        assert.equal(await store.release(input), true);
        assert.equal(await store.read({ playFabId, xsollaSku }), null);
    });

    test("expires only pending reservations by TTL", async () => {
        let now = 1000;
        const store = createMemoryXsollaStarterReservationStore({
            ttlSeconds: 10,
            nowMilliseconds: () => now
        });
        await store.reserve({ playFabId, xsollaSku, reservationId: "reservation-old" });
        now = 10999;
        assert.equal((await store.read({ playFabId, xsollaSku })).reservationId, "reservation-old");
        now = 11000;
        assert.equal(await store.read({ playFabId, xsollaSku }), null);
        const fresh = await store.reserve({
            playFabId,
            xsollaSku,
            reservationId: "reservation-new"
        });
        assert.equal(fresh.existing, false);
    });

    test("settles matching reservations once and detects duplicate paid orders", async () => {
        const store = createMemoryXsollaStarterReservationStore();
        await store.reserve({ playFabId, xsollaSku, reservationId: "reservation-a" });
        assert.equal((await store.settlePaid({
            playFabId,
            xsollaSku,
            reservationId: "reservation-a",
            transactionId: "800001"
        })).status, "accepted");
        assert.equal((await store.settlePaid({
            playFabId,
            xsollaSku,
            reservationId: "reservation-a",
            transactionId: "800001"
        })).status, "replayed");
        assert.equal((await store.settlePaid({
            playFabId,
            xsollaSku,
            reservationId: "reservation-b",
            transactionId: "800002"
        })).status, "duplicate_paid");
        assert.equal((await store.reserve({
            playFabId,
            xsollaSku,
            reservationId: "reservation-c"
        })).status, "owned");
    });

    test("distinguishes pending conflict, missing reservation, and explicit legacy acceptance", async () => {
        const pending = createMemoryXsollaStarterReservationStore();
        await pending.reserve({ playFabId, xsollaSku, reservationId: "reservation-a" });
        assert.equal((await pending.settlePaid({
            playFabId,
            xsollaSku,
            reservationId: "reservation-b",
            transactionId: "800003"
        })).status, "pending_conflict");

        const missing = createMemoryXsollaStarterReservationStore();
        assert.equal((await missing.settlePaid({
            playFabId,
            xsollaSku,
            transactionId: "800004"
        })).status, "reservation_missing");
        assert.equal((await missing.settlePaid({
            playFabId,
            xsollaSku,
            transactionId: "800004",
            requireReservation: false
        })).status, "accepted_unreserved");
    });

    test("fails closed on malformed users, SKUs, reservations, and transactions", async () => {
        const store = createMemoryXsollaStarterReservationStore();
        for (const input of [
            { playFabId: ` ${playFabId}`, xsollaSku, reservationId: "r" },
            { playFabId, xsollaSku: "constructor", reservationId: "r" },
            { playFabId, xsollaSku, reservationId: " " }
        ]) {
            await assert.rejects(store.reserve(input));
        }
        await assert.rejects(store.settlePaid({
            playFabId,
            xsollaSku,
            transactionId: "001"
        }));
    });

    test("uses Redis NX+EX and an atomic settlement script", async () => {
        const calls = [];
        let stored = null;
        const redis = {
            async set(key, value, options) {
                calls.push({ operation: "set", key, value, options });
                if (stored !== null) return null;
                stored = value;
                return "OK";
            },
            async get(key) {
                calls.push({ operation: "get", key });
                return stored;
            },
            async eval(script, options) {
                calls.push({ operation: "eval", script, options });
                if (script.includes("cjson.decode")) {
                    stored = options.arguments[3];
                    return ["accepted", stored];
                }
                stored = null;
                return 1;
            }
        };
        const store = createRedisXsollaStarterReservationStore(redis, {
            ttlSeconds: 30,
            nowMilliseconds: () => 1000
        });
        const reserved = await store.reserve({
            playFabId,
            xsollaSku,
            reservationId: "reservation-redis"
        });
        assert.equal(reserved.status, "reserved");
        assert.deepEqual(calls[0].options, { NX: true, EX: 30 });
        const settled = await store.settlePaid({
            playFabId,
            xsollaSku,
            reservationId: "reservation-redis",
            transactionId: "800005"
        });
        assert.equal(settled.status, "accepted");
        assert.equal(settled.record.state, "owned");
        assert.equal(calls.at(-1).operation, "eval");
    });
});
