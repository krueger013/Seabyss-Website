import { readConfiguredDiamondsCanaryPlayFabId } from "./diamonds-canary-identity.js";
import {
    DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION,
    DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION
} from "./diamonds-migration-proof-companion.js";
export const DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID = "1D0C16";
export const DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID = readConfiguredDiamondsCanaryPlayFabId();
export const DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID = "142853";
export const DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE = 515;

const REQUIRED_PREFLIGHT_FLAGS = Object.freeze([
    "certificateValid",
    "legacyReceiptAbsent",
    "playFabHealthy",
    "productionTitleUntouched",
    "redisHealthy",
    "rollbackAvailable",
    "scannerZeroForbidden",
    "syntheticV2ReceiptAbsent",
    "zeroPendingPayment"
]);

function coded(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireFunction(value, name) {
    if (typeof value !== "function") throw new TypeError(`${name} is required.`);
    return value;
}

function safeString(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function sha256(value, name) {
    const selected = safeString(value, name, 64);
    if (!/^[a-f0-9]{64}$/u.test(selected)) throw new TypeError(`${name} must be SHA-256.`);
    return selected;
}

function balanceFrom(value, name) {
    const balance = value?.diamonds ?? value?.targetValue ?? value?.balance;
    if (!Number.isSafeInteger(balance) || balance < 0) {
        throw coded("DIAMONDS_CANARY_BALANCE_INVALID", `${name} did not return a valid Target balance.`);
    }
    return balance;
}

function validatePreflight(value) {
    if (!plain(value) || value.titleId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID ||
        value.playFabId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID ||
        value.productionTitleId !== DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID ||
        value.legacyValue !== 0 || value.legacyProfileDiamonds !== 0 || value.targetValue !== 0 ||
        value.migrationProofExists !== false || value.scannerForbiddenCount !== 0 ||
        !Number.isSafeInteger(value.redisVersionMajor) || value.redisVersionMajor < 7 ||
        !plain(value.plan) || value.plan.status !== "ready" || value.plan.readOnly !== true ||
        value.plan.legacyValue !== 0 || value.plan.targetValue !== 0 ||
        value.plan.proposedTarget !== 0 || value.plan.playFabId !== value.playFabId ||
        value.plan.titleId !== value.titleId || value.plan.rollback?.available !== true) {
        throw coded("DIAMONDS_CANARY_PREFLIGHT_FAILED",
            "Diamonds Canary preflight differs from the certified 0 -> 0 reversible baseline.");
    }
    for (const flag of REQUIRED_PREFLIGHT_FLAGS) {
        if (value[flag] !== true) {
            throw coded("DIAMONDS_CANARY_PREFLIGHT_FAILED", `Diamonds Canary preflight ${flag} is not true.`);
        }
    }
    sha256(value.plan.planHash, "planHash");
    sha256(value.scannerHash, "scannerHash");
    return value;
}

function validateProof(proof, { planHash, expectedBalance, requireTargetOnly = false } = {}) {
    const supportedSchema = proof?.schemaVersion === DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION ||
        proof?.schemaVersion === DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION;
    if (!plain(proof) || !supportedSchema || proof.state !== "Completed" ||
        proof.titleId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID ||
        proof.playFabId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID ||
        proof.domain !== "Diamonds" || proof.planHash !== planHash ||
        proof.legacyValue !== 0 || proof.targetValue !== expectedBalance ||
        !Number.isSafeInteger(proof.targetOnlyOperationCount) ||
        proof.targetOnlyOperationCount < (requireTargetOnly ? 3 : 0)) {
        throw coded("DIAMONDS_CANARY_PROOF_INVALID", "Diamonds migration proof does not attest the expected Target state.");
    }
    return proof;
}

function validateLedgerCompleted(transaction, providerTransactionId) {
    if (!plain(transaction) || transaction.provider !== "xsolla" ||
        transaction.providerTransactionId !== providerTransactionId ||
        transaction.playFabId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID ||
        transaction.environment !== "sandbox" || transaction.state !== "Completed" ||
        !transaction.receiptId?.startsWith("xsd2_") ||
        !transaction.checkpoints?.receipt_persisted ||
        !transaction.checkpoints?.diamonds_target_granted ||
        !transaction.checkpoints?.profile_granted) {
        throw coded("DIAMONDS_CANARY_XSD2_LEDGER_INVALID",
            "Synthetic xsd2 ledger transaction is not durably Completed.");
    }
    return transaction;
}

async function assertBalance(readTarget, expected, label) {
    const snapshot = await readTarget();
    const actual = balanceFrom(snapshot, label);
    if (actual !== expected) {
        throw coded("DIAMONDS_CANARY_BALANCE_MISMATCH",
            `${label} expected ${expected} Target Diamonds and observed ${actual}.`,
            { expected, actual });
    }
    return snapshot;
}

function requireDependencies(dependencies, mode) {
    if (!plain(dependencies)) throw new TypeError("Diamonds Canary harness dependencies are required.");
    const common = [
        "readTarget",
        "readMigrationProof",
        "getSyntheticProviderTransactionId",
        "projectTrustedXsd2",
        "readLedgerTransaction",
        "assertStaleLegacyWriteBlocked"
    ];
    const apply = [
        "preflight",
        "applyMigration",
        "executeTargetOperation",
        "ensureSyntheticXsd2"
    ];
    for (const name of mode === "apply" ? [...common, ...apply] : common) {
        requireFunction(dependencies[name], `dependencies.${name}`);
    }
    return dependencies;
}

async function runApply(dependencies) {
    const preflight = validatePreflight(await dependencies.preflight());
    const migration = await dependencies.applyMigration({
        plan: preflight.plan,
        approvedPlanHash: preflight.plan.planHash
    });
    if (!plain(migration) || migration.status !== "completed" ||
        migration.providerWriteCount !== 1 || migration.observation?.targetValue !== 0) {
        throw coded("DIAMONDS_CANARY_MIGRATION_INVALID",
            "Diamonds migration did not complete one atomic 0 -> 0 state+proof CAS.");
    }
    validateProof(migration.proof, { planHash: preflight.plan.planHash, expectedBalance: 0 });
    await assertBalance(dependencies.readTarget, 0, "migration readback");

    await dependencies.executeTargetOperation({
        operation: "grant_25",
        operationId: "diamonds-canary-v1:grant-25",
        eventId: "diamonds-canary-v1:event-grant-25",
        delta: 25
    });
    await assertBalance(dependencies.readTarget, 25, "grant +25");

    await dependencies.executeTargetOperation({
        operation: "spend_10",
        operationId: "diamonds-canary-v1:spend-10",
        eventId: "diamonds-canary-v1:event-spend-10",
        delta: -10
    });
    await assertBalance(dependencies.readTarget, 15, "spend -10");

    let insufficientCode = null;
    try {
        await dependencies.executeTargetOperation({
            operation: "insufficient_spend",
            operationId: "diamonds-canary-v1:insufficient-16",
            eventId: "diamonds-canary-v1:event-insufficient-16",
            delta: -16
        });
    } catch (error) {
        insufficientCode = error?.code || null;
    }
    if (insufficientCode !== "POC_INSUFFICIENT_DIAMONDS") {
        throw coded("DIAMONDS_CANARY_INSUFFICIENT_NOT_BLOCKED",
            "Target accepted an insufficient Diamonds spend.", { observedCode: insufficientCode });
    }
    await assertBalance(dependencies.readTarget, 15, "insufficient spend readback");

    const synthetic = await dependencies.ensureSyntheticXsd2();
    const providerTransactionId = safeString(
        synthetic?.providerTransactionId,
        "synthetic providerTransactionId",
        255
    );
    if (Object.keys(synthetic).some((key) => ["reward", "rewards", "amount", "balance", "playFabId"].includes(key))) {
        throw coded("DIAMONDS_CANARY_XSD2_CALLER_AUTHORITY_INVALID",
            "Synthetic xsd2 caller returned forbidden financial authority fields.");
    }
    const first = await dependencies.projectTrustedXsd2({ providerTransactionId });
    if (first?.route !== "target_diamonds_canary" || first?.authoritative !== true ||
        first?.operation?.diamonds !== 500) {
        throw coded("DIAMONDS_CANARY_XSD2_ROUTE_INVALID",
            "Trusted xsd2 did not route +500 to authoritative Canary Target.");
    }
    await assertBalance(dependencies.readTarget, DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE,
        "trusted xsd2 +500");
    const replay = await dependencies.projectTrustedXsd2({ providerTransactionId });
    if (replay?.status !== "already_applied" || replay?.authoritative !== true) {
        throw coded("DIAMONDS_CANARY_XSD2_REPLAY_INVALID", "Trusted xsd2 replay was not idempotent.");
    }
    await assertBalance(dependencies.readTarget, DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE,
        "trusted xsd2 replay");
    validateLedgerCompleted(
        await dependencies.readLedgerTransaction({ providerTransactionId }),
        providerTransactionId
    );
    const finalProof = validateProof(await dependencies.readMigrationProof(), {
        planHash: preflight.plan.planHash,
        expectedBalance: DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE,
        requireTargetOnly: true
    });
    const stale = await dependencies.assertStaleLegacyWriteBlocked();
    if (stale?.blocked !== true || stale.targetBalance !== DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE ||
        stale.legacyValue !== 0 || stale.exactLegacyRewritePerformed !== true ||
        stale.legacyProfileDiamonds !== 0) {
        throw coded("DIAMONDS_CANARY_STALE_LEGACY_WRITE_NOT_BLOCKED",
            "Stale Legacy save protection did not preserve Target 515 / Legacy 0.");
    }
    return Object.freeze({
        mode: "apply",
        verdict: "PASS",
        titleId: DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID,
        playFabId: DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID,
        productionTitleUntouched: true,
        planHash: preflight.plan.planHash,
        migration: Object.freeze({ status: migration.status, legacyBefore: 0, targetAfter: 0,
            proof: true, atomicProviderWrites: migration.providerWriteCount }),
        operations: Object.freeze({ grant25: 25, spend10: 15, insufficientBlocked: true,
            xsd2Grant500: 515, replay: 515 }),
        xsd2: Object.freeze({ providerTransactionId, ledgerState: "Completed", exactlyOnce: true }),
        staleLegacyWriteBlocked: true,
        rollbackAvailable: false,
        targetOnlyOperationCount: finalProof.targetOnlyOperationCount,
        finalBalance: DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE
    });
}

async function runVerify(dependencies) {
    const providerTransactionId = safeString(
        await dependencies.getSyntheticProviderTransactionId(),
        "synthetic providerTransactionId",
        255
    );
    const before = await assertBalance(dependencies.readTarget,
        DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE, "restart verification before replay");
    const proof = await dependencies.readMigrationProof();
    const transaction = validateLedgerCompleted(
        await dependencies.readLedgerTransaction({ providerTransactionId }),
        providerTransactionId
    );
    const replay = await dependencies.projectTrustedXsd2({ providerTransactionId });
    if (replay?.status !== "already_applied" || replay?.authoritative !== true) {
        throw coded("DIAMONDS_CANARY_XSD2_RESTART_REPLAY_INVALID",
            "Process-restart xsd2 replay was not answered by durable Completed evidence.");
    }
    const after = await assertBalance(dependencies.readTarget,
        DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE, "restart verification after replay");
    if (before.revision !== after.revision || before.fencingEpoch !== after.fencingEpoch) {
        throw coded("DIAMONDS_CANARY_RESTART_MUTATED_TARGET",
            "Verification replay changed Target revision or fencing epoch.");
    }
    validateProof(proof, {
        planHash: proof?.planHash,
        expectedBalance: DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE,
        requireTargetOnly: true
    });
    const stale = await dependencies.assertStaleLegacyWriteBlocked();
    if (stale?.blocked !== true || stale.targetBalance !== DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE) {
        throw coded("DIAMONDS_CANARY_STALE_LEGACY_WRITE_NOT_BLOCKED",
            "Restart verification could not prove stale Legacy isolation.");
    }
    return Object.freeze({
        mode: "verify",
        verdict: "PASS",
        titleId: DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID,
        playFabId: DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID,
        productionTitleUntouched: true,
        providerTransactionId,
        transactionState: transaction.state,
        xsd2Replay: "already_applied",
        targetUnchanged: true,
        staleLegacyWriteBlocked: true,
        finalBalance: DIAMONDS_SANDBOX_CANARY_EXPECTED_FINAL_BALANCE
    });
}

/**
 * Short, fail-closed orchestration contract. Real provider composition lives in
 * the executable CLI; tests can certify this sequence without any network.
 */
export async function runDiamondsSandboxCanaryApplyHarness({
    mode = "apply",
    explicitlyEnabled = false,
    dependencies
} = {}) {
    if (mode !== "apply" && mode !== "verify") throw new TypeError("Diamonds Canary harness mode is invalid.");
    if (explicitlyEnabled !== true) {
        throw coded("DIAMONDS_CANARY_HARNESS_DISABLED", "Diamonds Canary harness requires explicit enablement.");
    }
    const selected = requireDependencies(dependencies, mode);
    return mode === "apply" ? runApply(selected) : runVerify(selected);
}
