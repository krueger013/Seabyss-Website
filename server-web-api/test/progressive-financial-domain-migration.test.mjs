import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
    FINANCIAL_DOMAINS,
    FINANCIAL_DOMAIN_MODES,
    CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET,
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    DIAMONDS_TARGET_ADAPTER_VERSION,
    assertProgressiveFinancialDomainMigrationPlanFresh,
    classifyLegacyFinancialAccess,
    createFinancialDomainReadinessCertificate,
    createFinancialDomainMetrics,
    createProgressiveFinancialDomainMigrationExecutor,
    createProgressiveFinancialDomainService,
    evaluateFinancialDomainHealth,
    evaluateFinancialDomainStartupSafety,
    normalizeFinancialDomainValue,
    planProgressiveFinancialDomainMigration as planProgressiveFinancialDomainMigrationCore,
    readFinancialDomainEnvironment
} from "../src/progressive-financial-domain-migration.js";

const PLAYER = "61AD15CDA4137EA9";
const OTHER = "0000000000000001";
const premium = (tier, effectiveAtUtc, expiresAtUtc) => ({ tier, effectiveAtUtc, expiresAtUtc });
const SCANNER_DIGEST = "c".repeat(64);
const PROVIDER_DIGEST = "d".repeat(64);
const TEST_DIGEST = "e".repeat(64);

function planProgressiveFinancialDomainMigration(input) {
    const titleId = input.titleId || DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID;
    const migrationVersion = input.migrationVersion ||
        (input.domain === "Diamonds" ? DIAMONDS_PROGRESSIVE_MIGRATION_VERSION : `${input.domain.toLowerCase()}-domain-v1`);
    const targetRevision = input.targetRevision ?? 0;
    return planProgressiveFinancialDomainMigrationCore({
        ...input,
        titleId,
        migrationVersion,
        targetRevision,
        providerProfileVersion: input.providerProfileVersion ?? targetRevision,
        providerStateDigest: input.providerStateDigest || PROVIDER_DIGEST,
        migrationProof: input.migrationProof
            ? { titleId, migrationVersion, ...input.migrationProof }
            : null
    });
}

function currentObservation(plan, overrides = {}) {
    return {
        legacyValue: plan.legacyValue,
        targetValue: plan.targetValue,
        legacyRevision: 0,
        targetRevision: plan.expectedTargetRevision,
        providerProfileVersion: plan.expectedProviderProfileVersion,
        providerStateDigest: plan.providerStateDigest,
        migrationProof: null,
        ...overrides
    };
}

function configuration(domain, mode = "Legacy", overrides = {}) {
    return {
        domain,
        mode,
        canaryEnabled: false,
        cutoverEnabled: false,
        migrationEnabled: false,
        canaryPlayFabIds: [],
        ...overrides
    };
}

function readinessCertificate(domain, { mode = "Canary", canaryCertified = false } = {}) {
    return createFinancialDomainReadinessCertificate({
        healthInput: {
            configuration: configuration(domain, mode, mode === "Canary"
                ? { canaryEnabled: true, canaryPlayFabIds: [PLAYER] }
                : {}),
            legacyAccess: {
                intentionalLegacyAdapter: 1,
                migrationOnly: 1,
                forbiddenDirectAccess: 0
            },
            shadowMismatchCount: 0,
            migrationConflicts: 0,
            pendingOperations: 0,
            scannerCertified: true,
            dryRunCertified: true,
            targetHealthy: true,
            redisHealthy: true,
            playFabHealthy: true,
            rollbackPlanValid: true,
            canaryCertified
        },
        scannerBaselineDigest: SCANNER_DIGEST,
        sandboxTitleId: DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        dryRunPlanHash: "a".repeat(64),
        providerDigest: PROVIDER_DIGEST,
        healthChecks: {
            targetAdapterHealthy: true,
            redisHealthy: true,
            playFabHealthy: true,
            casSupported: true,
            scannerZeroForbidden: true,
            providerUnchanged: true
        },
        testDigest: TEST_DIGEST,
        issuedAtUtc: "2026-08-24T10:00:00.000Z",
        expiresAtUtc: "2026-08-24T12:00:00.000Z",
        targetContract: CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET
    });
}

