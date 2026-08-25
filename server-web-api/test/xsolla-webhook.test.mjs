import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import {
    createMemoryXsollaEventStore,
    createRedisXsollaEventStore,
    createXsollaWebhookHandler,
    getXsollaEventId,
    hasProcessedXsollaEvent,
    markXsollaEventProcessed,
    parseXsollaPayload,
    verifyXsollaSignature
} from "../src/xsolla-webhook.js";

const host = "127.0.0.1";
const fakeSecret = "fake-xsolla-webhook-secret-for-tests-only";
const projectId = "310966";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(testDirectory, "..");
const serverEntryPath = path.join(apiDirectory, "src", "server.js");
const webhookModulePath = path.join(apiDirectory, "src", "xsolla-webhook.js");

function signXsollaRawBody(rawBody, secret = fakeSecret) {
    return createHash("sha1")
        .update(rawBody)
        .update(secret, "utf8")
        .digest("hex");
}

async function unusedPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
    return port;
}

async function stopApi(api) {
    if (!api || api.child.exitCode !== null) {
        return;
    }
    api.child.kill();
    const exited = await Promise.race([
        once(api.child, "exit").then(() => true),
        delay(3000).then(() => false)
    ]);
    if (!exited && api.child.exitCode === null) {
        api.child.kill("SIGKILL");
        await once(api.child, "exit");
    }
}

async function startApi(options = {}) {
    const port = await unusedPort();
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [serverEntryPath], {
        cwd: apiDirectory,
        env: {
            ...process.env,
            NODE_ENV: "test",
            HOST: host,
            PORT: String(port),
            PUBLIC_SITE_ORIGIN: "https://www.seabyss.test",
            PLAYFAB_TITLE_ID: "local-test-title",
            PLAYFAB_SECRET_KEY: "local-test-playfab-secret",
            SESSION_SECRET: "local-test-session-secret-with-at-least-32-bytes",
            SEABYSS_ENV: "test",
            REDIS_URL: "",
            SESSION_TTL_SECONDS: "3600",
            UPSTREAM_TIMEOUT_MS: "1000",
            XSOLLA_WEBHOOK_SECRET: options.omitSecret ? "" : fakeSecret,
            XSOLLA_PROJECT_ID: options.omitProjectId ? "" : projectId,
            XSOLLA_PREMIUM_PLAN_ID: "321178",
            XSOLLA_PREMIUM_PLAN_EXTERNAL_ID: "NZSorpSt",
            PURCHASES_GLOBAL_ENABLED: "true",
            PURCHASES_DIAMOND_ENABLED: "true",
            PURCHASES_STARTER_ENABLED: "true",
            PURCHASES_PREMIUM_ENABLED: "true",
            PURCHASES_DOUBLER_ENABLED: "false",
            XSOLLA_HARDENED_CATALOG_ENABLED: "false",
            XSOLLA_CHECKOUT_ALLOWED_SKUS: "seabyss_starter_pack_1,seabyss_starter_pack_2,seabyss_starter_pack_3,seabyss_diamond_pack_1,seabyss_diamond_pack_2,seabyss_diamond_pack_3,seabyss_premium_bronze,seabyss_premium_silver,seabyss_premium_gold",
            XSOLLA_API_KEY: "",
            NODE_OPTIONS: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const api = {
        child,
        baseUrl: `http://${host}:${port}`,
        logs: () => stdout + "\n" + stderr
    };
    try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            if (child.exitCode !== null) {
                throw new Error("API exited during startup.\n" + api.logs());
            }
            try {
                const response = await fetch(api.baseUrl + "/health");
                if (response.ok) {
                    return api;
                }
            } catch {
                // The child process may still be binding its socket.
            }
            await delay(25);
        }
        throw new Error("API did not become ready.\n" + api.logs());
    } catch (error) {
        await stopApi(api);
        throw error;
    }
}

function payloadFor(notificationType, override = {}) {
    const payload = {
        notification_type: notificationType,
        settings: { project_id: Number(projectId) },
        user: {
            id: "player-test-id",
            external_id: "player-test-external-id"
        },
        transaction: { id: 900001 },
        subscription: { subscription_id: "subscription-test-1" },
        ...override
    };
    if (notificationType === "order_paid" || notificationType === "order_canceled") {
        delete payload.settings;
        payload.order = { id: 700001, mode: "sandbox" };
        payload.billing = {
            settings: { project_id: Number(projectId) },
            transaction: { id: 900001 }
        };
    }
    return payload;
}

