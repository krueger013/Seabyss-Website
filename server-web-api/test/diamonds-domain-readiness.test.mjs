import assert from "node:assert/strict";
import test from "node:test";

import { createDiamondsDomainReadinessCertificate } from "../src/diamonds-domain-readiness.js";
import {
    createFinancialDomainReadinessCertificate,
    validateFinancialDomainReadinessCertificate
} from
    "../src/progressive-financial-domain-migration.js";
import { DIAMONDS_DOMAIN_TARGET_ADAPTER_VERSION } from
    "../src/diamonds-domain-target-adapter.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function evidence(overrides = {}) {
    return {
        liveScan: {
            domain: "Diamonds",
            readyForCanary: true,
            forbiddenRouteCount: 0,
            scannerDigest: HASH_A,
            counts: { intentional_legacy_adapter: 3, migration_only: 4,
                forbidden_direct_access: 0 }
        },
        sandboxDryRun: {
            readOnly: true,
            sandboxTitleId: "1D0C16",
            playFabId: "61AD15CDA4137EA9",
            providerUnchanged: true,
            providerWriteCount: 0,
            providerBeforeDigest: HASH_B,
            providerAfterDigest: HASH_B,
            planHash: HASH_C,
            conflictState: "ready"
        },
        targetHealth: {
            targetAdapterComposed: true,
            targetHealthy: true,
            identityVerified: true,
            redisHealthy: true,
            playFabHealthy: true,
            snapshotReadHealthy: true,
            casSupported: true,
            zeroPendingPayment: true,
            rollbackAvailable: true
        },
        testDigest: "d".repeat(64),
        issuedAtUtc: "2026-08-24T10:00:00.000Z",
        expiresAtUtc: "2026-08-25T10:00:00.000Z",
        ...overrides
    };
}

function canaryConfiguration() {
    return {
        domain: "Diamonds",
        mode: "Canary",
        canaryEnabled: true,
        cutoverEnabled: false,
        migrationEnabled: false,
        canaryPlayFabIds: ["61AD15CDA4137EA9"]
    };
}

test("Diamonds certificate binds scanner, dry-run, health, test digest and <=24h expiry", () => {
    const certificate = createDiamondsDomainReadinessCertificate(evidence());
    assert.equal(certificate.domain, "Diamonds");
    assert.equal(certificate.sandboxTitleId, "1D0C16");
    assert.equal(certificate.scannerBaselineDigest, HASH_A);
    assert.equal(certificate.providerDigest, HASH_B);
    assert.equal(certificate.dryRunPlanHash, HASH_C);
    assert.equal(certificate.adapterVersion, DIAMONDS_DOMAIN_TARGET_ADAPTER_VERSION);
    assert.match(certificate.certificateHash, /^[a-f0-9]{64}$/u);
    const validation = validateFinancialDomainReadinessCertificate({
        certificate,
        configuration: canaryConfiguration(),
        nowUtc: "2026-08-24T12:00:00.000Z"
    });
    assert.equal(validation.valid, true);
});

test("Diamonds certificate validation rejects a validly rehashed foreign adapter version", () => {
    const certificate = createDiamondsDomainReadinessCertificate(evidence());
    const foreign = createFinancialDomainReadinessCertificate({
        healthInput: structuredClone(certificate.healthInput),
        scannerBaselineDigest: certificate.scannerBaselineDigest,
        sandboxTitleId: certificate.sandboxTitleId,
        adapterVersion: "another-diamonds-adapter-v1",
        migrationVersion: certificate.migrationVersion,
        dryRunPlanHash: certificate.dryRunPlanHash,
        providerDigest: certificate.providerDigest,
        healthChecks: structuredClone(certificate.healthChecks),
        testDigest: certificate.testDigest,
        issuedAtUtc: certificate.issuedAtUtc,
        expiresAtUtc: certificate.expiresAtUtc,
        targetContract: certificate.targetContract
    });
    const invalid = validateFinancialDomainReadinessCertificate({
        certificate: foreign,
        configuration: canaryConfiguration(),
        nowUtc: "2026-08-24T12:00:00.000Z"
    });
    assert.equal(certificate.adapterVersion, DIAMONDS_DOMAIN_TARGET_ADAPTER_VERSION);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.includes("readiness_certificate_diamonds_version_mismatch"));
});

test("Diamonds certificate refuses a dirty scanner or changed provider", () => {
    const dirty = evidence();
    dirty.liveScan = { ...dirty.liveScan, readyForCanary: false, forbiddenRouteCount: 1 };
    assert.throws(() => createDiamondsDomainReadinessCertificate(dirty), /scan is not clean/i);

    const drift = evidence();
    drift.sandboxDryRun = { ...drift.sandboxDryRun, providerAfterDigest: "e".repeat(64) };
    assert.throws(() => createDiamondsDomainReadinessCertificate(drift), /dry-run evidence/i);
});

test("Diamonds certificate refuses ManualReview and incomplete Target health", () => {
    const conflict = evidence();
    conflict.sandboxDryRun = { ...conflict.sandboxDryRun, conflictState: "manual_review" };
    assert.throws(() => createDiamondsDomainReadinessCertificate(conflict),
        { code: "FINANCIAL_DOMAIN_NOT_READY" });

    const unhealthy = evidence();
    unhealthy.targetHealth = { ...unhealthy.targetHealth, redisHealthy: false };
    assert.throws(() => createDiamondsDomainReadinessCertificate(unhealthy), /redisHealthy/);
});

test("certificate validation fails after expiration and after any evidence tamper", () => {
    const certificate = createDiamondsDomainReadinessCertificate(evidence());
    const expired = validateFinancialDomainReadinessCertificate({
        certificate,
        configuration: canaryConfiguration(),
        nowUtc: "2026-08-25T10:00:00.000Z"
    });
    assert.equal(expired.valid, false);
    assert.ok(expired.errors.includes("readiness_certificate_expired_or_not_yet_valid"));

    const tampered = structuredClone(certificate);
    tampered.providerDigest = "f".repeat(64);
    const invalid = validateFinancialDomainReadinessCertificate({
        certificate: tampered,
        configuration: canaryConfiguration(),
        nowUtc: "2026-08-24T12:00:00.000Z"
    });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.includes("readiness_certificate_hash_mismatch"));
});