test("domain environment defaults all three domains to Legacy with every write gate disabled", () => {
    const result = readFinancialDomainEnvironment({});
    assert.deepEqual(FINANCIAL_DOMAINS, ["Diamonds", "Elite", "Premium"]);
    assert.deepEqual(FINANCIAL_DOMAIN_MODES, ["Legacy", "Shadow", "Canary", "Cutover"]);
    for (const domain of FINANCIAL_DOMAINS) {
        assert.equal(result[domain].mode, "Legacy");
        assert.equal(result[domain].canaryEnabled, false);
        assert.equal(result[domain].cutoverEnabled, false);
        assert.equal(result[domain].migrationEnabled, false);
        assert.deepEqual(result[domain].canaryPlayFabIds, []);
    }
});

test("environment parser rejects wildcard allowlists and non-canonical booleans", () => {
    assert.throws(() => readFinancialDomainEnvironment({
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "*"
    }), /wildcard/i);
    assert.throws(() => readFinancialDomainEnvironment({
        FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "TRUE"
    }), /exactly true or false/i);
});

test("startup validation refuses contradictory gates in Legacy", () => {
    const result = evaluateFinancialDomainStartupSafety({ environment: {
        FINANCIAL_DIAMONDS_MODE: "Legacy",
        FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "true"
    }});
    assert.equal(result.safe, false);
    assert.match(result.domains.Diamonds.errors.join(" "), /CUTOVER_ENABLED=false/);
});

test("startup validation refuses Canary without a verified health certificate", () => {
    const environment = {
        FINANCIAL_DIAMONDS_MODE: "Canary",
        FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: PLAYER
    };
    const refused = evaluateFinancialDomainStartupSafety({ environment });
    assert.equal(refused.safe, false);
    assert.match(refused.domains.Diamonds.errors.join(" "), /verified_readyForCanary/);
    const accepted = evaluateFinancialDomainStartupSafety({
        environment,
        readinessByDomain: { Diamonds: readinessCertificate("Diamonds") },
        nowUtc: "2026-08-24T11:00:00.000Z"
    });
    assert.equal(accepted.safe, true);
    assert.equal(accepted.domains.Elite.mode, "Legacy");
    assert.equal(accepted.domains.Premium.mode, "Legacy");
});

test("startup validation refuses Cutover without both verified readiness levels", () => {
    const environment = {
        FINANCIAL_DIAMONDS_MODE: "Cutover",
        FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "true"
    };
    const canaryOnly = evaluateFinancialDomainStartupSafety({
        environment,
        readinessByDomain: { Diamonds: readinessCertificate("Diamonds") },
        nowUtc: "2026-08-24T11:00:00.000Z"
    });
    assert.equal(canaryOnly.safe, false);
    assert.match(canaryOnly.domains.Diamonds.errors.join(" "), /verified_readyForCutover/);
});

test("startup certificate is bound to certified Target, scanner digest, health and expiry", () => {
    const environment = {
        FINANCIAL_DIAMONDS_MODE: "Canary",
        FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: PLAYER
    };
    const certificate = readinessCertificate("Diamonds");
    const expired = evaluateFinancialDomainStartupSafety({
        environment,
        readinessByDomain: { Diamonds: certificate },
        nowUtc: "2026-08-24T12:00:00.000Z"
    });
    assert.equal(expired.safe, false);
    assert.match(expired.domains.Diamonds.errors.join(" "), /expired/);
    assert.throws(() => createFinancialDomainReadinessCertificate({
        healthInput: certificate.healthInput,
        scannerBaselineDigest: SCANNER_DIGEST,
        sandboxTitleId: DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        dryRunPlanHash: "a".repeat(64),
        providerDigest: PROVIDER_DIGEST,
        healthChecks: certificate.healthChecks,
        testDigest: TEST_DIGEST,
        issuedAtUtc: "2026-08-24T10:00:00.000Z",
        expiresAtUtc: "2026-08-24T12:00:00.000Z",
        targetContract: "SeabyssFinancialAuthorityV2"
    }), /not certified/i);
});

