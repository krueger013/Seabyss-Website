import { createHash } from "node:crypto";

import {
    serverEconomyPocDigest,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

export const CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT = Object.freeze({
    schemaVersion: 1,
    titleId: "1D0C16",
    productionTitleId: "142853",
    playFabId: "C5BD37AA141B3C4E",
    domain: "Diamonds",
    provider: "xsolla",
    providerTransactionId: "8209157741454957763",
    receiptId: "xsd2_xPNGLDlb4ys5lZhpL8duXBOgKQkfzZshrqN6CATfGyk",
    sku: "seabyss_diamond_pack_1",
    planVersion: 1,
    planHash: "6bc951222b7fe43432d5268b504a7322a9bf2910c0e5ce0ac6474c79c60b5d01",
    ledgerImmutableHash: "eb02c18d6e3e887b615f4e932c2f5be6e689be901ca4f7af5ddcda9c8406734b",
    providerGuardImmutableHash: "f11f34fe60364fb5b07c4467f81e832248a6a1cba96faf261a9de180c3ba015e",
    eventIndexIdentity: "event_1eff105bef44fed69ab3e99698e21c92f150d9525e09f4f7b77ff383fdb62e67",
    eventIndexImmutableHash: "d008c9030441269028491782a3822da40c93e6ff34d64630ddded77f7971e30b",
    ledgerLeaseOwner: "diamonds-historical-sequence-rebase",
    operationId: "poc_xsolla_0a012cef7910fb10924dd978f0ffa0ec6d18f731c54bb2daf093b9b7e3f9c562",
    eventId: "xsolla_0a012cef7910fb10924dd978f0ffa0ec6d18f731c54bb2daf093b9b7e3f9c562",
    operationImmutableHash: "29548ff96223577484370987afc4a653ecca38e84b65682e2f14c984fabe7d35",
    operationReason: "xsolla_diamond_pack",
    operationEffectiveAtUnixMs: 1_787_607_121_413,
    diamondsDelta: 500,
    originalSequence: 1,
    providerCursor: 2,
    rebasedSequence: 3,
    targetDiamonds: 15,
    targetRevision: 3,
    migrationProofSchemaVersion: 2,
    targetOnlyOperationCount: 2,
    historicalCounterBeforeAllocation: 2,
    historicalReservedSequence: 3,
    persistenceAofSha256: "62c876d5f10395d37ecbda0d337746deca93e1b91b60d1402af380a135123300",
    persistenceAofBytes: 108_598,
    reason: "HistoricalSequenceAllocatorBug"
});

const DEFAULT_TARGET_PREFIX = "seabyss:financial:diamonds:sandbox-canary:v1:";
const DEFAULT_LEDGER_PREFIX = "seabyss:payments:diamonds:sandbox-canary:v1:";
const REBASE_KIND = "HistoricalPendingSequenceRebase";
const REBASE_VERSION = 1;
const REBASE_JOURNAL_KIND = "HistoricalSequenceRebaseCommit";
const ACTIVE_BINDING_KIND = "HistoricalSequenceActiveBinding";
const DURABILITY_TIMEOUT_MILLISECONDS = 5_000;

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message, options = {}) {
    serverEconomyPocFail(code, message, { statusCode: 409, ...options });
}

function equal(actual, expected, label, code = "POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE") {
    if (actual !== expected) fail(code, `${label} differs from the certified historical operation.`);
}

function hash(value, label, expected = null) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) ||
        expected !== null && value !== expected) {
        fail("POC_HISTORICAL_REBASE_HASH_MISMATCH", `${label} is not the expected SHA-256 digest.`);
    }
    return value;
}

function integer(value, label, expected = null) {
    if (!Number.isSafeInteger(value) || value < 0 || expected !== null && value !== expected) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", `${label} differs from the certified historical operation.`);
    }
    return value;
}

function sha256Hex(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodedLedgerIdentity(...values) {
    return createHash("sha256").update(values.join("\0"), "utf8").digest("base64url");
}

function parseJson(value, label) {
    if (value === null) return null;
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
        if (!plain(parsed)) throw new Error();
        return parsed;
    } catch {
        fail("POC_HISTORICAL_REBASE_REDIS_CORRUPT", `${label} is malformed.`);
    }
}

function validateContract(contract) {
    if (!plain(contract) || contract.titleId === contract.productionTitleId ||
        contract.titleId !== "1D0C16" || contract.productionTitleId !== "142853") {
        fail("POC_HISTORICAL_REBASE_PRODUCTION_FORBIDDEN", "Only the isolated PlayFab Sandbox contract is accepted.");
    }
    for (const [name, value, maximum] of [
        ["playFabId", contract.playFabId, 160],
        ["providerTransactionId", contract.providerTransactionId, 200],
        ["receiptId", contract.receiptId, 255],
        ["operationId", contract.operationId, 200],
        ["eventId", contract.eventId, 200],
        ["eventIndexIdentity", contract.eventIndexIdentity, 255],
        ["ledgerLeaseOwner", contract.ledgerLeaseOwner, 160],
        ["operationReason", contract.operationReason, 160]
    ]) serverEconomyPocId(value, name, maximum);
    hash(contract.operationImmutableHash, "operation immutableHash");
    hash(contract.ledgerImmutableHash, "ledger immutableHash");
    hash(contract.providerGuardImmutableHash, "provider guard immutableHash");
    hash(contract.eventIndexImmutableHash, "event-index immutableHash");
    hash(contract.planHash, "product plan hash");
    hash(contract.persistenceAofSha256, "certified AOF digest");
    serverEconomyPocPositive(contract.diamondsDelta, "Diamonds delta");
    integer(contract.operationEffectiveAtUnixMs, "operation effectiveAt");
    integer(contract.originalSequence, "original sequence");
    integer(contract.providerCursor, "provider cursor");
    integer(contract.rebasedSequence, "rebased sequence");
    if (contract.rebasedSequence !== contract.providerCursor + 1 ||
        contract.historicalReservedSequence !== contract.rebasedSequence) {
        fail("POC_HISTORICAL_REBASE_SEQUENCE_INVALID", "The certified orphaned reservation must be provider cursor + 1.");
    }
    return contract;
}

function validateProviderEvidence(provider, contract) {
    if (!plain(provider) || !plain(provider.snapshot) || !plain(provider.migrationProof)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Provider readback is incomplete.");
    }
    equal(provider.titleId, contract.titleId, "provider Title");
    equal(provider.playFabId, contract.playFabId, "provider player");
    equal(provider.titleId === contract.productionTitleId, false, "Production isolation");
    integer(provider.snapshot.diamonds, "Target Diamonds", contract.targetDiamonds);
    integer(provider.snapshot.revision, "Target revision", contract.targetRevision);
    integer(provider.snapshot.highValueAppliedThroughSequence, "provider cursor", contract.providerCursor);
    if (!plain(provider.operationProof) || provider.operationProof.verified !== false ||
        provider.operationProof.reason !== "missing") {
        fail("POC_HISTORICAL_REBASE_PROVIDER_APPLIED", "Exact provider operation proof is not definitively absent.");
    }
    if (provider.operationMarker !== null || provider.operationResultHash !== null) {
        fail("POC_HISTORICAL_REBASE_PROVIDER_APPLIED", "Provider marker/resultHash indicates possible application.");
    }
    const migration = provider.migrationProof;
    equal(migration.schemaVersion, contract.migrationProofSchemaVersion, "migration proof schema");
    equal(migration.state, "Completed", "migration proof state");
    equal(migration.titleId, contract.titleId, "migration proof Title");
    equal(migration.playFabId, contract.playFabId, "migration proof player");
    equal(migration.domain, contract.domain, "migration proof domain");
    integer(migration.targetValue, "migration proof Target", contract.targetDiamonds);
    integer(migration.targetRevision, "migration proof revision", contract.targetRevision);
    integer(migration.targetOnlyOperationCount, "migration proof operation count", contract.targetOnlyOperationCount);
    if (migration.latestTargetOperation?.h === contract.operationImmutableHash ||
        migration.latestTargetOperation?.operationId === contract.operationId ||
        migration.latestTargetOperation?.operationHash === contract.operationImmutableHash) {
        fail("POC_HISTORICAL_REBASE_PROVIDER_APPLIED", "Migration proof already references the xsd2 operation.");
    }
}

function validateOperationRecord(record, contract, expectedSequence = contract.originalSequence) {
    if (!plain(record) || !plain(record.operation)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Historical Inbox record is absent.");
    }
    equal(record.schemaVersion, 1, "Inbox schema");
    equal(record.playFabId, contract.playFabId, "Inbox player");
    equal(record.operationId, contract.operationId, "Inbox operationId");
    integer(record.sequence, "historical sequence", expectedSequence);
    equal(record.state, "Pending", "Inbox state", "POC_HISTORICAL_REBASE_NOT_PENDING");
    if (record.result !== null || record.ackedAtUnixMs !== null) {
        fail("POC_HISTORICAL_REBASE_PROVIDER_APPLIED", "Inbox contains an ACK or applied result.");
    }
    if (record.claimOwner !== null || record.claimToken !== null || record.claimExpiresAtUnixMs !== null) {
        fail("POC_HISTORICAL_REBASE_ACTIVE_CLAIM", "Historical Inbox operation is actively claimed.");
    }
    const operation = record.operation;
    equal(operation.schemaVersion, 1, "operation schema");
    equal(operation.kind, "xsolla_entitlement", "operation kind");
    equal(operation.playFabId, contract.playFabId, "operation player");
    equal(operation.operationId, contract.operationId, "operationId");
    equal(operation.eventId, contract.eventId, "eventId");
    equal(operation.diamonds, contract.diamondsDelta, "Diamonds intent");
    equal(operation.eliteBall, 0, "Elite intent");
    equal(operation.premium, null, "Premium intent");
    equal(operation.reason, contract.operationReason, "operation reason");
    integer(operation.createdAtUnixMs, "operation createdAt", contract.operationEffectiveAtUnixMs);
    integer(operation.effectiveAtUnixMs, "operation effectiveAt", contract.operationEffectiveAtUnixMs);
    hash(operation.immutableHash, "operation immutableHash", contract.operationImmutableHash);
}

