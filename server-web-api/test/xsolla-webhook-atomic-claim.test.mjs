import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    claimXsollaEvent,
    completeXsollaEvent,
    createMemoryXsollaEventStore,
    createRedisXsollaEventStore,
    createXsollaWebhookHandler,
    readXsollaEventState,
    releaseXsollaEvent
} from "../src/xsolla-webhook.js";

const secret = "atomic-test-secret";
const projectId = "310966";

function sign(rawBody) {
    return createHash("sha1").update(rawBody).update(secret, "utf8").digest("hex");
}

function payload({ transactionId = "2118000001", userId = "ABCDEF123456", project = 310966,
    sku = "seabyss_starter_pack_1" } = {}) {
    return {
        notification_type: "payment",
        settings: { project_id: project },
        user: { id: userId },
        transaction: { id: transactionId },
        purchase: { order: { lineitems: [{ sku, quantity: 1 }] } }
    };
}

function response() {
    return {
        statusCode: 0,
        jsonBody: null,
        ended: false,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.jsonBody = value; return this; },
        end() { this.ended = true; return this; }
    };
}

async function invoke(handler, value) {
    const rawBody = Buffer.from(JSON.stringify(value));
    const res = response();
    await handler({
        body: rawBody,
        get(name) {
            return name.toLowerCase() === "authorization"
                ? `Signature ${sign(rawBody)}`
                : undefined;
        }
    }, res);
    return res;
}

function handler(options = {}) {
    return createXsollaWebhookHandler({
        webhookSecret: secret,
        projectId,
        eventStore: options.eventStore || createMemoryXsollaEventStore(),
        processEvent: options.processEvent,
        concurrentWaitMilliseconds: 1000,
        concurrentPollMilliseconds: 2,
        logger: { info() {}, warn() {}, error() {} }
    });
}

describe("Xsolla strict webhook inputs", () => {
    test("rejects array/object project IDs without String coercion", async () => {
        let processed = 0;
        const process = handler({ processEvent: async () => { processed += 1; return "ok"; } });
        const invalidProjects = [
            [310966],
            { value: 310966 },
            { toString: "310966" },
            true,
            " 310966"
        ];
        for (let index = 0; index < invalidProjects.length; index += 1) {
            const result = await invoke(process, payload({
                transactionId: String(2118000100 + index),
                project: invalidProjects[index]
            }));
            assert.equal(result.statusCode, 400);
            assert.deepEqual(result.jsonBody, {
                error: { code: "INVALID_PARAMETER", message: "Invalid project" }
            });
        }

        const mixedPaths = payload({ transactionId: "2118000199" });
        mixedPaths.billing = { settings: { project_id: [310966] } };
        assert.equal((await invoke(process, mixedPaths)).statusCode, 400);
        assert.equal(processed, 0);

        assert.equal((await invoke(process, payload({
            transactionId: "2118000200",
            project: "310966"
        }))).statusCode, 204);
        assert.equal(processed, 1);
    });

    test("rejects every whitespace-bearing user.id and order external_id", async () => {
        let processed = 0;
        const process = handler({ processEvent: async () => { processed += 1; return "ok"; } });
        for (const [index, userId] of [
            " ABCDEF123456",
            "ABCDEF123456 ",
            "ABC DEF123456",
            "ABCDEF\t123456",
            "\nABCDEF123456"
        ].entries()) {
            const result = await invoke(process, payload({
                transactionId: String(2118000300 + index),
                userId
            }));
            assert.equal(result.statusCode, 400);
            assert.equal(result.jsonBody.error.code, "INVALID_USER");
        }

        const order = {
            notification_type: "order_paid",
            user: { external_id: " ABCDEF123456" },
            order: { id: 811, mode: "default" },
            billing: {
                settings: { project_id: 310966 },
                transaction: { id: "2118000399" }
            },
            items: []
        };
        assert.equal((await invoke(process, order)).statusCode, 400);
        assert.equal(processed, 0);
    });
});

