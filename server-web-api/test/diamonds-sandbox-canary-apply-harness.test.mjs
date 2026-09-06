import "./fixtures/diamonds-canary-legacy.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
    DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE,
    runDiamondsSandboxCanaryApplyHarness
} from "../src/diamonds-sandbox-canary-apply-harness.js";

const TITLE = "1D0C16";
const PLAYER = "61AD15CDA4137EA9";
const PLAN_HASH = "a".repeat(64);
const SCANNER_HASH = "b".repeat(64);
const TRANSACTION = "810000000000000001";

function proof(balance, count) {
    return {
        schemaVersion: 1,
        state: "Completed",
        titleId: TITLE,
        playFabId: PLAYER,
        domain: "Diamonds",
        planHash: PLAN_HASH,
        legacyValue: 0,
        targetValue: balance,
        targetOnlyOperationCount: count
    };
}

function transaction() {
    return {
        provider: "xsolla",
        providerTransactionId: TRANSACTION,
        playFabId: PLAYER,
        environment: "sandbox",
        state: "Completed",
        receiptId: "xsd2_fixture",
        checkpoints: {
            receipt_persisted: {},
            diamonds_target_granted: {},
            profile_granted: {}
        }
    };
}

function applyDependencies(overrides = {}) {
    let balance = 0;
    let revision = 1;
    let count = 0;
    const projected = new Set();
    const calls = [];
    const dependencies = {
        async preflight() {
            return {
                titleId: TITLE,
                productionTitleId: "142853",
                productionTitleUntouched: true,
                playFabId: PLAYER,
                certificateValid: true,
                legacyReceiptAbsent: true,
                playFabHealthy: true,
                redisHealthy: true,
                redisVersionMajor: 7,
                rollbackAvailable: true,
                scannerZeroForbidden: true,
                syntheticV2ReceiptAbsent: true,
                scannerForbiddenCount: 0,
                scannerHash: SCANNER_HASH,
                zeroPendingPayment: true,
                legacyValue: 0,
                legacyProfileDiamonds: 0,
                targetValue: 0,
                migrationProofExists: false,
                plan: {
                    status: "ready",
                    readOnly: true,
                    titleId: TITLE,
                    playFabId: PLAYER,
                    legacyValue: 0,
                    targetValue: 0,
                    proposedTarget: 0,
                    planHash: PLAN_HASH,
                    rollback: { available: true }
                }
            };
        },
        async applyMigration({ plan, approvedPlanHash }) {
            calls.push(["migration", plan.planHash, approvedPlanHash]);
            return {
                status: "completed",
                providerWriteCount: 1,
                observation: { targetValue: 0 },
                proof: proof(0, 0)
            };
        },
        async readTarget() { return { diamonds: balance, revision, fencingEpoch: 7 }; },
        async executeTargetOperation({ operation, delta }) {
            calls.push([operation, delta]);
            if (balance + delta < 0) {
                const error = new Error("insufficient");
                error.code = "POC_INSUFFICIENT_DIAMONDS";
                throw error;
            }
            balance += delta;
            revision += 1;
            count += 1;
            return { status: "applied", balance };
        },
        async ensureSyntheticXsd2() { return { providerTransactionId: TRANSACTION }; },
        async projectTrustedXsd2(input) {
            assert.deepEqual(input, { providerTransactionId: TRANSACTION });
            const replay = projected.has(TRANSACTION);
            if (!replay) {
                projected.add(TRANSACTION);
                balance += 500;
                revision += 1;
                count += 1;
            }
            return {
                status: replay ? "already_applied" : "applied",
                route: "target_diamonds_canary",
                authoritative: true,
                operation: { diamonds: 500 }
            };
        },
        async readLedgerTransaction() { return transaction(); },
        async readMigrationProof() { return proof(balance, count); },
        async getSyntheticProviderTransactionId() { return TRANSACTION; },
        async assertStaleLegacyWriteBlocked() {
            return {
                blocked: true,
                legacyValue: 0,
                targetBalance: balance,
                exactLegacyRewritePerformed: true,
                legacyProfileDiamonds: 0
            };
        },
        ...overrides
    };
    return { dependencies, calls, balance: () => balance, revision: () => revision };
}