function validateRebasedOperationRecord(record, contract, expectedSequenceRebase) {
    if (!plain(record)) {
        fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "Active rebased operation is absent.");
    }
    const pendingProjection = {
        ...structuredClone(record),
        state: "Pending",
        claimOwner: null,
        claimToken: null,
        claimExpiresAtUnixMs: null,
        result: null,
        ackedAtUnixMs: null
    };
    validateOperationRecord(pendingProjection, contract, contract.rebasedSequence);
    integer(record.originalSequence, "active original sequence", contract.originalSequence);
    integer(record.activeSequence, "active provider sequence", contract.rebasedSequence);
    equal(serverEconomyPocDigest(record.sequenceRebase),
        serverEconomyPocDigest(expectedSequenceRebase), "active sequence-rebase binding",
        "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT");
    if (!Number.isSafeInteger(record.claimEpoch) || record.claimEpoch < 0) {
        fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "Active claim epoch is invalid.");
    }
    if (record.state === "Pending") {
        if (record.result !== null || record.ackedAtUnixMs !== null || record.claimOwner !== null ||
            record.claimToken !== null || record.claimExpiresAtUnixMs !== null) {
            fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "Pending rebased lifecycle is invalid.");
        }
    } else if (record.state === "Claimed") {
        if (record.result !== null || record.ackedAtUnixMs !== null ||
            typeof record.claimOwner !== "string" || record.claimOwner.length === 0 ||
            typeof record.claimToken !== "string" || record.claimToken.length === 0 ||
            !Number.isSafeInteger(record.claimExpiresAtUnixMs) || record.claimExpiresAtUnixMs <= 0 ||
            record.claimEpoch <= 0) {
            fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "Claimed rebased lifecycle is invalid.");
        }
    } else if (record.state === "Acked") {
        if (record.result === null || !Number.isSafeInteger(record.ackedAtUnixMs) ||
            record.ackedAtUnixMs < 0 || record.claimExpiresAtUnixMs !== null || record.claimEpoch <= 0) {
            fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "ACKed rebased lifecycle is invalid.");
        }
    } else {
        fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "Rebased lifecycle state is invalid.");
    }
    return record;
}

function validateLedgerWrapper(wrapper, contract, requireActiveLease = true) {
    if (!plain(wrapper) || !plain(wrapper.record)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Durable payment ledger wrapper is absent.");
    }
    hash(wrapper.immutableHash, "ledger immutableHash", contract.ledgerImmutableHash);
    const transaction = wrapper.record;
    for (const [label, actual, expected] of [
        ["ledger provider", transaction.provider, contract.provider],
        ["ledger transactionId", transaction.providerTransactionId, contract.providerTransactionId],
        ["ledger player", transaction.playFabId, contract.playFabId],
        ["ledger receipt", transaction.receiptId, contract.receiptId],
        ["ledger SKU", transaction.sku, contract.sku],
        ["ledger state", transaction.state, "Failed"],
        ["ledger plan version", transaction.planVersion, contract.planVersion],
        ["ledger plan hash", transaction.planHash, contract.planHash]
    ]) equal(actual, expected, label);
    const receiptStep = transaction.stepJournal?.receipt_persisted;
    const receiptCheckpoint = transaction.checkpoints?.receipt_persisted;
    const targetStep = transaction.stepJournal?.diamonds_target_granted;
    if (!plain(receiptStep) || receiptStep.status !== "StepApplied" || !plain(receiptCheckpoint) ||
        receiptStep.resultHash !== receiptCheckpoint.resultHash ||
        receiptCheckpoint.result?.receiptId !== contract.receiptId) {
        fail("POC_HISTORICAL_REBASE_RECEIPT_UNTRUSTED", "Immutable xsd2 receipt checkpoint is incomplete.");
    }
    if (!plain(targetStep) || targetStep.status !== "StepPending" || targetStep.resultHash != null ||
        transaction.checkpoints?.diamonds_target_granted || transaction.checkpoints?.profile_granted) {
        fail("POC_HISTORICAL_REBASE_PROVIDER_APPLIED", "Target grant has an applied result/checkpoint.");
    }
    if (requireActiveLease && (transaction.leaseOwner !== contract.ledgerLeaseOwner ||
        typeof transaction.leaseToken !== "string" || transaction.leaseToken.length === 0 ||
        !Number.isSafeInteger(transaction.leaseExpiresAtUnixMs) || transaction.leaseExpiresAtUnixMs <= 0)) {
        fail("POC_HISTORICAL_REBASE_LEDGER_LEASE_REQUIRED",
            "An active dedicated transaction lease is required for metadata rebase.");
    }
    return transaction;
}

function validateProviderGuard(record, contract) {
    if (!plain(record) || !plain(record.intent)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Provider transaction guard is absent.");
    }
    hash(record.immutableHash, "provider guard immutableHash", contract.providerGuardImmutableHash);
    equal(record.identity, contract.providerTransactionId, "provider guard identity");
    equal(record.intent.providerTransactionId, contract.providerTransactionId, "guard transactionId");
    equal(record.intent.playFabId, contract.playFabId, "guard player");
    equal(record.intent.sku, contract.sku, "guard SKU");
    equal(record.intent.operationId, contract.operationId, "guard operationId");
}

function validateEventIndex(record, contract) {
    if (!plain(record) || !plain(record.intent)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Immutable event-index record is absent.");
    }
    hash(record.immutableHash, "event-index immutableHash", contract.eventIndexImmutableHash);
    equal(record.identity, contract.eventIndexIdentity, "event-index identity");
    equal(record.intent.playFabId, contract.playFabId, "event-index player");
    equal(record.intent.eventId, contract.eventId, "event-index eventId");
    equal(record.intent.operationId, contract.operationId, "event-index operationId");
}

function validateTrustedChain(trusted, historicalOperation, contract) {
    if (!plain(trusted) || !plain(trusted.operation) || !plain(trusted.transaction) ||
        !plain(trusted.receipt) || !plain(trusted.product)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Trusted ledger/receipt/plan resolution is incomplete.");
    }
    equal(trusted.transaction.providerTransactionId, contract.providerTransactionId, "trusted transactionId");
    equal(trusted.receipt.providerTransactionId, contract.providerTransactionId, "trusted receipt transactionId");
    equal(trusted.receipt.userId, contract.playFabId, "trusted receipt player");
    equal(trusted.product.sku, contract.sku, "trusted product SKU");
    equal(trusted.product.planVersion, contract.planVersion, "trusted plan version");
    equal(trusted.product.planHash, contract.planHash, "trusted plan hash");
    equal(trusted.operation.operationId, contract.operationId, "trusted operationId");
    equal(trusted.operation.eventId, contract.eventId, "trusted eventId");
    equal(trusted.operation.diamonds, contract.diamondsDelta, "trusted Diamonds intent");
    equal(trusted.operation.playFabId, contract.playFabId, "trusted operation player");
    equal(trusted.operation.kind, "xsolla_entitlement", "trusted operation kind");
    equal(trusted.operation.reason, contract.operationReason, "trusted operation reason");
    equal(trusted.operation.eliteBall, 0, "trusted Elite intent");
    equal(trusted.operation.premium, null, "trusted Premium intent");
    integer(trusted.operation.createdAtUnixMs, "trusted createdAt", contract.operationEffectiveAtUnixMs);
    const currentImmutable = {
        schemaVersion: trusted.operation.schemaVersion,
        kind: trusted.operation.kind,
        playFabId: trusted.operation.playFabId,
        operationId: trusted.operation.operationId,
        eventId: trusted.operation.eventId,
        reason: trusted.operation.reason,
        diamonds: trusted.operation.diamonds,
        eliteBall: trusted.operation.eliteBall,
        premium: trusted.operation.premium,
        createdAtUnixMs: trusted.operation.createdAtUnixMs
    };
    hash(trusted.operation.immutableHash, "trusted current-schema operation hash",
        serverEconomyPocDigest(currentImmutable));
    for (const field of ["playFabId", "operationId", "eventId", "kind", "reason",
        "diamonds", "eliteBall", "premium", "createdAtUnixMs"]) {
        equal(serverEconomyPocDigest(trusted.operation[field]),
            serverEconomyPocDigest(historicalOperation[field]), `trusted/historical ${field}`);
    }
}

