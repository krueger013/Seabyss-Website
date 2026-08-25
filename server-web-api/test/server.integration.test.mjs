import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { createClient } from "redis";

const loopbackHost = "127.0.0.1";
const allowedOrigin = "https://www.seabyss.test";
const xsollaProjectId = "310966";
const xsollaWebhookSecret = "fake-xsolla-webhook-secret-for-tests-only";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(testDirectory, "..");
const serverEntryPath = path.join(apiDirectory, "src", "server.js");
const fetchMockPreloadPath = path.join(testDirectory, "playfab-fetch-mock.mjs");
const fetchMockPreloadUrl = pathToFileURL(fetchMockPreloadPath).href;
const redisTestUrl = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6389/15";

function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
}

async function readJsonBody(req) {
    let raw = "";
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64 * 1024) {
            throw new Error("Mock PlayFab request exceeded 64 KiB.");
        }
    }
    return raw ? JSON.parse(raw) : {};
}

function modeFromEmail(email) {
    return String(email || "").split("@")[0].toLowerCase();
}

function successfulLoginPayload() {
    return {
        code: 200,
        data: {
            PlayFabId: "ABCDEF123456",
            SessionTicket: "session-ticket-must-not-leak",
            EntityToken: { EntityToken: "entity-token-must-not-leak" },
            NewlyCreated: false,
            InfoResultPayload: {
                AccountInfo: { Created: "2026-01-02T03:04:05Z" },
                PlayerProfile: { DisplayName: "Test Captain" }
            }
        }
    };
}

function successfulRegistrationPayload() {
    return {
        code: 200,
        data: {
            PlayFabId: "ABCDEF123456",
            Username: "Test Captain",
            SessionTicket: "registration-ticket-must-not-leak"
        }
    };
}

function successfulProfilePayload() {
    return {
        code: 200,
        data: {
            Data: {
                profile_v1: {
                    Value: JSON.stringify({
                        gold: 1234,
                        diamonds: 12,
                        sirenTears: 3,
                        xp: 900,
                        elitePoints: 4,
                        combatPoints: 55,
                        equippedEliteShipId: "elite_1",
                        cannons: [{ id: "carronade", equipped: 2 }],
                        npcKills: 10,
                        boardingCount: 2,
                        playerKills: 5,
                        privateServerField: "private-profile-field-must-not-leak"
                    })
                }
            }
        }
    };
}

function successfulAccountInfoPayload(playFabId) {
    return {
        code: 200,
        data: {
            UserInfo: { PlayFabId: playFabId }
        }
    };
}

async function sendScenario(res, mode, successPayload) {
    if (mode === "upstream429") {
        sendJson(res, 429, {
            code: 429,
            error: "TooManyRequests",
            errorMessage: "upstream-detail-must-not-leak"
        });
        return;
    }

    if (mode === "upstream500") {
        sendJson(res, 500, {
            code: 500,
            error: "InternalServerError",
            errorMessage: "upstream-detail-must-not-leak"
        });
        return;
    }

    if (mode === "invalidjson") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{not-valid-json");
        return;
    }

    if (mode === "redirect") {
        res.writeHead(302, { Location: "/redirect-target" });
        res.end();
        return;
    }

    if (mode === "timeout") {
        await delay(1250);
        if (!res.destroyed && !res.writableEnded) {
            sendJson(res, 200, successPayload);
        }
        return;
    }

    sendJson(res, 200, successPayload);
}