test("readiness certificate is capped at 24 hours and rejects tampering", () => {
    const certificate = readinessCertificate("Diamonds");
    assert.match(certificate.certificateHash, /^[a-f0-9]{64}$/u);
    assert.equal(certificate.sandboxTitleId, DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID);
    assert.equal(certificate.adapterVersion, DIAMONDS_TARGET_ADAPTER_VERSION);
    assert.equal(certificate.migrationVersion, DIAMONDS_PROGRESSIVE_MIGRATION_VERSION);
    assert.throws(() => createFinancialDomainReadinessCertificate({
        healthInput: certificate.healthInput,
        scannerBaselineDigest: SCANNER_DIGEST,
        sandboxTitleId: DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        dryRunPlanHash: "a".repeat(64),
        providerDigest: PROVIDER_DIGEST,
        healthChecks: certificate.healthChecks,
        testDigest: TEST_DIGEST,
        issuedAtUtc: "2026-08-24T00:00:00.000Z",
        expiresAtUtc: "2026-08-25T00:00:00.001Z"
    }), /expiration/i);
    assert.throws(() => createFinancialDomainReadinessCertificate({
        healthInput: certificate.healthInput,
        scannerBaselineDigest: SCANNER_DIGEST,
        sandboxTitleId: "ABC123",
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        dryRunPlanHash: "a".repeat(64),
        providerDigest: PROVIDER_DIGEST,
        healthChecks: certificate.healthChecks,
        testDigest: TEST_DIGEST,
        issuedAtUtc: "2026-08-24T00:00:00.000Z",
        expiresAtUtc: "2026-08-25T00:00:00.000Z"
    }), /must target Sandbox 1D0C16/i);

    const tampered = structuredClone(certificate);
    tampered.adapterVersion = "tampered-adapter";
    const result = evaluateFinancialDomainStartupSafety({
        environment: {
            FINANCIAL_DIAMONDS_MODE: "Canary",
            FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
            FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: PLAYER
        },
        readinessByDomain: { Diamonds: tampered },
        nowUtc: "2026-08-24T11:00:00.000Z"
    });
    assert.equal(result.safe, false);
    assert.match(result.domains.Diamonds.errors.join(" "), /hash_mismatch/);
});

test("startup enforces Diamonds then Elite then Premium and only one Canary", () => {
    const environment = {
        FINANCIAL_ELITE_MODE: "Canary",
        FINANCIAL_ELITE_CANARY_ENABLED: "true",
        FINANCIAL_ELITE_CANARY_PLAYFAB_IDS: PLAYER
    };
    const result = evaluateFinancialDomainStartupSafety({
        environment,
        readinessByDomain: { Elite: readinessCertificate("Elite") },
        nowUtc: "2026-08-24T11:00:00.000Z"
    });
    assert.equal(result.safe, false);
    assert.match(result.domains.Elite.errors.join(" "), /requires_Diamonds_Cutover/);
});