function validateRebaseAudit(audit, contract) {
    if (!plain(audit)) {
        fail("POC_HISTORICAL_REBASE_AUDIT_CONFLICT", "Historical rebase audit is absent.");
    }
    const auditBasis = Object.fromEntries(Object.entries(audit)
        .filter(([name]) => name !== "auditHash"));
    hash(audit.auditHash, "historical rebase audit hash", serverEconomyPocDigest(auditBasis));
    for (const [label, actual, expected] of [
        ["audit schema", audit.schemaVersion, 1],
        ["audit kind", audit.kind, REBASE_KIND],
        ["audit Title", audit.titleId, contract.titleId],
        ["audit player", audit.playFabId, contract.playFabId],
        ["audit domain", audit.domain, contract.domain],
        ["audit provider", audit.provider, contract.provider],
        ["audit transaction", audit.providerTransactionId, contract.providerTransactionId],
        ["audit receipt", audit.receiptId, contract.receiptId],
        ["audit SKU", audit.sku, contract.sku],
        ["audit plan version", audit.planVersion, contract.planVersion],
        ["audit plan hash", audit.planHash, contract.planHash],
        ["audit operationId", audit.operationId, contract.operationId],
        ["audit eventId", audit.eventId, contract.eventId],
        ["audit payload hash", audit.payloadHash, contract.operationImmutableHash],
        ["audit original sequence", audit.originalSequence, contract.originalSequence],
        ["audit rebased sequence", audit.rebasedSequence, contract.rebasedSequence],
        ["audit provider cursor", audit.providerCursorAtRebase, contract.providerCursor],
        ["audit Target Diamonds", audit.targetDiamondsAtRebase, contract.targetDiamonds],
        ["audit Target revision", audit.targetRevisionAtRebase, contract.targetRevision],
        ["audit reason", audit.reason, contract.reason]
    ]) equal(actual, expected, label, "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    integer(audit.rebasedAtUnixMs, "audit timestamp");
    hash(audit.evidenceHash, "audit evidence hash");
    hash(audit.originalRecordHash, "audit original record hash");
    hash(audit.certifiedAofSha256, "audit certified AOF hash", contract.persistenceAofSha256);
    if (typeof audit.allocatorMetadataRecovered !== "boolean") {
        fail("POC_HISTORICAL_REBASE_AUDIT_CONFLICT", "Audit allocator recovery marker is invalid.");
    }
    if (audit.allocatorMetadataRecovered) {
        equal(audit.redisSequenceCounterBefore, null, "audit missing Redis counter");
        equal(audit.redisOperationIndexScoreBefore, null, "audit missing Redis index");
    } else {
        equal(audit.redisSequenceCounterBefore, contract.historicalReservedSequence,
            "audit Redis counter");
        equal(audit.redisOperationIndexScoreBefore, contract.originalSequence,
            "audit Redis index");
    }
    serverEconomyPocId(audit.operatorMarker, "audit operator/system marker", 160);
    return audit;
}

function buildDurableRebaseRecords({ originalRecord, audit, contract }) {
    validateOperationRecord(originalRecord, contract, contract.originalSequence);
    validateRebaseAudit(audit, contract);
    const originalRecordHash = serverEconomyPocDigest(originalRecord);
    equal(originalRecordHash, audit.originalRecordHash, "durable original-record hash",
        "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");

    const bindingBasis = {
        schemaVersion: 1,
        kind: ACTIVE_BINDING_KIND,
        rebaseVersion: REBASE_VERSION,
        titleId: contract.titleId,
        playFabId: contract.playFabId,
        domain: contract.domain,
        operationId: contract.operationId,
        transactionId: contract.providerTransactionId,
        payloadHash: contract.operationImmutableHash,
        originalSequence: contract.originalSequence,
        activeSequence: contract.rebasedSequence,
        providerCursorAtRebase: contract.providerCursor,
        reason: contract.reason,
        evidenceHash: audit.evidenceHash,
        rebasedAtUnixMs: audit.rebasedAtUnixMs,
        auditHash: audit.auditHash
    };
    const activeBinding = {
        ...bindingBasis,
        bindingHash: serverEconomyPocDigest(bindingBasis)
    };
    const sequenceRebase = {
        schemaVersion: 2,
        kind: REBASE_KIND,
        rebaseVersion: REBASE_VERSION,
        originalSequence: contract.originalSequence,
        activeSequence: contract.rebasedSequence,
        transactionId: contract.providerTransactionId,
        payloadHash: contract.operationImmutableHash,
        auditHash: audit.auditHash,
        bindingHash: activeBinding.bindingHash
    };
    const activeRecord = {
        ...structuredClone(originalRecord),
        sequence: contract.rebasedSequence,
        originalSequence: contract.originalSequence,
        activeSequence: contract.rebasedSequence,
        sequenceRebase
    };
    const originalArchive = {
        schemaVersion: 2,
        kind: "HistoricalSequenceRebaseArchive",
        rebaseVersion: REBASE_VERSION,
        auditHash: audit.auditHash,
        originalRecordHash,
        originalSequence: contract.originalSequence,
        activeSequence: contract.rebasedSequence,
        originalRecord: structuredClone(originalRecord)
    };
    const journalBasis = {
        schemaVersion: 1,
        kind: REBASE_JOURNAL_KIND,
        rebaseVersion: REBASE_VERSION,
        titleId: contract.titleId,
        playFabId: contract.playFabId,
        domain: contract.domain,
        operationId: contract.operationId,
        transactionId: contract.providerTransactionId,
        receiptId: contract.receiptId,
        payloadHash: contract.operationImmutableHash,
        originalSequence: contract.originalSequence,
        activeSequence: contract.rebasedSequence,
        providerCursorAtRebase: contract.providerCursor,
        reason: contract.reason,
        evidenceHash: audit.evidenceHash,
        rebasedAtUnixMs: audit.rebasedAtUnixMs,
        auditHash: audit.auditHash,
        bindingHash: activeBinding.bindingHash,
        originalRecordHash,
        activeRecordHash: serverEconomyPocDigest(activeRecord),
        archiveHash: serverEconomyPocDigest(originalArchive)
    };
    const rebaseJournal = {
        ...journalBasis,
        journalHash: serverEconomyPocDigest(journalBasis)
    };
    return serverEconomyPocReadonly({
        activeRecord,
        activeBinding,
        originalArchive,
        rebaseJournal
    });
}

function validateDurableRebaseRecords(redisEvidence, contract, audit, archive) {
    if (!plain(redisEvidence.activeBinding) || !plain(redisEvidence.rebaseJournal)) {
        fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_MISSING",
            "Historical rebase binding/journal is absent after persistence.");
    }
    const expected = buildDurableRebaseRecords({
        originalRecord: archive.originalRecord,
        audit,
        contract
    });
    for (const [label, actual, wanted] of [
        ["active sequence binding", redisEvidence.activeBinding, expected.activeBinding],
        ["rebase commit journal", redisEvidence.rebaseJournal, expected.rebaseJournal],
        ["original operation archive", archive, expected.originalArchive]
    ]) {
        equal(serverEconomyPocDigest(actual), serverEconomyPocDigest(wanted), label,
            "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT");
    }
    validateRebasedOperationRecord(redisEvidence.operationRecord, contract,
        expected.activeRecord.sequenceRebase);
    equal(redisEvidence.playerIdentity, contract.playFabId, "Inbox player identity",
        "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT");
    equal(redisEvidence.playerRegistered, true, "Inbox player registry membership",
        "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT");
    equal(redisEvidence.operationIndexScore, contract.rebasedSequence,
        "active operation index", "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT");
    return expected;
}

