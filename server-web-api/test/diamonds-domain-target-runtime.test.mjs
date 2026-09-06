import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalMemoryServerEconomyPocHarness } from "../src/server-economy-poc-canonical.js";
import { createDiamondsDomainTargetAdapter } from "../src/diamonds-domain-target-adapter.js";
import {
    createDiamondsDomainTargetHttpHandlers,
    registerDiamondsDomainTargetRoutes
} from "../src/diamonds-domain-target-http.js";
import { createDiamondsDomainTargetRuntime } from "../src/diamonds-domain-target-runtime.js";

const PLAYER = "DIAMONDS_CANARY_TEST";
const TITLE = "1D0C16";
const PRODUCTION_TITLE = "142853";

function mutation(overrides = {}) {
    return {
        playFabId: PLAYER,
        sessionId: "SESSION_A",
        sessionEpoch: 1,
        operationId: "OPERATION_A",
        eventId: "EVENT_A",
        delta: 25,
        reason: "quest_reward",
        contextId: "QUEST_CONTEXT_A",
        ...overrides
    };
}

function certificate() {
    return Object.freeze({ certificateId: "diamonds-readiness-test" });
}

function verifier(expiresAtUnixMs = Date.now() + 60_000) {
    return async ({ domain, titleId }) => ({ valid: true, domain, titleId, expiresAtUnixMs });
}

async function healthy() {
    return {
        targetHealthy: true,
        redisHealthy: true,
        playFabHealthy: true,
        snapshotCasSupported: true
    };
}

function targetHarness() {
    const canonical = createCanonicalMemoryServerEconomyPocHarness();
    return {
        canonical,
        adapter: createDiamondsDomainTargetAdapter({ canonicalRuntime: canonical.poc })
    };
}

function response() {
    return {
        statusCode: null,
        headers: {},
        body: null,
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; }
    };
}

const authenticateGameServer = async () => ({
    authenticated: true,
    authenticationType: "GameServer",
    serverId: "MIRROR_SANDBOX_A"
});

const authorizePlayer = async ({ playFabId }) => ({ authorized: true, playFabId });

test("narrow Target adapter applies symmetric grant/spend replays and rejects underflow before Inbox/provider mutation", async () => {
    const { adapter, canonical } = targetHarness();
    const grant = await adapter.mutate(mutation());
    assert.equal(grant.status, "Applied");
    assert.equal(grant.balance, 25);
    assert.equal(grant.revision, 1);

    const grantReplay = await adapter.mutate(mutation());
    assert.equal(grantReplay.status, "AlreadyApplied");
    assert.equal(grantReplay.balance, 25);
    assert.equal(grantReplay.revision, 1);

    const spendMutation = mutation({
        operationId: "OPERATION_B",
        eventId: "EVENT_B",
        delta: -10
    });
    const spend = await adapter.mutate(spendMutation);
    assert.equal(spend.status, "Applied");
    assert.equal(spend.balance, 15);
    assert.equal(spend.revision, 2);

    const spendReplay = await adapter.mutate(spendMutation);
    assert.equal(spendReplay.status, "AlreadyApplied");
    assert.equal(spendReplay.balance, 15);
    assert.equal(spendReplay.revision, 2);

    const inboxBefore = await canonical.stores.operationInbox.scanAfter({
        playFabId: PLAYER,
        afterSequence: 0
    });
    const snapshotBefore = await canonical.poc.readSnapshot(PLAYER);
    const rejected = await adapter.mutate(mutation({
        operationId: "OPERATION_C",
        eventId: "EVENT_C",
        delta: -20
    }));
    assert.equal(rejected.status, "Insufficient");
    assert.equal(rejected.providerWriteAttempted, false);
    assert.equal(rejected.preflightRejected, true);
    assert.equal(rejected.balance, 15);
    assert.equal(rejected.revision, snapshotBefore.revision);
    const snapshotAfter = await canonical.poc.readSnapshot(PLAYER);
    const inboxAfter = await canonical.stores.operationInbox.scanAfter({
        playFabId: PLAYER,
        afterSequence: 0
    });
    assert.deepEqual(snapshotAfter, snapshotBefore);
    assert.deepEqual(inboxAfter, inboxBefore);
    assert.equal(await canonical.stores.operationInbox.get(PLAYER, "OPERATION_C"), null);
});

