import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, test } from "node:test";
import { createClient } from "redis";

const loopbackHost = "127.0.0.1";
const allowedOrigin = "https://www.seabyss.test";
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
        requests: []
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

            if (requestUrl.pathname === "/Server/GetUserInternalData") {
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
            version: "0.1.0"
        });

        const denied = await request(api, "/health", { origin: "https://attacker.example" });
        assert.equal(denied.status, 403);
        assert.deepEqual(await denied.json(), { message: "CORS origin not allowed." });

        const missing = await request(api, "/not-a-route");
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { message: "Not found." });
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

    test("production uses a host-only __Host- cookie and Redis survives restart", async () => {
        assertLocalRedisUrl(redisTestUrl);
        const redis = createClient({ url: redisTestUrl });
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