function validateAlreadyRebasedState(redisEvidence, contract) {
    const audit = validateRebaseAudit(redisEvidence.rebaseAudit, contract);
    const archive = redisEvidence.originalArchive;
    if (!plain(archive) || !plain(archive.originalRecord)) {
        fail("POC_HISTORICAL_REBASE_AUDIT_CONFLICT", "Historical original-record archive is absent.");
    }
    equal(archive.schemaVersion, 2, "archive schema", "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    equal(archive.kind, "HistoricalSequenceRebaseArchive", "archive kind",
        "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    equal(archive.rebaseVersion, REBASE_VERSION, "archive rebase version",
        "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    equal(archive.auditHash, audit.auditHash, "archive audit hash",
        "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    equal(archive.originalRecordHash, audit.originalRecordHash, "archive original hash",
        "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    validateOperationRecord(archive.originalRecord, contract, contract.originalSequence);
    equal(serverEconomyPocDigest(archive.originalRecord), audit.originalRecordHash,
        "archived original-record digest", "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    validateDurableRebaseRecords(redisEvidence, contract, audit, archive);
    integer(redisEvidence.sequenceCounter, "Redis sequence counter");
    if (redisEvidence.sequenceCounter < contract.rebasedSequence) {
        fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT",
            "Redis sequence counter regressed below the active rebased sequence.");
    }
    equal(redisEvidence.operationIndexScore, contract.rebasedSequence,
        "rebased Inbox index score", "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    equal(redisEvidence.rebasedSequenceOccupied, false,
        "rebased sequence uniqueness", "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    equal(redisEvidence.targetOperationDiscovered, true,
        "active operation discovery", "POC_HISTORICAL_REBASE_AUDIT_CONFLICT");
    integer(redisEvidence.rebasedSequenceRecordCount,
        "rebased sequence record count", 1);
    if (audit.allocatorMetadataRecovered) {
        integer(redisEvidence.indexEntryCount, "recovered Inbox index entry count");
        if (redisEvidence.indexEntryCount < 1) {
            fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT", "Recovered Inbox index is empty.");
        }
    }
    return { audit, archive };
}

export function validateHistoricalXsd2SequenceRebaseEvidence({
    evidence,
    contract = CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT,
    requireLedgerLease = true
} = {}) {
    if (typeof requireLedgerLease !== "boolean") {
        throw new TypeError("requireLedgerLease must be boolean.");
    }
    validateContract(contract);
    if (!plain(evidence) || !plain(evidence.redis) || !plain(evidence.provenance)) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Historical rebase evidence is absent.");
    }
    validateProviderEvidence(evidence.provider, contract);
    validateLedgerWrapper(evidence.redis.ledgerWrapper, contract, requireLedgerLease);
    validateProviderGuard(evidence.redis.providerGuardRecord, contract);
    validateEventIndex(evidence.redis.eventIndexRecord, contract);
    if (evidence.redis.resolutionRecord !== null) {
        fail("POC_HISTORICAL_REBASE_RESOLUTION_CONFLICT",
            "A durable gameplay resolution exists; Inbox-only rebase is forbidden.");
    }
    const persistedCommitParts = [
        evidence.redis.rebaseAudit,
        evidence.redis.originalArchive,
        evidence.redis.rebaseJournal,
        evidence.redis.activeBinding
    ];
    const persistedPartCount = persistedCommitParts.filter((value) => value != null).length;
    const auditPresent = persistedPartCount === persistedCommitParts.length;
    if (persistedPartCount !== 0 && !auditPresent) {
        fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT",
            "Historical rebase audit/archive/journal/binding are only partially persisted.");
    }
    let existing = null;
    let allocatorMetadataRecoveryRequired = false;
    if (auditPresent) {
        existing = validateAlreadyRebasedState(evidence.redis, contract);
    } else {
        validateOperationRecord(evidence.redis.operationRecord, contract, contract.originalSequence);
        equal(evidence.redis.rebasedSequenceOccupied, false, "rebased sequence availability");
        const historicalMetadataPresent =
            evidence.redis.sequenceCounter === contract.historicalReservedSequence &&
            evidence.redis.operationIndexScore === contract.originalSequence &&
            evidence.redis.targetOperationDiscovered === true &&
            evidence.redis.pendingInboxOperationCount === 1 &&
            evidence.redis.rebasedSequenceRecordCount === 0;
        const historicalMetadataMissing = evidence.redis.sequenceCounter === null &&
            evidence.redis.operationIndexScore === null && evidence.redis.indexEntryCount === 0 &&
            evidence.redis.targetOperationDiscovered === true &&
            evidence.redis.pendingInboxOperationCount === 1 &&
            evidence.redis.rebasedSequenceRecordCount === 0;
        if (!historicalMetadataPresent && !historicalMetadataMissing) {
            fail("POC_HISTORICAL_REBASE_ALLOCATOR_METADATA_CONFLICT",
                "Redis allocator metadata is mixed, advanced, or cannot be reconstructed exactly.");
        }
        allocatorMetadataRecoveryRequired = historicalMetadataMissing;
    }
    const historicalOperation = existing?.archive.originalRecord.operation ??
        evidence.redis.operationRecord.operation;
    validateTrustedChain(evidence.trusted, historicalOperation, contract);
    hash(evidence.provenance.persistenceDigest, "persistence evidence digest");
    integer(evidence.provenance.totalBytes, "persistence evidence bytes");
    integer(evidence.provenance.fileCount, "persistence evidence file count");
    hash(evidence.provenance.aofSha256, "certified AOF digest", contract.persistenceAofSha256);
    integer(evidence.provenance.aofBytes, "certified AOF bytes", contract.persistenceAofBytes);
    const allocator = evidence.provenance.allocatorHistory;
    if (!plain(allocator) || evidence.provenance.totalBytes === 0 || evidence.provenance.fileCount === 0) {
        fail("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE", "Redis persistence/allocator provenance is incomplete.");
    }
    integer(allocator.counterBeforeAllocation, "historical counter", contract.historicalCounterBeforeAllocation);
    integer(allocator.incrementReservedSequence, "historical reserved sequence", contract.historicalReservedSequence);
    integer(allocator.persistedOperationSequence, "historical persisted sequence", contract.originalSequence);
    integer(allocator.persistedIndexSequence, "historical index sequence", contract.originalSequence);
    equal(allocator.rebasedSequenceRecordAbsent, true, "absence of sequence 3 operation");
    return serverEconomyPocReadonly({
        status: existing ? "already_rebased" : "complete",
        neverApplied: true,
        allocatorBugProven: true,
        orphanedReservationProven: true,
        alreadyRebased: existing !== null,
        allocatorMetadataRecoveryRequired,
        transactionLeaseVerified: requireLedgerLease,
        evidenceHash: existing?.audit.evidenceHash ?? serverEconomyPocDigest(evidence),
        nextSequence: contract.historicalReservedSequence,
        operationImmutableHash: contract.operationImmutableHash
    });
}

export function createHistoricalXsd2SequenceRebasePlan({
    evidence,
    rebasedAtUnixMs,
    operatorMarker,
    contract = CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT
} = {}) {
    const verified = validateHistoricalXsd2SequenceRebaseEvidence({ evidence, contract });
    if (verified.allocatorBugProven !== true || verified.orphanedReservationProven !== true ||
        verified.nextSequence !== contract.rebasedSequence) {
        fail("POC_HISTORICAL_REBASE_NOT_PROVEN", "Historical allocator bug does not prove the orphaned sequence 3 reservation.");
    }
    const timestamp = serverEconomyPocNonNegative(rebasedAtUnixMs, "rebase timestamp");
    const operator = serverEconomyPocId(operatorMarker, "operator/system marker", 160);
    const originalRecord = verified.alreadyRebased
        ? evidence.redis.originalArchive.originalRecord
        : evidence.redis.operationRecord;
    const originalRecordHash = serverEconomyPocDigest(originalRecord);
    const auditBasis = verified.alreadyRebased ? null : {
        schemaVersion: 1,
        kind: REBASE_KIND,
        titleId: contract.titleId,
        playFabId: contract.playFabId,
        domain: contract.domain,
        provider: contract.provider,
        providerTransactionId: contract.providerTransactionId,
        receiptId: contract.receiptId,
        sku: contract.sku,
        planVersion: contract.planVersion,
        planHash: contract.planHash,
        operationId: contract.operationId,
        eventId: contract.eventId,
        payloadHash: contract.operationImmutableHash,
        originalSequence: contract.originalSequence,
        rebasedSequence: contract.rebasedSequence,
        providerCursorAtRebase: contract.providerCursor,
        targetDiamondsAtRebase: contract.targetDiamonds,
        targetRevisionAtRebase: contract.targetRevision,
        reason: contract.reason,
        rebasedAtUnixMs: timestamp,
        evidenceHash: verified.evidenceHash,
        originalRecordHash,
        certifiedAofSha256: contract.persistenceAofSha256,
        allocatorMetadataRecovered: verified.allocatorMetadataRecoveryRequired,
        redisSequenceCounterBefore: evidence.redis.sequenceCounter,
        redisOperationIndexScoreBefore: evidence.redis.operationIndexScore,
        operatorMarker: operator
    };
    const audit = verified.alreadyRebased
        ? structuredClone(evidence.redis.rebaseAudit)
        : { ...auditBasis, auditHash: serverEconomyPocDigest(auditBasis) };
    validateRebaseAudit(audit, contract);
    const persisted = buildDurableRebaseRecords({ originalRecord, audit, contract });
    if (verified.alreadyRebased) {
        validateDurableRebaseRecords(evidence.redis, contract, audit, evidence.redis.originalArchive);
    }
    const raw = plain(evidence.redis.raw) ? evidence.redis.raw : {};
    return serverEconomyPocReadonly({
        schemaVersion: 1,
        kind: REBASE_KIND,
        contract: structuredClone(contract),
        evidenceHash: verified.evidenceHash,
        expectedRedis: {
            operationRecordHash: serverEconomyPocDigest(evidence.redis.operationRecord),
            ledgerWrapperHash: serverEconomyPocDigest(evidence.redis.ledgerWrapper),
            providerGuardRecordHash: serverEconomyPocDigest(evidence.redis.providerGuardRecord),
            eventIndexRecordHash: serverEconomyPocDigest(evidence.redis.eventIndexRecord),
            sequenceCounter: evidence.redis.sequenceCounter,
            operationIndexScore: evidence.redis.operationIndexScore,
            operationRecordJson: raw.operationRecord ?? JSON.stringify(evidence.redis.operationRecord),
            ledgerWrapperJson: raw.ledgerWrapper ?? JSON.stringify(evidence.redis.ledgerWrapper),
            providerGuardRecordJson: raw.providerGuardRecord ?? JSON.stringify(evidence.redis.providerGuardRecord),
            eventIndexRecordJson: raw.eventIndexRecord ?? JSON.stringify(evidence.redis.eventIndexRecord),
            rebaseAuditJson: raw.rebaseAudit ?? (verified.alreadyRebased ? JSON.stringify(audit) : ""),
            originalArchiveJson: raw.originalArchive ??
                (verified.alreadyRebased ? JSON.stringify(evidence.redis.originalArchive) : ""),
            rebaseJournalJson: raw.rebaseJournal ??
                (verified.alreadyRebased ? JSON.stringify(evidence.redis.rebaseJournal) : ""),
            activeBindingJson: raw.activeBinding ??
                (verified.alreadyRebased ? JSON.stringify(evidence.redis.activeBinding) : "")
        },
        allocatorMetadataRecoveryRequired: verified.allocatorMetadataRecoveryRequired,
        originalRecord: structuredClone(originalRecord),
        audit,
        persisted
    });
}

export function historicalSequenceRebaseRedisKeys({
    prefix = DEFAULT_TARGET_PREFIX,
    ledgerPrefix = DEFAULT_LEDGER_PREFIX,
    contract = CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT
} = {}) {
    const playerHash = sha256Hex(contract.playFabId);
    const base = `${prefix}player:${playerHash}:`;
    const operationHash = sha256Hex(contract.operationId);
    const operationNamespace = `${base}inbox:operation:`;
    return Object.freeze({
        playerHash,
        lease: `${prefix}{${playerHash}}:player-lease`,
        operation: `${operationNamespace}${operationHash}`,
        operationNamespace,
        operationPattern: `${operationNamespace}*`,
        sequence: `${base}inbox:sequence`,
        index: `${base}inbox:index`,
        audit: `${base}inbox:historical-rebase:${operationHash}:audit`,
        archive: `${base}inbox:historical-rebase:${operationHash}:original`,
        journal: `${base}inbox:historical-rebase:${operationHash}:commit`,
        activeBinding: `${base}inbox:historical-rebase:${operationHash}:active-binding`,
        playerIdentity: `${base}identity`,
        players: `${prefix}inbox:players`,
        providerGuard: `${prefix}provider-transaction:{${sha256Hex(contract.providerTransactionId)}}`,
        resolution: `${prefix}player:{${playerHash}}:gameplay-resolution:${operationHash}`,
        eventIndex: `${prefix}event-index:{${sha256Hex(contract.eventIndexIdentity)}}`,
        ledger: `${ledgerPrefix}tx:${encodedLedgerIdentity(contract.provider, contract.providerTransactionId)}`
    });
}