async function startPlayFabMock() {
    const state = {
        profileMode: "success",
        redirectHits: 0,
        requests: [],
        premiumInternalData: new Map()
    };

    const server = createServer((req, res) => {
        void (async () => {
            const requestUrl = new URL(req.url, "http://playfab.test");
            if (requestUrl.pathname === "/redirect-target") {
                state.redirectHits += 1;
                sendJson(res, 200, successfulLoginPayload());
                return;
            }

            const body = await readJsonBody(req);
            state.requests.push({
                path: requestUrl.pathname,
                headers: { ...req.headers },
                body
            });

            if (requestUrl.pathname === "/Client/LoginWithEmailAddress") {
                const mode = modeFromEmail(body.Email);
                if (mode === "invalid") {
                    sendJson(res, 400, {
                        code: 400,
                        error: "InvalidEmailOrPassword",
                        errorMessage: "upstream-detail-must-not-leak"
                    });
                    return;
                }
                await sendScenario(res, mode, successfulLoginPayload());
                return;
            }

            if (requestUrl.pathname === "/Client/RegisterPlayFabUser") {
                const mode = modeFromEmail(body.Email);
                if (mode === "duplicate") {
                    sendJson(res, 400, {
                        code: 400,
                        error: "AccountAlreadyExists",
                        errorMessage: "upstream-detail-must-not-leak"
                    });
                    return;
                }
                await sendScenario(res, mode, successfulRegistrationPayload());
                return;
            }

            if (requestUrl.pathname === "/Server/GetUserAccountInfo") {
                if (body.PlayFabId === "ABCDEF123456") {
                    sendJson(res, 200, successfulAccountInfoPayload(body.PlayFabId));
                    return;
                }
                const invalidParams = body.PlayFabId === "TESTUSER1";
                sendJson(res, 400, {
                    code: 400,
                    error: invalidParams ? "InvalidParams" : "AccountNotFound",
                    errorCode: invalidParams ? 1000 : 1001,
                    errorMessage: "upstream-detail-must-not-leak"
                });
                return;
            }

            if (requestUrl.pathname === "/Server/UpdateUserInternalData") {
                const playerData = state.premiumInternalData.get(body.PlayFabId) || new Map();
                for (const [key, value] of Object.entries(body.Data || {})) {
                    playerData.set(key, value);
                }
                state.premiumInternalData.set(body.PlayFabId, playerData);
                sendJson(res, 200, { code: 200, data: { DataVersion: playerData.size } });
                return;
            }

            if (requestUrl.pathname === "/Server/GetUserInternalData") {
                const premiumKeys = Array.isArray(body.Keys)
                    ? body.Keys.filter((key) => typeof key === "string" && (
                        key.startsWith("xsp1_") ||
                        key.startsWith("xspm1_") ||
                        key.startsWith("xsd1_") ||
                        key.startsWith("xss1_") ||
                        key.startsWith("xsp2_")
                    ))
                    : [];
                if (premiumKeys.length > 0) {
                    const playerData = state.premiumInternalData.get(body.PlayFabId) || new Map();
                    const data = {};
                    for (const key of premiumKeys) {
                        if (playerData.has(key)) {
                            data[key] = { Value: playerData.get(key) };
                        }
                    }
                    sendJson(res, 200, { code: 200, data: { Data: data } });
                    return;
                }

                await sendScenario(res, state.profileMode, successfulProfilePayload());
                return;
            }

            sendJson(res, 404, { code: 404, error: "MockRouteNotFound" });
        })().catch((error) => {
            if (!res.headersSent) {
                sendJson(res, 500, { code: 500, error: error.message });
            } else {
                res.destroy();
            }
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, loopbackHost, () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    return {
        server,
        state,
        baseUrl: "http://" + loopbackHost + ":" + address.port
    };
}

async function getUnusedPort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, loopbackHost, () => {
            server.off("error", reject);
            resolve();
        });
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

async function waitForApi(api, attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (api.spawnError) {
            throw api.spawnError;
        }
        if (api.child.exitCode !== null) {
            throw new Error("API exited during startup.\n" + api.logs());
        }

        try {
            const response = await fetch(api.baseUrl + "/health");
            if (response.ok) {
                return;
            }
        } catch {
            // The process may still be binding its local socket.
        }
        await delay(25);
    }

    throw new Error("API did not become ready.\n" + api.logs());
}

async function startApi(playFabMock, options = {}) {
    const port = options.port || await getUnusedPort();
    const nodeEnv = options.nodeEnv || "test";
    let stdout = "";
    let stderr = "";

    const child = spawn(process.execPath, ["--import", fetchMockPreloadUrl, serverEntryPath], {
        cwd: apiDirectory,
        env: {
            ...process.env,
            NODE_ENV: nodeEnv,
            HOST: loopbackHost,
            PORT: String(port),
            PUBLIC_SITE_ORIGIN: allowedOrigin,
            PLAYFAB_TITLE_ID: "local-test-title",
            PLAYFAB_SECRET_KEY: "local-test-secret",
            PLAYFAB_MOCK_BASE_URL: playFabMock.baseUrl,
            ALLOW_PRODUCTION_COOKIE_TEST: nodeEnv === "production" ? "1" : "",
            SESSION_SECRET: "local-test-session-secret-with-at-least-32-bytes",
            SEABYSS_ENV: "test",
            REDIS_URL: options.redisUrl || "",
            SESSION_TTL_SECONDS: "3600",
            UPSTREAM_TIMEOUT_MS: String(options.upstreamTimeoutMs || 1000),
            XSOLLA_WEBHOOK_SECRET: xsollaWebhookSecret,
            XSOLLA_PROJECT_ID: xsollaProjectId,
            XSOLLA_PREMIUM_PLAN_ID: "321178",
            XSOLLA_PREMIUM_PLAN_EXTERNAL_ID: "NZSorpSt",
            XSOLLA_ALLOW_SANDBOX_GRANTS: options.allowSandboxGrants === true ? "true" : "false",
            XSOLLA_SANDBOX_TEST_PLAYFAB_IDS: (options.sandboxTestPlayFabIds || []).join(","),
            XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS: options.allowStarterSandboxGrants === true ? "true" : "false",
            XSOLLA_STARTER_SANDBOX_TEST_PLAYFAB_IDS: (options.starterSandboxTestPlayFabIds || []).join(","),
            XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS: options.allowStarterProductionGrants === true ? "true" : "false",
            XSOLLA_ENABLE_STANDALONE_PREMIUM_PRODUCTS: options.enableStandalonePremiumProducts === true ? "true" : "false",
            PURCHASES_GLOBAL_ENABLED: nodeEnv === "production" ? "false" : "true",
            PURCHASES_DIAMOND_ENABLED: nodeEnv === "production" ? "false" : "true",
            PURCHASES_STARTER_ENABLED: nodeEnv === "production" ? "false" : "true",
            PURCHASES_PREMIUM_ENABLED: nodeEnv === "production" ? "false" : "true",
            PURCHASES_DOUBLER_ENABLED: "false",
            XSOLLA_HARDENED_CATALOG_ENABLED: "false",
            XSOLLA_CHECKOUT_ALLOWED_SKUS: "seabyss_starter_pack_1,seabyss_starter_pack_2,seabyss_starter_pack_3,seabyss_diamond_pack_1,seabyss_diamond_pack_2,seabyss_diamond_pack_3,seabyss_premium_bronze,seabyss_premium_silver,seabyss_premium_gold",
            XSOLLA_API_KEY: "",
            COOKIE_DOMAIN: "",
            NODE_OPTIONS: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });

    const api = {
        child,
        baseUrl: "http://" + loopbackHost + ":" + port,
        spawnError: null,
        logs: () => stdout + "\n" + stderr
    };
    child.on("error", (error) => {
        api.spawnError = error;
    });

    try {
        await waitForApi(api, options.startupAttempts || 200);
        return api;
    } catch (error) {
        await stopApi(api);
        throw error;
    }
}

async function closePlayFabMock(playFabMock) {
    if (!playFabMock?.server.listening) {
        return;
    }
    await new Promise((resolve) => {
        playFabMock.server.close(resolve);
        playFabMock.server.closeAllConnections?.();
    });
}

async function request(api, route, options = {}) {
    const headers = new Headers(options.headers || {});
    const origin = options.origin === undefined ? allowedOrigin : options.origin;
    if (origin) {
        headers.set("Origin", origin);
    }
    if (options.cookie) {
        headers.set("Cookie", options.cookie);
    }

    let body = options.body;
    if (Object.hasOwn(options, "json")) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(options.json);
    }

    return fetch(api.baseUrl + route, {
        method: options.method || "GET",
        headers,
        body,
        redirect: "manual"
    });
}

async function sendXsollaWebhook(api, payload, signatureOverride = null) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = signatureOverride || createHash("sha1")
        .update(rawBody)
        .update(xsollaWebhookSecret, "utf8")
        .digest("hex");
    return request(api, "/xsolla/webhook", {
        method: "POST",
        origin: null,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Signature ${signature}`
        },
        body: rawBody
    });
}

function xsollaPayload(notificationType, userId, projectId = xsollaProjectId) {
    return {
        notification_type: notificationType,
        settings: { project_id: Number(projectId) },
        user: { id: userId },
        transaction: { id: 4300000000 }
    };
}

function xsollaPremiumPayment({
    userId = "ABCDEF123456",
    transactionId = "9007199254740991",
    planId = "321178",
    externalId = "NZSorpSt",
    projectId = xsollaProjectId,
    dryRun = undefined
} = {}) {
    const transaction = {
        id: transactionId,
        payment_date: "2026-08-09T12:00:00Z"
    };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    return {
        notification_type: "payment",
        settings: { project_id: Number(projectId) },
        user: { id: userId },
        transaction,
        purchase: {
            subscription: {
                plan_id: planId,
                external_id: externalId,
                date_next_charge: "2026-09-09T12:00:00Z"
            }
        }
    };
}

function xsollaDiamondPayment({
    userId = "ABCDEF123456",
    transactionId = "2116001001",
    sku = "seabyss_diamond_pack_1",
    projectId = xsollaProjectId,
    dryRun = undefined,
    lineitems = undefined
} = {}) {
    const transaction = { id: transactionId };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    return {
        notification_type: "payment",
        settings: { project_id: Number(projectId) },
        user: { id: userId },
        transaction,
        purchase: {
            order: {
                id: 61001,
                lineitems: lineitems || [{
                    sku,
                    quantity: 999999,
                    price: { currency: "USD", amount: 1.99 }
                }]
            }
        }
    };
}

function xsollaStrictLineItemPayment({
    userId = "ABCDEF123456",
    transactionId = "2117001001",
    sku = "seabyss_starter_pack_1",
    projectId = xsollaProjectId,
    dryRun = undefined,
    quantity = 1,
    includeQuantity = true,
    lineitems = undefined,
    subscription = undefined
} = {}) {
    const transaction = { id: transactionId };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    const item = { sku };
    if (includeQuantity) {
        item.quantity = quantity;
    }
    const purchase = {
        order: {
            id: 62001,
            lineitems: lineitems || [item]
        }
    };
    if (subscription !== undefined) {
        purchase.subscription = subscription;
    }
    return {
        notification_type: "payment",
        settings: { project_id: Number(projectId) },
        user: { id: userId },
        transaction,
        purchase
    };
}

function xsollaDiamondOrderPaid({
    userId = "ABCDEF123456",
    transactionId = "2116001002",
    orderId = 61002,
    sku = "seabyss_diamond_pack_3",
    projectId = xsollaProjectId,
    mode = "default",
    dryRun = undefined,
    items = undefined
} = {}) {
    const transaction = { id: transactionId };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    return {
        notification_type: "order_paid",
        user: { external_id: userId },
        order: {
            id: orderId,
            mode,
            status: "paid"
        },
        billing: {
            notification_type: "payment",
            settings: { project_id: Number(projectId) },
            transaction
        },
        items: items || [
            { sku, type: "bundle", quantity: 999999 },
            {
                sku: "seabyss_diamonds",
                type: "virtual_currency",
                quantity: 1
            }
        ]
    };
}

function setCookieLines(response) {
    if (typeof response.headers.getSetCookie === "function") {
        return response.headers.getSetCookie();
    }
    const value = response.headers.get("set-cookie");
    return value ? [value] : [];
}

function sessionCookie(response, name) {
    const prefix = name + "=";
    const line = setCookieLines(response).find((value) => value.startsWith(prefix));
    assert.ok(line, "Expected " + name + " Set-Cookie header.");
    const pair = line.split(";", 1)[0];
    assert.notEqual(pair, name + "=", "Expected a non-empty " + name + " cookie.");
    return { line, pair };
}

function sessionIdFromCookie(cookie) {
    const encodedValue = cookie.slice(cookie.indexOf("=") + 1);
    const value = decodeURIComponent(encodedValue);
    assert.match(value, /^s:[^.]+\.[A-Za-z0-9+/]+$/);
    return value.slice(2, value.lastIndexOf("."));
}

function assertNoStore(response) {
    assert.match(response.headers.get("cache-control") || "", /(?:^|,)\s*no-store(?:,|$)/i);
    assert.equal(response.headers.get("pragma"), "no-cache");
}

function assertLocalRedisUrl(value) {
    const parsed = new URL(value);
    assert.equal(parsed.protocol, "redis:", "TEST_REDIS_URL must use redis://.");
    assert.ok(
        [loopbackHost, "localhost", "::1"].includes(parsed.hostname),
        "TEST_REDIS_URL must target a loopback host."
    );
}

describe("Seabyss web API integration", { concurrency: false }, () => {
    let playFabMock;
    let api;

    before(async () => {
        playFabMock = await startPlayFabMock();
        api = await startApi(playFabMock);
    });

    after(async () => {
        await stopApi(api);
        await closePlayFabMock(playFabMock);
    });

    test("health, Helmet, CORS and 404 behavior", async () => {
        const health = await request(api, "/health");
        assert.equal(health.status, 200);
        assert.match(health.headers.get("content-type") || "", /^application\/json\b/i);
        assert.equal(health.headers.get("access-control-allow-origin"), allowedOrigin);
        assert.equal(health.headers.get("access-control-allow-credentials"), "true");
        assert.equal(health.headers.get("x-content-type-options"), "nosniff");
        assert.equal(health.headers.get("x-frame-options"), "SAMEORIGIN");
        assert.ok(health.headers.get("content-security-policy"));
        assert.ok(health.headers.get("strict-transport-security"));
        assert.equal(health.headers.get("server"), null);
        assert.equal(health.headers.get("x-powered-by"), null);
        assert.deepEqual(await health.json(), {
            status: "ok",
            environment: "test",
            version: "0.1.0",
            payments: {
                globalEnabled: true,
                activationReady: false
            },
            progressiveFinancialDomains: {
                Diamonds: { mode: "Legacy", activationRequested: false, safe: true },
                Elite: { mode: "Legacy", activationRequested: false, safe: true },
                Premium: { mode: "Legacy", activationRequested: false, safe: true }
            }
        });

        const live = await request(api, "/health/live");
        assert.equal(live.status, 200);
        assert.equal((await live.json()).status, "alive");
        const ready = await request(api, "/health/ready");
        assert.equal(ready.status, 503);
        const readiness = await ready.json();
        assert.equal(readiness.status, "not_ready");
        assert.equal(readiness.checks.find(
            (check) => check.component === "diamonds_domain_target"
        ).reason, "legacy_composed_inactive_no_runtime_probe");
        assert.equal(readiness.checks.find(
            (check) => check.component === "offline_grant_worker"
        ).reason, "production_profile_cas_adapter_not_configured");
        assert.deepEqual(readiness.checks.find(
            (check) => check.component === "playfab_financial_authority_cutover"
        ), {
            component: "playfab_financial_authority_cutover", ok: false, reason: "kill_switch_disabled"
        });

        const denied = await request(api, "/health", { origin: "https://attacker.example" });
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { message: "CORS origin not allowed." });

        const missing = await request(api, "/not-a-route");
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { message: "Not found." });
    });

    test("Xsolla user validation uses PlayFabId without creating accounts or processing payments", async () => {
        const requestCountBefore = playFabMock.state.requests.length;

        const existing = await sendXsollaWebhook(
            api,
            xsollaPayload("user_validation", "ABCDEF123456")
        );
        assert.equal(existing.status, 204);
        assert.equal(await existing.text(), "");

        const missing = await sendXsollaWebhook(
            api,
            xsollaPayload("user_validation", "TESTUSER1")
        );
        assert.equal(missing.status, 400);
        assert.deepEqual(await missing.json(), {
            error: { code: "INVALID_USER", message: "Invalid user" }
        });

        const badSignature = await sendXsollaWebhook(
            api,
            xsollaPayload("user_validation", "ABCDEF123456"),
            "0".repeat(40)
        );
        assert.equal(badSignature.status, 400);
        assert.deepEqual(await badSignature.json(), {
            error: { code: "INVALID_SIGNATURE", message: "Invalid signature" }
        });

        const wrongProject = await sendXsollaWebhook(
            api,
            xsollaPayload("user_validation", "ABCDEF123456", "310967")
        );
        assert.equal(wrongProject.status, 400);
        assert.deepEqual(await wrongProject.json(), {
            error: { code: "INVALID_PARAMETER", message: "Invalid project" }
        });

        const payment = await sendXsollaWebhook(
            api,
            xsollaPayload("payment", "ABCDEF123456")
        );
        assert.equal(payment.status, 204);

        const webhookPlayFabRequests = playFabMock.state.requests.slice(requestCountBefore);
        assert.equal(webhookPlayFabRequests.length, 2);
        assert.ok(webhookPlayFabRequests.every(
            (entry) => entry.path === "/Server/GetUserAccountInfo"
        ));
        assert.deepEqual(webhookPlayFabRequests.map((entry) => entry.body), [
            { PlayFabId: "ABCDEF123456" },
            { PlayFabId: "TESTUSER1" }
        ]);
        assert.ok(webhookPlayFabRequests.every(
            (entry) => entry.headers["x-secretkey"] === "local-test-secret"
        ));
        assert.equal(webhookPlayFabRequests.some(
            (entry) => /Register|Create|Grant|Purchase/i.test(entry.path)
        ), false);

        const health = await request(api, "/health");
        assert.equal(health.status, 200);
        const session = await request(api, "/auth/session");
        assert.equal(session.status, 200);
        assert.equal((await session.json()).loggedIn, false);
    });

    test("validated Premium payment persists once offline; invalid and lifecycle events never grant", async () => {
        const requestsBefore = playFabMock.state.requests.length;
        const payload = xsollaPremiumPayment();
        const first = await sendXsollaWebhook(api, payload);
        assert.equal(first.status, 204);
        const duplicate = await sendXsollaWebhook(api, payload);
        assert.equal(duplicate.status, 204);

        const paymentRequests = playFabMock.state.requests.slice(requestsBefore);
        assert.deepEqual(paymentRequests.map((entry) => entry.path), [
            "/Server/GetUserAccountInfo",
            "/Server/UpdateUserInternalData",
            "/Server/GetUserInternalData"
        ]);
        const expectedKey = "xsp1_" + createHash("sha256")
            .update(payload.transaction.id, "utf8")
            .digest("base64url");
        const expectedValue = JSON.stringify({
            schemaVersion: 1,
            transactionId: payload.transaction.id,
            activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
        });
        assert.deepEqual(paymentRequests[1].body, {
            PlayFabId: "ABCDEF123456",
            Data: { [expectedKey]: expectedValue }
        });
        assert.equal(
            playFabMock.state.premiumInternalData.get("ABCDEF123456").get(expectedKey),
            expectedValue
        );

        const requestsAfterGrant = playFabMock.state.requests.length;
        const badSignature = await sendXsollaWebhook(api, {
            ...xsollaPremiumPayment({ transactionId: "9002" })
        }, "0".repeat(40));
        assert.equal(badSignature.status, 400);
        const wrongProject = await sendXsollaWebhook(api, xsollaPremiumPayment({
            transactionId: "9003",
            projectId: "310967"
        }));
        assert.equal(wrongProject.status, 400);
        const unknownPlan = await sendXsollaWebhook(api, xsollaPremiumPayment({
            transactionId: "9004",
            planId: "999999"
        }));
        assert.equal(unknownPlan.status, 204);
        assert.equal(playFabMock.state.requests.length, requestsAfterGrant);

        const invalidUser = await sendXsollaWebhook(api, xsollaPremiumPayment({
            transactionId: "9005",
            userId: "TESTUSER1"
        }));
        assert.equal(invalidUser.status, 400);
        assert.deepEqual(await invalidUser.json(), {
            error: { code: "INVALID_USER", message: "Invalid user" }
        });
        assert.equal(playFabMock.state.requests.at(-1).path, "/Server/GetUserAccountInfo");

        const writesBeforeLifecycle = playFabMock.state.requests.filter(
            (entry) => entry.path === "/Server/UpdateUserInternalData"
        ).length;
        const cancellation = await sendXsollaWebhook(api, {
            notification_type: "cancel_subscription",
            settings: { project_id: Number(xsollaProjectId) },
            user: { id: "ABCDEF123456" },
            subscription: { subscription_id: "sub-premium-1" }
        });
        assert.equal(cancellation.status, 204);
        const orphanRefund = {
            notification_type: "refund",
            settings: { project_id: Number(xsollaProjectId) },
            user: { id: "ABCDEF123456" },
            transaction: { id: "9007199254740991" }
        };
        const refundFirst = await sendXsollaWebhook(api, orphanRefund);
        const refundRetry = await sendXsollaWebhook(api, orphanRefund);
        assert.equal(refundFirst.status, 500);
        assert.equal(refundRetry.status, 500);
        assert.equal((await refundFirst.json()).error.code, "WEBHOOK_UNAVAILABLE");
        assert.equal((await refundRetry.json()).error.code, "WEBHOOK_UNAVAILABLE");
        const writesAfterLifecycle = playFabMock.state.requests.filter(
            (entry) => entry.path === "/Server/UpdateUserInternalData"
        ).length;
        assert.equal(writesAfterLifecycle, writesBeforeLifecycle);

        const health = await request(api, "/health");
        assert.equal(health.status, 200);
    });

    test("allowlisted Sandbox Premium is persisted once and all other Sandbox paths stay closed", async () => {
        const sandboxApi = await startApi(playFabMock, {
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: ["ABCDEF123456", "TESTUSER1"]
        });
        try {
            const requestsBefore = playFabMock.state.requests.length;
            const payload = xsollaPremiumPayment({
                transactionId: "2115295061",
                planId: "NZSorpSt",
                externalId: undefined,
                dryRun: 1
            });
            for (let index = 0; index < 10; index += 1) {
                const response = await sendXsollaWebhook(sandboxApi, payload);
                assert.equal(response.status, 204);
            }
            const grantRequests = playFabMock.state.requests.slice(requestsBefore);
            assert.deepEqual(grantRequests.map((entry) => entry.path), [
                "/Server/GetUserAccountInfo",
                "/Server/UpdateUserInternalData",
                "/Server/GetUserInternalData"
            ]);
            const digest = createHash("sha256")
                .update(payload.transaction.id, "utf8")
                .digest("base64url");
            const receiptKey = "xsp1_" + digest;
            const metadataKey = "xspm1_" + digest;
            assert.deepEqual(grantRequests[1].body, {
                PlayFabId: "ABCDEF123456",
                Data: {
                    [receiptKey]: JSON.stringify({
                        schemaVersion: 1,
                        transactionId: payload.transaction.id,
                        activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
                        expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
                    }),
                    [metadataKey]: JSON.stringify({
                        schemaVersion: 1,
                        transactionId: payload.transaction.id,
                        grantSource: "xsolla_sandbox"
                    })
                }
            });

            const writesBeforeRejected = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/UpdateUserInternalData"
            ).length;
            const badSignature = await sendXsollaWebhook(sandboxApi, xsollaPremiumPayment({
                transactionId: "2115295062",
                dryRun: 1
            }), "0".repeat(40));
            assert.equal(badSignature.status, 400);
            const wrongPlan = await sendXsollaWebhook(sandboxApi, xsollaPremiumPayment({
                transactionId: "2115295063",
                planId: "999999",
                dryRun: 1
            }));
            assert.equal(wrongPlan.status, 204);
            const wrongExternalId = await sendXsollaWebhook(sandboxApi, xsollaPremiumPayment({
                transactionId: "2115295064",
                externalId: "other-plan",
                dryRun: 1
            }));
            assert.equal(wrongExternalId.status, 204);
            const nonAllowlisted = await sendXsollaWebhook(sandboxApi, xsollaPremiumPayment({
                userId: "OTHERPLAYER",
                transactionId: "2115295065",
                dryRun: 1
            }));
            assert.equal(nonAllowlisted.status, 204);
            const invalidAllowedUser = await sendXsollaWebhook(sandboxApi, xsollaPremiumPayment({
                userId: "TESTUSER1",
                transactionId: "2115295066",
                dryRun: 1
            }));
            assert.equal(invalidAllowedUser.status, 400);
            assert.deepEqual(await invalidAllowedUser.json(), {
                error: { code: "INVALID_USER", message: "Invalid user" }
            });
            assert.equal(playFabMock.state.requests.at(-1).path, "/Server/GetUserAccountInfo");
            const writesAfterRejected = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/UpdateUserInternalData"
            ).length;
            assert.equal(writesAfterRejected, writesBeforeRejected);

            const health = await request(sandboxApi, "/health");
            assert.equal(health.status, 200);
        } finally {
            await stopApi(sandboxApi);
        }
    });

    test("Diamond webhook mapping is strict, allowlisted, deterministic, and idempotent", async () => {
        const sandboxApi = await startApi(playFabMock, {
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: ["ABCDEF123456"]
        });
        try {
            const requestsBefore = playFabMock.state.requests.length;
            const payload = xsollaDiamondPayment({
                transactionId: "2116001101",
                sku: "seabyss_diamond_pack_1",
                dryRun: 1
            });
            for (let index = 0; index < 10; index += 1) {
                const response = await sendXsollaWebhook(sandboxApi, payload);
                assert.equal(response.status, 204);
            }

            const grantRequests = playFabMock.state.requests.slice(requestsBefore);
            assert.deepEqual(grantRequests.map((entry) => entry.path), [
                "/Server/GetUserAccountInfo",
                "/Server/UpdateUserInternalData",
                "/Server/GetUserInternalData"
            ]);
            const sandboxKey = "xsd1_" + createHash("sha256")
                .update(payload.transaction.id, "utf8")
                .digest("base64url");
            const sandboxValue = JSON.stringify({
                schemaVersion: 1,
                transactionId: payload.transaction.id,
                productId: "diamond_pack_1",
                xsollaSku: "seabyss_diamond_pack_1",
                productType: "diamond_pack",
                source: "xsolla_sandbox"
            });
            assert.deepEqual(grantRequests[1].body, {
                PlayFabId: "ABCDEF123456",
                Data: { [sandboxKey]: sandboxValue }
            });
            assert.equal(
                playFabMock.state.premiumInternalData
                    .get("ABCDEF123456")
                    .get(sandboxKey),
                sandboxValue
            );
            assert.equal(Object.hasOwn(JSON.parse(sandboxValue), "quantity"), false);

            const combinedRequestsBefore = playFabMock.state.requests.length;
            const combinedSandboxPayload = xsollaDiamondOrderPaid({
                transactionId: "2116001151",
                orderId: 61151,
                sku: "seabyss_diamond_pack_2",
                mode: "sandbox",
                dryRun: 1
            });
            const combinedSandboxResponse = await sendXsollaWebhook(
                sandboxApi,
                combinedSandboxPayload
            );
            assert.equal(combinedSandboxResponse.status, 204);
            const combinedRequests = playFabMock.state.requests.slice(combinedRequestsBefore);
            assert.deepEqual(combinedRequests.map((entry) => entry.path), [
                "/Server/GetUserAccountInfo",
                "/Server/UpdateUserInternalData",
                "/Server/GetUserInternalData"
            ]);
            const combinedKey = "xsd1_" + createHash("sha256")
                .update(combinedSandboxPayload.billing.transaction.id, "utf8")
                .digest("base64url");
            assert.deepEqual(JSON.parse(combinedRequests[1].body.Data[combinedKey]), {
                schemaVersion: 1,
                transactionId: combinedSandboxPayload.billing.transaction.id,
                productId: "diamond_pack_2",
                xsollaSku: "seabyss_diamond_pack_2",
                productType: "diamond_pack",
                source: "xsolla_sandbox"
            });

            const writesBeforeRejected = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/UpdateUserInternalData"
            ).length;
            const inconsistentCombinedSandbox = await sendXsollaWebhook(
                sandboxApi,
                xsollaDiamondOrderPaid({
                    transactionId: "2116001152",
                    orderId: 61152,
                    mode: "sandbox"
                })
            );
            assert.equal(inconsistentCombinedSandbox.status, 204);
            const badSignature = await sendXsollaWebhook(sandboxApi, xsollaDiamondPayment({
                transactionId: "2116001102",
                dryRun: 1
            }), "0".repeat(40));
            assert.equal(badSignature.status, 400);
            const wrongProject = await sendXsollaWebhook(sandboxApi, xsollaDiamondPayment({
                transactionId: "2116001103",
                projectId: "310967",
                dryRun: 1
            }));
            assert.equal(wrongProject.status, 400);
            const wrongSku = await sendXsollaWebhook(sandboxApi, xsollaDiamondPayment({
                transactionId: "2116001104",
                sku: "wrong_sku",
                dryRun: 1
            }));
            assert.equal(wrongSku.status, 204);
            const ambiguous = await sendXsollaWebhook(sandboxApi, xsollaDiamondPayment({
                transactionId: "2116001105",
                dryRun: 1,
                lineitems: [
                    { sku: "seabyss_diamond_pack_1", quantity: 1 },
                    { sku: "seabyss_diamond_pack_2", quantity: 1 }
                ]
            }));
            assert.equal(ambiguous.status, 204);
            const nonAllowlisted = await sendXsollaWebhook(sandboxApi, xsollaDiamondPayment({
                userId: "OTHERPLAYER",
                transactionId: "2116001106",
                dryRun: 1
            }));
            assert.equal(nonAllowlisted.status, 204);
            const writesAfterRejected = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/UpdateUserInternalData"
            ).length;
            assert.equal(writesAfterRejected, writesBeforeRejected);
        } finally {
            await stopApi(sandboxApi);
        }

        const productionRequestsBefore = playFabMock.state.requests.length;
        const productionPayload = xsollaDiamondOrderPaid({
            transactionId: "2116001201",
            orderId: 61201,
            sku: "seabyss_diamond_pack_3"
        });
        const productionResponse = await sendXsollaWebhook(api, productionPayload);
        assert.equal(productionResponse.status, 204);
        const productionRequests = playFabMock.state.requests.slice(productionRequestsBefore);
        assert.deepEqual(productionRequests.map((entry) => entry.path), [
            "/Server/GetUserAccountInfo",
            "/Server/UpdateUserInternalData",
            "/Server/GetUserInternalData"
        ]);
        const productionKey = "xsd1_" + createHash("sha256")
            .update(productionPayload.billing.transaction.id, "utf8")
            .digest("base64url");
        assert.deepEqual(productionRequests[1].body, {
            PlayFabId: "ABCDEF123456",
            Data: {
                [productionKey]: JSON.stringify({
                    schemaVersion: 1,
                    transactionId: productionPayload.billing.transaction.id,
                    productId: "diamond_pack_3",
                    xsollaSku: "seabyss_diamond_pack_3",
                    productType: "diamond_pack",
                    source: "xsolla_production"
                })
            }
        });

        const health = await request(api, "/health");
        assert.equal(health.status, 200);
    });

    test("Starter and standalone Premium webhooks are strict, deterministic, allowlisted, and idempotent", async () => {
        const sandboxApi = await startApi(playFabMock, {
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: ["ABCDEF123456"],
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: ["ABCDEF123456"],
            enableStandalonePremiumProducts: true
        });
        try {
            const catalogFirstRequestsBefore = playFabMock.state.requests.length;
            const catalogFirstPayload = xsollaDiamondOrderPaid({
                transactionId: "2117001100",
                orderId: 62100,
                mode: "sandbox",
                dryRun: 1,
                items: [{
                    sku: "seabyss_starter_pack_1",
                    type: "virtual_good",
                    is_pre_order: false,
                    quantity: 1
                }]
            });
            catalogFirstPayload.order.currency_type = "real";
            const catalogFirstResponses = await Promise.all(
                Array.from({ length: 10 }, () =>
                    sendXsollaWebhook(sandboxApi, catalogFirstPayload)
                )
            );
            assert.deepEqual(
                catalogFirstResponses.map((response) => response.status),
                Array(10).fill(204)
            );
            const catalogFirstRequests = playFabMock.state.requests.slice(
                catalogFirstRequestsBefore
            );
            assert.deepEqual(catalogFirstRequests.map((entry) => entry.path), [
                "/Server/GetUserAccountInfo",
                "/Server/GetUserInternalData",
                "/Server/UpdateUserInternalData",
                "/Server/GetUserInternalData"
            ]);
            const catalogFirstKey = "xss1_" + createHash("sha256")
                .update(catalogFirstPayload.billing.transaction.id, "utf8")
                .digest("base64url");
            const catalogFirstValue = JSON.stringify({
                schemaVersion: 1,
                transactionId: catalogFirstPayload.billing.transaction.id,
                productId: "starter_pack_1",
                xsollaSku: "seabyss_starter_pack_1",
                productType: "starter_pack",
                source: "xsolla_sandbox"
            });
            assert.deepEqual(catalogFirstRequests[2].body, {
                PlayFabId: "ABCDEF123456",
                Data: { [catalogFirstKey]: catalogFirstValue }
            });
            assert.equal(catalogFirstRequests[3].body.Keys[0], catalogFirstKey);
            assert.equal(
                playFabMock.state.premiumInternalData
                    .get("ABCDEF123456")
                    .get(catalogFirstKey),
                catalogFirstValue
            );

            const starterRequestsBefore = playFabMock.state.requests.length;
            const starterPayload = xsollaStrictLineItemPayment({
                transactionId: "2117001101",
                sku: "seabyss_starter_pack_1",
                dryRun: 1
            });
            const starterResponses = await Promise.all(Array.from({ length: 10 }, () =>
                sendXsollaWebhook(sandboxApi, starterPayload)
            ));
            for (const response of starterResponses) {
                assert.equal(response.status, 204);
            }
            const starterRequests = playFabMock.state.requests.slice(starterRequestsBefore);
            assert.deepEqual(starterRequests.map((entry) => entry.path), [
                "/Server/GetUserAccountInfo",
                "/Server/GetUserInternalData",
                "/Server/UpdateUserInternalData",
                "/Server/GetUserInternalData"
            ]);
            const starterKey = "xss1_" + createHash("sha256")
                .update(starterPayload.transaction.id, "utf8")
                .digest("base64url");
            const starterValue = JSON.stringify({
                schemaVersion: 1,
                transactionId: starterPayload.transaction.id,
                productId: "starter_pack_1",
                xsollaSku: "seabyss_starter_pack_1",
                productType: "starter_pack",
                source: "xsolla_sandbox"
            });
            assert.deepEqual(starterRequests[2].body, {
                PlayFabId: "ABCDEF123456",
                Data: { [starterKey]: starterValue }
            });
            assert.equal(starterRequests[3].body.Keys[0], starterKey);
            assert.equal(
                playFabMock.state.premiumInternalData
                    .get("ABCDEF123456")
                    .get(starterKey),
                starterValue
            );
            assert.deepEqual(Object.keys(JSON.parse(starterValue)), [
                "schemaVersion",
                "transactionId",
                "productId",
                "xsollaSku",
                "productType",
                "source"
            ]);

            const catalogStarterRequestsBefore = playFabMock.state.requests.length;
            const catalogStarterPayload = xsollaDiamondOrderPaid({
                transactionId: starterPayload.transaction.id,
                orderId: 62101,
                mode: "sandbox",
                dryRun: 1,
                items: [{
                    sku: "seabyss_starter_pack_1",
                    type: "virtual_good",
                    is_pre_order: false,
                    quantity: 1
                }]
            });
            catalogStarterPayload.order.currency_type = "real";
            const catalogStarterResponses = await Promise.all(
                Array.from({ length: 10 }, () =>
                    sendXsollaWebhook(sandboxApi, catalogStarterPayload)
                )
            );
            assert.deepEqual(
                catalogStarterResponses.map((response) => response.status),
                Array(10).fill(204)
            );
            const catalogStarterRequests = playFabMock.state.requests.slice(
                catalogStarterRequestsBefore
            );
            assert.deepEqual(catalogStarterRequests.map((entry) => entry.path), [
                "/Server/GetUserAccountInfo",
                "/Server/GetUserInternalData"
            ]);
            assert.equal(
                playFabMock.state.premiumInternalData
                    .get("ABCDEF123456")
                    .get(starterKey),
                starterValue
            );

            const premiumRequestsBefore = playFabMock.state.requests.length;
            const premiumPayload = xsollaStrictLineItemPayment({
                transactionId: "2117101101",
                sku: "seabyss_premium_gold",
                dryRun: 1
            });
            premiumPayload.duration = 999999;
            premiumPayload.purchase.order.lineitems[0].duration = 999999;
            const premiumResponses = await Promise.all(Array.from({ length: 10 }, () =>
                sendXsollaWebhook(sandboxApi, premiumPayload)
            ));
            for (const response of premiumResponses) {
                assert.equal(response.status, 500);
                assert.equal((await response.json()).error.code, "WEBHOOK_UNAVAILABLE");
            }
            const premiumRequests = playFabMock.state.requests.slice(premiumRequestsBefore);
            assert.deepEqual(premiumRequests, []);

            const writesBeforeRejected = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/UpdateUserInternalData"
            ).length;
            const badSignature = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001102",
                dryRun: 1
            }), "0".repeat(40));
            assert.equal(badSignature.status, 400);
            const wrongProject = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001103",
                projectId: "310967",
                dryRun: 1
            }));
            assert.equal(wrongProject.status, 400);
            const wrongQuantity = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001104",
                quantity: 2,
                dryRun: 1
            }));
            assert.equal(wrongQuantity.status, 204);
            const stringQuantity = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001105",
                quantity: "1",
                dryRun: 1
            }));
            assert.equal(stringQuantity.status, 204);
            const paddedSku = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001106",
                sku: " seabyss_starter_pack_1",
                dryRun: 1
            }));
            assert.equal(paddedSku.status, 204);
            const multipleMixed = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001107",
                lineitems: [
                    { sku: "seabyss_starter_pack_1", quantity: 1 },
                    { sku: "seabyss_diamond_pack_1", quantity: 1 }
                ],
                dryRun: 1
            }));
            assert.equal(multipleMixed.status, 204);
            const ambiguousLegacy = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                transactionId: "2117001108",
                dryRun: 1,
                subscription: {
                    plan_id: "321178",
                    external_id: "NZSorpSt",
                    date_next_charge: "2026-09-18T00:00:00Z"
                }
            }));
            assert.equal(ambiguousLegacy.status, 204);
            const nonAllowlisted = await sendXsollaWebhook(sandboxApi, xsollaStrictLineItemPayment({
                userId: "OTHERPLAYER",
                transactionId: "2117001109",
                dryRun: 1
            }));
            assert.equal(nonAllowlisted.status, 204);
            const unsupportedOrderPaid = await sendXsollaWebhook(
                sandboxApi,
                xsollaDiamondOrderPaid({
                    transactionId: "2117001110",
                    orderId: 62110,
                    sku: "seabyss_starter_pack_1",
                    mode: "sandbox",
                    dryRun: 1
                })
            );
            assert.equal(unsupportedOrderPaid.status, 204);
            const writesAfterRejected = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/UpdateUserInternalData"
            ).length;
            assert.equal(writesAfterRejected, writesBeforeRejected);
        } finally {
            await stopApi(sandboxApi);
        }

        const productionStarterBefore = playFabMock.state.requests.length;
        const productionStarter = xsollaStrictLineItemPayment({
            transactionId: "2117001201",
            sku: "seabyss_starter_pack_3"
        });
        const productionStarterResponse = await sendXsollaWebhook(api, productionStarter);
        assert.equal(productionStarterResponse.status, 204);
        const productionStarterRequests = playFabMock.state.requests.slice(
            productionStarterBefore
        );
        assert.deepEqual(productionStarterRequests, []);

        const productionPremiumBefore = playFabMock.state.requests.length;
        const productionPremium = xsollaStrictLineItemPayment({
            transactionId: "2117101201",
            sku: "seabyss_premium_bronze"
        });
        const productionPremiumResponse = await sendXsollaWebhook(api, productionPremium);
        assert.equal(productionPremiumResponse.status, 500);
        assert.equal((await productionPremiumResponse.json()).error.code, "WEBHOOK_UNAVAILABLE");
        const productionPremiumRetry = await sendXsollaWebhook(api, productionPremium);
        assert.equal(productionPremiumRetry.status, 500);
        assert.equal((await productionPremiumRetry.json()).error.code, "WEBHOOK_UNAVAILABLE");
        const productionPremiumRequests = playFabMock.state.requests.slice(
            productionPremiumBefore
        );
        assert.deepEqual(productionPremiumRequests, []);

        const health = await request(api, "/health");
        assert.equal(health.status, 200);
    });

    test("CORS preflight succeeds only for the configured origin", async () => {
        const allowed = await request(api, "/auth/login", {
            method: "OPTIONS",
            headers: {
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type"
            }
        });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
        assert.match(allowed.headers.get("access-control-allow-methods") || "", /\bPOST\b/);
        assert.match(allowed.headers.get("access-control-allow-headers") || "", /\bcontent-type\b/i);

        const denied = await request(api, "/auth/login", {
            method: "OPTIONS",
            origin: "https://attacker.example",
            headers: { "Access-Control-Request-Method": "POST" }
        });
        assert.equal(denied.status, 403);
    });

    test("login rejects unsupported, non-object and malformed JSON", async () => {
        const unsupported = await request(api, "/auth/login", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "email=test@example.test"
        });
        assert.equal(unsupported.status, 415);
        assertNoStore(unsupported);

        const arrayBody = await request(api, "/auth/login", {
            method: "POST",
            json: ["test@example.test", "password"]
        });
        assert.equal(arrayBody.status, 400);
        assertNoStore(arrayBody);

        const malformed = await request(api, "/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{not-json"
        });
        assert.equal(malformed.status, 400);
        assert.deepEqual(await malformed.json(), { message: "Invalid JSON request body." });
        assertNoStore(malformed);

        const oversized = await request(api, "/auth/login", {
            method: "POST",
            json: {
                email: "large@example.test",
                password: "x".repeat(17 * 1024)
            }
        });
        assert.equal(oversized.status, 413);
        assertNoStore(oversized);
    });

    test("invalid signed session cookies never authenticate", async () => {
        const invalidCookie = "seabyss.sid=s%3Anot-a-session.invalid-signature";
        const session = await request(api, "/auth/session", { cookie: invalidCookie });
        assert.equal(session.status, 200);
        assert.equal((await session.json()).loggedIn, false);
        assert.equal(setCookieLines(session).length, 0);

        const profile = await request(api, "/me", { cookie: invalidCookie });
        assert.equal(profile.status, 401);
        assertNoStore(profile);
    });

    test("successful reauthentication regenerates and invalidates the previous SID", async () => {
        const freshApi = await startApi(playFabMock);
        try {
            const firstLogin = await request(freshApi, "/auth/login", {
                method: "POST",
                json: {
                    email: "valid@example.test",
                    password: "password123"
                }
            });
            const firstCookie = sessionCookie(firstLogin, "seabyss.sid");

            const secondLogin = await request(freshApi, "/auth/login", {
                method: "POST",
                cookie: firstCookie.pair,
                json: {
                    email: "valid@example.test",
                    password: "password123"
                }
            });
            const secondCookie = sessionCookie(secondLogin, "seabyss.sid");
            assert.notEqual(secondCookie.pair, firstCookie.pair);

            const oldSession = await request(freshApi, "/auth/session", {
                cookie: firstCookie.pair
            });
            assert.equal((await oldSession.json()).loggedIn, false);

            const currentSession = await request(freshApi, "/auth/session", {
                cookie: secondCookie.pair
            });
            assert.equal((await currentSession.json()).loggedIn, true);
        } finally {
            await stopApi(freshApi);
        }
    });

    test("authentication, sanitized profile, profile failures and logout", async () => {
        const unauthenticated = await request(api, "/me");
        assert.equal(unauthenticated.status, 401);
        assertNoStore(unauthenticated);

        const login = await request(api, "/auth/login", {
            method: "POST",
            json: {
                email: "valid@example.test",
                password: "correct horse battery staple"
            }
        });
        assert.equal(login.status, 200);
        assertNoStore(login);
        const cookie = sessionCookie(login, "seabyss.sid");
        assert.match(cookie.line, /;\s*HttpOnly/i);
        assert.match(cookie.line, /;\s*SameSite=Lax/i);
        assert.match(cookie.line, /;\s*Path=\//i);
        assert.doesNotMatch(cookie.line, /;\s*Domain=/i);
        assert.doesNotMatch(cookie.line, /;\s*Secure/i);

        const loginBody = await login.json();
        assert.equal(loginBody.loggedIn, true);
        assert.equal(loginBody.displayName, "Test Captain");
        assert.doesNotMatch(JSON.stringify(loginBody), /ticket|token|secret/i);

        const session = await request(api, "/auth/session", { cookie: cookie.pair });
        assert.equal(session.status, 200);
        assert.equal((await session.json()).loggedIn, true);
        assertNoStore(session);

        const requestCountBeforeProfile = playFabMock.state.requests.length;
        const profile = await request(api, "/me", { cookie: cookie.pair });
        assert.equal(profile.status, 200);
        assertNoStore(profile);
        const profileBody = await profile.json();
        assert.equal(profileBody.gold, "1,234");
        assert.equal(profileBody.gameplay.gold, 1234);
        assert.equal(profileBody.gameplay.equippedShipId, "elite_1");
        assert.doesNotMatch(JSON.stringify(profileBody), /private-profile-field|ticket|local-test-secret/i);

        const profileRequest = playFabMock.state.requests
            .slice(requestCountBeforeProfile)
            .find((entry) => entry.path === "/Server/GetUserInternalData");
        assert.ok(profileRequest);
        assert.equal(profileRequest.headers["x-secretkey"], "local-test-secret");
        assert.deepEqual(profileRequest.body, {
            PlayFabId: "ABCDEF123456",
            Keys: ["profile_v1"]
        });

        for (const mode of ["upstream429", "upstream500", "invalidjson", "redirect", "timeout"]) {
            playFabMock.state.profileMode = mode;
            const unavailableProfile = await request(api, "/me", { cookie: cookie.pair });
            assert.equal(unavailableProfile.status, 200, "profile mode " + mode);
            const unavailableBody = await unavailableProfile.json();
            assert.equal(unavailableBody.gameplay.gold, null, "profile mode " + mode);
            assert.doesNotMatch(JSON.stringify(unavailableBody), /upstream-detail|private-profile-field/i);
        }
        playFabMock.state.profileMode = "success";
        assert.equal(playFabMock.state.redirectHits, 0);

        const logout = await request(api, "/auth/logout", {
            method: "POST",
            cookie: cookie.pair
        });
        assert.equal(logout.status, 200);
        assert.deepEqual(await logout.json(), { success: true });
        assertNoStore(logout);

        const afterLogout = await request(api, "/auth/session", { cookie: cookie.pair });
        assert.equal(afterLogout.status, 200);
        assert.equal((await afterLogout.json()).loggedIn, false);
    });

    test("registration validates input, creates a session and maps upstream errors", async () => {
        const invalid = await request(api, "/register", {
            method: "POST",
            json: {
                email: "not-an-email",
                password: "password123",
                confirmPassword: "password123"
            }
        });
        assert.equal(invalid.status, 400);
        assertNoStore(invalid);

        const created = await request(api, "/register", {
            method: "POST",
            json: {
                email: "new@example.test",
                password: "password123",
                confirmPassword: "password123",
                displayName: "New Captain"
            }
        });
        assert.equal(created.status, 201);
        assert.equal((await created.json()).created, true);
        const cookie = sessionCookie(created, "seabyss.sid");

        const upstream500 = await request(api, "/register", {
            method: "POST",
            json: {
                email: "upstream500@example.test",
                password: "password123",
                confirmPassword: "password123"
            }
        });
        assert.equal(upstream500.status, 503);
        assert.doesNotMatch(await upstream500.text(), /upstream-detail/i);

        const upstream429 = await request(api, "/register", {
            method: "POST",
            json: {
                email: "upstream429@example.test",
                password: "password123",
                confirmPassword: "password123"
            }
        });
        assert.equal(upstream429.status, 429);
        assert.doesNotMatch(await upstream429.text(), /upstream-detail/i);

        const logout = await request(api, "/auth/logout", {
            method: "POST",
            cookie: cookie.pair
        });
        assert.equal(logout.status, 200);
    });

    test("login contains upstream 429, 5xx, invalid JSON, redirects and timeouts", async () => {
        const scenarios = [
            { email: "upstream429@example.test", status: 401 },
            { email: "upstream500@example.test", status: 401 },
            { email: "invalidjson@example.test", status: 401 },
            { email: "redirect@example.test", status: 500 },
            { email: "timeout@example.test", status: 500 }
        ];

        for (const scenario of scenarios) {
            const startedAt = Date.now();
            const response = await request(api, "/auth/login", {
                method: "POST",
                json: {
                    email: scenario.email,
                    password: "password123"
                }
            });
            assert.equal(response.status, scenario.status, scenario.email);
            assertNoStore(response);
            assert.doesNotMatch(await response.text(), /upstream-detail|ticket|token|secret/i);

            if (scenario.email.startsWith("timeout@")) {
                const elapsedMs = Date.now() - startedAt;
                assert.ok(elapsedMs >= 800, "timeout returned too early after " + elapsedMs + " ms");
                assert.ok(elapsedMs < 3000, "timeout returned too late after " + elapsedMs + " ms");
            }
        }
        assert.equal(playFabMock.state.redirectHits, 0);
    });

    test("login rate limit rejects the eleventh attempt", async () => {
        const freshApi = await startApi(playFabMock);
        try {
            for (let attempt = 1; attempt <= 10; attempt += 1) {
                const response = await request(freshApi, "/auth/login", {
                    method: "POST",
                    json: {
                        email: "invalid@example.test",
                        password: "wrong-password"
                    }
                });
                assert.equal(response.status, 401, "attempt " + attempt);
            }

            const limited = await request(freshApi, "/auth/login", {
                method: "POST",
                json: {
                    email: "invalid@example.test",
                    password: "wrong-password"
                }
            });
            assert.equal(limited.status, 429);
            assertNoStore(limited);
        } finally {
            await stopApi(freshApi);
        }
    });

    test("registration rate limit rejects the sixth attempt", async () => {
        const freshApi = await startApi(playFabMock);
        try {
            for (let attempt = 1; attempt <= 5; attempt += 1) {
                const response = await request(freshApi, "/register", {
                    method: "POST",
                    json: {
                        email: "new" + attempt + "@example.test",
                        password: "password123",
                        confirmPassword: "password123"
                    }
                });
                assert.equal(response.status, 201, "attempt " + attempt);
            }

            const limited = await request(freshApi, "/register", {
                method: "POST",
                json: {
                    email: "new6@example.test",
                    password: "password123",
                    confirmPassword: "password123"
                }
            });
            assert.equal(limited.status, 429);
            assertNoStore(limited);
        } finally {
            await stopApi(freshApi);
        }
    });

    test("profile rate limit is shared by PlayFabId and rejects request 31", async () => {
        const freshApi = await startApi(playFabMock);
        playFabMock.state.profileMode = "success";
        try {
            const firstLogin = await request(freshApi, "/auth/login", {
                method: "POST",
                json: {
                    email: "valid@example.test",
                    password: "password123"
                }
            });
            const secondLogin = await request(freshApi, "/auth/login", {
                method: "POST",
                json: {
                    email: "second@example.test",
                    password: "password123"
                }
            });
            const firstCookie = sessionCookie(firstLogin, "seabyss.sid").pair;
            const secondCookie = sessionCookie(secondLogin, "seabyss.sid").pair;
            assert.notEqual(firstCookie, secondCookie);

            const profileCallsBefore = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/GetUserInternalData"
            ).length;

            for (let attempt = 0; attempt < 30; attempt += 1) {
                const cookie = attempt % 2 === 0 ? firstCookie : secondCookie;
                const response = await request(freshApi, "/me", { cookie });
                assert.equal(response.status, 200, "profile request " + attempt);
            }

            const profileCallsAfterThirty = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/GetUserInternalData"
            ).length;
            assert.equal(profileCallsAfterThirty - profileCallsBefore, 30);

            const limited = await request(freshApi, "/me", { cookie: secondCookie });
            assert.equal(limited.status, 429);
            assertNoStore(limited);

            const profileCallsAfterLimit = playFabMock.state.requests.filter(
                (entry) => entry.path === "/Server/GetUserInternalData"
            ).length;
            assert.equal(profileCallsAfterLimit, profileCallsAfterThirty);
        } finally {
            await stopApi(freshApi);
        }
    });

    test("production uses a host-only __Host- cookie and Redis survives restart", async (t) => {
        if (!process.env.TEST_REDIS_URL) {
            t.skip("TEST_REDIS_URL is not configured; real Redis restart remains an infrastructure test.");
            return;
        }
        assertLocalRedisUrl(redisTestUrl);
        const redis = createClient({
            url: redisTestUrl,
            socket: {
                connectTimeout: 1_000,
                reconnectStrategy: () => false
            }
        });
        redis.on("error", () => {});
        const testKeys = new Set();
        const port = await getUnusedPort();
        const forwardedHttps = { "X-Forwarded-Proto": "https" };
        let firstApi;
        let secondApi;

        try {
            await redis.connect();
            firstApi = await startApi(playFabMock, {
                nodeEnv: "production",
                port,
                redisUrl: redisTestUrl
            });

            const login = await request(firstApi, "/auth/login", {
                method: "POST",
                headers: forwardedHttps,
                json: {
                    email: "valid@example.test",
                    password: "password123"
                }
            });
            assert.equal(login.status, 200);
            const cookie = sessionCookie(login, "__Host-seabyss.sid");
            assert.match(cookie.line, /;\s*Secure/i);
            assert.match(cookie.line, /;\s*HttpOnly/i);
            assert.match(cookie.line, /;\s*SameSite=Lax/i);
            assert.match(cookie.line, /;\s*Path=\//i);
            assert.doesNotMatch(cookie.line, /;\s*Domain=/i);

            const firstKey = "seabyss:web:sess:" + sessionIdFromCookie(cookie.pair);
            testKeys.add(firstKey);
            assert.equal(await redis.exists(firstKey), 1);
            const ttl = await redis.ttl(firstKey);
            assert.ok(ttl > 0 && ttl <= 3600, "Unexpected Redis TTL: " + ttl);

            await stopApi(firstApi);
            firstApi = null;

            secondApi = await startApi(playFabMock, {
                nodeEnv: "production",
                port,
                redisUrl: redisTestUrl
            });
            const restored = await request(secondApi, "/auth/session", {
                headers: forwardedHttps,
                cookie: cookie.pair
            });
            assert.equal(restored.status, 200);
            assert.equal((await restored.json()).loggedIn, true);

            await redis.pExpire(firstKey, 75);
            await delay(150);
            assert.equal(await redis.exists(firstKey), 0);

            const expired = await request(secondApi, "/auth/session", {
                headers: forwardedHttps,
                cookie: cookie.pair
            });
            assert.equal(expired.status, 200);
            assert.equal((await expired.json()).loggedIn, false);

            const secondLogin = await request(secondApi, "/auth/login", {
                method: "POST",
                headers: forwardedHttps,
                json: {
                    email: "valid@example.test",
                    password: "password123"
                }
            });
            const secondCookie = sessionCookie(secondLogin, "__Host-seabyss.sid");
            const secondKey = "seabyss:web:sess:" + sessionIdFromCookie(secondCookie.pair);
            testKeys.add(secondKey);
            assert.equal(await redis.exists(secondKey), 1);

            const logout = await request(secondApi, "/auth/logout", {
                method: "POST",
                headers: forwardedHttps,
                cookie: secondCookie.pair
            });
            assert.equal(logout.status, 200);
            const clearedCookies = setCookieLines(logout);
            assert.equal(clearedCookies.length, 2);
            assert.ok(clearedCookies.some((line) => line.startsWith("__Host-seabyss.sid=")));
            assert.ok(clearedCookies.some((line) =>
                line.startsWith("seabyss.sid=") && /Domain=\.?seabyss\.com/i.test(line)
            ));
            assert.ok(clearedCookies.every((line) =>
                line.startsWith("__Host-seabyss.sid=") || line.startsWith("seabyss.sid=")
            ));
            assert.equal(await redis.exists(secondKey), 0);
        } finally {
            await stopApi(firstApi);
            await stopApi(secondApi);
            if (redis.isOpen) {
                if (testKeys.size) {
                    await redis.del([...testKeys]);
                }
                await redis.quit();
            }
        }
    });

    test("production remains fail-closed when local Redis is unavailable", async () => {
        const closedPort = await getUnusedPort();
        await assert.rejects(
            startApi(playFabMock, {
                nodeEnv: "production",
                redisUrl: "redis://127.0.0.1:" + closedPort + "/15",
                startupAttempts: 40
            }),
            /did not become ready|exited during startup/i
        );
    });

    test("malformed HTTP 200 registration payload must not return success", async () => {
        const response = await request(api, "/register", {
            method: "POST",
            json: {
                email: "invalidjson@example.test",
                password: "password123",
                confirmPassword: "password123"
            }
        });
        assert.ok(response.status >= 500);
    });
});
