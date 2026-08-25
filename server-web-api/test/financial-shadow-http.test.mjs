import test from "node:test";
import assert from "node:assert/strict";
import {
    createFinancialShadowHttpHandlers,
    financialShadowRateLimitKey,
    registerFinancialShadowRoutes
} from "../src/financial-shadow-http.js";
import { evaluateFinancialShadowPolicy } from "../src/financial-shadow-policy.js";
import { createFinancialShadowInitialSnapshot, createFinancialShadowMetrics } from "../src/financial-shadow-model.js";
import { createFinancialShadowRuntime } from "../src/financial-shadow-runtime.js";
import { createMemoryFinancialShadowStateStore } from "../src/financial-shadow-store.js";
import { createServerEconomyPocHighValueOperation } from "../src/server-economy-poc-domain-model.js";

const PLAYER = "SHADOW_HTTP_PLAYER";
const TICKET = "PLAYFAB_SESSION_TICKET_FOR_SHADOW_TEST";
const IDENTITY = Object.freeze({
    playFabId: PLAYER,
    titlePlayerAccountId: "TPA_SHADOW_HTTP_PLAYER",
    entity: Object.freeze({ id: "TPA_SHADOW_HTTP_PLAYER", type: "title_player_account" })
});

function policy(enabled = true) {
    return evaluateFinancialShadowPolicy({
        enabled,
        nodeEnv: "test",
        shadowEnvironment: "test",
        allowlistedPlayFabIds: enabled ? [PLAYER] : [],
        serverId: enabled ? "SHADOW_HTTP_SERVER" : "",
        redisConfigured: enabled,
        playFabConfigured: enabled
    });
}

function response() {
    return {
        statusCode: 200, headers: {}, body: null,
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; }
    };
}

function request({ body = undefined, headers = {}, query = {}, ip = "127.0.0.1" } = {}) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return { body, headers: normalized, query, ip, get(name) { return normalized[name.toLowerCase()]; } };
}

