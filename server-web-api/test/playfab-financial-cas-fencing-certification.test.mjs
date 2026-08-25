import test from "node:test";
import assert from "node:assert/strict";
import {
    CANARY_PLAYFAB_ID,
    CANARY_TITLE_PLAYER_ACCOUNT_ID,
    CERTIFICATION_GATES,
    PRODUCTION_TITLE_ID,
    SANDBOX_TITLE_ID,
    assertSandboxCertificationEnvironment,
    createPlayFabSetObjectsBarrierFetch,
    createPlayFabSetObjectsFaultController,
    convergePremiumWorkerRetries,
    convergeRawCasRetries,
    finalizeCertificationCleanup,
    loadCertificationConfiguration,
    parseCertificationArguments,
    parsePlayFabProviderError,
    parseWorkerOutput,
    providerEntityContext,
    redactCertificationValue,
    restoreProviderBaseline,
    safeCertificationError,
    safeProviderCauseDiagnostics,
    sanitizeWorkerDiagnostics,
    summarizeCertificationConfiguration,
    validateWorkerJob,
    writeProviderStateExact
} from "../playfab-financial-cas-fencing-certification.mjs";

function safeEnvironment(overrides = {}) {
    return {
        NODE_ENV: "test",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: SANDBOX_TITLE_ID,
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: "test-only-secret-never-log",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_PLAYFAB_ID: CANARY_PLAYFAB_ID,
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_URL: "redis://sandbox-user:sandbox-pass@127.0.0.1:63879/0",
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_PREFIX:
            "seabyss:cert:financial:1d0c16:unit-run:",
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_ISOLATED: "true",
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_MUTATION_ENABLED: "true",
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_RUN_ID: "unit-run",
        XSOLLA_CHECKOUT_MODE: "sandbox",
        ...Object.fromEntries(CERTIFICATION_GATES.map((gate) => [gate, "false"])),
        ...overrides
    };
}

function setObjectsRequest(objectNames = ["SeabyssEconomyStateV1", "SeabyssEconomyProofV1"]) {
    return [
        "https://1D0C16.playfabapi.com/Object/SetObjects",
        {
            method: "POST",
            body: JSON.stringify({
                Entity: { Id: "CANARY_TPA", Type: "title_player_account" },
                ExpectedProfileVersion: 7,
                Objects: objectNames.map((ObjectName) => ({ ObjectName, DataObject: {} }))
            })
        }
    ];
}

function providerFixtureState(marker = "baseline") {
    return {
        snapshot: { marker, nested: { beta: 2, alpha: 1 } },
        fence: null,
        highValueProof: null,
        ammoProof: null
    };
}

function createProviderWriterHarness({ initialState, setObjectsBehavior = null } = {}) {
    const objectFields = new Map([
        ["SeabyssEconomyStateV1", "snapshot"],
        ["SeabyssEconomyFenceV1", "fence"],
        ["SeabyssEconomyProofV1", "highValueProof"],
        ["SeabyssEconomyAmmoProofV1", "ammoProof"]
    ]);
    let state = structuredClone(initialState);
    let version = 7;
    let setObjectsCalls = 0;
    let readCalls = 0;
    function metadata() {
        return {
            exists: state.snapshot !== null,
            objectVersion: version,
            snapshot: structuredClone(state.snapshot),
            fence: structuredClone(state.fence),
            highValueProof: structuredClone(state.highValueProof),
            ammoProof: structuredClone(state.ammoProof)
        };
    }
    function apply(objects) {
        for (const object of objects) {
            const field = objectFields.get(object.ObjectName);
            assert.ok(field, `unexpected provider object ${object.ObjectName}`);
            state[field] = object.DeleteObject === true ? null : structuredClone(object.DataObject);
        }
        version += 1;
    }
    const harness = {
        playFab: {
            getUserAccountInfo: async (playFabId) => ({
                UserInfo: {
                    PlayFabId: playFabId,
                    TitleInfo: { TitlePlayerAccount: { Id: CANARY_TITLE_PLAYER_ACCOUNT_ID } }
                }
            }),
            getEntityToken: async () => ({ EntityToken: "test-only-entity-token" }),
            async setObjects(entity, entityToken, expectedVersion, objects) {
                assert.equal(entity.Id, CANARY_TITLE_PLAYER_ACCOUNT_ID);
                assert.equal(entityToken, "test-only-entity-token");
                assert.equal(expectedVersion, version);
                setObjectsCalls += 1;
                if (setObjectsBehavior) {
                    return setObjectsBehavior({ call: setObjectsCalls, objects, apply: () => apply(objects) });
                }
                apply(objects);
                return { ProfileVersion: version };
            }
        },
        snapshotStore: {
            async readWithMetadata() {
                readCalls += 1;
                return metadata();
            }
        }
    };
    return {
        harness,
        counters: () => ({ setObjectsCalls, readCalls }),
        state: () => structuredClone(state)
    };
}

function providerError(code, { status = null, retryable = false, retryAfterMilliseconds = null } = {}) {
    const error = new Error("test provider failure");
    error.code = code;
    if (status !== null) error.status = status;
    error.retryable = retryable;
    if (retryAfterMilliseconds !== null) error.retryAfterMilliseconds = retryAfterMilliseconds;
    return error;
}

test("Sandbox guard accepts only Title 1D0C16 and the dedicated canary", () => {
    assert.deepEqual(assertSandboxCertificationEnvironment(safeEnvironment()), {
        titleId: SANDBOX_TITLE_ID,
        canaryPlayFabId: CANARY_PLAYFAB_ID
    });
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({
            PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: PRODUCTION_TITLE_ID
        })),
        { code: "CERT_PRODUCTION_TITLE_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({
            PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "WRONG_TITLE"
        })),
        { code: "CERT_SANDBOX_TITLE_MISMATCH" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({
            PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_PLAYFAB_ID: "ANOTHER_PLAYER"
        })),
        { code: "CERT_CANARY_MISMATCH" }
    );
});