test("server startup refuses a per-domain Canary enabled only by environment variables", async () => {
    const child = spawn(process.execPath, ["src/server.js"], {
        cwd: new URL("..", import.meta.url),
        windowsHide: true,
        env: {
            ...process.env,
            NODE_ENV: "production",
            HOST: "127.0.0.1",
            PORT: "0",
            SESSION_SECRET: "domain-startup-test-secret-with-at-least-32-bytes",
            PLAYFAB_TITLE_ID: "sandbox-only-test-title",
            PLAYFAB_SECRET_KEY: "not-a-real-secret",
            REDIS_URL: "redis://127.0.0.1:1",
            PURCHASES_GLOBAL_ENABLED: "false",
            PURCHASES_DIAMOND_ENABLED: "false",
            PURCHASES_STARTER_ENABLED: "false",
            PURCHASES_PREMIUM_ENABLED: "false",
            PURCHASES_DOUBLER_ENABLED: "false",
            PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "false",
            FINANCIAL_DIAMONDS_MODE: "Canary",
            FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
            FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "false",
            FINANCIAL_DIAMONDS_MIGRATION_ENABLED: "false",
            FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: PLAYER,
            FINANCIAL_ELITE_MODE: "Legacy",
            FINANCIAL_PREMIUM_MODE: "Legacy"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.notEqual(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.match(stderr, /Progressive financial domain activation is unsafe/);
    assert.match(stderr, /verified_readyForCanary=true/);
    assert.doesNotMatch(stdout, /listening/i);
});

test("Diamonds dry-run selects exact Legacy DM and is deterministic", () => {
    const first = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 0, legacyRevision: 12, targetRevision: 4
    });
    const second = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 0, legacyRevision: 12, targetRevision: 4
    });
    assert.equal(first.status, "ready");
    assert.equal(first.readOnly, true);
    assert.equal(first.providerWriteCount, 0);
    assert.equal(first.proposedTarget, 500);
    assert.equal(first.planHash, second.planHash);
    assert.match(first.operationId, /^domain-migration:diamonds:/);
    assert.equal(first.rollback.available, true);
    assert.equal(first.titleId, DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID);
    assert.equal(first.migrationVersion, DIAMONDS_PROGRESSIVE_MIGRATION_VERSION);
    assert.equal(first.expectedProviderProfileVersion, 4);
    assert.equal(first.providerStateDigest, PROVIDER_DIGEST);
});

test("Diamonds dry-run implements the four certified conflict cases", () => {
    const emptyTarget = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER, legacyValue: 500, targetValue: 0
    });
    assert.equal(emptyTarget.status, "ready");
    assert.equal(emptyTarget.proposedTarget, 500);

    const equalWithoutProof = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER, legacyValue: 500, targetValue: 500
    });
    assert.equal(equalWithoutProof.status, "ready");
    assert.equal(equalWithoutProof.proposedTarget, 500);

    const divergentWithoutProof = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER, legacyValue: 500, targetValue: 1200
    });
    assert.equal(divergentWithoutProof.status, "manual_review");
    assert.match(divergentWithoutProof.conflicts[0].reason, /never_add_or_merge/);
    assert.match(divergentWithoutProof.planHash, /^[a-f0-9]{64}$/u);

    const targetDigest = createHash("sha256").update(JSON.stringify(500)).digest("hex");
    const validProof = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER, legacyValue: 500, targetValue: 500,
        targetRevision: 7,
        migrationProof: {
            state: "Completed", domain: "Diamonds", playFabId: PLAYER,
            planHash: "a".repeat(64), targetDigest, targetRevision: 7,
            targetOnlyOperationCount: 0
        }
    });
    assert.equal(validProof.status, "already_migrated");
    assert.equal(validProof.authorityWinner, "Target");
});

test("Diamonds plan hash becomes stale after any provider or Legacy observation changes", () => {
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 0, legacyRevision: 12,
        targetRevision: 4, providerProfileVersion: 9
    });
    assert.deepEqual(assertProgressiveFinancialDomainMigrationPlanFresh({
        plan,
        currentObservation: currentObservation(plan, { legacyRevision: 12 })
    }), { fresh: true, planHash: plan.planHash });
    assert.throws(() => assertProgressiveFinancialDomainMigrationPlanFresh({
        plan,
        currentObservation: currentObservation(plan, {
            legacyValue: 501,
            legacyRevision: 13
        })
    }), { code: "DOMAIN_MIGRATION_PLAN_STALE" });
    assert.throws(() => assertProgressiveFinancialDomainMigrationPlanFresh({
        plan,
        currentObservation: currentObservation(plan, {
            providerProfileVersion: 10,
            providerStateDigest: "f".repeat(64)
        })
    }), { code: "DOMAIN_MIGRATION_PLAN_STALE" });
});

