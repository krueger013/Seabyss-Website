import assert from "node:assert/strict";
import test from "node:test";

import {
    FINISH_INSUFFICIENT_OPERATION_ID,
    FINISH_PLAYFAB_ID,
    FINISH_PRODUCTION_TITLE_ID,
    FINISH_SPEND_OPERATION_ID,
    FINISH_TITLE_ID,
    runDiamondsSandboxCanaryFinishHarness
} from "../src/diamonds-sandbox-canary-finish-harness.js";

const SPEND_HASH = "a".repeat(64);
const INSUFFICIENT_HASH = "b".repeat(64);

function spendRecord(state = "Pending") {
    return {
        state,
        sequence: 2,
        operationId: FINISH_SPEND_OPERATION_ID,
        operation: {
            kind: "trusted_gameplay",
            playFabId: FINISH_PLAYFAB_ID,
            operationId: FINISH_SPEND_OPERATION_ID,
            diamondsDelta: -10,
            diamonds: 0,
            eliteBall: 0,
            premium: null,
            immutableHash: SPEND_HASH
        },
        ...(state === "Acked" ? { result: { status: "applied" } } : {})
    };
}

function insufficientRecord() {
    return {
        state: "Acked",
        sequence: 3,
        operationId: FINISH_INSUFFICIENT_OPERATION_ID,
        operation: {
            operationId: FINISH_INSUFFICIENT_OPERATION_ID,
            diamondsDelta: -16,
            immutableHash: INSUFFICIENT_HASH
        },
        result: { status: "rejected_insufficient_funds" }
    };
}

function state25() {
    return {
        titleId: FINISH_TITLE_ID,
        productionTitleId: FINISH_PRODUCTION_TITLE_ID,
        productionTitleUntouched: true,
        playFabId: FINISH_PLAYFAB_ID,
        legacyValue: 0,
        legacyProfileDiamonds: 0,
        providerProfileVersion: 10,
        migrationProfileVersion: 10,
        providerStateDigest: "c".repeat(64),
        providerFence: { fencingEpoch: 8 },
        target: { diamonds: 25, revision: 2, fencingEpoch: 8, highValueAppliedThroughSequence: 1 },
        migrationProof: { state: "Completed", titleId: FINISH_TITLE_ID, playFabId: FINISH_PLAYFAB_ID,
            domain: "Diamonds", legacyValue: 0 },
        operation: spendRecord(),
        resolution: { state: "Prepared", playFabId: FINISH_PLAYFAB_ID,
            operationId: FINISH_SPEND_OPERATION_ID, sequence: 2, expectedRevision: 2,
            diamondsBefore: 25, diamondsDelta: -10, diamondsAfter: 15, outcome: "applied",
            providerAttemptHistory: [] },
        activeLease: null,
        providerProof: { verified: false, reason: "missing" },
        syntheticReceipt: { providerTransactionId: "8100000000000000001", v2Present: false,
            v2Compatible: true, legacyPresent: false, ledgerTransaction: null }
    };
}

function spent15() {
    const value = state25();
    value.providerProfileVersion = value.migrationProfileVersion = 11;
    value.providerFence = { fencingEpoch: 9 };
    value.target = { diamonds: 15, revision: 3, fencingEpoch: 9, highValueAppliedThroughSequence: 2 };
    value.operation = spendRecord("Acked");
    value.resolution.state = "Acked";
    value.providerProof = { verified: true, operationId: FINISH_SPEND_OPERATION_ID,
        operationHash: SPEND_HASH, delta: -10 };
    return value;
}