test("provider context accepts only the exact canary Title Player Account", async () => {
    const account = (entityId) => ({
        UserInfo: {
            PlayFabId: CANARY_PLAYFAB_ID,
            TitleInfo: { TitlePlayerAccount: { Id: entityId } }
        }
    });
    const accepted = await providerEntityContext({
        getUserAccountInfo: async () => account(CANARY_TITLE_PLAYER_ACCOUNT_ID),
        getEntityToken: async () => ({ EntityToken: "test-only-entity-token" })
    }, CANARY_PLAYFAB_ID);
    assert.deepEqual(accepted.entity, {
        Id: CANARY_TITLE_PLAYER_ACCOUNT_ID,
        Type: "title_player_account"
    });

    await assert.rejects(providerEntityContext({
        getUserAccountInfo: async () => account("FOREIGN_TITLE_PLAYER_ACCOUNT"),
        getEntityToken: async () => ({ EntityToken: "must-not-be-used" })
    }, CANARY_PLAYFAB_ID), { code: "CERT_CANARY_ENTITY_MISMATCH" });
});
test("guard refuses production, active/invalid gates, and missing explicit mutation isolation", () => {
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({ NODE_ENV: "production" })),
        { code: "CERT_PRODUCTION_ENVIRONMENT_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({ PURCHASES_GLOBAL_ENABLED: "true" })),
        { code: "CERT_ACTIVE_GATE_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({ PURCHASES_GLOBAL_ENABLED: "maybe" })),
        { code: "CERT_INVALID_SWITCH" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({ PAYMENT_WORKER_ENABLED: "true" })),
        { code: "CERT_ACTIVE_GATE_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({ PLAYFAB_ECONOMY_V2_ENABLED: "true" })),
        { code: "CERT_ACTIVE_GATE_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({
            XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS: "true"
        })),
        { code: "CERT_ACTIVE_GATE_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({ XSOLLA_CHECKOUT_MODE: "production" })),
        { code: "CERT_PRODUCTION_CHECKOUT_MODE_REFUSED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({
            PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_ISOLATED: "false"
        })),
        { code: "CERT_ISOLATED_REDIS_REQUIRED" }
    );
    assert.throws(
        () => assertSandboxCertificationEnvironment(safeEnvironment({
            PLAYFAB_FINANCIAL_CAS_CERTIFICATION_MUTATION_ENABLED: "false"
        })),
        { code: "CERT_MUTATION_OPT_IN_REQUIRED" }
    );
});

test("configuration keeps credentials private and constrains Redis to the run prefix", () => {
    const configuration = loadCertificationConfiguration(safeEnvironment());
    assert.equal(configuration.titleId, SANDBOX_TITLE_ID);
    assert.equal(configuration.canaryPlayFabId, CANARY_PLAYFAB_ID);
    assert.equal(configuration.redisPrefix, "seabyss:cert:financial:1d0c16:unit-run:");
    const summary = summarizeCertificationConfiguration(configuration);
    assert.equal(summary.redisEndpoint, "redis://127.0.0.1:63879/0");
    assert.equal(summary.secretsLogged, false);
    assert.equal(JSON.stringify(summary).includes("sandbox-pass"), false);
    assert.equal(JSON.stringify(summary).includes("test-only-secret-never-log"), false);
    assert.throws(
        () => loadCertificationConfiguration(safeEnvironment({
            PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_PREFIX: "server:economy:production:"
        })),
        { code: "CERT_UNSAFE_REDIS_PREFIX" }
    );
    assert.throws(
        () => loadCertificationConfiguration(safeEnvironment({
            PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_PREFIX:
                "seabyss:cert:financial:1d0c16:another-run:"
        })),
        { code: "CERT_RUN_PREFIX_MISMATCH" }
    );
    assert.throws(
        () => loadCertificationConfiguration(safeEnvironment({
            PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_URL: "redis://sandbox.example:6379/0"
        })),
        { code: "CERT_NON_LOOPBACK_REDIS_REFUSED" }
    );
});

test("recursive report redaction covers credential keys, explicit values, URLs, and cycles", () => {
    const cyclic = { label: "contains super-secret material", authorization: "Bearer abc" };
    cyclic.self = cyclic;
    const redacted = redactCertificationValue({
        secretKey: "super-secret",
        nested: cyclic,
        redisUrl: "redis://user:password@host:6379/0",
        safe: "visible"
    }, ["super-secret", "password"]);
    assert.equal(redacted.secretKey, "[REDACTED]");
    assert.equal(redacted.redisUrl, "[REDACTED]");
    assert.equal(redacted.nested.authorization, "[REDACTED]");
    assert.equal(redacted.nested.label.includes("super-secret"), false);
    assert.equal(redacted.nested.self, "[CIRCULAR]");
    assert.equal(redacted.safe, "visible");

    const safeError = safeCertificationError({
        code: "SAMPLE",
        message: "provider echoed super-secret",
        secretKey: "super-secret"
    }, ["super-secret"]);
    assert.equal(safeError.message, "provider echoed [REDACTED]");
    assert.equal(Object.hasOwn(safeError, "secretKey"), false);
});