test("Diamonds readiness plans refuse the Production title", () => {
    assert.throws(() => planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        titleId: "142853", legacyValue: 500, targetValue: 0
    }), { code: "DIAMONDS_SANDBOX_TITLE_MISMATCH" });
});

test("Diamonds never adds or merges a non-empty divergent target", () => {
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 250
    });
    assert.equal(plan.status, "manual_review");
    assert.equal(plan.proposedTarget, null);
    assert.match(plan.conflicts[0].reason, /never_add_or_merge/);
});

test("Elite dry-run preserves zero and exact quantities without underflow", () => {
    const empty = planProgressiveFinancialDomainMigration({
        domain: "Elite", playFabId: PLAYER,
        legacyValue: 0, targetValue: 0
    });
    assert.equal(empty.status, "ready");
    assert.equal(empty.proposedTarget, 0);
    assert.throws(() => planProgressiveFinancialDomainMigration({
        domain: "Elite", playFabId: PLAYER,
        legacyValue: -1, targetValue: 0
    }), /non-negative/);
});

test("Premium dry-run preserves tier and exact UTC timestamps", () => {
    const value = premium(3, "2026-08-24T10:00:00.000Z", "2026-09-24T10:00:00.000Z");
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Premium", playFabId: PLAYER,
        legacyValue: value,
        targetValue: premium(0, null, null)
    });
    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.proposedTarget, value);
    assert.equal(plan.conflictPolicy, "valid_newer_target_proof_wins_otherwise_manual_review");
});

test("Premium refuses to reduce a divergent non-empty target without a valid proof", () => {
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Premium", playFabId: PLAYER,
        legacyValue: premium(1, "2026-08-24T10:00:00.000Z", "2026-08-25T10:00:00.000Z"),
        targetValue: premium(3, "2026-08-24T10:00:00.000Z", "2026-09-24T10:00:00.000Z")
    });
    assert.equal(plan.status, "manual_review");
    assert.match(plan.conflicts[0].reason, /never_reduce_financial_proof/);
});

test("valid completed migration proof makes Target authoritative and preserves rollback metadata", () => {
    const target = 500;
    const targetDigest = createHash("sha256").update(JSON.stringify(target)).digest("hex");
    const proof = {
        state: "Completed", domain: "Diamonds", playFabId: PLAYER,
        planHash: "a".repeat(64), targetDigest, targetRevision: 7,
        targetOnlyOperationCount: 0
    };
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 450, targetValue: target, targetRevision: 7,
        migrationProof: proof
    });
    assert.equal(plan.status, "already_migrated");
    assert.equal(plan.authorityWinner, "Target");
    assert.equal(plan.proposedTarget, 500);
    assert.equal(plan.rollback.available, true);
});

test("a target-only operation passes the rollback point of no return", () => {
    const targetDigest = createHash("sha256").update(JSON.stringify(500)).digest("hex");
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 500,
        migrationProof: {
            state: "Completed", domain: "Diamonds", playFabId: PLAYER,
            planHash: "b".repeat(64), targetDigest, targetRevision: 8,
            targetOnlyOperationCount: 1
        },
        targetRevision: 8
    });
    assert.equal(plan.rollback.available, false);
    assert.equal(plan.rollback.automatic, false);
    assert.equal(plan.rollback.pointOfNoReturn, "passed");
});

test("two divergent post-cutover authorities always require ManualReview", () => {
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 600,
        legacyClaimsPostCutover: true,
        targetClaimsPostCutover: true
    });
    assert.equal(plan.status, "manual_review");
    assert.ok(plan.conflicts.some((conflict) => conflict.reason === "divergent_post_cutover_authorities"));
});

test("migration executor is fail-closed by default and performs no provider call", async () => {
    let writes = 0;
    const executor = createProgressiveFinancialDomainMigrationExecutor({
        targetWriter: { async replaceIdempotent() { writes += 1; } }
    });
    await assert.rejects(executor.execute({}), { code: "DOMAIN_MIGRATION_DISABLED" });
    assert.equal(writes, 0);
    assert.deepEqual(executor.health(), { enabled: false, providerWritesEnabled: false, ready: false });
});