test("Target read exposes provider-confirmed balance/revision but accepts identity only", async () => {
    const { adapter } = targetHarness();
    await adapter.mutate(mutation());
    assert.deepEqual(await adapter.read({ playFabId: PLAYER }), {
        status: "Read",
        playFabId: PLAYER,
        balance: 25,
        revision: 1,
        fencingEpoch: 2,
        highValueAppliedThroughSequence: 1,
        objectName: "SeabyssEconomyStateV1"
    });
    await assert.rejects(
        adapter.read({ playFabId: PLAYER, revision: 0 }),
        { code: "DIAMONDS_TARGET_SCHEMA_INVALID" }
    );
});

test("Target mutation rejects caller balances, revisions, rewards, proofs, and leases before runtime", async () => {
    const { adapter, canonical } = targetHarness();
    for (const forbidden of [
        { balance: 9_999 },
        { revision: 7 },
        { rewards: { diamonds: 9_999 } },
        { leaseToken: "attacker" },
        { providerProof: { forged: true } }
    ]) {
        await assert.rejects(
            adapter.mutate({ ...mutation(), ...forbidden }),
            { code: "DIAMONDS_TARGET_SCHEMA_INVALID" }
        );
    }
    assert.equal((await canonical.poc.readSnapshot(PLAYER)).diamonds, 0);
});

test("same operation identity cannot be replayed with a different delta", async () => {
    const { adapter } = targetHarness();
    await adapter.mutate(mutation());
    await assert.rejects(
        adapter.mutate(mutation({ delta: 26 })),
        { code: "POC_OPERATION_IDEMPOTENCY_CONFLICT" }
    );
});

test("Legacy composes an available Target adapter but keeps it inert and exposes no handlers", async () => {
    const { canonical } = targetHarness();
    let healthCalls = 0;
    const runtime = await createDiamondsDomainTargetRuntime({
        mode: "Legacy",
        canonicalRuntime: canonical.poc,
        healthProbe: async () => { healthCalls += 1; return healthy(); }
    });
    assert.equal(runtime.mode, "Legacy");
    assert.equal(runtime.targetAdapterComposed, true);
    assert.equal(runtime.targetAdapterSource, "canonical_runtime");
    assert.equal(runtime.active, false);
    assert.equal(runtime.handlers, null);
    assert.equal(healthCalls, 0);
    await assert.rejects(runtime.adapter.read({ playFabId: PLAYER }), {
        code: "DIAMONDS_TARGET_MODE_INACTIVE"
    });
    assert.throws(() => registerDiamondsDomainTargetRoutes({ post() {} }, { handlers: runtime.handlers }), {
        code: "DIAMONDS_TARGET_ROUTES_INACTIVE"
    });
});

test("Shadow is read-only and fails closed when Target health is incomplete", async () => {
    const { adapter } = targetHarness();
    await assert.rejects(
        createDiamondsDomainTargetRuntime({
            mode: "Shadow",
            titleId: TITLE,
            forbiddenTitleIds: [PRODUCTION_TITLE],
            targetAdapter: adapter,
            healthProbe: async () => ({ ...await healthy(), redisHealthy: false })
        }),
        { code: "DIAMONDS_TARGET_UNHEALTHY" }
    );
    const runtime = await createDiamondsDomainTargetRuntime({
        mode: "Shadow",
        titleId: TITLE,
        forbiddenTitleIds: [PRODUCTION_TITLE],
        targetAdapter: adapter,
        healthProbe: healthy
    });
    assert.equal(runtime.handlers, null);
    await assert.rejects(runtime.adapter.mutate(mutation()), {
        code: "DIAMONDS_TARGET_SHADOW_READ_ONLY"
    });
});