test("PlayFab provider parsing recognizes real string/numeric CAS conflicts over HTTP 400", () => {
    assert.deepEqual(parsePlayFabProviderError({
        status: 400,
        payload: { error: "EntityProfileVersionMismatch", errorCode: 1352 }
    }), {
        status: 400,
        providerCode: "EntityProfileVersionMismatch",
        providerErrorCode: 1352,
        versionConflict: true,
        retryable: false,
        retryAfterSeconds: null
    });
    assert.equal(parsePlayFabProviderError({
        status: 400,
        payload: { errorCode: 1133 }
    }).versionConflict, true);
    assert.equal(parsePlayFabProviderError({
        status: 400,
        payload: { error: "UsersAlreadyFriends", errorCode: 1183 }
    }).versionConflict, false);
    assert.equal(parsePlayFabProviderError({
        status: 429,
        payload: { error: "APIRequestLimitExceeded", retryAfterSeconds: "3" }
    }).retryable, true);
});

test("fault wrapper injects a timeout before provider without sending the mutation", async () => {
    let calls = 0;
    const controller = createPlayFabSetObjectsFaultController({
        fetchImpl: async () => { calls += 1; return { ok: true }; }
    });
    controller.arm({ phase: "before" });
    await assert.rejects(controller.fetch(...setObjectsRequest()), {
        name: "AbortError",
        code: "CERT_TIMEOUT_BEFORE_PROVIDER"
    });
    assert.equal(calls, 0);
    assert.deepEqual(controller.snapshot(), { matchingCalls: 1, injectedCalls: 1, armed: false });
});

test("fault wrapper injects a lost response only after provider accepted one mutation", async () => {
    let calls = 0;
    const response = { ok: true, marker: "provider-response" };
    const controller = createPlayFabSetObjectsFaultController({
        fetchImpl: async () => { calls += 1; return response; }
    });
    controller.arm({ phase: "after" });
    await assert.rejects(controller.fetch(...setObjectsRequest()), {
        name: "AbortError",
        code: "CERT_TIMEOUT_AFTER_PROVIDER"
    });
    assert.equal(calls, 1);
    const passthrough = await controller.fetch(...setObjectsRequest());
    assert.equal(passthrough, response);
    assert.equal(calls, 2);
});

test("fault and barrier wrappers ignore fence-only and unrelated HTTP calls", async () => {
    let calls = 0;
    let barriers = 0;
    const base = async () => { calls += 1; return { ok: true }; };
    const controller = createPlayFabSetObjectsFaultController({ fetchImpl: base });
    controller.arm({ phase: "before" });
    const barrierFetch = createPlayFabSetObjectsBarrierFetch({
        fetchImpl: controller.fetch,
        arriveAndWait: async () => { barriers += 1; }
    });
    await barrierFetch(...setObjectsRequest(["SeabyssEconomyFenceV1"]));
    await barrierFetch("https://1D0C16.playfabapi.com/Object/GetObjects", {
        method: "POST",
        body: "{}"
    });
    assert.equal(calls, 2);
    assert.equal(barriers, 0);
    assert.deepEqual(controller.snapshot(), { matchingCalls: 0, injectedCalls: 0, armed: true });

    await assert.rejects(barrierFetch(...setObjectsRequest()), {
        code: "CERT_TIMEOUT_BEFORE_PROVIDER"
    });
    assert.equal(barriers, 1);
});

test("CLI parser exposes only orchestrator and bounded worker scenarios", () => {
    assert.deepEqual(parseCertificationArguments(["orchestrator"]), { mode: "orchestrator" });
    assert.deepEqual(
        parseCertificationArguments([
            "worker",
            "raw-cas",
            "seabyss:cert:financial:1d0c16:unit-run:cert:job:one",
            "worker-1"
        ]),
        {
            mode: "worker",
            scenario: "raw-cas",
            jobKey: "seabyss:cert:financial:1d0c16:unit-run:cert:job:one",
            workerId: "worker-1"
        }
    );
    assert.throws(() => parseCertificationArguments([]), { code: "CERT_USAGE" });
    assert.throws(
        () => parseCertificationArguments(["worker", "arbitrary", "job", "worker-1"]),
        { code: "CERT_USAGE" }
    );
    assert.throws(
        () => parseCertificationArguments(["worker", "raw-cas", "job", "unsafe worker"]),
        { code: "CERT_INVALID_IDENTIFIER" }
    );
});

test("worker result parser is strict, bounded, and rejects noisy output", () => {
    assert.deepEqual(parseWorkerOutput(JSON.stringify({
        workerId: "worker-1",
        status: "version_conflict",
        revision: 9,
        code: null
    })), {
        workerId: "worker-1",
        status: "version_conflict",
        revision: 9,
        code: null
    });
    assert.throws(() => parseWorkerOutput("not-json"), { code: "CERT_WORKER_PROTOCOL" });
    assert.throws(
        () => parseWorkerOutput('{"workerId":"one","status":"updated"}\nnoise'),
        { code: "CERT_WORKER_PROTOCOL" }
    );
    assert.throws(
        () => parseWorkerOutput(JSON.stringify({ workerId: "worker-1" })),
        { code: "CERT_WORKER_PROTOCOL" }
    );
});


test("raw CAS jobs are TTL-bound, canary-bound, and never persist a lease token", () => {
    const configuration = loadCertificationConfiguration(safeEnvironment());
    const now = Date.now();
    const job = {
        schemaVersion: 1,
        runId: configuration.runId,
        playFabId: CANARY_PLAYFAB_ID,
        expiresAtUnixMs: now + 1_000,
        barrier: {
            arrivedKey: `${configuration.redisPrefix}cert:barrier:raw:arrived`,
            releaseKey: `${configuration.redisPrefix}cert:barrier:raw:release`
        },
        casInput: {
            playFabId: CANARY_PLAYFAB_ID,
            expectedRevision: 7,
            fencingEpoch: 9,
            nextSnapshot: {
                playFabId: CANARY_PLAYFAB_ID,
                revision: 8,
                fencingEpoch: 9
            }
        }
    };
    assert.equal(validateWorkerJob(job, configuration, "raw-cas", now).casInput.expectedRevision, 7);
    assert.throws(
        () => validateWorkerJob({
            ...job,
            casInput: { ...job.casInput, leaseToken: "must-never-be-durable" }
        }, configuration, "raw-cas", now),
        { code: "CERT_JOB_CAS_INVALID" }
    );
    assert.throws(
        () => validateWorkerJob({
            ...job,
            casInput: {
                ...job.casInput,
                nextSnapshot: { ...job.casInput.nextSnapshot, playFabId: "FOREIGN_PLAYER" }
            }
        }, configuration, "raw-cas", now),
        { code: "CERT_JOB_IDENTITY_MISMATCH" }
    );
    assert.throws(
        () => validateWorkerJob({ ...job, expiresAtUnixMs: now - 1 }, configuration, "raw-cas", now),
        { code: "CERT_JOB_EXPIRED" }
    );
});