async function sendWebhook(api, rawBody, options = {}) {
    const signature = options.signature === undefined
        ? signXsollaRawBody(rawBody)
        : options.signature;
    const headers = {
        "Content-Type": "application/json"
    };
    if (signature !== null) {
        headers.Authorization = options.scheme
            ? `${options.scheme} ${signature}`
            : `Signature ${signature}`;
    }
    return fetch(api.baseUrl + "/xsolla/webhook", {
        method: "POST",
        headers,
        body: rawBody,
        redirect: "manual"
    });
}

describe("Xsolla webhook", { concurrency: false }, () => {
    let api;

    before(async () => {
        api = await startApi();
    });

    after(async () => {
        await stopApi(api);
    });

    test("valid signature is computed from the exact raw body and succeeds with 204", async () => {
        const rawBody = Buffer.from(
            '{\n  "notification_type": "payment", "settings": { "project_id": 310966 },\n' +
            '  "user": { "id": "player-test-id" }, "transaction": { "id": 101 }\n}',
            "utf8"
        );
        const response = await sendWebhook(api, rawBody);
        assert.equal(response.status, 204);
        assert.equal(await response.text(), "");
        assert.match(response.headers.get("cache-control") || "", /no-store/i);
    });

    test("invalid, missing, or incorrectly-prefixed signatures return INVALID_SIGNATURE", async () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor("payment")));
        for (const options of [
            { signature: "0".repeat(40) },
            { signature: null },
            { scheme: "Bearer" }
        ]) {
            const response = await sendWebhook(api, rawBody, options);
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), {
                error: { code: "INVALID_SIGNATURE", message: "Invalid signature" }
            });
        }
    });

    test("signature header format is exact and lowercase", () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor("payment")));
        const signature = signXsollaRawBody(rawBody);
        assert.equal(verifyXsollaSignature(rawBody, `Signature ${signature}`, fakeSecret), true);
        for (const header of [
            ` Signature ${signature}`,
            `Signature  ${signature}`,
            `Signature\t${signature}`,
            `Signature ${signature} `,
            `Signature ${signature.toUpperCase()}`
        ]) {
            assert.equal(verifyXsollaSignature(rawBody, header, fakeSecret), false, header);
        }
    });

    test("int64 JSON identifiers are preserved as exact canonical strings", () => {
        const cases = [
            ["4300000000", "number"],
            ["9007199254740991", "number"],
            ["9007199254740992", "string"],
            ["9223372036854775807", "string"]
        ];

        for (const [idText, expectedParsedType] of cases) {
            const rawBody = Buffer.from(
                `{"notification_type":"payment","transaction":{"id":${idText}}}`,
                "utf8"
            );
            const payload = parseXsollaPayload(rawBody);
            assert.equal(typeof payload.transaction.id, expectedParsedType, idText);
            assert.equal(
                getXsollaEventId(payload),
                `payment:transaction:${idText}`,
                idText
            );
        }

        const adjacentEventIds = ["9007199254740992", "9007199254740993"].map((idText) => {
            const payload = parseXsollaPayload(Buffer.from(
                `{"notification_type":"payment","transaction":{"id":${idText}}}`,
                "utf8"
            ));
            return getXsollaEventId(payload);
        });
        assert.deepEqual(adjacentEventIds, [
            "payment:transaction:9007199254740992",
            "payment:transaction:9007199254740993"
        ]);
        assert.equal(new Set(adjacentEventIds).size, 2);

        const alreadyRoundedNumber = JSON.parse(
            '{"id":9223372036854775807}'
        ).id;
        assert.equal(Number.isSafeInteger(alreadyRoundedNumber), false);
        assert.equal(getXsollaEventId({
            notification_type: "payment",
            transaction: { id: alreadyRoundedNumber }
        }), null);
        assert.throws(
            () => parseXsollaPayload(Buffer.from('{9223372036854775807:true}', "utf8")),
            SyntaxError
        );
    });

    test("lossless conversion is limited to canonical event identifier fields", async () => {
        const numericUserRawBody = Buffer.from(
            '{"notification_type":"payment","settings":{"project_id":310966},' +
            '"user":{"id":9223372036854775807},"transaction":{"id":102}}',
            "utf8"
        );
        const numericUserPayload = parseXsollaPayload(numericUserRawBody);
        assert.equal(typeof numericUserPayload.user.id, "number");
        assert.equal(typeof numericUserPayload.transaction.id, "number");
        const numericUserResponse = await sendWebhook(api, numericUserRawBody);
        assert.equal(numericUserResponse.status, 400);
        assert.deepEqual(await numericUserResponse.json(), {
            error: { code: "INVALID_USER", message: "Invalid user" }
        });

        const numericNotificationRawBody = Buffer.from(
            '{"notification_type":9223372036854775807,' +
            '"settings":{"project_id":310966},' +
            '"user":{"id":"player-int64-test"},"transaction":{"id":103}}',
            "utf8"
        );
        const numericNotificationPayload = parseXsollaPayload(numericNotificationRawBody);
        assert.equal(typeof numericNotificationPayload.notification_type, "number");
        const numericNotificationResponse = await sendWebhook(api, numericNotificationRawBody);
        assert.equal(numericNotificationResponse.status, 400);
        assert.deepEqual(await numericNotificationResponse.json(), {
            error: {
                code: "INVALID_PARAMETER",
                message: "Invalid notification type"
            }
        });
    });

    test("all numeric Xsolla event identifier paths preserve an int64 maximum", () => {
        const int64Maximum = "9223372036854775807";
        const cases = [
            [
                `{"notification_type":"payment","transaction":{"id":${int64Maximum}}}`,
                `payment:transaction:${int64Maximum}`
            ],
            [
                `{"notification_type":"refund","billing":{"transaction":{"id":${int64Maximum}}}}`,
                `refund:transaction:${int64Maximum}`
            ],
            [
                `{"notification_type":"order_paid","order":{"id":${int64Maximum}}}`,
                `order_paid:order:${int64Maximum}`
            ],
            [
                `{"notification_type":"order_canceled","order":{"id":${int64Maximum}}}`,
                `order_canceled:order:${int64Maximum}`
            ],
            [
                `{"notification_type":"create_subscription","subscription":{"subscription_id":${int64Maximum}}}`,
                `create_subscription:subscription:${int64Maximum}`
            ],
            [
                `{"notification_type":"update_subscription","purchase":{"subscription":{"subscription_id":${int64Maximum}}}}`,
                `update_subscription:subscription:${int64Maximum}`
            ],
            [
                `{"notification_type":"cancel_subscription","billing":{"purchase":{"subscription":{"subscription_id":${int64Maximum}}}}}`,
                `cancel_subscription:subscription:${int64Maximum}`
            ]
        ];

        for (const [rawJson, expectedEventId] of cases) {
            const payload = parseXsollaPayload(Buffer.from(rawJson, "utf8"));
            assert.equal(getXsollaEventId(payload), expectedEventId);
        }
    });

    test("max int64 keeps its exact raw signature and end-to-end event identity", async () => {
        const rawBody = Buffer.from(
            '{"notification_type":"payment","settings":{"project_id":310966},' +
            '"user":{"id":"player-int64-test"},' +
            '"transaction":{"id":9223372036854775807}}',
            "utf8"
        );
        const signature = signXsollaRawBody(rawBody);
        assert.equal(
            verifyXsollaSignature(rawBody, `Signature ${signature}`, fakeSecret),
            true
        );

        const response = await sendWebhook(api, rawBody, { signature });
        assert.equal(response.status, 204);
        const duplicateResponse = await sendWebhook(api, rawBody, { signature });
        assert.equal(duplicateResponse.status, 204);
        await delay(25);

        const exactEventIdHash = createHash("sha256")
            .update("payment:transaction:9223372036854775807")
            .digest("hex");
        assert.match(api.logs(), new RegExp(exactEventIdHash));

        const changedRawBody = Buffer.from(
            rawBody.toString("utf8").replace("9223372036854775807", "9223372036854775806"),
            "utf8"
        );
        assert.equal(
            verifyXsollaSignature(changedRawBody, `Signature ${signature}`, fakeSecret),
            false
        );
        const changedResponse = await sendWebhook(api, changedRawBody, { signature });
        assert.equal(changedResponse.status, 400);
        assert.equal((await changedResponse.json()).error.code, "INVALID_SIGNATURE");
    });

    test("Redis keys use exact string event IDs without int64 collisions", async () => {
        const setKeys = [];
        const fakeRedis = {
            async exists() {
                return 0;
            },
            async set(key, _value, options) {
                assert.equal(options.NX, true);
                setKeys.push(key);
                return "OK";
            }
        };
        const store = createRedisXsollaEventStore(fakeRedis, { ttlSeconds: 60 });
        const idTexts = [
            "4300000000",
            "9007199254740991",
            "9007199254740992",
            "9223372036854775807"
        ];

        for (const idText of idTexts) {
            const payload = parseXsollaPayload(Buffer.from(
                `{"notification_type":"payment","transaction":{"id":${idText}}}`,
                "utf8"
            ));
            const eventId = getXsollaEventId(payload);
            assert.equal(typeof eventId, "string");
            assert.equal(await markXsollaEventProcessed(store, eventId, {}), true);
        }

        assert.deepEqual(setKeys, idTexts.map((idText) =>
            `seabyss:xsolla:webhook:v1:payment%3Atransaction%3A${idText}`
        ));
        assert.equal(new Set(setKeys).size, idTexts.length);
        assert.equal(await markXsollaEventProcessed(store, 4300000000, {}), false);
        assert.equal(setKeys.length, idTexts.length);
    });

    test("changing raw JSON whitespace invalidates a signature made for another byte sequence", async () => {
        const canonical = Buffer.from(JSON.stringify(payloadFor("payment")));
        const changed = Buffer.from(JSON.stringify(payloadFor("payment"), null, 2));
        const response = await sendWebhook(api, changed, {
            signature: signXsollaRawBody(canonical)
        });
        assert.equal(response.status, 400);
    });

    test("missing server secret fails closed and never accepts a webhook", async () => {
        const withoutSecret = await startApi({ omitSecret: true });
        try {
            const rawBody = Buffer.from(JSON.stringify(payloadFor("payment")));
            const response = await sendWebhook(withoutSecret, rawBody);
            assert.equal(response.status, 500);
            assert.equal((await response.json()).error.code, "WEBHOOK_UNAVAILABLE");
            assert.match(withoutSecret.logs(), /XSOLLA_WEBHOOK_SECRET is not configured/);
            assert.doesNotMatch(withoutSecret.logs(), new RegExp(fakeSecret));
        } finally {
            await stopApi(withoutSecret);
        }
    });

    test("wrong project ID and signed invalid JSON are rejected after signature validation", async () => {
        const wrongProject = Buffer.from(JSON.stringify(payloadFor("payment", {
            settings: { project_id: 999999 }
        })));
        const wrongProjectResponse = await sendWebhook(api, wrongProject);
        assert.equal(wrongProjectResponse.status, 400);
        assert.equal((await wrongProjectResponse.json()).error.code, "INVALID_PARAMETER");

        const invalidJson = Buffer.from('{"notification_type":"payment"', "utf8");
        const invalidJsonResponse = await sendWebhook(api, invalidJson);
        assert.equal(invalidJsonResponse.status, 400);
        assert.equal((await invalidJsonResponse.json()).error.code, "INVALID_PARAMETER");
    });

    test("recognized notifications require their canonical stable event identifier", async () => {
        const paymentPayload = payloadFor("payment");
        delete paymentPayload.transaction;
        const orderPayload = payloadFor("order_paid");
        delete orderPayload.order.id;

        for (const payload of [
            paymentPayload,
            orderPayload
        ]) {
            const response = await sendWebhook(api, Buffer.from(JSON.stringify(payload)));
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), {
                error: { code: "INVALID_PARAMETER", message: "Invalid event identifier" }
            });
        }
    });

    test("non-reversal compatibility notifications are recognized", async () => {
        const types = [
            "payment",
            "create_subscription",
            "update_subscription",
            "cancel_subscription",
            "order_paid"
        ];
        for (const notificationType of types) {
            const rawBody = Buffer.from(JSON.stringify(payloadFor(notificationType)));
            const response = await sendWebhook(api, rawBody);
            assert.equal(response.status, 204, notificationType);
        }
        await delay(25);
        for (const notificationType of types) {
            assert.match(api.logs(), new RegExp(notificationType));
        }
    });

    test("orphan or malformed reversals fail closed and remain retryable", async () => {
        for (const notificationType of ["refund", "order_canceled"]) {
            const rawBody = Buffer.from(JSON.stringify(payloadFor(notificationType)));
            const first = await sendWebhook(api, rawBody);
            const retry = await sendWebhook(api, rawBody);
            assert.equal(first.status, 500, notificationType);
            assert.equal(retry.status, 500, notificationType);
            assert.equal((await first.json()).error.code, "WEBHOOK_UNAVAILABLE");
            assert.equal((await retry.json()).error.code, "WEBHOOK_UNAVAILABLE");
        }
    });

    test("user validation uses the injected account lookup and remains fail-closed", async () => {
        const accountLookupCalls = [];
        let eventStoreCalls = 0;
        const eventStore = {
            async hasProcessed() {
                eventStoreCalls += 1;
                return false;
            },
            async markProcessed() {
                eventStoreCalls += 1;
                return true;
            }
        };
        const invoke = async ({
            userId,
            lookupResult = true,
            lookupError = null,
            requestProjectId = projectId,
            authorizationSignature = null
        }) => {
            const rawBody = Buffer.from(JSON.stringify(payloadFor("user_validation", {
                settings: { project_id: Number(requestProjectId) },
                user: { id: userId }
            })));
            const signature = authorizationSignature || signXsollaRawBody(rawBody);
            const response = {
                statusCode: 0,
                jsonBody: null,
                ended: false,
                status(code) {
                    this.statusCode = code;
                    return this;
                },
                json(body) {
                    this.jsonBody = body;
                    return this;
                },
                end() {
                    this.ended = true;
                    return this;
                }
            };
            const handler = createXsollaWebhookHandler({
                webhookSecret: fakeSecret,
                projectId,
                eventStore,
                async validateUser(receivedUserId) {
                    accountLookupCalls.push(receivedUserId);
                    if (lookupError) {
                        throw lookupError;
                    }
                    return lookupResult;
                },
                logger: { info() {}, warn() {}, error() {} }
            });
            await handler({
                body: rawBody,
                get(name) {
                    return name.toLowerCase() === "authorization"
                        ? `Signature ${signature}`
                        : undefined;
                }
            }, response);
            return response;
        };

        const existing = await invoke({ userId: "ABCDEF123456" });
        assert.equal(existing.statusCode, 204);
        assert.equal(existing.ended, true);

        const missing = await invoke({ userId: "TESTUSER1", lookupResult: false });
        assert.equal(missing.statusCode, 400);
        assert.deepEqual(missing.jsonBody, {
            error: { code: "INVALID_USER", message: "Invalid user" }
        });

        const unavailable = await invoke({
            userId: "UNAVAILABLE123",
            lookupError: new Error("upstream unavailable")
        });
        assert.equal(unavailable.statusCode, 500);
        assert.deepEqual(unavailable.jsonBody, {
            error: { code: "WEBHOOK_UNAVAILABLE", message: "Webhook unavailable" }
        });

        const invalidLookupResult = await invoke({
            userId: "INVALIDRESULT123",
            lookupResult: "unexpected"
        });
        assert.equal(invalidLookupResult.statusCode, 500);
        assert.deepEqual(invalidLookupResult.jsonBody, {
            error: { code: "WEBHOOK_UNAVAILABLE", message: "Webhook unavailable" }
        });

        const callsBeforeRejectedRequests = accountLookupCalls.length;
        const badSignature = await invoke({
            userId: "ABCDEF123456",
            authorizationSignature: "0".repeat(40)
        });
        assert.equal(badSignature.statusCode, 400);
        assert.equal(accountLookupCalls.length, callsBeforeRejectedRequests);

        const wrongProject = await invoke({
            userId: "ABCDEF123456",
            requestProjectId: "310967"
        });
        assert.equal(wrongProject.statusCode, 400);
        assert.equal(accountLookupCalls.length, callsBeforeRejectedRequests);
        assert.deepEqual(accountLookupCalls, [
            "ABCDEF123456",
            "TESTUSER1",
            "UNAVAILABLE123",
            "INVALIDRESULT123"
        ]);
        assert.equal(eventStoreCalls, 0);
    });

    test("unknown signed notification is logged and acknowledged without retry pressure", async () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor("future_notification")));
        const response = await sendWebhook(api, rawBody);
        assert.equal(response.status, 204);
        await delay(25);
        assert.match(api.logs(), /ignored_unknown_notification/);
    });

    test("logs never contain the secret, full Authorization value, or raw sensitive fields", async () => {
        const sensitiveMarker = "card-or-payment-token-must-not-leak";
        const rawBody = Buffer.from(JSON.stringify({
            ...payloadFor("payment"),
            transaction: { id: 900009 },
            payment_token: sensitiveMarker
        }));
        const signature = signXsollaRawBody(rawBody);
        const response = await sendWebhook(api, rawBody, { signature });
        assert.equal(response.status, 204);
        await delay(25);
        assert.doesNotMatch(api.logs(), new RegExp(fakeSecret));
        assert.doesNotMatch(api.logs(), new RegExp(sensitiveMarker));
        assert.doesNotMatch(api.logs(), new RegExp(`Signature ${signature}`));
        const logs = api.logs();
        assert.doesNotMatch(logs, /player-test-id|player-test-external-id/);
        const expectedUserHash = createHash("sha256").update("player-test-id").digest("hex");
        const expectedEventHash = createHash("sha256")
            .update("payment:transaction:900009")
            .digest("hex");
        assert.match(logs, new RegExp(expectedUserHash));
        assert.match(logs, new RegExp(expectedEventHash));
    });

    test("idempotence helpers use the existing Redis interface and mark only after success", async () => {
        const values = new Map();
        const fakeRedis = {
            async exists(key) {
                return values.has(key) ? 1 : 0;
            },
            async get(key) {
                return values.get(key) ?? null;
            },
            async set(key, value, options) {
                assert.equal(options.NX, true);
                assert.ok(options.EX > 0);
                if (values.has(key)) {
                    return null;
                }
                values.set(key, value);
                return "OK";
            }
        };
        const store = createRedisXsollaEventStore(fakeRedis, { ttlSeconds: 60 });
        const eventId = getXsollaEventId(payloadFor("order_paid"));
        assert.equal(eventId, "order_paid:order:700001");
        assert.equal(await hasProcessedXsollaEvent(store, eventId), false);
        assert.equal(await markXsollaEventProcessed(store, eventId, {
            notificationType: "order_paid",
            payloadHash: "a".repeat(64),
            result: "validated_no_business_handler"
        }), true);
        assert.equal(await hasProcessedXsollaEvent(store, eventId), true);
        assert.equal(await markXsollaEventProcessed(store, eventId, {}), false);
    });

    test("development memory idempotence store admits a concurrent event only once", async () => {
        const store = createMemoryXsollaEventStore();
        const eventId = "payment:transaction:concurrent-test";
        const results = await Promise.all([
            markXsollaEventProcessed(store, eventId, { attempt: 1 }),
            markXsollaEventProcessed(store, eventId, { attempt: 2 })
        ]);
        assert.deepEqual(results.sort(), [false, true]);
    });

    test("recognized events fail closed when idempotence storage is unavailable", async () => {
        const rawBody = Buffer.from(JSON.stringify(payloadFor("payment")));
        const signature = signXsollaRawBody(rawBody);
        const invoke = async (eventStore) => {
            const response = {
                statusCode: 0,
                jsonBody: null,
                status(code) {
                    this.statusCode = code;
                    return this;
                },
                json(body) {
                    this.jsonBody = body;
                    return this;
                },
                end() {
                    return this;
                }
            };
            const handler = createXsollaWebhookHandler({
                webhookSecret: fakeSecret,
                projectId,
                eventStore,
                logger: { info() {}, warn() {}, error() {} }
            });
            await handler({
                body: rawBody,
                get(name) {
                    return name.toLowerCase() === "authorization"
                        ? `Signature ${signature}`
                        : undefined;
                }
            }, response);
            return response;
        };

        const unavailableStores = [
            null,
            {
                hasProcessed() {
                    throw new Error("lookup unavailable");
                },
                async markProcessed() {
                    return true;
                }
            },
            {
                async hasProcessed() {
                    return false;
                },
                markProcessed() {
                    throw new Error("write unavailable");
                }
            }
        ];

        for (const eventStore of unavailableStores) {
            const response = await invoke(eventStore);
            assert.equal(response.statusCode, 500);
            assert.deepEqual(response.jsonBody, {
                error: { code: "WEBHOOK_UNAVAILABLE", message: "Webhook unavailable" }
            });
        }
    });

    test("webhook module has no Unity, PlayFab, purchase, grant, or entitlement side effect", async () => {
        const source = await readFile(webhookModulePath, "utf8");
        assert.doesNotMatch(source, /Unity|World\.unity|PlayerShopEntitlement|PlayFab/i);
        assert.doesNotMatch(source, /\bgrant(?:ed|ing|s)?\b/i);
        assert.doesNotMatch(source, /checkout|pay\s*station/i);
    });
});
