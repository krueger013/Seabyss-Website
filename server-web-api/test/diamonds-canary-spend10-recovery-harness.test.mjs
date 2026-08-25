import test from "node:test";
import assert from "node:assert/strict";

process.env.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID = "1D0C16";
process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID = "C5BD37AA141B3C4E";
process.env.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS = "C5BD37AA141B3C4E";

const {
    parseRedisRespAof,
    runCanary02Spend10RecoveryHarness
} = await import("../src/diamonds-canary-spend10-recovery-harness.js?runner-tests");
const { readCanary02Spend10RecoveryEnvironment, runLiveCanary02Spend10Recovery } =
    await import("../diamonds-canary-spend10-recovery.mjs?runner-tests");

const OPERATION_ID = "diamonds-canary-v1:spend-10";
const OPERATION_HASH = "e738850decaa33a968dd8dee5b7595ab6e1ce6edbbf22dcb071f144714da2eb5";
const AUDIT_HASH = "a".repeat(64);

function aofEvidence() {
    return {
        provenance: { kind: "RedisAofReplay", sha256: "b".repeat(64), bytes: 1, concordantRecordCount: 15 },
        semanticContext: { contextId: "sandbox:spend_10" },
        eventIndexRecord: { immutableHash: "event", intent: { operationId: OPERATION_ID } },
        operationRecord: {
            state: "Pending",
            sequence: 2,
            operationId: OPERATION_ID,
            operation: { operationId: OPERATION_ID, immutableHash: OPERATION_HASH, diamondsDelta: -10 }
        },
        resolutionRecord: {
            state: "ManualReview",
            sequence: 2,
            operationId: OPERATION_ID,
            providerAttemptHistory: []
        },
        previousResolution: { state: "Acked", sequence: 1, operationId: "diamonds-canary-v1:grant-25" }
    };
}

function state(kind, evidence) {
    const pending = kind === "before" || kind === "scheduled";
    return {
        titleId: "1D0C16",
        productionTitleId: "142853",
        productionTitleUntouched: true,
        playFabId: "C5BD37AA141B3C4E",
        target: {
            diamonds: pending ? 25 : 15,
            revision: pending ? 2 : 3,
            highValueAppliedThroughSequence: pending ? 1 : 2,
            fencingEpoch: pending ? 5 : 11
        },
        migrationProof: pending
            ? { schemaVersion: 1, state: "Completed", titleId: "1D0C16", playFabId: "C5BD37AA141B3C4E",
                domain: "Diamonds", targetValue: 25, targetRevision: 2 }
            : { schemaVersion: 2, state: "Completed", titleId: "1D0C16", playFabId: "C5BD37AA141B3C4E",
                domain: "Diamonds", targetValue: 15, targetRevision: 3 },
        providerProof: pending
            ? { verified: false, reason: "missing" }
            : { verified: true, reason: "applied", operationId: OPERATION_ID,
                operationHash: OPERATION_HASH, delta: -10, balance: 15, revision: 3 },
        operation: pending
            ? evidence.operationRecord
            : { ...evidence.operationRecord, state: "Acked", result: { status: "applied" } },
        resolution: kind === "before"
            ? evidence.resolutionRecord
            : kind === "scheduled"
                ? { ...evidence.resolutionRecord, state: "RetryScheduled", recovery: { auditHash: AUDIT_HASH } }
                : { ...evidence.resolutionRecord, state: "Acked", recovery: { auditHash: AUDIT_HASH } },
        activeLease: null
    };
}

function metrics(setObjects) {
    return { counters: { "playfab_set_objects_total|": setObjects }, timings: {} };
}

function harnessDependencies({ providerFailure = null } = {}) {
    const evidence = aofEvidence();
    let phase = "before";
    let consumes = 0;
    let metricReads = 0;
    const metricValues = [3, 5, 5, 5];
    const proof = {
        operationId: OPERATION_ID,
        operationHash: OPERATION_HASH,
        schemaVersion: 2,
        bytes: 873,
        maximumBytes: 1024,
        providerRequestAttempted: true,
        providerWriteCompleted: true,
        reconciledAfterAmbiguousResponse: false
    };
    const calls = [];
    const dependencies = {
        calls,
        async inspectFinishState() { return state(phase, evidence); },
        async readRecoveryRedisRecords() {
            return {
                operationRecord: evidence.operationRecord,
                resolutionRecord: evidence.resolutionRecord,
                previousResolution: evidence.previousResolution,
                eventIndexRecord: evidence.eventIndexRecord,
                audit: null
            };
        },
        async acquireRecoveryPlayerLease() {
            calls.push("lease_acquire");
            return { status: "acquired", lease: { playFabId: "C5BD37AA141B3C4E", token: "not-logged", epoch: 9 } };
        },
        async importRecoveredOriginalOperation({ plan, lease }) {
            calls.push("import:" + lease.epoch + ":" + plan.operationId);
            phase = "scheduled";
            return { status: "recovered", recoveredOriginalOperation: true };
        },
        async releaseRecoveryPlayerLease() {
            calls.push("lease_release");
            return { status: "released" };
        },
        async consumeExistingTargetOperation() {
            consumes += 1;
            calls.push("consume:" + consumes);
            if (consumes === 1 && providerFailure) throw providerFailure;
            if (consumes === 1) {
                phase = "applied";
                return { status: "applied" };
            }
            return { status: "already_acked" };
        },
        async readProviderHttpMetrics() {
            return metrics(metricValues[Math.min(metricReads++, metricValues.length - 1)]);
        },
        async readProofWriteDiagnostics() {
            return phase === "applied" ? proof : null;
        }
    };
    return { dependencies, evidence };
}