test("state-only raw CAS reaches the process barrier without arming provider-timeout injection", async () => {
    let calls = 0;
    let barriers = 0;
    const controller = createPlayFabSetObjectsFaultController({
        fetchImpl: async () => { calls += 1; return { ok: true }; }
    });
    controller.arm({ phase: "before" });
    const barrierFetch = createPlayFabSetObjectsBarrierFetch({
        fetchImpl: controller.fetch,
        arriveAndWait: async () => { barriers += 1; }
    });
    await barrierFetch(...setObjectsRequest(["SeabyssEconomyStateV1"]));
    assert.equal(barriers, 1);
    assert.equal(calls, 1);
    assert.deepEqual(controller.snapshot(), { matchingCalls: 0, injectedCalls: 0, armed: true });
});
test("runtime TTLs cover multiple provider calls while crash/takeover TTLs stay isolated", () => {
    const configuration = loadCertificationConfiguration(safeEnvironment());
    assert.equal(configuration.leaseTtlMilliseconds, 74_000);
    assert.equal(configuration.claimTtlMilliseconds, 74_000);
    assert.equal(configuration.crashLeaseTtlMilliseconds, 37_000);
    assert.equal(configuration.crashClaimTtlMilliseconds, 37_000);
    assert.ok(configuration.crashLeaseTtlMilliseconds >= 30_000);
    assert.ok(configuration.crashClaimTtlMilliseconds >= 30_000);
    assert.equal(configuration.shortLeaseTtlMilliseconds, 2_000);
    assert.equal(configuration.shortClaimTtlMilliseconds, 2_000);
    const maximum = loadCertificationConfiguration(safeEnvironment({
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_PROVIDER_TIMEOUT_MS: "30000",
        PLAYFAB_FINANCIAL_CAS_CERTIFICATION_WORKER_TIMEOUT_MS: "120000"
    }));
    assert.equal(maximum.leaseTtlMilliseconds, 250_000);
    assert.equal(maximum.claimTtlMilliseconds, 250_000);
    assert.equal(maximum.crashLeaseTtlMilliseconds, 125_000);
    assert.equal(maximum.crashClaimTtlMilliseconds, 125_000);
    assert.ok(maximum.leaseTtlMilliseconds <= 300_000);
    const summary = summarizeCertificationConfiguration(configuration);
    assert.equal(summary.leaseTtlMilliseconds, 74_000);
    assert.equal(summary.crashLeaseTtlMilliseconds, 37_000);
    assert.equal(summary.shortLeaseTtlMilliseconds, 2_000);
});

test("provider exact writer is hash-first and canonical-order tolerant", async () => {
    const intended = providerFixtureState();
    const reordered = {
        snapshot: { nested: { alpha: 1, beta: 2 }, marker: "baseline" },
        fence: null,
        highValueProof: null,
        ammoProof: null
    };
    const fixture = createProviderWriterHarness({ initialState: reordered });
    const result = await writeProviderStateExact(
        fixture.harness,
        CANARY_PLAYFAB_ID,
        intended,
        "test_restore",
        { sleep: async () => {} }
    );
    assert.equal(result.status, "test_restore_already_exact");
    assert.deepEqual(fixture.counters(), { setObjectsCalls: 0, readCalls: 1 });
});

test("provider exact writer reconciles timeout-after without a second mutation", async () => {
    const intended = providerFixtureState();
    const fixture = createProviderWriterHarness({
        initialState: providerFixtureState("dirty"),
        setObjectsBehavior: async ({ apply }) => {
            apply();
            throw providerError("PLAYFAB_TIMEOUT", { retryable: true });
        }
    });
    const result = await writeProviderStateExact(
        fixture.harness,
        CANARY_PLAYFAB_ID,
        intended,
        "test_restore",
        { sleep: async () => {} }
    );
    assert.equal(result.status, "test_restore_recovered");
    assert.equal(fixture.counters().setObjectsCalls, 1);
    assert.deepEqual(fixture.state(), intended);
});

test("provider exact writer retries timeout-before, 429 and 503 with bounded delay", async () => {
    const cases = [
        { error: () => providerError("PLAYFAB_TIMEOUT", { retryable: true }), expectedDelay: 100 },
        { error: () => providerError("APIRequestLimitExceeded", {
            status: 429,
            retryable: true,
            retryAfterMilliseconds: 60_000
        }), expectedDelay: 2_000 },
        { error: () => providerError("HTTP_503", { status: 503, retryable: true }), expectedDelay: 100 }
    ];
    for (const entry of cases) {
        const intended = providerFixtureState();
        const delays = [];
        const fixture = createProviderWriterHarness({
            initialState: providerFixtureState("dirty"),
            setObjectsBehavior: async ({ call, apply }) => {
                if (call === 1) throw entry.error();
                apply();
            }
        });
        const result = await writeProviderStateExact(
            fixture.harness,
            CANARY_PLAYFAB_ID,
            intended,
            "test_restore",
            { maximumAttempts: 3, sleep: async (delay) => { delays.push(delay); } }
        );
        assert.equal(result.status, "test_restore");
        assert.equal(fixture.counters().setObjectsCalls, 2);
        assert.deepEqual(delays, [entry.expectedDelay]);
    }
});

