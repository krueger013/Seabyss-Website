import {
    mapValidatedXsollaReceiptToFinalServerEconomyPocOperation
} from "./server-economy-poc-receipt-mapper-final.js";

function coded(code, message, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function validateCommand(command) {
    if (!command || typeof command !== "object" || Array.isArray(command) ||
        command.schemaVersion !== 1 || command.domain !== "Diamonds" ||
        command.provider !== "xsolla" || typeof command.playFabId !== "string" ||
        typeof command.providerTransactionId !== "string" ||
        typeof command.receiptId !== "string" || !command.receiptId.startsWith("xsd2_") ||
        typeof command.sku !== "string" || !Number.isSafeInteger(command.quantity) ||
        command.quantity !== 1 || typeof command.currency !== "string" ||
        !Number.isSafeInteger(command.amountMinor) || command.amountMinor <= 0 ||
        !Number.isSafeInteger(command.productPlanVersion) || command.productPlanVersion <= 0 ||
        typeof command.productPlanHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(command.productPlanHash) ||
        typeof command.operationId !== "string" || typeof command.eventId !== "string" ||
        typeof command.operationHash !== "string" || !/^[a-f0-9]{64}$/u.test(command.operationHash) ||
        !Number.isSafeInteger(command.delta) || command.delta <= 0 ||
        !Number.isSafeInteger(command.effectiveAtUnixMs) || command.effectiveAtUnixMs < 0) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_CANONICAL_COMMAND_INVALID",
            "Canonical Target received an invalid trusted xsd2 command.",
            400
        );
    }
    return command;
}

function projection(command) {
    return Object.freeze({
        provider: "xsolla",
        source: "durable_immutable_receipt",
        receiptPersisted: true,
        economicValidationPassed: true,
        playFabId: command.playFabId,
        providerTransactionId: command.providerTransactionId,
        sku: command.sku,
        effectiveAtUnixMs: command.effectiveAtUnixMs,
        quantity: command.quantity,
        currency: command.currency,
        amountMinor: command.amountMinor,
        productPlanVersion: command.productPlanVersion,
        productPlanHash: command.productPlanHash
    });
}

function assertMappedOperation(mapped, command) {
    if (!mapped || mapped.playFabId !== command.playFabId ||
        mapped.providerTransactionId !== command.providerTransactionId ||
        mapped.operationId !== command.operationId || mapped.eventId !== command.eventId ||
        mapped.diamonds !== command.delta ||
        mapped.eliteBall !== 0 || mapped.premium !== null) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_CANONICAL_MISMATCH",
            "Canonical runtime mapping differs from the ledger/receipt/plan command.",
            409
        );
    }
}

function providerResult(result, command) {
    const consumed = result?.consumed;
    const snapshot = consumed?.snapshot;
    const operation = result?.operation;
    const allowed = new Set(["applied", "already_acked", "recovered_after_snapshot"]);
    if (!consumed || !allowed.has(consumed.status) || !snapshot ||
        !operation || operation.operationId !== command.operationId ||
        operation.eventId !== command.eventId ||
        operation.diamonds !== command.delta || operation.eliteBall !== 0 || operation.premium !== null ||
        snapshot.playFabId !== command.playFabId ||
        !Number.isSafeInteger(snapshot.diamonds) || snapshot.diamonds < 0 ||
        !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
        !Number.isSafeInteger(snapshot.fencingEpoch) || snapshot.fencingEpoch <= 0) {
        throw coded(
            "DIAMONDS_CANARY_XSD2_CANONICAL_RESULT_INVALID",
            "Canonical inbox/WAL consumer did not return a durable Target snapshot."
        );
    }
    return Object.freeze({
        status: consumed.status === "already_acked" ? "AlreadyApplied" : "Applied",
        authoritative: true,
        providerConfirmed: true,
        playFabId: command.playFabId,
        operationId: command.operationId,
        delta: command.delta,
        balance: snapshot.diamonds,
        revision: snapshot.revision,
        fencingEpoch: snapshot.fencingEpoch
    });
}

/**
 * Adapts a trusted xsd2 command to the already-certified canonical
 * operationInbox/WAL/lease/fencing consumer. The companion is wired at the
 * PlayFab SetObjects boundary and atomically maintains the migration proof in
 * the same snapshot CAS.
 */
export function createDiamondsCanaryXsd2CanonicalTargetExecutor({
    canonicalRuntime,
    migrationProofCompanion = canonicalRuntime
} = {}) {
    const proofCapabilities = migrationProofCompanion?.capabilities ||
        canonicalRuntime?.proofCapabilities;
    if (typeof canonicalRuntime?.consumeValidatedXsollaReceipt !== "function" ||
        typeof canonicalRuntime?.readSnapshot !== "function" ||
        typeof migrationProofCompanion?.verifyTrustedOperation !== "function" ||
        proofCapabilities?.atomicStateProofCas !== true ||
        proofCapabilities?.fencing !== true ||
        proofCapabilities?.migrationProof !== true) {
        throw new TypeError("Canonical Diamonds canary xsd2 Target executor is not configured.");
    }

    async function executeTrustedXsd2(rawCommand) {
        const command = validateCommand(rawCommand);
        const trustedProjection = projection(command);
        const mapped = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(trustedProjection);
        assertMappedOperation(mapped, command);
        return providerResult(
            await canonicalRuntime.consumeValidatedXsollaReceipt(
                trustedProjection,
                { preferOnline: false }
            ),
            command
        );
    }

    async function verifyTrustedXsd2(rawCommand) {
        const command = validateCommand(rawCommand);
        const snapshot = await canonicalRuntime.readSnapshot(command.playFabId);
        const proof = await migrationProofCompanion.verifyTrustedOperation({
            titleId: command.titleId,
            playFabId: command.playFabId,
            operationId: command.operationId,
            operationHash: command.operationHash,
            delta: command.delta
        });
        if (proof?.verified !== true || proof.playFabId !== command.playFabId ||
            proof.operationId !== command.operationId || proof.operationHash !== command.operationHash ||
            proof.delta !== command.delta || proof.balance !== snapshot?.diamonds ||
            proof.revision !== snapshot?.revision || proof.fencingEpoch !== snapshot?.fencingEpoch ||
            !Number.isSafeInteger(proof.targetOnlyOperationCount) ||
            proof.targetOnlyOperationCount <= 0) {
            throw coded(
                "DIAMONDS_CANARY_XSD2_PROOF_READBACK_INVALID",
                "Atomic migration proof does not attest the canonical Target snapshot."
            );
        }
        return Object.freeze({
            verified: true,
            providerConfirmed: true,
            playFabId: command.playFabId,
            operationId: command.operationId,
            operationHash: command.operationHash,
            delta: command.delta,
            balance: snapshot.diamonds,
            revision: snapshot.revision,
            fencingEpoch: snapshot.fencingEpoch,
            targetOnlyOperationCount: proof.targetOnlyOperationCount
        });
    }

    return Object.freeze({
        executeTrustedXsd2,
        verifyTrustedXsd2,
        capabilities: Object.freeze({
            authoritative: true,
            cas: true,
            exactlyOnce: true,
            fencing: true,
            migrationProofRequired: true,
            operationInbox: true,
            wal: true
        }),
        route: "canonical_operation_inbox_wal"
    });
}