function validateEvidence() {
    return { status: "complete", evidenceHash: "c".repeat(64) };
}

function createPlan() {
    return {
        status: "RecoveredOriginalOperation",
        operationId: OPERATION_ID,
        recoveryAudit: { kind: "RecoveredOriginalOperation", auditHash: AUDIT_HASH }
    };
}

test("targeted runner imports the exact original, writes once and replays without SetObjects", async () => {
    const h = harnessDependencies();
    const result = await runCanary02Spend10RecoveryHarness({
        explicitlyEnabled: true,
        providerWritesEnabled: true,
        aofEvidence: h.evidence,
        dependencies: h.dependencies,
        nowMilliseconds: () => 1_787_608_000_000,
        validateEvidence,
        createRecoveryPlan: createPlan
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(result.recoveredOriginalOperation, true);
    assert.equal(result.operationId, OPERATION_ID);
    assert.equal(result.sequence, 2);
    assert.equal(result.payloadBytes, 873);
    assert.equal(result.balanceBefore, 25);
    assert.equal(result.balanceAfter, 15);
    assert.equal(result.revisionAfter, 3);
    assert.equal(result.proofSchema, 2);
    assert.equal(result.replay, "already_acked");
    assert.equal(result.providerSetObjectsDuringAttempt, 2);
    assert.equal(result.economicProviderWrites, 1);
    assert.equal(result.replayProviderWrites, 0);
    assert.deepEqual(h.dependencies.calls, [
        "lease_acquire", "import:9:" + OPERATION_ID, "lease_release", "consume:1", "consume:2"
    ]);
});

test("provider failure stops after the one authorized attempt and never replays", async () => {
    const failure = Object.assign(new Error("provider failed"), { code: "POC_PLAYFAB_NOT_APPLIED" });
    const h = harnessDependencies({ providerFailure: failure });
    await assert.rejects(runCanary02Spend10RecoveryHarness({
        explicitlyEnabled: true,
        providerWritesEnabled: true,
        aofEvidence: h.evidence,
        dependencies: h.dependencies,
        nowMilliseconds: () => 1_787_608_000_000,
        validateEvidence,
        createRecoveryPlan: createPlan
    }), (error) => error === failure);
    assert.equal(h.dependencies.calls.filter((entry) => entry.startsWith("consume:")).length, 1);
});

test("runner refuses absent explicit write authorization before any dependency call", async () => {
    const h = harnessDependencies();
    await assert.rejects(runCanary02Spend10RecoveryHarness({
        explicitlyEnabled: true,
        providerWritesEnabled: false,
        aofEvidence: h.evidence,
        dependencies: h.dependencies,
        validateEvidence,
        createRecoveryPlan: createPlan
    }), (error) => error.code === "DIAMONDS_RECOVERY_DISABLED");
    assert.deepEqual(h.dependencies.calls, []);
});

test("RESP AOF parser preserves bulk JSON containing newlines", () => {
    const value = JSON.stringify({ operationId: OPERATION_ID, note: "line1\nline2" });
    const command = `*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    assert.deepEqual(parseRedisRespAof(Buffer.from(command, "utf8")), [["SET", "key", value]]);
});

function safeEnvironment() {
    return {
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        NODE_ENV: "test",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "1D0C16",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: "sandbox-secret-not-logged",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID: "C5BD37AA141B3C4E",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "C5BD37AA141B3C4E",
        FINANCIAL_DIAMONDS_MODE: "Canary",
        FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
        FINANCIAL_ELITE_MODE: "Legacy",
        FINANCIAL_PREMIUM_MODE: "Legacy",
        FINANCIAL_REDIS_URL: "redis://canary:password@127.0.0.1:6398/0",
        SEABYSS_DIAMONDS_ORIGINAL_RECOVERY_ENABLED: "true",
        SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED: "true"
    };
}

test("CLI environment is exact-canary, Sandbox-only and fail-closed", () => {
    const configuration = readCanary02Spend10RecoveryEnvironment(safeEnvironment());
    assert.equal(configuration.titleId, "1D0C16");
    assert.equal(configuration.playFabId, "C5BD37AA141B3C4E");
    assert.equal(configuration.providerWritesEnabled, true);
    assert.match(configuration.aofPath, /canary02.*financial-canary\.aof\.1\.incr\.aof$/u);

    for (const [field, value, code] of [
        ["PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID", "142853", "DIAMONDS_RECOVERY_TITLE_INVALID"],
        ["FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID", "*", "DIAMONDS_RECOVERY_CANARY_INVALID"],
        ["FINANCIAL_SHADOW_MODE_ENABLED", "true", "DIAMONDS_RECOVERY_UNSAFE_GATE"],
        ["SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED", "false",
            "DIAMONDS_RECOVERY_EXPLICIT_ENABLE_REQUIRED"]
    ]) {
        const environment = { ...safeEnvironment(), [field]: value };
        assert.throws(() => readCanary02Spend10RecoveryEnvironment(environment),
            (error) => error.code === code);
    }
});

test("AOF validation completes before dependency construction", async () => {
    let dependencyConstructed = false;
    await assert.rejects(runLiveCanary02Spend10Recovery({
        environment: safeEnvironment(),
        readAofEvidence() { throw Object.assign(new Error("bad evidence"), { code: "AOF_BAD" }); },
        async dependencyFactory() { dependencyConstructed = true; throw new Error("must not run"); }
    }), (error) => error.code === "AOF_BAD");
    assert.equal(dependencyConstructed, false);
});