test("provider exact writer does not retry a nonretryable rejection", async () => {
    const fixture = createProviderWriterHarness({
        initialState: providerFixtureState("dirty"),
        setObjectsBehavior: async () => {
            throw providerError("InvalidParams", { status: 400, retryable: false });
        }
    });
    await assert.rejects(writeProviderStateExact(
        fixture.harness,
        CANARY_PLAYFAB_ID,
        providerFixtureState(),
        "test_restore",
        { sleep: async () => {} }
    ), { code: "CERT_PROVIDER_STATE_WRITE_REJECTED" });
    assert.equal(fixture.counters().setObjectsCalls, 1);
});

test("provider exact writer exhausts exactly five transient attempts", async () => {
    const delays = [];
    const fixture = createProviderWriterHarness({
        initialState: providerFixtureState("dirty"),
        setObjectsBehavior: async () => {
            throw providerError("HTTP_503", { status: 503, retryable: true });
        }
    });
    await assert.rejects(writeProviderStateExact(
        fixture.harness,
        CANARY_PLAYFAB_ID,
        providerFixtureState(),
        "test_restore",
        { sleep: async (delay) => { delays.push(delay); } }
    ), { code: "CERT_PROVIDER_STATE_RETRY_EXHAUSTED" });
    assert.equal(fixture.counters().setObjectsCalls, 5);
    assert.equal(delays.length, 4);
    assert.ok(delays.every((delay) => delay >= 0 && delay <= 2_000));
});

test("baseline restoration disarms provider fault injection before any write", async () => {
    let armed = true;
    let disarmCalls = 0;
    const baseline = providerFixtureState();
    const fixture = createProviderWriterHarness({
        initialState: providerFixtureState("dirty"),
        setObjectsBehavior: async ({ apply }) => {
            assert.equal(armed, false);
            apply();
        }
    });
    const result = await restoreProviderBaseline({
        faultController: {
            disarm() {
                disarmCalls += 1;
                armed = false;
            }
        },
        harness: fixture.harness,
        playFabId: CANARY_PLAYFAB_ID,
        baselineState: baseline
    });
    assert.equal(result.status, "provider_baseline_restored");
    assert.equal(disarmCalls, 1);
    assert.deepEqual(fixture.state(), baseline);
});

test("cleanup preserves a primary failure and reports provider plus Redis failures safely", async () => {
    const primary = providerError("CERT_PRIMARY_FAILURE");
    primary.message = "primary contains super-secret";
    const restore = providerError("CERT_RESTORE_FAILURE");
    restore.message = "restore contains super-secret";
    const redis = providerError("CERT_REDIS_FAILURE");
    let redisAttempted = false;
    let combined;
    try {
        await finalizeCertificationCleanup({
            primaryFailure: primary,
            restoreProvider: async () => { throw restore; },
            cleanupRedis: async () => {
                redisAttempted = true;
                throw redis;
            }
        });
    } catch (error) {
        combined = error;
    }
    assert.equal(redisAttempted, true);
    const safe = safeCertificationError(combined, ["super-secret"]);
    assert.equal(safe.code, "CERT_PRIMARY_AND_CLEANUP_FAILURE");
    assert.deepEqual(safe.failures, [
        { stage: "primary", code: "CERT_PRIMARY_FAILURE" },
        { stage: "provider_restore", code: "CERT_RESTORE_FAILURE" },
        { stage: "redis_cleanup", code: "CERT_REDIS_FAILURE" }
    ]);
    assert.equal(JSON.stringify(safe).includes("super-secret"), false);

    let observed = null;
    try {
        await finalizeCertificationCleanup({
            primaryFailure: primary,
            restoreProvider: async () => ({ status: "restored" }),
            cleanupRedis: async () => {}
        });
    } catch (error) {
        observed = error;
    }
    assert.equal(observed, primary);
});

test("Premium worker diagnostics retain only bounded non-secret fields", () => {
    assert.deepEqual(sanitizeWorkerDiagnostics([{
        workerId: "premium-secret-worker",
        status: "rejected",
        revision: 12,
        code: "POC_PLAYER_BUSY",
        secretKey: "must-not-appear",
        diagnostic: "must-not-appear"
    }]), [{ worker: 1, status: "rejected", revision: 12, code: "POC_PLAYER_BUSY" }]);
    assert.equal(JSON.stringify(sanitizeWorkerDiagnostics([{
        workerId: "worker",
        status: "unexpected-secret-status",
        revision: -1,
        code: "secret-value"
    }])).includes("secret"), false);
});
test("Premium convergence retries every reviewed transient code with fresh attempt numbers", async () => {
    const transientCodes = [
        "POC_PLAYER_BUSY",
        "POC_OPERATION_BUSY",
        "POC_OPERATION_ORDER_BLOCKED",
        "POC_STALE_WRITER",
        "POC_STALE_INBOX_CLAIM",
        "POC_PLAYFAB_AMBIGUOUS_RESULT",
        "POC_PLAYFAB_FENCE_ACTIVATION_CONFLICT",
        "POC_SNAPSHOT_CAS_EXHAUSTED",
        "POC_INBOX_ACK_FAILED",
        "POC_REDIS_LEASE_UNAVAILABLE"
    ];
    for (const code of transientCodes) {
        const attempts = [];
        const delays = [];
        const result = await convergePremiumWorkerRetries({
            name: "bronze",
            attempt: async (attemptNumber) => {
                attempts.push(attemptNumber);
                return attemptNumber === 1
                    ? { workerId: `worker-${attemptNumber}`, status: "rejected", revision: null, code }
                    : { workerId: `worker-${attemptNumber}`, status: "already_acked", revision: 12, code: null };
            },
            sleep: async (delay) => { delays.push(delay); }
        });
        assert.equal(result.converged, true);
        assert.equal(result.attemptCount, 2);
        assert.deepEqual(attempts, [1, 2]);
        assert.deepEqual(delays, [100]);
    }
});