test("Canary refuses missing adapter, health, certificate, expiry, and forbidden Production Title", async () => {
    const { adapter } = targetHarness();
    const base = {
        mode: "Canary",
        titleId: TITLE,
        forbiddenTitleIds: [PRODUCTION_TITLE],
        canaryPlayFabIds: [PLAYER],
        targetAdapter: adapter,
        healthProbe: healthy,
        readinessCertificate: certificate(),
        verifyReadinessCertificate: verifier(),
        authenticateGameServer,
        authorizePlayer
    };
    await assert.rejects(createDiamondsDomainTargetRuntime({ ...base, targetAdapter: null }), {
        code: "DIAMONDS_TARGET_ADAPTER_MISSING"
    });
    await assert.rejects(createDiamondsDomainTargetRuntime({ ...base, healthProbe: null }), {
        code: "DIAMONDS_TARGET_HEALTH_MISSING"
    });
    await assert.rejects(createDiamondsDomainTargetRuntime({ ...base, readinessCertificate: null }), {
        code: "DIAMONDS_READINESS_CERTIFICATE_MISSING"
    });
    await assert.rejects(createDiamondsDomainTargetRuntime({ ...base, verifyReadinessCertificate: verifier(1) }), {
        code: "DIAMONDS_READINESS_CERTIFICATE_INVALID"
    });
    await assert.rejects(createDiamondsDomainTargetRuntime({ ...base, titleId: PRODUCTION_TITLE }), {
        code: "DIAMONDS_TARGET_TITLE_FORBIDDEN"
    });
});

test("Canary is exact-player only and exposes authenticated game-server handlers", async () => {
    const { adapter } = targetHarness();
    const runtime = await createDiamondsDomainTargetRuntime({
        mode: "Canary",
        titleId: TITLE,
        forbiddenTitleIds: [PRODUCTION_TITLE],
        canaryPlayFabIds: [PLAYER],
        targetAdapter: adapter,
        healthProbe: healthy,
        readinessCertificate: certificate(),
        verifyReadinessCertificate: verifier(),
        authenticateGameServer,
        authorizePlayer
    });
    assert.equal(runtime.handlers.authenticationType, "GameServer");
    assert.equal(runtime.handlers.clientSessionTicketsAccepted, false);
    await assert.rejects(runtime.adapter.read({ playFabId: "NOT_THE_CANARY" }), {
        code: "DIAMONDS_CANARY_PLAYER_DENIED"
    });
    const res = response();
    await runtime.handlers.mutate({ body: mutation() }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "Applied");
    assert.equal(res.body.balance, 25);
});

test("HTTP rejects unauthenticated game servers, unauthorized players, and financial field injection", async () => {
    const { adapter } = targetHarness();
    const silentLogger = { warn() {}, error() {} };
    const unauthenticated = createDiamondsDomainTargetHttpHandlers({
        adapter,
        authenticateGameServer: async () => null,
        authorizePlayer,
        logger: silentLogger
    });
    await assert.rejects(unauthenticated.mutate({ body: mutation() }, response()), {
        code: "DIAMONDS_TARGET_AUTH_REQUIRED"
    });

    const unauthorized = createDiamondsDomainTargetHttpHandlers({
        adapter,
        authenticateGameServer,
        authorizePlayer: async () => ({ authorized: false }),
        logger: silentLogger
    });
    await assert.rejects(unauthorized.mutate({ body: mutation() }, response()), {
        code: "DIAMONDS_TARGET_PLAYER_UNAUTHORIZED"
    });

    const handlers = createDiamondsDomainTargetHttpHandlers({
        adapter,
        authenticateGameServer,
        authorizePlayer,
        logger: silentLogger
    });
    await assert.rejects(handlers.mutate({ body: { ...mutation(), balance: 9_999 } }, response()), {
        code: "DIAMONDS_TARGET_HTTP_SCHEMA"
    });
});

test("route registration is narrow and POST-only", () => {
    const paths = [];
    const app = { post(path) { paths.push(path); } };
    const handlers = { read() {}, mutate() {} };
    const registered = registerDiamondsDomainTargetRoutes(app, { handlers });
    assert.deepEqual(paths, [
        "/financial/domains/diamonds/v1/read",
        "/financial/domains/diamonds/v1/mutate"
    ]);
    assert.equal(registered.routeCount, 2);
    assert.equal(registered.gameServerAuthenticated, true);
});