test("short apply harness performs exact migration, +25/-10, insufficient and xsd2 replay", async () => {
    const h = applyDependencies();
    const result = await runDiamondsSandboxCanaryApplyHarness({
        mode: "apply",
        explicitlyEnabled: true,
        dependencies: h.dependencies
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(result.migration.legacyBefore, 0);
    assert.equal(result.migration.targetAfter, 0);
    assert.deepEqual(result.operations, {
        grant25: 25,
        spend10: 15,
        insufficientBlocked: true,
        xsd2Grant500: 515,
        replay: 515
    });
    assert.equal(result.rollbackAvailable, false);
    assert.equal(result.finalBalance, DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE);
    assert.equal(h.balance(), 515);
    assert.deepEqual(h.calls.map((entry) => entry[0]), [
        "migration", "grant_25", "spend_10", "insufficient_spend"
    ]);
});

test("preflight mismatch stops before migration or Target operations", async () => {
    const h = applyDependencies({
        async preflight() {
            const current = await applyDependencies().dependencies.preflight();
            return { ...current, targetValue: 1 };
        }
    });
    await assert.rejects(runDiamondsSandboxCanaryApplyHarness({
        mode: "apply",
        explicitlyEnabled: true,
        dependencies: h.dependencies
    }), { code: "DIAMONDS_CANARY_PREFLIGHT_FAILED" });
    assert.deepEqual(h.calls, []);
    assert.equal(h.balance(), 0);
});

test("non-zero profile_v1 Diamonds projection stops before migration", async () => {
    const baseline = applyDependencies();
    const originalPreflight = baseline.dependencies.preflight;
    baseline.dependencies.preflight = async () => ({
        ...(await originalPreflight()),
        legacyProfileDiamonds: 1
    });
    await assert.rejects(runDiamondsSandboxCanaryApplyHarness({
        mode: "apply",
        explicitlyEnabled: true,
        dependencies: baseline.dependencies
    }), { code: "DIAMONDS_CANARY_PREFLIGHT_FAILED" });
    assert.deepEqual(baseline.calls, []);
    assert.equal(baseline.balance(), 0);
});

test("xsd2 caller cannot return reward, amount, balance or freely selected player", async () => {
    const h = applyDependencies({
        async ensureSyntheticXsd2() {
            return { providerTransactionId: TRANSACTION, reward: { diamonds: 500 } };
        }
    });
    await assert.rejects(runDiamondsSandboxCanaryApplyHarness({
        mode: "apply",
        explicitlyEnabled: true,
        dependencies: h.dependencies
    }), { code: "DIAMONDS_CANARY_XSD2_CALLER_AUTHORITY_INVALID" });
    assert.equal(h.balance(), 15);
});

test("apply requires a real exact stale profile_v1 rewrite from legacy Diamonds zero", async () => {
    const h = applyDependencies({
        async assertStaleLegacyWriteBlocked() {
            return {
                blocked: true,
                legacyValue: 0,
                targetBalance: 515,
                exactLegacyRewritePerformed: false,
                legacyProfileDiamonds: 0
            };
        }
    });
    await assert.rejects(runDiamondsSandboxCanaryApplyHarness({
        mode: "apply",
        explicitlyEnabled: true,
        dependencies: h.dependencies
    }), { code: "DIAMONDS_CANARY_STALE_LEGACY_WRITE_NOT_BLOCKED" });
    assert.equal(h.balance(), 515);
});

test("verify mode proves process-restart replay from Completed evidence without Target change", async () => {
    let projectCalls = 0;
    const dependencies = {
        async readTarget() { return { diamonds: 515, revision: 4, fencingEpoch: 9 }; },
        async readMigrationProof() { return proof(515, 3); },
        async getSyntheticProviderTransactionId() { return TRANSACTION; },
        async readLedgerTransaction() { return transaction(); },
        async projectTrustedXsd2(input) {
            projectCalls += 1;
            assert.deepEqual(input, { providerTransactionId: TRANSACTION });
            return { status: "already_applied", authoritative: true };
        },
        async assertStaleLegacyWriteBlocked() {
            return { blocked: true, legacyValue: 0, targetBalance: 515 };
        }
    };
    const result = await runDiamondsSandboxCanaryApplyHarness({
        mode: "verify",
        explicitlyEnabled: true,
        dependencies
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(result.xsd2Replay, "already_applied");
    assert.equal(result.targetUnchanged, true);
    assert.equal(projectCalls, 1);
});

test("harness is inert unless explicitly enabled", async () => {
    const h = applyDependencies();
    await assert.rejects(runDiamondsSandboxCanaryApplyHarness({
        mode: "apply",
        explicitlyEnabled: false,
        dependencies: h.dependencies
    }), { code: "DIAMONDS_CANARY_HARNESS_DISABLED" });
    assert.deepEqual(h.calls, []);
});
