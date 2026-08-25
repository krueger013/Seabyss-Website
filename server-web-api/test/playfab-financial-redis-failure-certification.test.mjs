import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    CANARY_ENTITY_ID,
    CANARY_PLAYFAB_ID,
    PRODUCTION_TITLE_ID,
    REDIS_FAILURE_PREFIX,
    SANDBOX_TITLE_ID,
    createRedisFailurePauseMarker,
    emitRedisFailurePause,
    hashEphemeralClaimToken,
    loadRedisFailureConfiguration,
    normalizeRedisFailureScenario,
    parseRedisFailureArguments,
    selectRedisFailureRuntimeTtls,
    validateRedisFailureJob
} from "../playfab-financial-redis-failure-certification.mjs";

function environment(overrides = {}) {
    return {
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: SANDBOX_TITLE_ID,
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: "LOCAL_TEST_SECRET_NOT_REAL",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_PLAYFAB_ID: CANARY_PLAYFAB_ID,
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_ENTITY_ID: CANARY_ENTITY_ID,
        PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_URL: "redis://127.0.0.1:63879/0",
        PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_PREFIX: REDIS_FAILURE_PREFIX,
        PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_ISOLATED: "true",
        PLAYFAB_FINANCIAL_REDIS_FAILURE_MUTATION_ENABLED: "true",
        ...overrides
    };
}

function validJob(configuration, overrides = {}) {
    const operationId = "cert:redis-failure:diamonds-500:11111111-1111-4111-8111-111111111111";
    return {
        schemaVersion: 1,
        identity: {
            titleId: SANDBOX_TITLE_ID,
            playFabId: CANARY_PLAYFAB_ID,
            entityId: CANARY_ENTITY_ID
        },
        operation: {
            operationId,
            eventId: "cert-event:redis-failure:diamonds-500:11111111-1111-4111-8111-111111111111",
            immutableHash: "a".repeat(64),
            scenario: "diamonds-500"
        },
        before: {
            profileVersion: 4,
            revision: 0,
            fencingEpoch: 0,
            payloadHash: "b".repeat(64)
        },
        createdAtUnixMs: 1_000,
        expiresAtUnixMs: 2_000,
        ...overrides,
        _operationId: operationId,
        _configuration: configuration
    };
}

function withoutTestMetadata(value) {
    const { _operationId, _configuration, ...job } = value;
    return { job, operationId: _operationId, configuration: _configuration };
}