describe("Xsolla atomic webhook claims", () => {
    test("Promise.all replay x10 runs the processor exactly once", async () => {
        let processed = 0;
        const process = handler({
            async processEvent() {
                processed += 1;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return "starter_pack_sandbox_granted";
            }
        });
        const event = payload({ transactionId: "2118001001" });
        const results = await Promise.all(
            Array.from({ length: 10 }, () => invoke(process, event))
        );
        assert.deepEqual(results.map((result) => result.statusCode), Array(10).fill(204));
        assert.equal(processed, 1);
    });

    test("same transaction with a different signed payload is a conflict", async () => {
        let processed = 0;
        const process = handler({ processEvent: async () => { processed += 1; return "ok"; } });
        assert.equal((await invoke(process, payload({
            transactionId: "2118001002",
            sku: "seabyss_starter_pack_1"
        }))).statusCode, 204);
        const conflict = await invoke(process, payload({
            transactionId: "2118001002",
            sku: "seabyss_starter_pack_2"
        }));
        assert.equal(conflict.statusCode, 400);
        assert.deepEqual(conflict.jsonBody, {
            error: { code: "INVALID_PARAMETER", message: "Conflicting event payload" }
        });
        assert.equal(processed, 1);
    });

    test("a failed processor releases only its own claim and a retry can succeed", async () => {
        let attempts = 0;
        const process = handler({
            async processEvent() {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error("simulated persistence failure");
                }
                return "ok";
            }
        });
        const event = payload({ transactionId: "2118001003" });
        assert.equal((await invoke(process, event)).statusCode, 500);
        assert.equal((await invoke(process, event)).statusCode, 204);
        assert.equal(attempts, 2);
    });

    test("claim ownership and the default 300-second TTL prevent stale-owner promotion", async () => {
        let clock = 0;
        const store = createMemoryXsollaEventStore({ nowMilliseconds: () => clock });
        const eventId = "payment:transaction:claim-owner-test";
        const hash = "a".repeat(64);
        assert.equal((await claimXsollaEvent(store, eventId, {
            claimToken: "owner-one",
            payloadHash: hash
        })).acquired, true);

        clock = 299_999;
        assert.equal((await claimXsollaEvent(store, eventId, {
            claimToken: "owner-two",
            payloadHash: hash
        })).acquired, false);
        assert.equal(await completeXsollaEvent(store, eventId, "wrong-owner", {
            payloadHash: hash
        }), false);
        assert.equal(await releaseXsollaEvent(store, eventId, "wrong-owner"), false);

        clock = 300_001;
        assert.equal((await claimXsollaEvent(store, eventId, {
            claimToken: "owner-two",
            payloadHash: hash
        })).acquired, true);
        assert.equal(await completeXsollaEvent(store, eventId, "owner-one", {
            payloadHash: hash
        }), false);
        assert.equal(await completeXsollaEvent(store, eventId, "owner-two", {
            payloadHash: hash,
            result: "ok"
        }), true);
        assert.equal((await readXsollaEventState(store, eventId)).state, "processed");
    });

    test("Redis claim, promotion, and release are token-checked atomically", async () => {
        const values = new Map();
        const fakeRedis = {
            async get(key) { return values.get(key) ?? null; },
            async exists(key) { return values.has(key) ? 1 : 0; },
            async set(key, value, options) {
                if (options?.NX && values.has(key)) return null;
                values.set(key, value);
                return "OK";
            },
            async eval(_script, { keys: [key], arguments: args }) {
                if (args.length === 2) {
                    const existing = values.get(key);
                    if (existing !== undefined) return [0, existing];
                    values.set(key, args[0]);
                    return [1, ""];
                }
                if (args.length === 3) {
                    if (values.get(key) !== args[0]) return 0;
                    values.set(key, args[1]);
                    return 1;
                }
                if (args.length === 1) {
                    if (values.get(key) !== args[0]) return 0;
                    values.delete(key);
                    return 1;
                }
                throw new Error("unexpected eval");
            }
        };
        const first = createRedisXsollaEventStore(fakeRedis);
        const second = createRedisXsollaEventStore(fakeRedis);
        const eventId = "payment:transaction:redis-atomic";
        const hash = "b".repeat(64);
        assert.equal((await first.claim(eventId, {
            claimToken: "first",
            payloadHash: hash
        })).acquired, true);
        const competing = await second.claim(eventId, {
            claimToken: "second",
            payloadHash: hash
        });
        assert.equal(competing.acquired, false);
        assert.equal(competing.existing.state, "processing");
        assert.equal(await first.hasProcessed(eventId), false);
        assert.equal(await second.release(eventId, "second"), false);
        assert.equal(await first.complete(eventId, "first", {
            payloadHash: hash,
            result: "ok"
        }), true);
        assert.equal(await first.hasProcessed(eventId), true);

        values.set("seabyss:xsolla:webhook:v1:corrupt", JSON.stringify({
            state: "processed",
            result: "ok"
        }));
        await assert.rejects(first.read("corrupt"));
    });
});