test("enabled fake executor replaces rather than adds and is idempotent", async () => {
    const markers = new Map();
    const operations = new Map();
    let writes = 0;
    let balance = 0;
    const markerStore = {
        async get({ domain, playFabId }) { return markers.get(`${domain}:${playFabId}`) || null; },
        async putIfAbsent({ domain, playFabId, proof }) {
            const key = `${domain}:${playFabId}`;
            if (markers.has(key)) return { created: false, proof: markers.get(key) };
            markers.set(key, proof);
            return { created: true, proof };
        }
    };
    const targetWriter = {
        async replaceIdempotent(request) {
            if (operations.has(request.operationId)) {
                return { alreadyApplied: true, targetRevision: operations.get(request.operationId) };
            }
            assert.equal(request.expectedRevision, 0);
            assert.equal(request.fencingEpoch, 9);
            balance = request.value;
            writes += 1;
            operations.set(request.operationId, 1);
            return { alreadyApplied: false, targetRevision: 1 };
        },
        async read() { return { value: balance, targetRevision: 1 }; }
    };
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds", playFabId: PLAYER,
        legacyValue: 500, targetValue: 0
    });
    const executor = createProgressiveFinancialDomainMigrationExecutor({
        enabled: true, providerWritesEnabled: true, markerStore, targetWriter
    });
    const first = await executor.execute({ plan, approvedPlanHash: plan.planHash, fencingEpoch: 9,
        currentObservation: currentObservation(plan) });
    const second = await executor.execute({ plan, approvedPlanHash: plan.planHash, fencingEpoch: 10,
        currentObservation: currentObservation(plan) });
    assert.equal(first.status, "completed");
    assert.equal(second.status, "already_migrated");
    assert.equal(balance, 500);
    assert.equal(writes, 1);
});

test("migration executor passes expected revision, operation id and fencing to target CAS", async () => {
    let request;
    const markerStore = {
        async get() { return null; },
        async putIfAbsent({ proof }) { return { created: true, proof }; }
    };
    const targetWriter = {
        async replaceIdempotent(value) {
            request = value;
            return { alreadyApplied: false, targetRevision: 43 };
        },
        async read() { return { value: 13000, targetRevision: 43 }; }
    };
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Elite", playFabId: PLAYER,
        legacyValue: 13000, targetValue: 0, targetRevision: 42
    });
    const executor = createProgressiveFinancialDomainMigrationExecutor({
        enabled: true, providerWritesEnabled: true, markerStore, targetWriter
    });
    await executor.execute({ plan, approvedPlanHash: plan.planHash, fencingEpoch: 77,
        currentObservation: currentObservation(plan) });
    assert.equal(request.expectedRevision, 42);
    assert.equal(request.fencingEpoch, 77);
    assert.equal(request.operationId, plan.operationId);
    assert.equal(request.value, 13000);
});

test("Legacy domain router remains behaviorally identical and never touches Target", async () => {
    let legacyMutations = 0;
    let targetCalls = 0;
    const service = createProgressiveFinancialDomainService({
        configuration: configuration("Diamonds"),
        legacyAdapter: {
            async read() { return 500; },
            async mutate(request) { legacyMutations += 1; return { request, balance: 525 }; }
        },
        targetAdapter: {
            async read() { targetCalls += 1; return 999; },
            async mutate() { targetCalls += 1; }
        }
    });
    const read = await service.read(PLAYER);
    const written = await service.mutate({
        playFabId: PLAYER, operationId: "quest:1", mutation: { kind: "grant", amount: 25 }
    });
    assert.equal(read.authoritativeSource, "Legacy");
    assert.equal(read.value, 500);
    assert.equal(written.balance, 525);
    assert.equal(legacyMutations, 1);
    assert.equal(targetCalls, 0);
});