const LEGACY_REBASE_LUA = `-- SERVER_ECONOMY_POC_HISTORICAL_SEQUENCE_REBASE_V1
local leaseRaw = redis.call('GET', KEYS[1])
if not leaseRaw then return {'stale_lease'} end
local leaseOk, lease = pcall(cjson.decode, leaseRaw)
if not leaseOk or type(lease) ~= 'table' or lease.schemaVersion ~= 1 or
   lease.playFabId ~= ARGV[1] or lease.tokenDigest ~= ARGV[2] or
   tonumber(lease.epoch) ~= tonumber(ARGV[3]) then return {'stale_lease'} end
local currentTime = redis.call('TIME')
local now = tonumber(currentTime[1]) * 1000 + math.floor(tonumber(currentTime[2]) / 1000)
if tonumber(lease.expiresAtUnixMs or 0) <= now or redis.call('PTTL', KEYS[1]) <= 0 then
  return {'stale_lease'}
end
if redis.call('EXISTS', KEYS[9]) ~= 0 then
  return {'resolution_conflict'}
end

local auditRaw = redis.call('GET', KEYS[5])
if auditRaw then
  local activeRaw = redis.call('GET', KEYS[2])
  local archiveRaw = redis.call('GET', KEYS[6])
  if not activeRaw or not archiveRaw then return {'audit_conflict'} end
  if auditRaw ~= ARGV[9] then return {'audit_conflict'} end
  if ARGV[25] ~= '' or ARGV[26] ~= '' then
    if ARGV[25] == '' or ARGV[26] == '' or auditRaw ~= ARGV[25] or
       archiveRaw ~= ARGV[26] or activeRaw ~= ARGV[17] then return {'audit_conflict'} end
  end
  if tonumber(redis.call('GET', KEYS[3]) or '-1') ~= tonumber(ARGV[7]) or
     tonumber(redis.call('ZSCORE', KEYS[4], KEYS[2]) or '-1') ~= tonumber(ARGV[7]) or
     tonumber(redis.call('ZCOUNT', KEYS[4], ARGV[7], ARGV[7])) ~= 1 then
    return {'audit_conflict'}
  end
  local auditOk, audit = pcall(cjson.decode, auditRaw)
  local activeOk, active = pcall(cjson.decode, activeRaw)
  local archiveOk, archive = pcall(cjson.decode, archiveRaw)
  if not auditOk or not activeOk or not archiveOk or type(audit) ~= 'table' or
     type(active) ~= 'table' or type(active.operation) ~= 'table' or
     type(archive) ~= 'table' or type(archive.originalRecord) ~= 'table' or
     type(archive.originalRecord.operation) ~= 'table' or audit.auditHash ~= ARGV[10] or
     active.schemaVersion ~= 1 or active.playFabId ~= ARGV[1] or
     tonumber(active.sequence) ~= tonumber(ARGV[7]) or active.operationId ~= ARGV[4] or
     active.operation.immutableHash ~= ARGV[5] or active.state ~= 'Pending' or
     active.result ~= cjson.null or active.ackedAtUnixMs ~= cjson.null or
     active.claimOwner ~= cjson.null or active.claimToken ~= cjson.null or
     active.claimExpiresAtUnixMs ~= cjson.null or type(active.sequenceRebase) ~= 'table' or
     active.sequenceRebase.auditHash ~= ARGV[10] or archive.schemaVersion ~= 1 or
     archive.kind ~= 'HistoricalSequenceRebaseArchive' or archive.auditHash ~= ARGV[10] or
     archive.originalRecordHash ~= ARGV[11] or
     archive.originalRecord.playFabId ~= ARGV[1] or
     archive.originalRecord.operationId ~= ARGV[4] or
     tonumber(archive.originalRecord.sequence) ~= tonumber(ARGV[6]) or
     archive.originalRecord.state ~= 'Pending' or
     archive.originalRecord.operation.immutableHash ~= ARGV[5] or
     archive.originalRecord.result ~= cjson.null or
     archive.originalRecord.ackedAtUnixMs ~= cjson.null or
     archive.originalRecord.claimOwner ~= cjson.null or
     archive.originalRecord.claimToken ~= cjson.null or
     archive.originalRecord.claimExpiresAtUnixMs ~= cjson.null then return {'audit_conflict'} end
  local guardRaw = redis.call('GET', KEYS[7])
  local ledgerRaw = redis.call('GET', KEYS[8])
  local eventRaw = redis.call('GET', KEYS[10])
  if guardRaw ~= ARGV[18] or ledgerRaw ~= ARGV[19] or eventRaw ~= ARGV[24] then
    return {'audit_conflict'}
  end
  local guardOk, guard = pcall(cjson.decode, guardRaw)
  local ledgerOk, wrapper = pcall(cjson.decode, ledgerRaw)
  local eventOk, eventRecord = pcall(cjson.decode, eventRaw)
  local transaction = ledgerOk and wrapper and wrapper.record
  local targetStep = transaction and transaction.stepJournal and transaction.stepJournal.diamonds_target_granted
  if not guardOk or type(guard) ~= 'table' or type(guard.intent) ~= 'table' or
     guard.immutableHash ~= ARGV[12] or guard.identity ~= ARGV[13] or
     guard.intent.operationId ~= ARGV[4] or guard.intent.playFabId ~= ARGV[1] or
     not ledgerOk or type(wrapper) ~= 'table' or wrapper.immutableHash ~= ARGV[14] or
     type(transaction) ~= 'table' or transaction.leaseOwner ~= ARGV[20] or
     transaction.leaseToken ~= ARGV[21] or tonumber(transaction.leaseExpiresAtUnixMs or 0) <= now or
     transaction.state ~= 'Failed' or type(targetStep) ~= 'table' or
     targetStep.status ~= 'StepPending' or
     (targetStep.resultHash ~= nil and targetStep.resultHash ~= cjson.null) or
     (transaction.checkpoints and transaction.checkpoints.diamonds_target_granted) or
     (transaction.checkpoints and transaction.checkpoints.profile_granted) or
     not eventOk or type(eventRecord) ~= 'table' or type(eventRecord.intent) ~= 'table' or
     eventRecord.immutableHash ~= ARGV[22] or eventRecord.identity ~= ARGV[23] or
     eventRecord.intent.playFabId ~= ARGV[1] or eventRecord.intent.operationId ~= ARGV[4] then
    return {'audit_conflict'}
  end
  return {'existing', activeRaw, auditRaw, archiveRaw}
elseif ARGV[25] ~= '' or ARGV[26] ~= '' then
  return {'audit_conflict'}
end

local operationRaw = redis.call('GET', KEYS[2])
if not operationRaw or operationRaw ~= ARGV[17] then return {'operation_conflict'} end
local operationOk, record = pcall(cjson.decode, operationRaw)
if not operationOk or type(record) ~= 'table' or record.schemaVersion ~= 1 or
   record.playFabId ~= ARGV[1] or record.operationId ~= ARGV[4] or
   tonumber(record.sequence) ~= tonumber(ARGV[6]) or record.state ~= 'Pending' or
   record.operation.immutableHash ~= ARGV[5] or record.result ~= cjson.null or
   record.ackedAtUnixMs ~= cjson.null or record.claimOwner ~= cjson.null or
   record.claimToken ~= cjson.null or record.claimExpiresAtUnixMs ~= cjson.null then
  return {'operation_conflict'}
end

local guardRaw = redis.call('GET', KEYS[7])
if not guardRaw or guardRaw ~= ARGV[18] then return {'provider_guard_conflict'} end
local guardOk, guard = pcall(cjson.decode, guardRaw)
if not guardOk or type(guard) ~= 'table' or guard.immutableHash ~= ARGV[12] or
   guard.identity ~= ARGV[13] or guard.intent.operationId ~= ARGV[4] or
   guard.intent.playFabId ~= ARGV[1] then return {'provider_guard_conflict'} end

local ledgerRaw = redis.call('GET', KEYS[8])
if not ledgerRaw or ledgerRaw ~= ARGV[19] then return {'ledger_conflict'} end
local ledgerOk, wrapper = pcall(cjson.decode, ledgerRaw)
if not ledgerOk or type(wrapper) ~= 'table' or wrapper.immutableHash ~= ARGV[14] or
   type(wrapper.record) ~= 'table' then return {'ledger_conflict'} end
local transaction = wrapper.record
local targetStep = transaction.stepJournal and transaction.stepJournal.diamonds_target_granted
if transaction.leaseOwner ~= ARGV[20] or transaction.leaseToken ~= ARGV[21] or
   tonumber(transaction.leaseExpiresAtUnixMs or 0) <= now or
   transaction.providerTransactionId ~= ARGV[13] or transaction.playFabId ~= ARGV[1] or
   transaction.receiptId ~= ARGV[15] or transaction.planHash ~= ARGV[16] or
   transaction.state ~= 'Failed' or type(targetStep) ~= 'table' or
   targetStep.status ~= 'StepPending' or
   (targetStep.resultHash ~= nil and targetStep.resultHash ~= cjson.null) or
   (transaction.checkpoints and transaction.checkpoints.diamonds_target_granted) or
   (transaction.checkpoints and transaction.checkpoints.profile_granted) then
  return {'ledger_conflict'}
end

local eventRaw = redis.call('GET', KEYS[10])
if not eventRaw or eventRaw ~= ARGV[24] then return {'event_index_conflict'} end
local eventOk, eventRecord = pcall(cjson.decode, eventRaw)
if not eventOk or type(eventRecord) ~= 'table' or eventRecord.immutableHash ~= ARGV[22] or
   eventRecord.identity ~= ARGV[23] or eventRecord.intent.playFabId ~= ARGV[1] or
   eventRecord.intent.operationId ~= ARGV[4] then return {'event_index_conflict'} end

local counterRaw = redis.call('GET', KEYS[3])
local currentScoreRaw = redis.call('ZSCORE', KEYS[4], KEYS[2])
local indexSize = tonumber(redis.call('ZCARD', KEYS[4]))
local providerCursor = tonumber(ARGV[8])
local requestedSequence = tonumber(ARGV[7])
local recoverAllocatorMetadata = ARGV[27] == '1'
if tonumber(redis.call('ZCOUNT', KEYS[4], requestedSequence, requestedSequence)) ~= 0 then
  return {'sequence_occupied'}
end
if providerCursor + 1 ~= requestedSequence then
  return {'next_sequence_mismatch'}
end
if recoverAllocatorMetadata then
  if counterRaw or currentScoreRaw or indexSize ~= 0 then
    return {'allocator_metadata_conflict'}
  end
else
  local counter = tonumber(counterRaw or '')
  local currentScore = tonumber(currentScoreRaw or '')
  if not counter or counter < 0 or counter ~= math.floor(counter) then
    return {'sequence_advanced'}
  end
  if counter ~= requestedSequence then return {'next_sequence_mismatch'} end
  if currentScore ~= tonumber(ARGV[6]) then return {'index_conflict'} end
end

local audit = cjson.decode(ARGV[9])
local originalRecord = cjson.decode(operationRaw)
local archive = {schemaVersion=1, kind='HistoricalSequenceRebaseArchive',
  auditHash=ARGV[10], originalRecordHash=ARGV[11], originalRecord=originalRecord}
record.sequence = requestedSequence
record.sequenceRebase = audit
local activeRaw = cjson.encode(record)
local archiveEncoded = cjson.encode(archive)

if recoverAllocatorMetadata then
  redis.call('SET', KEYS[3], requestedSequence)
end
redis.call('ZREM', KEYS[4], KEYS[2])
redis.call('ZADD', KEYS[4], requestedSequence, KEYS[2])
redis.call('SET', KEYS[6], archiveEncoded)
redis.call('SET', KEYS[5], ARGV[9])
redis.call('SET', KEYS[2], activeRaw)
return {'rebased', activeRaw, ARGV[9], archiveEncoded}
`;

