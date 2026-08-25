import { readConfiguredDiamondsCanaryPlayFabId } from "./diamonds-canary-identity.js";
export const FINISH_TITLE_ID = "1D0C16";
export const FINISH_PRODUCTION_TITLE_ID = "142853";
export const FINISH_PLAYFAB_ID = readConfiguredDiamondsCanaryPlayFabId();
export const FINISH_SPEND_OPERATION_ID = "diamonds-canary-v1:spend-10";
export const FINISH_INSUFFICIENT_OPERATION_ID = "diamonds-canary-v1:insufficient-16";

const MODES = new Set(["preflight", "spend", "insufficient", "xsd2", "stale"]);

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireFunction(value, name) {
    if (typeof value !== "function") throw new TypeError(`${name} is required.`);
}

function providerSetObjects(metrics) {
    const value = metrics?.counters?.["playfab_set_objects_total|"] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
        fail("DIAMONDS_FINISH_PROVIDER_METRICS_INVALID", "Provider SetObjects metric is invalid.");
    }
    return value;
}

function sameDiagnostics(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function balance(state) {
    const value = state?.target?.diamonds;
    if (!Number.isSafeInteger(value) || value < 0) fail("DIAMONDS_FINISH_TARGET_INVALID", "Target balance is invalid.");
    return value;
}

function assertIdentity(state) {
    if (!plain(state) || state.titleId !== FINISH_TITLE_ID ||
        state.productionTitleId !== FINISH_PRODUCTION_TITLE_ID ||
        state.productionTitleUntouched !== true || state.playFabId !== FINISH_PLAYFAB_ID ||
        state.legacyValue !== 0 || state.legacyProfileDiamonds !== 0) {
        fail("DIAMONDS_FINISH_IDENTITY_INVALID", "Canary identity, Production isolation or Legacy baseline differs.");
    }
    if (state.migrationProof?.state !== "Completed" ||
        state.migrationProof?.titleId !== FINISH_TITLE_ID ||
        state.migrationProof?.playFabId !== FINISH_PLAYFAB_ID ||
        state.migrationProof?.domain !== "Diamonds" || state.migrationProof?.legacyValue !== 0) {
        fail("DIAMONDS_FINISH_MIGRATION_PROOF_INVALID", "Diamonds migration proof is absent or invalid.");
    }
    return state;
}

function assertSpendRecord(state, expectedState) {
    const record = state.operation;
    const operation = record?.operation;
    if (!plain(record) || record.state !== expectedState || record.sequence !== 2 ||
        record.operationId !== FINISH_SPEND_OPERATION_ID || operation?.operationId !== FINISH_SPEND_OPERATION_ID ||
        operation?.playFabId !== FINISH_PLAYFAB_ID || operation?.kind !== "trusted_gameplay" ||
        operation?.diamondsDelta !== -10 || operation?.diamonds !== 0 || operation?.eliteBall !== 0 ||
        operation?.premium !== null || !/^[a-f0-9]{64}$/u.test(operation?.immutableHash || "")) {
        fail("DIAMONDS_FINISH_OPERATION_INVALID", "Existing spend-10 operation identity, sequence, hash or state differs.");
    }
    return record;
}

function assertXsd2Compatible(state) {
    const receipt = state.syntheticReceipt;
    const transaction = receipt?.ledgerTransaction;
    if (!plain(receipt) || receipt.v2Compatible !== true || receipt.legacyPresent !== false ||
        receipt.v2Present !== (transaction !== null)) {
        fail("DIAMONDS_FINISH_XSD2_INCOMPATIBLE", "Synthetic xsd2 receipt/ledger presence is inconsistent.");
    }
    if (transaction !== null && (transaction.provider !== "xsolla" ||
        transaction.providerTransactionId !== receipt.providerTransactionId ||
        transaction.playFabId !== FINISH_PLAYFAB_ID || transaction.state !== "Pending" ||
        typeof transaction.receiptId !== "string" || !transaction.receiptId.startsWith("xsd2_") ||
        !transaction.checkpoints?.receipt_persisted ||
        transaction.checkpoints?.diamonds_target_granted || transaction.checkpoints?.profile_granted)) {
        fail("DIAMONDS_FINISH_XSD2_INCOMPATIBLE", "Synthetic xsd2 ledger is not a compatible receipt-only Pending record.");
    }
    return receipt;
}

function assertPending25(state) {
    assertIdentity(state);
    if (balance(state) !== 25 || state.target.revision !== 2 || state.activeLease !== null ||
        !plain(state.providerFence) || !Number.isSafeInteger(state.providerFence.fencingEpoch) ||
        state.providerFence.fencingEpoch < state.target.fencingEpoch ||
        state.providerProof?.verified !== false || state.providerProof?.reason !== "missing" ||
        state.providerProfileVersion !== state.migrationProfileVersion) {
        fail("DIAMONDS_FINISH_PREFLIGHT_FAILED", "Target25/revision2/proof/lease/provider preflight differs.");
    }
    assertXsd2Compatible(state);
    const record = assertSpendRecord(state, "Pending");
    const resolution = state.resolution;
    if (!plain(resolution) || !new Set(["Prepared", "RetryScheduled", "ManualReview"]).has(resolution.state) ||
        resolution.playFabId !== FINISH_PLAYFAB_ID || resolution.operationId !== FINISH_SPEND_OPERATION_ID ||
        resolution.sequence !== 2 || resolution.expectedRevision !== 2 ||
        resolution.diamondsBefore !== 25 || resolution.diamondsDelta !== -10 ||
        resolution.diamondsAfter !== 15 || resolution.outcome !== "applied" ||
        (resolution.providerAttemptHistory || []).some((attempt) =>
            attempt.operationImmutableHash !== record.operation.immutableHash)) {
        fail("DIAMONDS_FINISH_RESOLUTION_INVALID", "Spend-10 resolution or attempt history differs.");
    }
    return state;
}

function assertSpent15(state) {
    assertIdentity(state);
    const record = assertSpendRecord(state, "Acked");
    if (balance(state) !== 15 || state.target.revision !== 3 || state.providerProof?.verified !== true ||
        state.providerProof?.operationId !== FINISH_SPEND_OPERATION_ID ||
        state.providerProof?.operationHash !== record.operation.immutableHash ||
        state.providerProof?.delta !== -10 || state.resolution?.state !== "Acked") {
        fail("DIAMONDS_FINISH_SPEND_READBACK_FAILED", "Spend-10 Target/proof/revision/ACK readback differs.");
    }
    return state;
}

async function inspect(dependencies) {
    return dependencies.inspectFinishState();
}

async function runPreflight(dependencies) {
    const state = assertPending25(await inspect(dependencies));
    return Object.freeze({ mode: "preflight", verdict: "PASS", balance: 25, revision: 2,
        operationState: state.operation.state, resolutionState: state.resolution.state,
        operationHash: state.operation.operation.immutableHash,
        fence: state.providerFence.fencingEpoch,
        activeLease: false, migrationProof: true, providerProof: "absent", xsd2Compatible: true });
}

async function runSpend(dependencies) {
    assertPending25(await inspect(dependencies));
    const applied = await dependencies.consumeExistingTargetOperation({
        operationId: FINISH_SPEND_OPERATION_ID,
        consumer: "diamonds-canary-finish-spend"
    });
    if (applied?.status !== "applied") fail("DIAMONDS_FINISH_SPEND_NOT_APPLIED", "Spend-10 did not apply.");
    const after = assertSpent15(await inspect(dependencies));
    const revision = after.target.revision;
    const fence = after.target.fencingEpoch;
    const replay = await dependencies.consumeExistingTargetOperation({
        operationId: FINISH_SPEND_OPERATION_ID,
        consumer: "diamonds-canary-finish-replay"
    });
    if (replay?.status !== "already_acked") fail("DIAMONDS_FINISH_SPEND_REPLAY_FAILED", "Spend-10 replay was not already_acked.");
    const replayState = assertSpent15(await inspect(dependencies));
    if (replayState.target.revision !== revision || replayState.target.fencingEpoch !== fence) {
        fail("DIAMONDS_FINISH_SPEND_REPLAY_MUTATED", "Spend-10 replay mutated Target.");
    }
    return Object.freeze({ mode: "spend", verdict: "PASS", before: 25, after: 15,
        revisionBefore: 2, revisionAfter: 3, proof: true, operationState: "Acked",
        replay: "already_acked", replayProviderWrite: false });
}

async function runInsufficient(dependencies) {
    const before = assertSpent15(await inspect(dependencies));
    if (await dependencies.readTargetOperation({ operationId: FINISH_INSUFFICIENT_OPERATION_ID }) !== null) {
        fail("DIAMONDS_FINISH_INSUFFICIENT_ID_EXISTS", "Insufficient operationId already exists.");
    }
    const metricsBefore = await dependencies.readProviderHttpMetrics();
    const diagnosticsBefore = await dependencies.readProofWriteDiagnostics();
    let code = null;
    try {
        await dependencies.executeTargetOperation({
            operation: "insufficient_spend", operationId: FINISH_INSUFFICIENT_OPERATION_ID,
            eventId: "diamonds-canary-v1:event-insufficient-16", delta: -16
        });
    } catch (error) { code = error?.code || null; }
    if (code !== "POC_INSUFFICIENT_DIAMONDS") {
        fail("DIAMONDS_FINISH_INSUFFICIENT_NOT_BLOCKED", "Insufficient spend was not refused.");
    }
    const after = assertIdentity(await inspect(dependencies));
    const operation = await dependencies.readTargetOperation({ operationId: FINISH_INSUFFICIENT_OPERATION_ID });
    const metricsAfter = await dependencies.readProviderHttpMetrics();
    const diagnosticsAfter = await dependencies.readProofWriteDiagnostics();
    if (balance(after) !== 15 || after.target.revision !== before.target.revision ||
        after.target.fencingEpoch !== before.target.fencingEpoch ||
        after.target.highValueAppliedThroughSequence !== before.target.highValueAppliedThroughSequence ||
        operation !== null ||
        providerSetObjects(metricsAfter) !== providerSetObjects(metricsBefore) ||
        !sameDiagnostics(diagnosticsAfter, diagnosticsBefore)) {
        fail("DIAMONDS_FINISH_INSUFFICIENT_PREFLIGHT_INVALID",
            "Insufficient spend changed Target, Inbox/proof, sequence, fence or provider-write diagnostics.");
    }
    return Object.freeze({ mode: "insufficient", verdict: "PASS", result: "refused",
        balance: 15, revision: before.target.revision,
        sequence: before.target.highValueAppliedThroughSequence,
        proof: false, operationCreated: false, providerWrites: 0 });
}

async function runXsd2(dependencies) {
    const before = assertIdentity(await inspect(dependencies));
    const insufficient = await dependencies.readTargetOperation({ operationId: FINISH_INSUFFICIENT_OPERATION_ID });
    if (balance(before) !== 15 || before.target.revision !== 3 ||
        before.target.highValueAppliedThroughSequence !== 2 || insufficient !== null) {
        fail("DIAMONDS_FINISH_XSD2_BASELINE_INVALID", "xsd2 requires the exact post-insufficient Target15 baseline.");
    }
    const identity = await dependencies.ensureSyntheticXsd2();
    if (!plain(identity) || Object.keys(identity).join(",") !== "providerTransactionId") {
        fail("DIAMONDS_FINISH_XSD2_CALLER_INVALID", "xsd2 caller supplied financial authority fields.");
    }
    const pending = await dependencies.readLedgerTransaction(identity);
    if (pending?.provider !== "xsolla" || pending.providerTransactionId !== identity.providerTransactionId ||
        pending.playFabId !== FINISH_PLAYFAB_ID || pending.state !== "Pending" ||
        typeof pending.receiptId !== "string" || !pending.receiptId.startsWith("xsd2_") ||
        !pending.checkpoints?.receipt_persisted || pending.checkpoints?.diamonds_target_granted ||
        pending.checkpoints?.profile_granted) {
        fail("DIAMONDS_FINISH_XSD2_PENDING_INVALID",
            "Trusted xsd2 is not receipt-persisted Pending before Target projection.");
    }
    const first = await dependencies.projectTrustedXsd2(identity);
    if (first?.route !== "target_diamonds_canary" || first?.authoritative !== true ||
        first?.operation?.diamonds !== 500 || first?.status !== "applied") {
        fail("DIAMONDS_FINISH_XSD2_APPLY_FAILED", "Trusted xsd2 +500 did not apply to Target.");
    }
    const after = assertIdentity(await inspect(dependencies));
    if (balance(after) !== 515 || after.target.revision !== before.target.revision + 1 ||
        after.target.highValueAppliedThroughSequence !== before.target.highValueAppliedThroughSequence + 1) {
        fail("DIAMONDS_FINISH_XSD2_BALANCE_FAILED", "xsd2 did not produce exact Target515 revision/sequence.");
    }
    const revision = after.target.revision;
    const fence = after.target.fencingEpoch;
    const replay = await dependencies.projectTrustedXsd2(identity);
    if (replay?.status !== "already_applied" || replay?.authoritative !== true) {
        fail("DIAMONDS_FINISH_XSD2_REPLAY_FAILED", "xsd2 replay was not already_applied.");
    }
    const final = assertIdentity(await inspect(dependencies));
    if (balance(final) !== 515 || final.target.revision !== revision ||
        final.target.fencingEpoch !== fence) {
        fail("DIAMONDS_FINISH_XSD2_REPLAY_MUTATED", "xsd2 replay mutated Target.");
    }
    const ledger = await dependencies.readLedgerTransaction(identity);
    if (ledger?.state !== "Completed" || !ledger?.checkpoints?.diamonds_target_granted ||
        !ledger?.checkpoints?.profile_granted) {
        fail("DIAMONDS_FINISH_XSD2_LEDGER_INVALID", "xsd2 ledger is not durably Completed.");
    }
    return Object.freeze({ mode: "xsd2", verdict: "PASS", before: 15, after: 515,
        replay: "already_applied", exactlyOnce: true, providerTransactionId: identity.providerTransactionId });
}

async function runStale(dependencies) {
    const before = assertIdentity(await inspect(dependencies));
    if (balance(before) !== 515) fail("DIAMONDS_FINISH_STALE_BASELINE_INVALID", "Stale test requires Target515.");
    const revision = before.target.revision;
    const result = await dependencies.assertStaleLegacyWriteBlocked();
    if (result?.blocked !== true || result.targetBalance !== 515 || result.legacyValue !== 0 ||
        result.exactLegacyRewritePerformed !== true || result.legacyProfileDiamonds !== 0) {
        fail("DIAMONDS_FINISH_STALE_NOT_BLOCKED", "Stale Legacy rewrite isolation failed.");
    }
    const after = assertIdentity(await inspect(dependencies));
    if (balance(after) !== 515 || after.target.revision !== revision) {
        fail("DIAMONDS_FINISH_STALE_MUTATED_TARGET", "Stale Legacy rewrite changed Target.");
    }
    return Object.freeze({ mode: "stale", verdict: "PASS", blocked: true, targetUnchanged: true, balance: 515 });
}

export async function runDiamondsSandboxCanaryFinishHarness({ mode, explicitlyEnabled = false,
    providerWritesEnabled = false, staleLegacyWriteEnabled = false, dependencies } = {}) {
    if (!MODES.has(mode)) throw new TypeError("Diamonds finish mode is invalid.");
    if (explicitlyEnabled !== true || !plain(dependencies)) fail("DIAMONDS_FINISH_DISABLED", "Finish runner is disabled.");
    requireFunction(dependencies.inspectFinishState, "dependencies.inspectFinishState");
    if (["spend", "insufficient", "xsd2"].includes(mode) && providerWritesEnabled !== true) {
        fail("DIAMONDS_FINISH_PROVIDER_WRITES_DISABLED", "This phase requires explicit provider writes.");
    }
    if (mode === "stale" && staleLegacyWriteEnabled !== true) {
        fail("DIAMONDS_FINISH_STALE_WRITE_DISABLED", "Stale Legacy phase requires explicit enablement.");
    }
    if (mode === "preflight") return runPreflight(dependencies);
    if (mode === "spend") {
        requireFunction(dependencies.consumeExistingTargetOperation, "dependencies.consumeExistingTargetOperation");
        return runSpend(dependencies);
    }
    if (mode === "insufficient") {
        requireFunction(dependencies.executeTargetOperation, "dependencies.executeTargetOperation");
        requireFunction(dependencies.readTargetOperation, "dependencies.readTargetOperation");
        requireFunction(dependencies.readProviderHttpMetrics, "dependencies.readProviderHttpMetrics");
        requireFunction(dependencies.readProofWriteDiagnostics, "dependencies.readProofWriteDiagnostics");
        return runInsufficient(dependencies);
    }
    if (mode === "xsd2") {
        requireFunction(dependencies.ensureSyntheticXsd2, "dependencies.ensureSyntheticXsd2");
        requireFunction(dependencies.projectTrustedXsd2, "dependencies.projectTrustedXsd2");
        requireFunction(dependencies.readLedgerTransaction, "dependencies.readLedgerTransaction");
        return runXsd2(dependencies);
    }
    requireFunction(dependencies.assertStaleLegacyWriteBlocked, "dependencies.assertStaleLegacyWriteBlocked");
    return runStale(dependencies);
}