test("Shadow domain router applies Legacy once, observes once and reports comparison", async () => {
    let legacyMutations = 0;
    let observations = 0;
    const service = createProgressiveFinancialDomainService({
        configuration: configuration("Elite", "Shadow"),
        legacyAdapter: {
            async read() { return 13000; },
            async mutate() { legacyMutations += 1; return { quantity: 12999 }; }
        },
        shadowAdapter: {
            async read() { return 13000; },
            async observe(request) { observations += 1; assert.equal(request.domain, "Elite"); }
        }
    });
    assert.equal((await service.read(PLAYER)).comparison.match, true);
    await service.mutate({
        playFabId: PLAYER, operationId: "shot:1", mutation: { kind: "spend", amount: 1 }
    });
    assert.equal(legacyMutations, 1);
    assert.equal(observations, 1);
});

test("Canary router selects Target only for the explicit user", async () => {
    const calls = { legacy: 0, target: 0 };
    const service = createProgressiveFinancialDomainService({
        configuration: configuration("Diamonds", "Canary", {
            canaryEnabled: true,
            canaryPlayFabIds: [PLAYER]
        }),
        legacyAdapter: {
            async read() { calls.legacy += 1; return 100; },
            async mutate() { calls.legacy += 1; return "legacy"; }
        },
        targetAdapter: {
            async read() { calls.target += 1; return 200; },
            async mutate() { calls.target += 1; return "target"; }
        }
    });
    assert.equal((await service.read(PLAYER)).authoritativeSource, "Target");
    assert.equal((await service.read(OTHER)).authoritativeSource, "Legacy");
    assert.equal(await service.mutate({ playFabId: PLAYER, operationId: "a", mutation: {} }), "target");
    assert.equal(await service.mutate({ playFabId: OTHER, operationId: "b", mutation: {} }), "legacy");
    assert.deepEqual(calls, { legacy: 3, target: 2 });
});

test("domain service refuses internally contradictory mode gates", () => {
    assert.throws(() => createProgressiveFinancialDomainService({
        configuration: configuration("Diamonds", "Canary", {
            canaryEnabled: false,
            canaryPlayFabIds: [PLAYER]
        }),
        legacyAdapter: { read() {}, mutate() {} },
        targetAdapter: { read() {}, mutate() {} }
    }), { code: "FINANCIAL_DOMAIN_CONFIGURATION_UNSAFE" });
});

test("Cutover router is Target-only and cannot silently fall back to Legacy", async () => {
    let legacy = 0;
    const service = createProgressiveFinancialDomainService({
        configuration: configuration("Premium", "Cutover", { cutoverEnabled: true }),
        legacyAdapter: {
            async read() { legacy += 1; return premium(0, null, null); },
            async mutate() { legacy += 1; }
        },
        targetAdapter: {
            async read() { return premium(1, "2026-08-24T10:00:00.000Z", "2026-08-25T10:00:00.000Z"); },
            async mutate() { return "target"; }
        }
    });
    assert.equal((await service.read(PLAYER)).authoritativeSource, "Target");
    assert.equal(await service.mutate({ playFabId: PLAYER, operationId: "p", mutation: {} }), "target");
    assert.equal(legacy, 1);
});

test("stale migration proof revision is ManualReview and disables automatic rollback", () => {
    const target = 500;
    const targetDigest = createHash("sha256").update(JSON.stringify(target)).digest("hex");
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds",
        playFabId: PLAYER,
        legacyValue: target,
        targetValue: target,
        targetRevision: 8,
        migrationProof: {
            state: "Completed",
            domain: "Diamonds",
            playFabId: PLAYER,
            planHash: "d".repeat(64),
            targetDigest,
            targetRevision: 7,
            targetOnlyOperationCount: 0
        }
    });
    assert.equal(plan.status, "manual_review");
    assert.equal(plan.rollback.available, false);
});