const REBASE_LUA = `-- SERVER_ECONOMY_POC_HISTORICAL_SEQUENCE_REBASE_V2
local leaseRaw = redis.call('GET', KEYS[1])
if not leaseRaw then return {'stale_lease'} end
local leaseOk, lease = pcall(cjson.decode, leaseRaw)
if not leaseOk or type(lease) ~= 'table' or lease.schemaVersion ~= 1 or
   lease.playFabId ~= ARGV[1] or lease.tokenDigest ~= ARGV[2] or
   tonumber(lease.epoch) ~= tonumber(ARGV[3]) then return {'stale_lease'} end
local currentTime = redis.call('TIME')
local now = tonumber(currentTime[1]) * 1000 + math.floor(tonumber(currentTime[2]) / 1000)
if tonumber(lease.expiresAtUnixMs or 0) <= now or redis.call('PTTL', KEYS[1]) <= 0 then
  return {'stale_lease'}
end
local function trusted_chain_valid()
  local guardRaw = redis.call('GET', KEYS[11])
  local ledgerRaw = redis.call('GET', KEYS[12])
  local eventRaw = redis.call('GET', KEYS[14])
  if guardRaw ~= ARGV[18] or ledgerRaw ~= ARGV[19] or eventRaw ~= ARGV[24] then return false end
  local guardOk, guard = pcall(cjson.decode, guardRaw)
  local ledgerOk, wrapper = pcall(cjson.decode, ledgerRaw)
  local eventOk, eventRecord = pcall(cjson.decode, eventRaw)
  local transaction = ledgerOk and wrapper and wrapper.record
  local targetStep = transaction and transaction.stepJournal and transaction.stepJournal.diamonds_target_granted
  return guardOk and type(guard) == 'table' and type(guard.intent) == 'table' and
    guard.immutableHash == ARGV[12] and guard.identity == ARGV[13] and
    guard.intent.operationId == ARGV[4] and guard.intent.playFabId == ARGV[1] and
    ledgerOk and type(wrapper) == 'table' and wrapper.immutableHash == ARGV[14] and
    type(transaction) == 'table' and transaction.leaseOwner == ARGV[20] and
    transaction.leaseToken == ARGV[21] and tonumber(transaction.leaseExpiresAtUnixMs or 0) > now and
    transaction.state == 'Failed' and type(targetStep) == 'table' and
    targetStep.status == 'StepPending' and
    (targetStep.resultHash == nil or targetStep.resultHash == cjson.null) and
    not (transaction.checkpoints and transaction.checkpoints.diamonds_target_granted) and
    not (transaction.checkpoints and transaction.checkpoints.profile_granted) and
    eventOk and type(eventRecord) == 'table' and type(eventRecord.intent) == 'table' and
    eventRecord.immutableHash == ARGV[22] and eventRecord.identity == ARGV[23] and
    eventRecord.intent.playFabId == ARGV[1] and eventRecord.intent.operationId == ARGV[4]
end

local auditRaw = redis.call('GET', KEYS[5])
local archiveRaw = redis.call('GET', KEYS[6])
local journalRaw = redis.call('GET', KEYS[7])
local bindingRaw = redis.call('GET', KEYS[8])
if auditRaw or archiveRaw or journalRaw or bindingRaw then
  local activeRaw = redis.call('GET', KEYS[2])
  if auditRaw ~= ARGV[9] or archiveRaw ~= ARGV[33] or journalRaw ~= ARGV[28] or
     bindingRaw ~= ARGV[30] or not activeRaw then return {'durable_commit_conflict'} end
  local activeOk, active = pcall(cjson.decode, activeRaw)
  local lifecycleOk = activeOk and type(active) == 'table' and type(active.operation) == 'table' and
    active.schemaVersion == 1 and active.playFabId == ARGV[1] and active.operationId == ARGV[4] and
    active.operation.immutableHash == ARGV[5] and tonumber(active.sequence) == tonumber(ARGV[7]) and
    tonumber(active.originalSequence) == tonumber(ARGV[6]) and
    tonumber(active.activeSequence) == tonumber(ARGV[7]) and type(active.sequenceRebase) == 'table' and
    active.sequenceRebase.auditHash == ARGV[10] and active.sequenceRebase.bindingHash == ARGV[31]
  if lifecycleOk and active.state == 'Pending' then
    lifecycleOk = active.result == cjson.null and active.ackedAtUnixMs == cjson.null and
      active.claimOwner == cjson.null and active.claimToken == cjson.null and
      active.claimExpiresAtUnixMs == cjson.null
  elseif lifecycleOk and active.state == 'Claimed' then
    lifecycleOk = active.result == cjson.null and active.ackedAtUnixMs == cjson.null and
      type(active.claimOwner) == 'string' and type(active.claimToken) == 'string' and
      tonumber(active.claimExpiresAtUnixMs or 0) > 0 and tonumber(active.claimEpoch or 0) > 0
  elseif lifecycleOk and active.state == 'Acked' then
    lifecycleOk = active.result ~= cjson.null and tonumber(active.ackedAtUnixMs or -1) >= 0 and
      active.claimExpiresAtUnixMs == cjson.null and tonumber(active.claimEpoch or 0) > 0
  else
    lifecycleOk = false
  end
  local persistedCounter = tonumber(redis.call('GET', KEYS[3]) or '')
  if not lifecycleOk or not persistedCounter or persistedCounter ~= math.floor(persistedCounter) or
     persistedCounter < tonumber(ARGV[7]) or
     tonumber(redis.call('ZSCORE', KEYS[4], KEYS[2]) or '-1') ~= tonumber(ARGV[7]) or
     tonumber(redis.call('ZCOUNT', KEYS[4], ARGV[7], ARGV[7])) ~= 1 or
     redis.call('GET', KEYS[9]) ~= ARGV[1] or
     tonumber(redis.call('SISMEMBER', KEYS[10], ARGV[34])) ~= 1 then
    return {'durable_commit_conflict'}
  end
  return {'existing', activeRaw, auditRaw, archiveRaw, journalRaw, bindingRaw}
end

if redis.call('EXISTS', KEYS[13]) ~= 0 then return {'resolution_conflict'} end
if not trusted_chain_valid() then return {'trusted_chain_conflict'} end

local operationRaw = redis.call('GET', KEYS[2])
if not operationRaw or operationRaw ~= ARGV[17] then return {'operation_conflict'} end
local operationOk, original = pcall(cjson.decode, operationRaw)
if not operationOk or type(original) ~= 'table' or original.schemaVersion ~= 1 or
   original.playFabId ~= ARGV[1] or original.operationId ~= ARGV[4] or
   tonumber(original.sequence) ~= tonumber(ARGV[6]) or original.state ~= 'Pending' or
   type(original.operation) ~= 'table' or original.operation.immutableHash ~= ARGV[5] or
   original.result ~= cjson.null or original.ackedAtUnixMs ~= cjson.null or
   original.claimOwner ~= cjson.null or original.claimToken ~= cjson.null or
   original.claimExpiresAtUnixMs ~= cjson.null then return {'operation_conflict'} end

local counterRaw = redis.call('GET', KEYS[3])
local scoreRaw = redis.call('ZSCORE', KEYS[4], KEYS[2])
local indexSize = tonumber(redis.call('ZCARD', KEYS[4]))
local requestedSequence = tonumber(ARGV[7])
local recoverMetadata = ARGV[27] == '1'
if tonumber(ARGV[8]) + 1 ~= requestedSequence then return {'next_sequence_mismatch'} end
if tonumber(redis.call('ZCOUNT', KEYS[4], requestedSequence, requestedSequence)) ~= 0 then
  return {'sequence_occupied'}
end
if recoverMetadata then
  if counterRaw or scoreRaw or indexSize ~= 0 then return {'allocator_metadata_conflict'} end
else
  if tonumber(counterRaw or '-1') ~= requestedSequence then return {'next_sequence_mismatch'} end
  if tonumber(scoreRaw or '-1') ~= tonumber(ARGV[6]) then return {'index_conflict'} end
end
local identity = redis.call('GET', KEYS[9])
if identity and identity ~= ARGV[1] then return {'identity_conflict'} end

local activeOk, active = pcall(cjson.decode, ARGV[32])
local archiveOk, archive = pcall(cjson.decode, ARGV[33])
local journalOk, journal = pcall(cjson.decode, ARGV[28])
local bindingOk, binding = pcall(cjson.decode, ARGV[30])
if not activeOk or not archiveOk or not journalOk or not bindingOk or
   type(active) ~= 'table' or type(archive) ~= 'table' or
   type(journal) ~= 'table' or type(binding) ~= 'table' or
   active.operationId ~= ARGV[4] or active.operation.immutableHash ~= ARGV[5] or
   tonumber(active.sequence) ~= requestedSequence or
   tonumber(active.originalSequence) ~= tonumber(ARGV[6]) or
   tonumber(active.activeSequence) ~= requestedSequence or
   type(active.sequenceRebase) ~= 'table' or active.sequenceRebase.auditHash ~= ARGV[10] or
   active.sequenceRebase.bindingHash ~= ARGV[31] or
   archive.kind ~= 'HistoricalSequenceRebaseArchive' or archive.auditHash ~= ARGV[10] or
   archive.originalRecordHash ~= ARGV[11] or tonumber(archive.originalSequence) ~= tonumber(ARGV[6]) or
   tonumber(archive.activeSequence) ~= requestedSequence or
   journal.kind ~= 'HistoricalSequenceRebaseCommit' or journal.journalHash ~= ARGV[29] or
   journal.auditHash ~= ARGV[10] or journal.bindingHash ~= ARGV[31] or
   tonumber(journal.originalSequence) ~= tonumber(ARGV[6]) or
   tonumber(journal.activeSequence) ~= requestedSequence or
   binding.kind ~= 'HistoricalSequenceActiveBinding' or binding.bindingHash ~= ARGV[31] or
   binding.auditHash ~= ARGV[10] or tonumber(binding.originalSequence) ~= tonumber(ARGV[6]) or
   tonumber(binding.activeSequence) ~= requestedSequence then return {'durable_payload_invalid'} end

if recoverMetadata then redis.call('SET', KEYS[3], requestedSequence) end
redis.call('ZREM', KEYS[4], KEYS[2])
redis.call('ZADD', KEYS[4], requestedSequence, KEYS[2])
redis.call('SET', KEYS[9], ARGV[1])
redis.call('SADD', KEYS[10], ARGV[34])
redis.call('SET', KEYS[6], ARGV[33])
redis.call('SET', KEYS[5], ARGV[9])
redis.call('SET', KEYS[8], ARGV[30])
redis.call('SET', KEYS[7], ARGV[28])
redis.call('SET', KEYS[2], ARGV[32])
return {'rebased', ARGV[32], ARGV[9], ARGV[33], ARGV[28], ARGV[30]}
`;