test("Premium convergence stops immediately on protocol, worker, or integrity failures", async () => {
    const terminalCodes = [
        "CERT_WORKER_TIMEOUT",
        "CERT_WORKER_EXIT",
        "CERT_WORKER_PROTOCOL",
        "POC_OPERATION_IDEMPOTENCY_CONFLICT",
        "POC_PROVIDER_PROOF_CORRUPT"
    ];
    for (const code of terminalCodes) {
        let calls = 0;
        const result = await convergePremiumWorkerRetries({
            name: "gold",
            attempt: async () => {
                calls += 1;
                return { workerId: "worker", status: "rejected", revision: null, code };
            },
            sleep: async () => { throw new Error("nontransient result must not sleep"); }
        });
        assert.equal(result.converged, false);
        assert.equal(result.terminal, "nontransient");
        assert.equal(result.attemptCount, 1);
        assert.equal(calls, 1);
    }
});

test("Premium convergence is bounded to five attempts with sanitized diagnostics", async () => {
    const delays = [];
    const result = await convergePremiumWorkerRetries({
        name: "bronze",
        attempt: async (attemptNumber) => ({
            workerId: `secret-worker-${attemptNumber}`,
            status: "rejected",
            revision: null,
            code: "POC_PLAYER_BUSY",
            secretKey: "must-not-appear"
        }),
        sleep: async (delay) => { delays.push(delay); }
    });
    assert.equal(result.converged, false);
    assert.equal(result.terminal, "exhausted");
    assert.equal(result.attemptCount, 5);
    assert.deepEqual(delays, [100, 200, 300, 400]);
    assert.equal(result.diagnostics.length, 5);
    assert.equal(JSON.stringify(result).includes("secret"), false);
});
test("provider cause diagnostics expose only bounded safe fields across the cause chain", () => {
    const provider = new Error("secret provider message must not appear");
    provider.code = "HTTP_429";
    provider.providerError = "APIRequestLimitExceeded";
    provider.providerErrorCode = 1234;
    provider.status = 429;
    provider.retryAfterMilliseconds = 60_000;
    provider.body = { secretKey: "must-not-appear" };
    provider.headers = { authorization: "must-not-appear" };
    const ambiguous = new Error("secret ambiguous message");
    ambiguous.code = "POC_PLAYFAB_AMBIGUOUS_RESULT";
    ambiguous.cause = provider;
    const outer = new Error("secret outer message");
    outer.code = "POC_OPERATION_BUSY";
    outer.cause = ambiguous;

    const diagnostics = safeProviderCauseDiagnostics(outer);
    assert.deepEqual(diagnostics, [
        {
            depth: 0,
            code: "POC_OPERATION_BUSY",
            providerError: null,
            providerErrorCode: null,
            status: null,
            retryAfterMilliseconds: null
        },
        {
            depth: 1,
            code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
            providerError: null,
            providerErrorCode: null,
            status: null,
            retryAfterMilliseconds: null
        },
        {
            depth: 2,
            code: "HTTP_429",
            providerError: "APIRequestLimitExceeded",
            providerErrorCode: 1234,
            status: 429,
            retryAfterMilliseconds: 60_000
        }
    ]);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes("message"), false);
    assert.equal(serialized.includes("body"), false);
    assert.equal(serialized.includes("header"), false);
    assert.equal(serialized.includes("secret"), false);
});

test("provider cause diagnostics stop at five entries and sanitize worker payload bounds", () => {
    const errors = Array.from({ length: 7 }, (_, index) => {
        const error = new Error(`hidden-${index}`);
        error.code = `SAFE_${index}`;
        return error;
    });
    for (let index = 0; index < errors.length - 1; index += 1) errors[index].cause = errors[index + 1];
    errors[6].cause = errors[0];
    assert.equal(safeProviderCauseDiagnostics(errors[0]).length, 5);

    const [diagnostic] = sanitizeWorkerDiagnostics([{
        workerId: "gold",
        status: "rejected",
        revision: null,
        code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
        providerDiagnostics: [{
            code: "HTTP_400",
            providerError: "EntityProfileVersionMismatch",
            providerErrorCode: 1352,
            status: 400,
            retryAfterMilliseconds: 999_999,
            message: "must-not-appear",
            token: "must-not-appear"
        }]
    }]);
    assert.deepEqual(diagnostic.providerDiagnostics, [{
        depth: 0,
        code: "HTTP_400",
        providerError: "EntityProfileVersionMismatch",
        providerErrorCode: 1352,
        status: 400,
        retryAfterMilliseconds: null
    }]);
    assert.equal(JSON.stringify(diagnostic).includes("must-not-appear"), false);
});
test("Premium ambiguous 429 honors the 7000ms provider Retry-After without sleeping in test", async () => {
    const delays = [];
    const result = await convergePremiumWorkerRetries({
        name: "gold",
        attempt: async (attemptNumber) => attemptNumber === 1 ? {
            workerId: "gold-1",
            status: "rejected",
            revision: null,
            code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
            providerDiagnostics: [{
                code: "DataUpdateRateExceeded",
                providerError: "DataUpdateRateExceeded",
                providerErrorCode: 1287,
                status: 429,
                retryAfterMilliseconds: 7_000
            }]
        } : {
            workerId: "gold-2",
            status: "already_acked",
            revision: 20,
            code: null
        },
        sleep: async (delay) => { delays.push(delay); }
    });
    assert.equal(result.converged, true);
    assert.deepEqual(delays, [7_000]);

    const cappedDelays = [];
    await convergePremiumWorkerRetries({
        name: "gold",
        maximumDelayMilliseconds: 5_000,
        attempt: async (attemptNumber) => attemptNumber === 1 ? {
            workerId: "gold-cap-1",
            status: "rejected",
            revision: null,
            code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
            providerDiagnostics: [{ status: 429, retryAfterMilliseconds: 7_000 }]
        } : { workerId: "gold-cap-2", status: "already_acked", revision: 21, code: null },
        sleep: async (delay) => { cappedDelays.push(delay); }
    });
    assert.deepEqual(cappedDelays, [5_000]);
});

