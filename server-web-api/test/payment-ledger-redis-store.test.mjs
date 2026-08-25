import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPaymentLedger } from "../src/payment-ledger.js";
import {
    createRedisPaymentLedgerStore,
    PAYMENT_LEDGER_REDIS_SCRIPTS
} from "../src/payment-ledger-redis-store.js";

class AtomicRedisHarness {
    constructor() {
        this.values = new Map();
        this.sortedSets = new Map();
        this.epochs = new Map();
        this.calls = [];
    }

    async get(key) {
        return this.values.get(key) ?? null;
    }

    async mGet(keys) {
        return keys.map((key) => this.values.get(key) ?? null);
    }

    async zRange(key, start, stop) {
        return [...(this.sortedSets.get(key) || new Map()).entries()]
            .sort(([leftMember, leftScore], [rightMember, rightScore]) =>
                leftScore - rightScore || leftMember.localeCompare(rightMember))
            .slice(start, stop + 1)
            .map(([member]) => member);
    }

    async ping() {
        return "PONG";
    }

    zadd(key, score, member) {
        const values = this.sortedSets.get(key) || new Map();
        values.set(member, Number(score));
        this.sortedSets.set(key, values);
    }

    response(status, value = null) {
        return [status, value === null ? "" : JSON.stringify(value)];
    }

    async eval(script, { keys, arguments: args }) {
        const marker = script.split("\n", 1)[0];
        this.calls.push({ marker, keys: [...keys], arguments: [...args] });
        if (marker.includes("INSERT_TRANSACTION")) {
            const existingText = this.values.get(keys[0]);
            if (existingText) {
                const existing = JSON.parse(existingText);
                return existing.immutableHash === args[1]
                    ? this.response("existing", existing.record)
                    : this.response("conflict");
            }
            const wrapper = JSON.parse(args[0]);
            this.values.set(keys[0], args[0]);
            for (const key of keys.slice(1)) this.zadd(key, args[2], args[3]);
            return this.response("created", wrapper.record);
        }
        if (marker.includes("MUTATE_TRANSACTION")) {
            const wrapperText = this.values.get(keys[0]);
            if (!wrapperText) return this.response("missing");
            const wrapper = JSON.parse(wrapperText);
            const record = wrapper.record;
            const command = JSON.parse(args[3]);
            const now = Number(args[2]);
            if (args[0] && Number(args[0]) !== record.version) {
                return ["version_conflict", String(record.version)];
            }
            if (command.type === "acquire_lease") {
                const active = record.leaseToken && record.leaseExpiresAtUnixMs > now;
                if (active && record.leaseToken !== command.token) {
                    return this.response("busy", record);
                }
                if (!active) {
                    record.leaseOwner = command.owner;
                    record.leaseToken = command.token;
                    record.leaseExpiresAtUnixMs = now + command.ttlMilliseconds;
                    record.leaseEpoch += 1;
                    record.updatedAtUnixMs = now;
                    record.version += 1;
                    this.values.set(keys[0], JSON.stringify(wrapper));
                }
                return this.response("acquired", record);
            }
            if (command.type === "renew_lease") {
                if (record.leaseToken !== args[1] || record.leaseExpiresAtUnixMs <= now) {
                    return this.response("lease_conflict");
                }
                record.leaseExpiresAtUnixMs = now + command.ttlMilliseconds;
                record.updatedAtUnixMs = now;
                record.version += 1;
                this.values.set(keys[0], JSON.stringify(wrapper));
                return this.response("renewed", record);
            }
            if (command.type === "release_lease") {
                if (record.leaseToken !== args[1]) return this.response("lease_conflict");
                record.leaseOwner = null;
                record.leaseToken = null;
                record.leaseExpiresAtUnixMs = null;
                record.updatedAtUnixMs = now;
                record.version += 1;
                this.values.set(keys[0], JSON.stringify(wrapper));
                return this.response("released", record);
            }
            throw new Error(`Unsupported fake mutation ${command.type}`);
        }
        if (marker.includes("ACQUIRE_RESOURCE_LEASE")) {
            const existingText = this.values.get(keys[0]);
            const now = Number(args[0]);
            if (existingText) {
                const existing = JSON.parse(existingText);
                if (existing.expiresAtUnixMs > now) {
                    return this.response(existing.token === args[2] ? "acquired" : "busy", existing);
                }
            }
            const epoch = (this.epochs.get(keys[1]) || 0) + 1;
            this.epochs.set(keys[1], epoch);
            const lease = {
                resourceType: args[4],
                resourceId: args[5],
                owner: args[1],
                token: args[2],
                epoch,
                acquiredAtUnixMs: now,
                expiresAtUnixMs: now + Number(args[3])
            };
            this.values.set(keys[0], JSON.stringify(lease));
            return this.response("acquired", lease);
        }
        if (marker.includes("RENEW_RESOURCE_LEASE")) {
            const existing = JSON.parse(this.values.get(keys[0]) || "null");
            const now = Number(args[0]);
            if (!existing || existing.token !== args[1] || existing.expiresAtUnixMs <= now) {
                return this.response("lease_conflict");
            }
            existing.expiresAtUnixMs = now + Number(args[2]);
            this.values.set(keys[0], JSON.stringify(existing));
            return this.response("renewed", existing);
        }
        if (marker.includes("RELEASE_RESOURCE_LEASE")) {
            const existing = JSON.parse(this.values.get(keys[0]) || "null");
            if (!existing || existing.token !== args[0]) return this.response("lease_conflict");
            this.values.delete(keys[0]);
            return this.response("released", existing);
        }
        throw new Error(`Unexpected Redis script ${marker}`);
    }
}