function tokenDigest(token) {
    return sha256Hex(serverEconomyPocId(token, "rebase lease token", 255));
}

export function createRedisHistoricalXsd2SequenceRebaser({
    redis,
    prefix = DEFAULT_TARGET_PREFIX,
    ledgerPrefix = DEFAULT_LEDGER_PREFIX,
    contract = CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT,
    verifyProviderPrecommit = null
} = {}) {
    if (typeof redis?.sendCommand !== "function") {
        throw new TypeError("Historical sequence rebase requires Redis sendCommand.");
    }
    validateContract(contract);
    if (verifyProviderPrecommit !== null && typeof verifyProviderPrecommit !== "function") {
        throw new TypeError("Provider precommit verifier must be a function.");
    }
    serverEconomyPocId(prefix, "Target Redis prefix", 160);
    serverEconomyPocId(ledgerPrefix, "ledger Redis prefix", 200);
    const keys = historicalSequenceRebaseRedisKeys({ prefix, ledgerPrefix, contract });

    async function inspect() {
        const values = await redis.sendCommand([
            "MGET", keys.operation, keys.sequence, keys.audit, keys.archive,
            keys.journal, keys.activeBinding, keys.playerIdentity,
            keys.providerGuard, keys.ledger, keys.resolution, keys.eventIndex
        ]);
        if (!Array.isArray(values) || values.length !== 11) {
            fail("POC_HISTORICAL_REBASE_REDIS_PROTOCOL", "Historical rebase MGET returned invalid data.");
        }
        const playerRegisteredRaw = await redis.sendCommand([
            "SISMEMBER", keys.players, keys.playerHash
        ]);
        const playerRegistered = Number(playerRegisteredRaw) === 1;
        const indexed = await redis.sendCommand(["ZRANGE", keys.index, "0", "-1", "WITHSCORES"]);
        if (!Array.isArray(indexed) || indexed.length % 2 !== 0) {
            fail("POC_HISTORICAL_REBASE_REDIS_PROTOCOL", "Historical rebase Inbox index is invalid.");
        }
        const operationKeys = new Set();
        let cursor = "0";
        do {
            const page = await redis.sendCommand([
                "SCAN", cursor, "MATCH", keys.operationPattern, "COUNT", "100"
            ]);
            if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) {
                fail("POC_HISTORICAL_REBASE_REDIS_PROTOCOL",
                    "Historical rebase Inbox operation scan is invalid.");
            }
            cursor = String(page[0]);
            for (const key of page[1]) operationKeys.add(String(key));
        } while (cursor !== "0");
        const discoveredKeys = [...operationKeys].sort();
        const operationValues = discoveredKeys.length > 0
            ? await redis.sendCommand(["MGET", ...discoveredKeys])
            : [];
        if (!Array.isArray(operationValues) || operationValues.length !== discoveredKeys.length) {
            fail("POC_HISTORICAL_REBASE_REDIS_PROTOCOL",
                "Historical rebase Inbox operation read is invalid.");
        }
        let pendingInboxOperationCount = 0;
        let rebasedSequenceRecordCount = 0;
        for (let index = 0; index < operationValues.length; index += 1) {
            const record = parseJson(operationValues[index], "discovered Inbox operation");
            if (!plain(record) || !Number.isSafeInteger(record.sequence) || typeof record.state !== "string") {
                fail("POC_HISTORICAL_REBASE_REDIS_PROTOCOL",
                    "Historical rebase discovered an invalid Inbox operation.");
            }
            if (record.state === "Pending") pendingInboxOperationCount += 1;
            if (record.sequence === contract.rebasedSequence) rebasedSequenceRecordCount += 1;
        }
        let operationIndexScore = null;
        let rebasedSequenceOccupied = false;
        for (let index = 0; index < indexed.length; index += 2) {
            const score = Number(indexed[index + 1]);
            if (indexed[index] === keys.operation) operationIndexScore = score;
            else if (score === contract.rebasedSequence) rebasedSequenceOccupied = true;
        }
        return serverEconomyPocReadonly({
            operationRecord: parseJson(values[0], "historical Inbox record"),
            sequenceCounter: values[1] === null ? null : Number(values[1]),
            rebaseAudit: parseJson(values[2], "historical rebase audit"),
            originalArchive: parseJson(values[3], "historical rebase archive"),
            rebaseJournal: parseJson(values[4], "historical rebase commit journal"),
            activeBinding: parseJson(values[5], "historical active sequence binding"),
            playerIdentity: values[6],
            playerRegistered,
            providerGuardRecord: parseJson(values[7], "provider transaction guard"),
            ledgerWrapper: parseJson(values[8], "payment ledger wrapper"),
            resolutionRecord: parseJson(values[9], "gameplay resolution"),
            eventIndexRecord: parseJson(values[10], "event-index record"),
            raw: Object.freeze({
                operationRecord: values[0], providerGuardRecord: values[7],
                ledgerWrapper: values[8], eventIndexRecord: values[10],
                rebaseAudit: values[2], originalArchive: values[3],
                rebaseJournal: values[4], activeBinding: values[5]
            }),
            operationIndexScore,
            rebasedSequenceOccupied,
            indexEntryCount: indexed.length / 2,
            inboxOperationCount: discoveredKeys.length,
            pendingInboxOperationCount,
            rebasedSequenceRecordCount,
            targetOperationDiscovered: operationKeys.has(keys.operation)
        });
    }

    async function rebase({ plan, playerLeaseToken, playerFencingEpoch, ledgerLeaseToken } = {}) {
        const auditBasis = plain(plan?.audit)
            ? Object.fromEntries(Object.entries(plan.audit).filter(([name]) => name !== "auditHash"))
            : null;
        if (!plain(plan) || plan.kind !== REBASE_KIND ||
            serverEconomyPocDigest(plan.contract) !== serverEconomyPocDigest(contract) ||
            !auditBasis || plan.audit.auditHash !== serverEconomyPocDigest(auditBasis)) {
            fail("POC_HISTORICAL_REBASE_PLAN_INVALID", "Historical sequence rebase plan is invalid.");
        }
        const epoch = serverEconomyPocPositive(playerFencingEpoch, "rebase fencing epoch");
        const transactionToken = serverEconomyPocId(ledgerLeaseToken, "rebase ledger lease token", 255);
        const persisted = plan.persisted;
        if (!plain(persisted?.activeRecord) || !plain(persisted?.activeBinding) ||
            !plain(persisted?.originalArchive) || !plain(persisted?.rebaseJournal)) {
            fail("POC_HISTORICAL_REBASE_PLAN_INVALID", "Durable historical rebase records are absent.");
        }
        const expectedPersisted = buildDurableRebaseRecords({
            originalRecord: plan.originalRecord,
            audit: plan.audit,
            contract
        });
        for (const [label, actual, expected] of [
            ["active record", persisted.activeRecord, expectedPersisted.activeRecord],
            ["active binding", persisted.activeBinding, expectedPersisted.activeBinding],
            ["original archive", persisted.originalArchive, expectedPersisted.originalArchive],
            ["rebase journal", persisted.rebaseJournal, expectedPersisted.rebaseJournal]
        ]) {
            if (serverEconomyPocDigest(actual) !== serverEconomyPocDigest(expected)) {
                fail("POC_HISTORICAL_REBASE_PLAN_INVALID", `Historical sequence ${label} was modified.`);
            }
        }
        for (const [label, json, expectedHash] of [
            ["operation", plan.expectedRedis?.operationRecordJson,
                plan.expectedRedis?.operationRecordHash],
            ["provider guard", plan.expectedRedis?.providerGuardRecordJson,
                plan.expectedRedis?.providerGuardRecordHash],
            ["payment ledger", plan.expectedRedis?.ledgerWrapperJson,
                plan.expectedRedis?.ledgerWrapperHash],
            ["event index", plan.expectedRedis?.eventIndexRecordJson,
                plan.expectedRedis?.eventIndexRecordHash]
        ]) {
            const parsed = typeof json === "string" ? parseJson(json, `planned ${label}`) : null;
            if (!plain(parsed) || serverEconomyPocDigest(parsed) !== expectedHash) {
                fail("POC_HISTORICAL_REBASE_PLAN_INVALID", `Historical sequence ${label} prestate is invalid.`);
            }
        }
        if (verifyProviderPrecommit !== null) {
            const provider = await verifyProviderPrecommit({
                contract,
                plan,
                playerLeaseToken,
                playerFencingEpoch: epoch
            });
            if (!plain(provider) || provider.titleId !== contract.titleId ||
                provider.playFabId !== contract.playFabId || provider.operationId !== contract.operationId ||
                provider.operationHash !== contract.operationImmutableHash ||
                provider.diamonds !== contract.targetDiamonds || provider.revision !== contract.targetRevision ||
                provider.cursor !== contract.providerCursor || provider.proofAbsent !== true) {
                fail("POC_HISTORICAL_REBASE_PROVIDER_CHANGED",
                    "Provider state changed before the atomic Redis rebase commit.");
            }
        }
        const response = await redis.sendCommand([
            "EVAL", REBASE_LUA, "14",
            keys.lease, keys.operation, keys.sequence, keys.index, keys.audit, keys.archive,
            keys.journal, keys.activeBinding, keys.playerIdentity, keys.players,
            keys.providerGuard, keys.ledger, keys.resolution, keys.eventIndex,
            contract.playFabId, tokenDigest(playerLeaseToken), String(epoch), contract.operationId,
            contract.operationImmutableHash, String(contract.originalSequence),
            String(contract.rebasedSequence), String(contract.providerCursor),
            JSON.stringify(plan.audit), plan.audit.auditHash,
            plan.audit.originalRecordHash, contract.providerGuardImmutableHash,
            contract.providerTransactionId, contract.ledgerImmutableHash,
            contract.receiptId, contract.planHash,
            plan.expectedRedis.operationRecordJson,
            plan.expectedRedis.providerGuardRecordJson,
            plan.expectedRedis.ledgerWrapperJson,
            contract.ledgerLeaseOwner, transactionToken,
            contract.eventIndexImmutableHash, contract.eventIndexIdentity,
            plan.expectedRedis.eventIndexRecordJson,
            plan.expectedRedis.rebaseAuditJson,
            plan.expectedRedis.originalArchiveJson,
            plan.allocatorMetadataRecoveryRequired ? "1" : "0",
            JSON.stringify(persisted.rebaseJournal), persisted.rebaseJournal.journalHash,
            JSON.stringify(persisted.activeBinding), persisted.activeBinding.bindingHash,
            JSON.stringify(persisted.activeRecord), JSON.stringify(persisted.originalArchive),
            keys.playerHash,
            plan.expectedRedis.rebaseJournalJson,
            plan.expectedRedis.activeBindingJson
        ]);
        if (!Array.isArray(response) || typeof response[0] !== "string") {
            fail("POC_HISTORICAL_REBASE_REDIS_PROTOCOL", "Historical rebase Lua returned invalid data.");
        }
        if (response[0] === "stale_lease") {
            fail("POC_STALE_WRITER", "Historical rebase candidate lease is stale.", { retryable: true });
        }
        if (!["rebased", "existing"].includes(response[0])) {
            const codes = {
                audit_conflict: "POC_HISTORICAL_REBASE_AUDIT_CONFLICT",
                operation_conflict: "POC_HISTORICAL_REBASE_OPERATION_CONFLICT",
                provider_guard_conflict: "POC_HISTORICAL_REBASE_PROVIDER_GUARD_CONFLICT",
                ledger_conflict: "POC_HISTORICAL_REBASE_LEDGER_CONFLICT",
                sequence_advanced: "POC_HISTORICAL_REBASE_SEQUENCE_ADVANCED",
                index_conflict: "POC_HISTORICAL_REBASE_INDEX_CONFLICT",
                sequence_occupied: "POC_HISTORICAL_REBASE_SEQUENCE_OCCUPIED",
                next_sequence_mismatch: "POC_HISTORICAL_REBASE_NEXT_SEQUENCE_MISMATCH",
                allocator_metadata_conflict: "POC_HISTORICAL_REBASE_ALLOCATOR_METADATA_CONFLICT",
                durable_commit_conflict: "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT",
                durable_payload_invalid: "POC_HISTORICAL_REBASE_DURABLE_PAYLOAD_INVALID",
                identity_conflict: "POC_HISTORICAL_REBASE_IDENTITY_CONFLICT",
                trusted_chain_conflict: "POC_HISTORICAL_REBASE_TRUSTED_CHAIN_CONFLICT",
                resolution_conflict: "POC_HISTORICAL_REBASE_RESOLUTION_CONFLICT",
                event_index_conflict: "POC_HISTORICAL_REBASE_EVENT_INDEX_CONFLICT"
            };
            fail(codes[response[0]] || "POC_HISTORICAL_REBASE_REDIS_CONFLICT",
                `Historical sequence rebase was refused (${response[0]}).`);
        }
        const aof = await redis.sendCommand([
            "WAITAOF", "1", "0", String(DURABILITY_TIMEOUT_MILLISECONDS)
        ]);
        if (!Array.isArray(aof) || Number(aof[0]) < 1) {
            fail("POC_HISTORICAL_REBASE_DURABILITY_UNCONFIRMED",
                "Redis did not confirm local AOF fsync for the historical rebase.", { retryable: true });
        }
        const readback = await inspect();
        const verified = validateAlreadyRebasedState(readback, contract);
        return serverEconomyPocReadonly({
            status: response[0] === "rebased" ? "rebased" : "already_rebased",
            activeRecord: readback.operationRecord,
            audit: verified.audit,
            originalArchive: verified.archive,
            rebaseJournal: readback.rebaseJournal,
            activeBinding: readback.activeBinding,
            durability: Object.freeze({ aofLocalFsync: true, localAofAcknowledgements: Number(aof[0]) }),
            providerMutation: false,
            economicMutation: false
        });
    }

    async function hydrate() {
        const readback = await inspect();
        const parts = [readback.rebaseAudit, readback.originalArchive,
            readback.rebaseJournal, readback.activeBinding];
        if (parts.every((value) => value === null)) {
            return serverEconomyPocReadonly({ status: "not_rebased", readback });
        }
        if (parts.some((value) => value === null)) {
            fail("POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT",
                "Startup found a partial historical rebase commit.");
        }
        validateAlreadyRebasedState(readback, contract);
        return serverEconomyPocReadonly({
            status: "hydrated",
            originalSequence: readback.operationRecord.originalSequence,
            activeSequence: readback.operationRecord.activeSequence,
            operation: readback.operationRecord,
            audit: readback.rebaseAudit,
            journal: readback.rebaseJournal,
            binding: readback.activeBinding
        });
    }

    return Object.freeze({
        inspect,
        rebase,
        hydrate,
        keys,
        contract,
        metadataOnly: true,
        providerMutation: false,
        atomicRedisLua: true,
        preservesOriginalRecord: true,
        aofFsyncBeforeAck: true,
        restartHydrationFailClosed: true
    });
}

export const SERVER_ECONOMY_POC_HISTORICAL_SEQUENCE_REBASE_LUA = REBASE_LUA;