test("Premium ambiguous provider 400 is definitive and stops before a second attempt", async () => {
    let calls = 0;
    const result = await convergePremiumWorkerRetries({
        name: "gold",
        attempt: async () => {
            calls += 1;
            return {
                workerId: "gold-400",
                status: "rejected",
                revision: null,
                code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
                providerDiagnostics: [{
                    code: "HTTP_400",
                    providerError: "InvalidParams",
                    providerErrorCode: 1000,
                    status: 400,
                    retryAfterMilliseconds: null
                }]
            };
        },
        sleep: async () => { throw new Error("400 must not retry or sleep"); }
    });
    assert.equal(result.converged, false);
    assert.equal(result.terminal, "nontransient");
    assert.equal(result.attemptCount, 1);
    assert.equal(calls, 1);
});
function rawCasSnapshot({ revision = 11, fencingEpoch = 7, diamonds = 100, updatedAtUnixMs = 1_000 } = {}) {
    return {
        playFabId: CANARY_PLAYFAB_ID,
        revision,
        fencingEpoch,
        updatedAtUnixMs,
        diamonds,
        eliteBall: 13_000,
        premium: { tier: "bronze", expiresAtUnixMs: 86_400_000 },
        unlocks: { redPoint: true }
    };
}

test("raw CAS convergence keeps one immutable N+2 target and honors 429 Retry-After", async () => {
    const base = rawCasSnapshot();
    let current = structuredClone(base);
    const targets = [];
    const delays = [];
    const renewals = [];
    const result = await convergeRawCasRetries({
        baseSnapshot: base,
        fencingEpoch: 7,
        readSnapshot: async () => structuredClone(current),
        renewLease: async (entry) => { renewals.push(entry.phase); },
        attempt: async ({ attemptNumber, nextSnapshot, targetHash }) => {
            targets.push({ snapshot: structuredClone(nextSnapshot), targetHash });
            if (attemptNumber === 1) {
                return {
                    status: "rejected",
                    revision: null,
                    code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
                    providerDiagnostics: [{
                        providerError: "DataUpdateRateExceeded",
                        providerErrorCode: 1287,
                        status: 429,
                        retryAfterMilliseconds: 7_000
                    }]
                };
            }
            current = structuredClone(nextSnapshot);
            return { status: "updated", revision: nextSnapshot.revision, code: null };
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); }
    });
    assert.equal(result.status, "updated");
    assert.equal(result.attemptCount, 2);
    assert.equal(result.revisionAdvance, 1);
    assert.equal(current.revision, 12);
    assert.equal(current.diamonds, base.diamonds);
    assert.deepEqual(targets[0], targets[1]);
    assert.deepEqual(delays, [7_000]);
    assert.deepEqual(renewals, ["read", "attempt", "sleep", "read", "attempt"]);
});

test("raw CAS convergence reconciles an ambiguous applied target without producing N+3", async () => {
    const base = rawCasSnapshot();
    let current = structuredClone(base);
    let attempts = 0;
    const result = await convergeRawCasRetries({
        baseSnapshot: base,
        fencingEpoch: 7,
        readSnapshot: async () => structuredClone(current),
        renewLease: async () => {},
        attempt: async ({ nextSnapshot }) => {
            attempts += 1;
            current = structuredClone(nextSnapshot);
            return {
                status: "rejected",
                revision: null,
                code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
                providerDiagnostics: [{ status: 503 }]
            };
        },
        sleep: async () => { throw new Error("applied target must reconcile without sleep"); }
    });
    assert.equal(result.status, "recovered_after_ambiguous");
    assert.equal(attempts, 1);
    assert.equal(current.revision, 12);
    assert.equal(current.diamonds, 100);
});

test("raw CAS convergence stops on provider 400 and exposes only sanitized diagnostics", async () => {
    const base = rawCasSnapshot();
    let attempts = 0;
    let observed;
    try {
        await convergeRawCasRetries({
            baseSnapshot: base,
            fencingEpoch: 7,
            readSnapshot: async () => structuredClone(base),
            renewLease: async () => {},
            attempt: async () => {
                attempts += 1;
                return {
                    status: "rejected",
                    revision: null,
                    code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
                    providerDiagnostics: [{
                        providerError: "InvalidParams",
                        providerErrorCode: 1000,
                        status: 400,
                        body: "hidden-secret",
                        token: "hidden-secret"
                    }]
                };
            },
            sleep: async () => { throw new Error("400 must not sleep"); }
        });
    } catch (error) {
        observed = error;
    }
    assert.equal(observed?.code, "CERT_RAW_CAS_RETRY_FAILED");
    assert.equal(attempts, 1);
    assert.match(observed.message, /"status":400/u);
    assert.equal(observed.message.includes("hidden-secret"), false);
});