class LuaCjsonEmptyArrayHarness extends AtomicRedisHarness {
    response(status, value = null) {
        if (value?.reversalIds && Array.isArray(value.reversalIds) &&
            value.reversalIds.length === 0) {
            return super.response(status, { ...value, reversalIds: {} });
        }
        return super.response(status, value);
    }
}

function transaction(providerTransactionId = "2119300001") {
    return {
        provider: "xsolla",
        providerTransactionId,
        orderId: `order-${providerTransactionId}`,
        receiptId: `receipt-${providerTransactionId}`,
        playFabId: "4DF88C225D91FE06",
        sku: "seabyss_starter_pack_1",
        planVersion: 1,
        planHash: "d".repeat(64),
        amountMinor: 399,
        currency: "USD",
        environment: "sandbox",
        createdAtUnixMs: 900
    };
}

describe("Redis atomic payment ledger adapter", () => {
    test("concurrent inserts and leases are performed through atomic scripts", async () => {
        let now = 1_000;
        const redis = new AtomicRedisHarness();
        const ledger = createPaymentLedger({
            store: createRedisPaymentLedgerStore(redis),
            nowMilliseconds: () => now
        });
        const inserted = await Promise.all(Array.from({ length: 10 }, () =>
            ledger.createTransaction(transaction())));
        assert.equal(inserted.filter((result) => result.status === "created").length, 1);
        assert.equal(inserted.filter((result) => result.status === "existing").length, 9);
        const identity = { provider: "xsolla", providerTransactionId: "2119300001" };
        const leases = await Promise.all(Array.from({ length: 10 }, (_, index) =>
            ledger.acquireLease(identity, {
                owner: `redis-worker-${index}`,
                token: `redis-token-${index}`,
                ttlMilliseconds: 100
            })));
        assert.equal(leases.filter((result) => result.status === "acquired").length, 1);
        assert.equal(leases.filter((result) => result.status === "busy").length, 9);
        now += 101;
        const promoted = await ledger.acquireLease(identity, {
            owner: "redis-worker-promoted",
            token: "redis-token-promoted",
            ttlMilliseconds: 100
        });
        assert.equal(promoted.record.leaseEpoch, 2);
        assert.ok(redis.calls.every((call) => call.marker.includes("PAYMENT_LEDGER_")));
    });

    test("index keys hash user/order/SKU values and pages can be read", async () => {
        const redis = new AtomicRedisHarness();
        const ledger = createPaymentLedger({
            store: createRedisPaymentLedgerStore(redis),
            nowMilliseconds: () => 1_000
        });
        await ledger.createTransaction(transaction());
        const result = await ledger.lookup({ playFabId: "4DF88C225D91FE06" });
        assert.equal(result.items.length, 1);
        const allKeys = redis.calls.flatMap((call) => call.keys);
        assert.ok(allKeys.every((key) => !key.includes("4DF88C225D91FE06")));
        assert.ok(allKeys.every((key) => !key.includes("seabyss_starter_pack_1")));
        assert.ok(allKeys.every((key) => !key.includes("order-2119300001")));
        assert.equal(await ledger.ping(), true);
    });

    test("resource leases use a persistent fencing epoch", async () => {
        let now = 2_000;
        const redis = new AtomicRedisHarness();
        const ledger = createPaymentLedger({
            store: createRedisPaymentLedgerStore(redis),
            nowMilliseconds: () => now
        });
        const first = await ledger.acquireResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            owner: "redis-a",
            token: "resource-a",
            ttlMilliseconds: 100
        });
        assert.equal(first.lease.epoch, 1);
        assert.equal((await ledger.acquireResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            owner: "redis-b",
            token: "resource-b",
            ttlMilliseconds: 100
        })).status, "busy");
        now += 101;
        const second = await ledger.acquireResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            owner: "redis-b",
            token: "resource-b",
            ttlMilliseconds: 100
        });
        assert.equal(second.lease.epoch, 2);
        await assert.rejects(ledger.releaseResourceLease({
            resourceType: "playfab-profile",
            resourceId: "4DF88C225D91FE06",
            token: "resource-a"
        }), (error) => error.code === "LEASE_LOST");
    });

    test("Lua cjson empty reversalIds objects normalize to arrays at every Redis boundary", async () => {
        const redis = new LuaCjsonEmptyArrayHarness();
        const ledger = createPaymentLedger({
            store: createRedisPaymentLedgerStore(redis),
            nowMilliseconds: () => 1_000
        });
        const created = await ledger.createTransaction(transaction("2119300090"));
        assert.deepEqual(created.record.reversalIds, []);

        const transactionEntry = [...redis.values.entries()]
            .find(([, value]) => JSON.parse(value)?.record?.providerTransactionId === "2119300090");
        assert.ok(transactionEntry);
        const wrapper = JSON.parse(transactionEntry[1]);
        wrapper.record.reversalIds = {};
        redis.values.set(transactionEntry[0], JSON.stringify(wrapper));
        const reloaded = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119300090"
        });
        assert.deepEqual(reloaded.reversalIds, []);
    });

    test("non-empty reversalIds objects remain corrupt and fail closed", async () => {
        const redis = new AtomicRedisHarness();
        const ledger = createPaymentLedger({ store: createRedisPaymentLedgerStore(redis) });
        await ledger.createTransaction(transaction("2119300091"));
        const transactionEntry = [...redis.values.entries()]
            .find(([, value]) => JSON.parse(value)?.record?.providerTransactionId === "2119300091");
        assert.ok(transactionEntry);
        const wrapper = JSON.parse(transactionEntry[1]);
        wrapper.record.reversalIds = { forged: "reversal" };
        redis.values.set(transactionEntry[0], JSON.stringify(wrapper));
        await assert.rejects(ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: "2119300091"
        }), /reversalIds is invalid/u);
    });

    test("every mutating Redis contract includes explicit atomic ownership checks", () => {
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.insertTransaction, /GET.*SET/s);
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.mutateTransaction, /leaseToken/s);
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.insertReversal, /reversedAmountMinor/s);
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.mutateReversal, /version_conflict/s);
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.acquireResourceLease, /INCR/s);
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.renewResourceLease, /lease_conflict/s);
        assert.match(PAYMENT_LEDGER_REDIS_SCRIPTS.releaseResourceLease, /DEL/s);
    });
});
