import test from "node:test";
import assert from "node:assert/strict";
import {
    createDiamondsDomainServerComposition,
    loadDiamondsReadinessCertificate
} from "../src/diamonds-domain-server-composition.js";
import { registerDiamondsDomainTargetRoutes } from "../src/diamonds-domain-target-http.js";

const LEGACY = Object.freeze({
    domain: "Diamonds",
    mode: "Legacy",
    canaryEnabled: false,
    cutoverEnabled: false,
    migrationEnabled: false,
    canaryPlayFabIds: Object.freeze([])
});

const CANARY = Object.freeze({
    domain: "Diamonds",
    mode: "Canary",
    canaryEnabled: true,
    cutoverEnabled: false,
    migrationEnabled: false,
    canaryPlayFabIds: Object.freeze(["61AD15CDA4137EA9"])
});

test("server composition keeps the real Target factory composed but never constructs or probes it in Legacy", async () => {
    let buildCalls = 0;
    const composition = await createDiamondsDomainServerComposition({
        configuration: LEGACY,
        buildCanonicalRuntime() {
            buildCalls += 1;
            throw new Error("Legacy must not construct the Target runtime");
        }
    });
    assert.equal(composition.mode, "Legacy");
    assert.equal(composition.active, false);
    assert.equal(composition.targetAdapterComposed, true);
    assert.equal(composition.targetAdapterSource, "canonical_runtime");
    assert.equal(composition.handlers, null);
    assert.deepEqual(composition.runtimeDiagnostics(), {
        constructed: false,
        constructionPending: false
    });
    assert.equal(buildCalls, 0);

    const routes = [];
    if (composition.handlers) {
        registerDiamondsDomainTargetRoutes({ post(path) { routes.push(path); } }, {
            handlers: composition.handlers
        });
    }
    assert.deepEqual(routes, []);
});

test("Legacy certificate loader performs no file access", () => {
    let reads = 0;
    const result = loadDiamondsReadinessCertificate({
        mode: "Legacy",
        certificatePath: "should-not-be-read.json",
        readFile() { reads += 1; throw new Error("unexpected read"); }
    });
    assert.equal(result, null);
    assert.equal(reads, 0);
});

test("non-Legacy certificate loader fails closed when evidence is absent", () => {
    assert.throws(() => loadDiamondsReadinessCertificate({
        mode: "Canary",
        certificatePath: "missing.json",
        readFile() { throw new Error("missing"); }
    }), { code: "DIAMONDS_READINESS_CERTIFICATE_MISSING" });
});

test("Canary activation cannot construct without real Redis/PlayFab/game-server dependencies", async () => {
    await assert.rejects(createDiamondsDomainServerComposition({
        configuration: CANARY,
        readinessCertificate: Object.freeze({}),
        redis: null,
        titleId: "1D0C16",
        secretKey: null,
        gameServerId: null,
        gameServerToken: null
    }), { code: "DIAMONDS_TARGET_RUNTIME_DEPENDENCY_MISSING" });
});

test("Canary Sandbox composition refuses the Production Title before any provider call", async () => {
    let redisCalls = 0;
    const redis = {
        async sendCommand() { redisCalls += 1; throw new Error("must not call Redis"); },
        async ping() { redisCalls += 1; throw new Error("must not call Redis"); }
    };
    await assert.rejects(createDiamondsDomainServerComposition({
        configuration: CANARY,
        readinessCertificate: Object.freeze({}),
        redis,
        titleId: "142853",
        secretKey: "not-used-but-present",
        gameServerId: "sandbox-mirror",
        gameServerToken: "x".repeat(32)
    }), { code: "DIAMONDS_TARGET_TITLE_FORBIDDEN" });
    assert.equal(redisCalls, 0);
});
