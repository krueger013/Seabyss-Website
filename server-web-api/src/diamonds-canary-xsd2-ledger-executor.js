import { createPaymentWorker } from "./payment-worker.js";

export const DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT = "diamonds_target_granted";
export const DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT = "profile_granted";

const UNDERLYING_CAPABILITIES = Object.freeze([
    "authoritative", "cas", "exactlyOnce", "fencing", "migrationProofRequired"
]);

function coded(code, message, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function validateCommand(command) {
    if (!command || typeof command !== "object" || Array.isArray(command) ||
        command.schemaVersion !== 1 || command.domain !== "Diamonds" ||
        command.provider !== "xsolla" || typeof command.providerTransactionId !== "string" ||
        typeof command.receiptId !== "string" || !command.receiptId.startsWith("xsd2_") ||
        typeof command.playFabId !== "string" || typeof command.operationId !== "string" ||
        typeof command.operationHash !== "string" || !/^[a-f0-9]{64}$/u.test(command.operationHash) ||
        !Number.isSafeInteger(command.delta) || command.delta <= 0) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_COMMAND_INVALID",
            "Trusted xsd2 command is invalid.",
            400
        );
    }
    return command;
}

function assertLedgerBinding(transaction, command) {
    const receipt = transaction?.checkpoints?.receipt_persisted;
    if (transaction?.provider !== "xsolla" ||
        transaction.providerTransactionId !== command.providerTransactionId ||
        transaction.playFabId !== command.playFabId || transaction.receiptId !== command.receiptId ||
        transaction.sku !== command.sku || transaction.planVersion !== command.productPlanVersion ||
        transaction.planHash !== command.productPlanHash || transaction.environment !== "sandbox" ||
        !receipt || receipt.result?.receiptId !== command.receiptId) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_LEDGER_MISMATCH",
            "Target command does not match the durable Sandbox ledger/receipt chain.",
            409
        );
    }
}

function checkpointResult(transaction, name, command) {
    const result = transaction?.checkpoints?.[name]?.result;
    if (!result || result.playFabId !== command.playFabId ||
        result.operationId !== command.operationId || result.operationHash !== command.operationHash ||
        result.receiptId !== command.receiptId || result.delta !== command.delta) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_PROOF_MISMATCH",
            `Durable ${name} checkpoint differs from the trusted xsd2 command.`,
            409
        );
    }
    return result;
}

function targetCheckpointResult(command, result) {
    if (!result || (result.status !== "Applied" && result.status !== "AlreadyApplied") ||
        result.authoritative !== true || result.providerConfirmed !== true ||
        result.playFabId !== command.playFabId || result.operationId !== command.operationId ||
        result.delta !== command.delta || !Number.isSafeInteger(result.balance) || result.balance < 0 ||
        !Number.isSafeInteger(result.revision) || result.revision < 0 ||
        !Number.isSafeInteger(result.fencingEpoch) || result.fencingEpoch <= 0) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_PROVIDER_RESULT_INVALID",
            "Atomic Target executor returned an invalid result."
        );
    }
    return Object.freeze({
        ...result,
        receiptId: command.receiptId,
        operationHash: command.operationHash
    });
}

function verificationCheckpointResult(command, result) {
    if (!result || result.verified !== true || result.providerConfirmed !== true ||
        result.playFabId !== command.playFabId || result.operationId !== command.operationId ||
        result.delta !== command.delta || !Number.isSafeInteger(result.balance) || result.balance < 0 ||
        !Number.isSafeInteger(result.revision) || result.revision < 0 ||
        !Number.isSafeInteger(result.fencingEpoch) || result.fencingEpoch <= 0) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_READBACK_INVALID",
            "Target state/proof readback did not verify the xsd2 operation."
        );
    }
    return Object.freeze({
        ...result,
        receiptId: command.receiptId,
        operationHash: command.operationHash
    });
}

/**
 * Adds the central-ledger completion boundary around the atomic PlayFab
 * state+proof executor. A crash after PlayFab but before a ledger checkpoint
 * replays the same operationId/hash at the provider, where it is a no-op;
 * Completed is reached only after a fresh provider readback checkpoint.
 */
export function createDiamondsCanaryXsd2LedgerExecutor({
    ledger,
    targetExecutor,
    workerId = `diamonds-canary-xsd2-${process.pid}`,
    workerOptions = {}
} = {}) {
    if (!ledger || typeof targetExecutor?.executeTrustedXsd2 !== "function" ||
        typeof targetExecutor?.verifyTrustedXsd2 !== "function" ||
        !workerOptions || typeof workerOptions !== "object" || Array.isArray(workerOptions)) {
        throw new TypeError("Diamonds canary xsd2 ledger executor is not configured.");
    }
    for (const capability of UNDERLYING_CAPABILITIES) {
        if (targetExecutor.capabilities?.[capability] !== true) {
            throw coded(
                "DIAMONDS_CANARY_XSD2_PROVIDER_UNSAFE",
                `Atomic Target executor lacks ${capability}.`
            );
        }
    }

    async function executeTrustedXsd2(rawCommand) {
        const command = validateCommand(rawCommand);
        const identity = {
            provider: "xsolla",
            providerTransactionId: command.providerTransactionId
        };
        const before = await ledger.requireTransaction(identity);
        assertLedgerBinding(before, command);

        const worker = createPaymentWorker({
            ...workerOptions,
            ledger,
            workerId,
            completeAfterCheckpoints: true,
            steps: [
                {
                    name: DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT,
                    async run(context) {
                        assertLedgerBinding(context.transaction, command);
                        await context.assertLeaseOwnership();
                        return targetCheckpointResult(
                            command,
                            await targetExecutor.executeTrustedXsd2(command)
                        );
                    }
                },
                {
                    name: DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT,
                    async run(context) {
                        assertLedgerBinding(context.transaction, command);
                        await context.assertLeaseOwnership();
                        return verificationCheckpointResult(
                            command,
                            await targetExecutor.verifyTrustedXsd2(command)
                        );
                    }
                }
            ]
        });
        const processed = await worker.processTransaction(identity);
        if (processed.status !== "completed" && processed.status !== "already_completed") {
            throw coded(
                "DIAMONDS_CANARY_XSD2_NOT_COMPLETED",
                `Target xsd2 ledger transaction stopped in ${processed.status}.`
            );
        }
        if (processed.transaction.state !== "Completed") {
            throw coded(
                "DIAMONDS_CANARY_XSD2_NOT_COMPLETED",
                "Target xsd2 ledger transaction is not Completed."
            );
        }
        const target = checkpointResult(
            processed.transaction,
            DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT,
            command
        );
        checkpointResult(
            processed.transaction,
            DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT,
            command
        );
        return Object.freeze({
            ...target,
            status: processed.status === "already_completed" ? "AlreadyApplied" : target.status,
            transactionState: "Completed"
        });
    }

    return Object.freeze({
        executeTrustedXsd2,
        capabilities: Object.freeze({
            authoritative: true,
            cas: true,
            durableCompletion: true,
            exactlyOnce: true,
            fencing: true,
            migrationProofRequired: true
        }),
        checkpoints: Object.freeze([
            DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT,
            DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT
        ])
    });
}
