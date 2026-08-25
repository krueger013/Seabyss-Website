import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
    createCanary02V2BootstrapImportPlan,
    extractCertifiedCanary02V2BootstrapEvidence
} from "../src/financial-canary-redis-v2-bootstrap.js";

const aofPath = process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, "SeabyssCodex", "financial-canary-memurai", "canary02",
        "runtime", "data", "appendonlydir", "financial-canary.aof.1.incr.aof")
    : "";
const hasEvidence = aofPath.length > 0 && existsSync(aofPath);

test("certified legacy AOF extracts only the exact Canary_02 import records", {
    skip: !hasEvidence
}, () => {
    const evidence = extractCertifiedCanary02V2BootstrapEvidence(readFileSync(aofPath));
    assert.equal(evidence.certifiedPrefixSha256,
        "62c876d5f10395d37ecbda0d337746deca93e1b91b60d1402af380a135123300");
    assert.equal(evidence.evidenceRedis.operationRecord.sequence, 1);
    assert.equal(evidence.evidenceRedis.operationRecord.state, "Pending");
    assert.equal(evidence.evidenceRedis.sequenceCounter, 3);
    assert.equal(evidence.evidenceRedis.pendingInboxOperationCount, 1);
    assert.equal(evidence.evidenceRedis.ledgerWrapper.record.state, "Failed");
    assert.equal(evidence.strings.length, 13);
    assert.equal(evidence.zsets.length, 6);
    assert.equal(evidence.sets.length, 1);
});

test("certified legacy AOF tampering fails closed", { skip: !hasEvidence }, () => {
    const tampered = Buffer.from(readFileSync(aofPath));
    tampered[100] ^= 1;
    assert.throws(() => extractCertifiedCanary02V2BootstrapEvidence(tampered),
        (error) => error.code === "FINANCIAL_CANARY_V2_AOF_MISMATCH");
});

test("V2 import plan is deterministic and binds provider attestation to one dataset", {
    skip: !hasEvidence
}, () => {
    const historical = extractCertifiedCanary02V2BootstrapEvidence(readFileSync(aofPath));
    const datasetBinding = {
        schemaVersion: 2,
        sandboxTitleId: "1D0C16",
        canaryPlayFabId: "C5BD37AA141B3C4E",
        environment: "sandbox",
        runtimeId: "canary02-v2-runtime-test",
        datasetId: "canary02-v2-dataset-test",
        bindingHash: "a".repeat(64)
    };
    const providerAttestation = {
        schemaVersion: 1,
        kind: "Canary02PlayFabProviderAttestation",
        titleId: "1D0C16",
        playFabId: "C5BD37AA141B3C4E",
        targetDiamonds: 15,
        targetRevision: 3,
        providerCursor: 2,
        migrationProofSchemaVersion: 2,
        targetOnlyOperationCount: 2,
        spend10ProofVerified: true,
        xsd2ProofMissing: true,
        providerStateDigest: "b".repeat(64),
        receiptDigest: "c".repeat(64)
    };
    const first = createCanary02V2BootstrapImportPlan({
        historical, providerAttestation, datasetBinding, importedAtUnixMs: 123
    });
    const second = createCanary02V2BootstrapImportPlan({
        historical, providerAttestation, datasetBinding, importedAtUnixMs: 123
    });
    assert.deepEqual(second, first);
    assert.equal(first.journal.originalXsd2Sequence, 1);
    assert.equal(first.journal.targetSequenceCursor, 2);
    assert.equal(first.journal.orphanedReservedSequence, 3);
    assert.equal(first.journal.bindingHash, datasetBinding.bindingHash);
});