function assertExactMembers(value, expected, label) {
    assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} member set changed`);
}

function runtimeStub() {
    const calls = [];
    const snapshot = createFinancialShadowInitialSnapshot(PLAYER, 1000);
    return {
        calls,
        async getSnapshot(playFabId) { calls.push(["snapshot", playFabId]); return snapshot; },
        async registerPresence(input) { calls.push(["register", input]); return { status: "registered", ...input, sessionEpoch: 1, fencingEpoch: 1, heartbeatAtUnixMs: 1, expiresAtUnixMs: 2, ownerServerId: "SHADOW_HTTP_SERVER" }; },
        async heartbeatPresence(input) { calls.push(["heartbeat", input]); return { status: "renewed", ...input }; },
        async observe(playFabId, input, identity) { calls.push(["observe", playFabId, input, identity]); return { status: "observed", authoritative: false, sourceAttested: false }; },
        async claimInbox(input) { calls.push(["inbox", input]); return { status: "claimed", deliveries: [] }; },
        async ackDelivery(input) { calls.push(["ack", input]); return { status: "acked", deliveryId: input.deliveryId, deliveryEpoch: input.deliveryEpoch }; },
        async diagnostics(playFabId) { calls.push(["diagnostics", playFabId]); return { schemaVersion: 1, authoritative: false, sourceAttested: false }; }
    };
}

test("disabled Shadow handlers return 404 before session authentication", async () => {
    let authCalls = 0;
    const handlers = createFinancialShadowHttpHandlers({
        policy: policy(false), runtime: null,
        authenticateSessionTicket: async () => { authCalls += 1; return IDENTITY; }
    });
    await assert.rejects(handlers.getSnapshot(request(), response()), { statusCode: 404 });
    assert.equal(authCalls, 0);
});

test("all identity comes from AuthenticateSessionTicket including the Title Player Account", async () => {
    const runtime = runtimeStub();
    const handlers = createFinancialShadowHttpHandlers({
        policy: policy(), runtime,
        authenticateSessionTicket: async (ticket) => { assert.equal(ticket, TICKET); return IDENTITY; }
    });
    const res = response();
    await handlers.registerPresence(request({ headers: { "X-PlayFab-SessionTicket": TICKET }, body: { sessionId: "UNITY_SESSION" } }), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(runtime.calls[0], ["register", { playFabId: PLAYER, sessionId: "UNITY_SESSION" }]);
    assert.equal(res.body.authoritative, false);
    assert.match(res.headers["Cache-Control"], /no-store/u);
});

test("missing Title Player Account identity and nested client identity smuggling fail closed", async () => {
    const runtime = runtimeStub();
    const incomplete = createFinancialShadowHttpHandlers({ policy: policy(), runtime, authenticateSessionTicket: async () => ({ playFabId: PLAYER }) });
    await assert.rejects(incomplete.getSnapshot(request({ headers: { "X-PlayFab-SessionTicket": TICKET } }), response()), { code: "FINANCIAL_SHADOW_IDENTITY_INCOMPLETE", statusCode: 503 });
    const handlers = createFinancialShadowHttpHandlers({ policy: policy(), runtime, authenticateSessionTicket: async () => IDENTITY });
    await assert.rejects(handlers.observe(request({
        headers: { "X-PlayFab-SessionTicket": TICKET }, body: { clientSnapshot: { playFabId: "ATTACKER_CHOSEN_ID" } }
    }), response()), { code: "FINANCIAL_SHADOW_CLIENT_IDENTITY_FORBIDDEN", statusCode: 400 });
    assert.equal(runtime.calls.length, 0);
});

test("missing, expired, upstream-failed and non-allowlisted sessions fail closed", async () => {
    const runtime = runtimeStub();
    const missing = createFinancialShadowHttpHandlers({ policy: policy(), runtime, authenticateSessionTicket: async () => IDENTITY });
    await assert.rejects(missing.getSnapshot(request(), response()), { statusCode: 401 });
    const expired = createFinancialShadowHttpHandlers({ policy: policy(), runtime, authenticateSessionTicket: async () => null });
    await assert.rejects(expired.getSnapshot(request({ headers: { "X-PlayFab-SessionTicket": TICKET } }), response()), { statusCode: 401 });
    const unavailable = createFinancialShadowHttpHandlers({ policy: policy(), runtime, authenticateSessionTicket: async () => { throw new Error("provider detail"); } });
    await assert.rejects(unavailable.getSnapshot(request({ headers: { "X-PlayFab-SessionTicket": TICKET } }), response()), { statusCode: 503 });
    const forbidden = createFinancialShadowHttpHandlers({
        policy: policy(), runtime,
        authenticateSessionTicket: async () => ({ playFabId: "OTHER_PLAYER", titlePlayerAccountId: "TPA_OTHER", entity: { id: "TPA_OTHER", type: "title_player_account" } })
    });
    await assert.rejects(forbidden.getSnapshot(request({ headers: { "X-PlayFab-SessionTicket": TICKET } }), response()), { statusCode: 403 });
});

test("snapshot, observe, heartbeat, inbox, ACK and diagnostics forward only authenticated identity", async () => {
    const runtime = runtimeStub();
    const handlers = createFinancialShadowHttpHandlers({
        policy: policy(), runtime, authenticateSessionTicket: async () => IDENTITY,
        authenticationDiagnostics: () => ({ cacheEntryCount: 1, storesRawTickets: false })
    });
    const headers = { "X-PlayFab-SessionTicket": TICKET, "X-Shadow-Session-Id": "UNITY_SESSION", "X-Shadow-Session-Epoch": "1" };
    const snapshotRes = response();
    await handlers.getSnapshot(request({ headers }), snapshotRes);
    assert.equal(snapshotRes.body.snapshot.playFabId, PLAYER);
    await handlers.observe(request({ headers, body: { opaque: true } }), response());
    assert.deepEqual(runtime.calls.at(-1)[3], IDENTITY);
    await handlers.heartbeatPresence(request({ headers, body: { sessionId: "UNITY_SESSION", sessionEpoch: 1 } }), response());
    await handlers.getInbox(request({ headers, query: { limit: "10" } }), response());
    await handlers.ackInbox(request({ headers, body: { sessionId: "UNITY_SESSION", sessionEpoch: 1, deliveryId: "DELIVERY_1", deliveryEpoch: 2 } }), response());
    const diagnosticsRes = response();
    await handlers.getDiagnostics(request({ headers }), diagnosticsRes);
    assert.equal(diagnosticsRes.body.authentication.storesRawTickets, false);
    assert.equal(JSON.stringify(diagnosticsRes.body).includes(TICKET), false);
    assert.equal(runtime.calls.every((call) => {
        const input = typeof call[1] === "object" ? call[1] : null;
        return !input || input.playFabId === PLAYER;
    }), true);
});

test("serialized financial operation inbox claim matches Unity's strict seven-member payload contract", async () => {
    const clock = { now: 1_000 };
    const runtime = createFinancialShadowRuntime({
        stateStore: createMemoryFinancialShadowStateStore(),
        policy: policy(),
        metrics: createFinancialShadowMetrics(),
        nowMilliseconds: () => clock.now,
        monotonicMilliseconds: () => clock.now,
        presenceLeaseTtlMilliseconds: 1_000
    });
    const session = await runtime.registerPresence({
        playFabId: PLAYER,
        sessionId: "SHADOW_HTTP_CONTRACT_SESSION"
    });
    const before = await runtime.getSnapshot(PLAYER);
    const clientSnapshot = structuredClone(before);
    delete clientSnapshot.playFabId;
    await runtime.observe(PLAYER, {
        schemaVersion: 1,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        operationId: "SHADOW_HTTP_CONTRACT_BOOTSTRAP_OPERATION",
        eventId: "SHADOW_HTTP_CONTRACT_BOOTSTRAP_EVENT",
        kind: "snapshot_observation",
        reason: "shadow_http_contract_test",
        contextId: "SHADOW_HTTP_CONTRACT_BOOTSTRAP_CONTEXT",
        occurredAtUnixMs: clock.now,
        effect: {},
        clientBeforeSnapshot: clientSnapshot,
        clientSnapshot
    }, IDENTITY);
    clock.now += 1;
    await runtime.projectExternalPocOperation({
        playFabId: PLAYER,
        sequence: 1,
        operation: createServerEconomyPocHighValueOperation({
            playFabId: PLAYER,
            operationId: "SHADOW_HTTP_CONTRACT_PAYMENT_OPERATION",
            eventId: "SHADOW_HTTP_CONTRACT_PAYMENT_EVENT",
            diamonds: 500,
            createdAtUnixMs: clock.now
        })
    });

    const handlers = createFinancialShadowHttpHandlers({
        policy: policy(),
        runtime,
        authenticateSessionTicket: async (ticket) => {
            assert.equal(ticket, TICKET);
            return IDENTITY;
        }
    });
    const res = response();
    await handlers.getInbox(request({
        headers: {
            "x-playfab-sessionticket": TICKET,
            "x-shadow-session-id": session.sessionId,
            "x-shadow-session-epoch": String(session.sessionEpoch)
        },
        query: { limit: "10" }
    }), res);
    const wire = JSON.parse(JSON.stringify(res.body));
    assertExactMembers(wire, ["schemaVersion", "authoritative", "inbox"], "inbox envelope");
    assertExactMembers(wire.inbox, ["status", "deliveries"], "inbox");
    const delivery = wire.inbox.deliveries.find((entry) => entry.type === "financial_operation");
    assert.ok(delivery);
    assertExactMembers(delivery, [
        "deliveryId", "deliveryEpoch", "state", "type", "operationId", "eventId",
        "createdAtUnixMs", "claimedBySessionId", "claimedBySessionEpoch",
        "claimedAtUnixMs", "ackedAtUnixMs", "payload"
    ], "financial operation delivery");
    assertExactMembers(delivery.payload, [
        "authoritative", "sourceAttested", "modelSnapshot", "mismatch",
        "operation", "projectionResult", "consumptionMode"
    ], "financial operation payload");
    assert.equal(delivery.payload.authoritative, false);
    assert.equal(delivery.payload.sourceAttested, true);
    assert.equal(delivery.payload.consumptionMode, "online");
    assert.equal(delivery.payload.operation.playFabId, PLAYER);
    assert.equal(delivery.payload.operation.diamonds, 500);
    assert.equal(Object.hasOwn(delivery.payload.operation, "callerRewards"), false);
});

test("rate-limit keys hash tickets and isolate one hundred sessions without leaking raw tickets", () => {
    const keys = new Set();
    for (let index = 0; index < 100; index += 1) {
        const ticket = `${TICKET}_${String(index).padStart(3, "0")}`;
        const key = financialShadowRateLimitKey(request({ headers: { "X-PlayFab-SessionTicket": ticket }, ip: "10.0.0.1" }));
        assert.equal(key.includes(ticket), false);
        keys.add(key);
    }
    assert.equal(keys.size, 100);
    assert.notEqual(financialShadowRateLimitKey(request({ ip: "10.0.0.1" })), financialShadowRateLimitKey(request({ ip: "10.0.0.2" })));
});

test("route registrar exposes exactly seven versioned Shadow endpoints", () => {
    const routes = [];
    const app = {
        get(path, ...handlers) { routes.push(["GET", path, handlers.length]); },
        post(path, ...handlers) { routes.push(["POST", path, handlers.length]); }
    };
    const handlers = createFinancialShadowHttpHandlers({ policy: policy(), runtime: runtimeStub(), authenticateSessionTicket: async () => IDENTITY });
    const registered = registerFinancialShadowRoutes(app, { handlers, limiter: [() => {}, () => {}] });
    assert.equal(registered.registered, true);
    assert.equal(registered.routeCount, 7);
    assert.deepEqual(routes.map(([method, path]) => `${method} ${path}`), [
        "GET /financial/shadow/v1/snapshot",
        "POST /financial/shadow/v1/presence/register",
        "POST /financial/shadow/v1/presence/heartbeat",
        "POST /financial/shadow/v1/observe",
        "GET /financial/shadow/v1/inbox",
        "POST /financial/shadow/v1/inbox/ack",
        "GET /financial/shadow/v1/diagnostics"
    ]);
});