test("preflight certifies only the exact resumable spend-10 state", async () => {
    const result = await runDiamondsSandboxCanaryFinishHarness({
        mode: "preflight", explicitlyEnabled: true,
        dependencies: { async inspectFinishState() { return state25(); } }
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(result.fence, 8);
    assert.equal(result.operationHash, SPEND_HASH);
});

test("spend consumes the existing operation once and replays without enqueue/provider mutation", async () => {
    let state = state25();
    let consumes = 0;
    const result = await runDiamondsSandboxCanaryFinishHarness({
        mode: "spend", explicitlyEnabled: true, providerWritesEnabled: true,
        dependencies: {
            async inspectFinishState() { return structuredClone(state); },
            async consumeExistingTargetOperation() {
                consumes += 1;
                if (consumes === 1) { state = spent15(); return { status: "applied" }; }
                return { status: "already_acked" };
            }
        }
    });
    assert.equal(result.after, 15);
    assert.equal(result.replay, "already_acked");
    assert.equal(consumes, 2);
});

test("insufficient spend is rejected before Inbox/proof/provider write and preserves revision/cursor", async () => {
    let state = spent15();
    const metrics = { counters: { "playfab_set_objects_total|": 1 } };
    const diagnostics = { operationId: FINISH_SPEND_OPERATION_ID, providerWriteCompleted: true };
    const result = await runDiamondsSandboxCanaryFinishHarness({
        mode: "insufficient", explicitlyEnabled: true, providerWritesEnabled: true,
        dependencies: {
            async inspectFinishState() { return structuredClone(state); },
            async readTargetOperation() { return null; },
            async executeTargetOperation() {
                throw Object.assign(new Error("insufficient"), { code: "POC_INSUFFICIENT_DIAMONDS" });
            },
            async readProviderHttpMetrics() { return structuredClone(metrics); },
            async readProofWriteDiagnostics() { return structuredClone(diagnostics); }
        }
    });
    assert.equal(result.revision, 3);
    assert.equal(result.sequence, 2);
    assert.equal(result.providerWrites, 0);
    assert.equal(result.operationCreated, false);
});

test("xsd2 requires receipt-only Pending ledger then applies +500 and replays without rev/fence change", async () => {
    let state = spent15();
    let ledger = null;
    let projections = 0;
    const transactionId = "8100000000000000001";
    const result = await runDiamondsSandboxCanaryFinishHarness({
        mode: "xsd2", explicitlyEnabled: true, providerWritesEnabled: true,
        dependencies: {
            async inspectFinishState() { return structuredClone(state); },
            async readTargetOperation() { return null; },
            async ensureSyntheticXsd2() {
                ledger = { provider: "xsolla", providerTransactionId: transactionId,
                    playFabId: FINISH_PLAYFAB_ID, state: "Pending", receiptId: "xsd2_fixture",
                    checkpoints: { receipt_persisted: {} } };
                return { providerTransactionId: transactionId };
            },
            async readLedgerTransaction() { return structuredClone(ledger); },
            async projectTrustedXsd2() {
                projections += 1;
                if (projections === 1) {
                    state.target = { diamonds: 515, revision: 4, fencingEpoch: 11,
                        highValueAppliedThroughSequence: 3 };
                    ledger.state = "Completed";
                    ledger.checkpoints.diamonds_target_granted = {};
                    ledger.checkpoints.profile_granted = {};
                    return { route: "target_diamonds_canary", authoritative: true,
                        status: "applied", operation: { diamonds: 500 } };
                }
                return { authoritative: true, status: "already_applied" };
            }
        }
    });
    assert.equal(result.after, 515);
    assert.equal(result.exactlyOnce, true);
    assert.equal(projections, 2);
});

test("stale Legacy exact rewrite cannot change Target515", async () => {
    const state = spent15();
    state.target = { diamonds: 515, revision: 5, fencingEpoch: 11, highValueAppliedThroughSequence: 4 };
    const result = await runDiamondsSandboxCanaryFinishHarness({
        mode: "stale", explicitlyEnabled: true, staleLegacyWriteEnabled: true,
        dependencies: {
            async inspectFinishState() { return structuredClone(state); },
            async assertStaleLegacyWriteBlocked() {
                return { blocked: true, targetBalance: 515, legacyValue: 0,
                    exactLegacyRewritePerformed: true, legacyProfileDiamonds: 0 };
            }
        }
    });
    assert.equal(result.targetUnchanged, true);
});