test("legacy scanner classifies adapter, migration-only and forbidden direct access per domain", () => {
    const result = classifyLegacyFinancialAccess([
        { domain: "Diamonds", path: "a.js", access: "DM read", classification: "intentional_legacy_adapter" },
        { domain: "Diamonds", path: "b.js", access: "DM migration", classification: "migration_only" },
        { domain: "Diamonds", path: "c.js", access: "DM write", classification: "forbidden_direct_access" },
        { domain: "Elite", path: "d.js", access: "ammo", classification: "intentional_legacy_adapter" }
    ]);
    assert.equal(result.domains.Diamonds.intentionalLegacyAdapter, 1);
    assert.equal(result.domains.Diamonds.migrationOnly, 1);
    assert.equal(result.domains.Diamonds.forbiddenDirectAccess, 1);
    assert.equal(result.totals.Diamonds, 3);
    assert.equal(result.totals.Elite, 1);
});

test("domain health enumerates every Canary prerequisite and becomes ready only when clean", () => {
    const config = configuration("Diamonds");
    const blocked = evaluateFinancialDomainHealth({ configuration: config,
        legacyAccess: { forbiddenDirectAccess: 1 }, shadowMismatchCount: 1,
        migrationConflicts: 1, pendingOperations: 1 });
    assert.equal(blocked.readyForCanary, false);
    assert.ok(blocked.blockers.includes("forbidden_legacy_direct_access"));
    assert.ok(blocked.blockers.includes("shadow_mismatch"));
    assert.ok(blocked.blockers.includes("migration_conflict"));
    assert.ok(blocked.blockers.includes("pending_financial_operations"));

    const ready = evaluateFinancialDomainHealth({
        configuration: config,
        legacyAccess: { intentionalLegacyAdapter: 2, migrationOnly: 1, forbiddenDirectAccess: 0 },
        scannerCertified: true,
        dryRunCertified: true,
        targetHealthy: true,
        redisHealthy: true,
        playFabHealthy: true,
        rollbackPlanValid: true
    });
    assert.equal(ready.readyForCanary, true);
    assert.equal(ready.readyForCutover, false);
    assert.deepEqual(ready.blockers, []);

    const canaryReady = evaluateFinancialDomainHealth({
        configuration: configuration("Diamonds", "Canary", {
            canaryEnabled: true,
            canaryPlayFabIds: [PLAYER]
        }),
        scannerCertified: true,
        dryRunCertified: true,
        targetHealthy: true,
        redisHealthy: true,
        playFabHealthy: true,
        rollbackPlanValid: true,
        canaryCertified: true
    });
    assert.equal(canaryReady.readyForCanary, true);
    assert.equal(canaryReady.readyForCutover, true);
});

test("domain metrics export required bounded per-domain counters and gauges", () => {
    const metrics = createFinancialDomainMetrics();
    metrics.setMode("Diamonds", "Legacy");
    metrics.setRollbackAvailable("Diamonds", true);
    metrics.record("migration_dry_run", { domain: "Diamonds" });
    metrics.record("migration_conflict", { domain: "Premium", value: 2 });
    metrics.record("canary_operation", { domain: "Elite" });
    metrics.record("legacy_direct_access", { domain: "Diamonds", value: 3 });
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.domain_mode.Diamonds, "Legacy");
    assert.equal(snapshot.rollback_available.Diamonds, true);
    assert.deepEqual(snapshot.counters, [
        { name: "canary_operation", domain: "Elite", value: 1 },
        { name: "legacy_direct_access", domain: "Diamonds", value: 3 },
        { name: "migration_conflict", domain: "Premium", value: 2 },
        { name: "migration_dry_run", domain: "Diamonds", value: 1 }
    ]);
});

test("domain value validation rejects invalid Premium time and unsupported resources", () => {
    assert.throws(() => normalizeFinancialDomainValue("Premium",
        premium(1, "2026-08-25T10:00:00.000Z", "2026-08-24T10:00:00.000Z")), /precedes/);
    assert.throws(() => normalizeFinancialDomainValue("Gold", 1), /unsupported/);
});