test("raw CAS convergence rejects stale lease and any state outside the immutable intent", async () => {
    const base = rawCasSnapshot();
    let attempts = 0;
    await assert.rejects(convergeRawCasRetries({
        baseSnapshot: base,
        fencingEpoch: 7,
        readSnapshot: async () => structuredClone(base),
        renewLease: async () => {
            const error = new Error("hidden stale lease detail");
            error.code = "POC_STALE_WRITER";
            throw error;
        },
        attempt: async () => { attempts += 1; },
        sleep: async () => {}
    }), { code: "CERT_RAW_CAS_RETRY_FAILED" });
    assert.equal(attempts, 0);

    const foreignState = rawCasSnapshot({ revision: 12, diamonds: 101 });
    await assert.rejects(convergeRawCasRetries({
        baseSnapshot: base,
        fencingEpoch: 7,
        readSnapshot: async () => structuredClone(foreignState),
        renewLease: async () => {},
        attempt: async () => { attempts += 1; },
        sleep: async () => {}
    }), { code: "CERT_RAW_CAS_RETRY_FAILED" });
    assert.equal(attempts, 0);
});

test("raw CAS convergence is bounded to five fresh attempts and renews around every backoff", async () => {
    const base = rawCasSnapshot();
    const attempts = [];
    const delays = [];
    const renewals = [];
    await assert.rejects(convergeRawCasRetries({
        baseSnapshot: base,
        fencingEpoch: 7,
        readSnapshot: async () => structuredClone(base),
        renewLease: async ({ attemptNumber, phase }) => { renewals.push(`${attemptNumber}:${phase}`); },
        attempt: async ({ attemptNumber, currentSnapshot, nextSnapshot }) => {
            attempts.push(attemptNumber);
            assert.equal(currentSnapshot.revision, 11);
            assert.equal(nextSnapshot.revision, 12);
            return { status: "version_conflict", revision: null, code: null };
        },
        sleep: async (milliseconds) => { delays.push(milliseconds); }
    }), { code: "CERT_RAW_CAS_RETRY_FAILED" });
    assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
    assert.deepEqual(delays, [100, 200, 300, 400]);
    assert.equal(renewals.filter((entry) => entry.endsWith(":read")).length, 5);
    assert.equal(renewals.filter((entry) => entry.endsWith(":attempt")).length, 5);
    assert.equal(renewals.filter((entry) => entry.endsWith(":sleep")).length, 4);
});
test("rate-limit exhaustion diagnostics are bounded, safe, and stop outer Premium retries", async () => {
    const provider = new Error("hidden provider detail");
    provider.code = "DataUpdateRateExceeded";
    provider.providerError = "DataUpdateRateExceeded";
    provider.providerErrorCode = 1287;
    provider.status = 429;
    provider.retryAfterMilliseconds = 7_000;
    provider.rateLimitRetryExhausted = true;
    provider.attempts = 5;
    provider.secretKey = "must-not-appear";
    const diagnostics = safeProviderCauseDiagnostics(provider);
    assert.deepEqual(diagnostics, [{
        depth: 0,
        code: "DataUpdateRateExceeded",
        providerError: "DataUpdateRateExceeded",
        providerErrorCode: 1287,
        status: 429,
        retryAfterMilliseconds: 7_000,
        rateLimitRetryExhausted: true,
        attempts: 5
    }]);
    assert.equal(JSON.stringify(diagnostics).includes("must-not-appear"), false);

    let calls = 0;
    const result = await convergePremiumWorkerRetries({
        name: "gold",
        attempt: async () => {
            calls += 1;
            return {
                status: "rejected",
                revision: null,
                code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
                providerDiagnostics: diagnostics
            };
        },
        sleep: async () => { throw new Error("exhausted core retry must stop outer retry"); }
    });
    assert.equal(calls, 1);
    assert.equal(result.terminal, "nontransient");
    assert.equal(result.attemptCount, 1);
});

test("rate-limit exhaustion stops raw CAS convergence after one immutable intent attempt", async () => {
    const base = rawCasSnapshot();
    let calls = 0;
    await assert.rejects(convergeRawCasRetries({
        baseSnapshot: base,
        fencingEpoch: 7,
        readSnapshot: async () => structuredClone(base),
        renewLease: async () => {},
        attempt: async () => {
            calls += 1;
            return {
                status: "rejected",
                revision: null,
                code: "POC_PLAYFAB_AMBIGUOUS_RESULT",
                providerDiagnostics: [{
                    status: 429,
                    providerError: "DataUpdateRateExceeded",
                    providerErrorCode: 1287,
                    rateLimitRetryExhausted: true,
                    attempts: 5
                }]
            };
        },
        sleep: async () => { throw new Error("exhausted core retry must not back off outside"); }
    }), { code: "CERT_RAW_CAS_RETRY_FAILED" });
    assert.equal(calls, 1);
});

test("provider exact writer does not multiply an exhausted core rate-limit retry", async () => {
    const fixture = createProviderWriterHarness({
        initialState: providerFixtureState("dirty"),
        setObjectsBehavior: async () => {
            const error = providerError("DataUpdateRateExceeded", {
                status: 429,
                retryable: true,
                retryAfterMilliseconds: 7_000
            });
            error.providerError = "DataUpdateRateExceeded";
            error.providerErrorCode = 1287;
            error.rateLimitRetryExhausted = true;
            error.attempts = 5;
            throw error;
        }
    });
    await assert.rejects(writeProviderStateExact(
        fixture.harness,
        CANARY_PLAYFAB_ID,
        providerFixtureState(),
        "test_restore",
        { sleep: async () => { throw new Error("outer restore must not retry"); } }
    ), { code: "CERT_PROVIDER_STATE_WRITE_REJECTED" });
    assert.equal(fixture.counters().setObjectsCalls, 1);
});