describe("PlayFab financial Redis/process failure certification harness", () => {
    test("accepts only the dedicated Sandbox canary, exact isolated loopback Redis, and explicit opt-in", () => {
        const configuration = loadRedisFailureConfiguration(environment());
        assert.equal(configuration.titleId, SANDBOX_TITLE_ID);
        assert.equal(configuration.playFabId, CANARY_PLAYFAB_ID);
        assert.equal(configuration.entityId, CANARY_ENTITY_ID);
        assert.equal(configuration.redisPrefix, REDIS_FAILURE_PREFIX);
        assert.equal(configuration.redisUrl, "redis://127.0.0.1:63879/0");
        assert.equal(configuration.leaseTtlMilliseconds, 2_000);
        assert.equal(configuration.claimTtlMilliseconds, 2_000);
    });

    test("uses short TTLs only for controlled pauses and a bounded provider-derived TTL for recovery", () => {
        const configuration = loadRedisFailureConfiguration(environment());
        assert.deepEqual(selectRedisFailureRuntimeTtls(configuration, "after_claim"), {
            mode: "controlled_expiration",
            leaseTtlMilliseconds: 2_000,
            claimTtlMilliseconds: 2_000
        });
        assert.deepEqual(selectRedisFailureRuntimeTtls(configuration, "after_provider"), {
            mode: "controlled_expiration",
            leaseTtlMilliseconds: 2_000,
            claimTtlMilliseconds: 2_000
        });
        assert.deepEqual(selectRedisFailureRuntimeTtls(configuration, "none"), {
            mode: "normal_or_recovery",
            leaseTtlMilliseconds: 64_000,
            claimTtlMilliseconds: 64_000
        });
        assert.equal(selectRedisFailureRuntimeTtls({
            ...configuration, providerTimeoutMilliseconds: 1_000
        }, "none").leaseTtlMilliseconds, 30_000);
        assert.equal(selectRedisFailureRuntimeTtls({
            ...configuration, providerTimeoutMilliseconds: 30_000
        }, "none").leaseTtlMilliseconds, 240_000);
        assert.throws(() => selectRedisFailureRuntimeTtls(configuration, "unbounded_pause"), {
            code: "REDIS_FAILURE_INVALID_PAUSE"
        });
    });

    test("fails closed for Production, another canary, an active gate, or missing explicit safety switches", () => {
        assert.throws(
            () => loadRedisFailureConfiguration(environment({
                PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: PRODUCTION_TITLE_ID
            })),
            { code: "REDIS_FAILURE_PRODUCTION_TITLE_REFUSED" }
        );
        assert.throws(
            () => loadRedisFailureConfiguration(environment({
                PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_PLAYFAB_ID: "OTHER_CANARY"
            })),
            { code: "REDIS_FAILURE_CANARY_MISMATCH" }
        );
        assert.throws(
            () => loadRedisFailureConfiguration(environment({ PURCHASES_GLOBAL_ENABLED: "true" })),
            { code: "REDIS_FAILURE_ACTIVE_GATE_REFUSED" }
        );
        for (const gate of [
            "PAYMENT_WORKER_ENABLED",
            "PLAYFAB_FINANCIAL_PROFILE_ENABLED",
            "PLAYFAB_ECONOMY_V2_ENABLED",
            "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED",
            "XSOLLA_ALLOW_SANDBOX_GRANTS",
            "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
            "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS",
            "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
            "XSOLLA_ENABLE_STANDALONE_PREMIUM_PRODUCTS"
        ]) assert.throws(() => loadRedisFailureConfiguration(environment({ [gate]: "true" })), {
            code: "REDIS_FAILURE_ACTIVE_GATE_REFUSED"
        });
        assert.throws(
            () => loadRedisFailureConfiguration(environment({
                PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_ISOLATED: "false"
            })),
            { code: "REDIS_FAILURE_ISOLATED_REDIS_REQUIRED" }
        );
        assert.throws(
            () => loadRedisFailureConfiguration(environment({
                PLAYFAB_FINANCIAL_REDIS_FAILURE_MUTATION_ENABLED: "false"
            })),
            { code: "REDIS_FAILURE_MUTATION_OPT_IN_REQUIRED" }
        );
        assert.throws(
            () => loadRedisFailureConfiguration(environment({ XSOLLA_CHECKOUT_MODE: "production" })),
            { code: "REDIS_FAILURE_PRODUCTION_CHECKOUT_MODE_REFUSED" }
        );
        assert.doesNotThrow(
            () => loadRedisFailureConfiguration(environment({ XSOLLA_CHECKOUT_MODE: "disabled" }))
        );
    });

    test("rejects non-loopback Redis, the wrong port, credentials, and any alternate prefix", () => {
        for (const redisUrl of [
            "redis://10.0.0.5:63879/0",
            "redis://127.0.0.1:6379/0",
            "redis://user:password@127.0.0.1:63879/0",
            "rediss://127.0.0.1:63879/0"
        ]) {
            assert.throws(
                () => loadRedisFailureConfiguration(environment({
                    PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_URL: redisUrl
                })),
                { code: "REDIS_FAILURE_UNSAFE_REDIS" }
            );
        }
        assert.throws(
            () => loadRedisFailureConfiguration(environment({
                PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_PREFIX: `${REDIS_FAILURE_PREFIX}other:`
            })),
            { code: "REDIS_FAILURE_UNSAFE_PREFIX" }
        );
    });

    test("parses only the three bounded CLI modes and canonicalizes fixed scenarios", () => {
        assert.deepEqual(parseRedisFailureArguments(["prepare", "diamonds"]), {
            mode: "prepare", scenario: "diamonds-500"
        });
        assert.deepEqual(parseRedisFailureArguments(["prepare", "elite-13000"]), {
            mode: "prepare", scenario: "elite-13000"
        });
        const operationId = "cert:redis-failure:diamonds-500:11111111-1111-4111-8111-111111111111";
        assert.deepEqual(parseRedisFailureArguments(["process", operationId, "after_claim"]), {
            mode: "process", operationId, pausePoint: "after_claim"
        });
        assert.deepEqual(parseRedisFailureArguments(["read", operationId]), { mode: "read", operationId });
        assert.equal(normalizeRedisFailureScenario("premium"), "premium-bronze");
        assert.throws(() => parseRedisFailureArguments(["process", operationId, "forever"]), {
            code: "REDIS_FAILURE_INVALID_PAUSE"
        });
        assert.throws(() => parseRedisFailureArguments(["read", "production:operation"]), {
            code: "REDIS_FAILURE_INVALID_OPERATION"
        });
        assert.throws(() => parseRedisFailureArguments(["prepare", "arbitrary-reward"]), {
            code: "REDIS_FAILURE_UNKNOWN_SCENARIO"
        });
        assert.throws(() => parseRedisFailureArguments(["read", operationId, "extra"]), {
            code: "REDIS_FAILURE_INVALID_ARGUMENTS"
        });
    });

    test("hashes ephemeral claim material before persistence", () => {
        const raw = "RAW_CLAIM_TOKEN_MUST_NOT_BE_PERSISTED";
        const hashed = hashEphemeralClaimToken(raw);
        assert.match(hashed, /^[a-f0-9]{64}$/u);
        assert.notEqual(hashed, raw);
        assert.equal(hashEphemeralClaimToken(raw), hashed);
    });

    test("creates and emits a bounded non-secret pause marker", async () => {
        const operationId = "cert:redis-failure:diamonds-500:11111111-1111-4111-8111-111111111111";
        const marker = createRedisFailurePauseMarker({
            pausePoint: "after_provider",
            operationId,
            scenario: "diamonds",
            ownerId: "worker-123",
            leaseEpoch: 2,
            revision: 9,
            leaseExpiresAtUnixMs: 20_000,
            boundedPauseMilliseconds: 1_000,
            leaseToken: "DO_NOT_LOG",
            claimToken: "DO_NOT_LOG"
        });
        assert.equal(marker.scenario, "diamonds-500");
        assert.equal(marker.tokensLogged, false);
        assert.equal(Object.hasOwn(marker, "leaseToken"), false);
        assert.equal(Object.hasOwn(marker, "claimToken"), false);
        const lines = [];
        const waits = [];
        await emitRedisFailurePause(marker, {
            writeLine: (line) => lines.push(line),
            wait: async (milliseconds) => { waits.push(milliseconds); }
        });
        assert.deepEqual(waits, [1_000]);
        assert.deepEqual(JSON.parse(lines[0]), marker);
        assert.doesNotMatch(lines[0], /DO_NOT_LOG/u);
    });

    test("validates exact nested job identities and bounded TTLs", () => {
        const configuration = loadRedisFailureConfiguration(environment());
        const source = validJob(configuration);
        const { job, operationId } = withoutTestMetadata(source);
        const verified = validateRedisFailureJob(job, {
            configuration,
            operationId,
            nowUnixMs: 1_500
        });
        assert.equal(verified.identity.titleId, SANDBOX_TITLE_ID);
        assert.equal(verified.operation.operationId, operationId);

        assert.throws(() => validateRedisFailureJob({
            ...job,
            identity: { ...job.identity, playFabId: "OTHER_CANARY" }
        }, { configuration, operationId, nowUnixMs: 1_500 }), {
            code: "REDIS_FAILURE_JOB_IDENTITY_MISMATCH"
        });
        assert.throws(() => validateRedisFailureJob({
            ...job,
            operation: { ...job.operation, unexpected: true }
        }, { configuration, operationId, nowUnixMs: 1_500 }), {
            code: "REDIS_FAILURE_JOB_CORRUPT"
        });
        assert.throws(() => validateRedisFailureJob(job, {
            configuration,
            operationId,
            nowUnixMs: 2_000
        }), { code: "REDIS_FAILURE_JOB_EXPIRED_OR_CORRUPT" });
    });
});
