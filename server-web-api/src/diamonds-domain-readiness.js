import { readConfiguredDiamondsCanaryPlayFabId } from "./diamonds-canary-identity.js";
import {
    CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET,
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    DIAMONDS_TARGET_ADAPTER_VERSION,
    MAX_FINANCIAL_READINESS_CERTIFICATE_LIFETIME_MS,
    createFinancialDomainReadinessCertificate
} from "./progressive-financial-domain-migration.js";

export const DIAMONDS_READINESS_CANARY_PLAYFAB_ID = readConfiguredDiamondsCanaryPlayFabId();

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha(value, name) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new TypeError(`${name} must be a SHA-256 digest.`);
    }
    return value;
}

function iso(value, name) {
    if (typeof value !== "string" || new Date(value).toISOString() !== value) {
        throw new TypeError(`${name} must be canonical UTC.`);
    }
    return value;
}

function requireTrue(value, name) {
    if (value !== true) throw new TypeError(`${name} must be certified true.`);
    return true;
}

export function createDiamondsDomainReadinessCertificate({
    liveScan,
    sandboxDryRun,
    targetHealth,
    testDigest,
    issuedAtUtc,
    expiresAtUtc
} = {}) {
    if (!plain(liveScan) || liveScan.domain !== "Diamonds" ||
        liveScan.readyForCanary !== true || liveScan.forbiddenRouteCount !== 0) {
        throw new TypeError("Diamonds live source scan is not clean.");
    }
    const scannerDigest = sha(liveScan.scannerDigest, "scannerDigest");
    if (!plain(sandboxDryRun) || sandboxDryRun.readOnly !== true ||
        sandboxDryRun.sandboxTitleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID ||
        sandboxDryRun.playFabId !== DIAMONDS_READINESS_CANARY_PLAYFAB_ID ||
        sandboxDryRun.providerUnchanged !== true || sandboxDryRun.providerWriteCount !== 0 ||
        sandboxDryRun.providerBeforeDigest !== sandboxDryRun.providerAfterDigest) {
        throw new TypeError("Diamonds Sandbox dry-run evidence is invalid or mutating.");
    }
    const dryRunPlanHash = sha(sandboxDryRun.planHash, "dryRunPlanHash");
    const providerDigest = sha(sandboxDryRun.providerBeforeDigest, "providerDigest");
    sha(testDigest, "testDigest");
    if (!plain(targetHealth)) throw new TypeError("Diamonds Target health evidence is missing.");
    const healthChecks = {
        targetAdapterComposed: requireTrue(targetHealth.targetAdapterComposed, "targetAdapterComposed"),
        targetHealthy: requireTrue(targetHealth.targetHealthy, "targetHealthy"),
        identityVerified: requireTrue(targetHealth.identityVerified, "identityVerified"),
        redisHealthy: requireTrue(targetHealth.redisHealthy, "redisHealthy"),
        playFabHealthy: requireTrue(targetHealth.playFabHealthy, "playFabHealthy"),
        snapshotReadHealthy: requireTrue(targetHealth.snapshotReadHealthy, "snapshotReadHealthy"),
        casSupported: requireTrue(targetHealth.casSupported, "casSupported"),
        scannerZeroForbidden: true,
        dryRunReadOnly: true,
        providerUnchanged: true,
        zeroPendingPayment: requireTrue(targetHealth.zeroPendingPayment, "zeroPendingPayment"),
        rollbackAvailable: requireTrue(targetHealth.rollbackAvailable, "rollbackAvailable")
    };
    const issued = iso(issuedAtUtc, "issuedAtUtc");
    const expires = expiresAtUtc ||
        new Date(Date.parse(issued) + MAX_FINANCIAL_READINESS_CERTIFICATE_LIFETIME_MS).toISOString();
    iso(expires, "expiresAtUtc");
    return createFinancialDomainReadinessCertificate({
        healthInput: {
            configuration: {
                domain: "Diamonds",
                mode: "Canary",
                canaryEnabled: true,
                cutoverEnabled: false,
                migrationEnabled: false,
                canaryPlayFabIds: [DIAMONDS_READINESS_CANARY_PLAYFAB_ID]
            },
            legacyAccess: {
                intentionalLegacyAdapter: liveScan.counts?.intentional_legacy_adapter ?? 0,
                migrationOnly: liveScan.counts?.migration_only ?? 0,
                forbiddenDirectAccess: 0
            },
            shadowMismatchCount: 0,
            migrationConflicts: sandboxDryRun.conflictState === "manual_review" ? 1 : 0,
            pendingOperations: 0,
            scannerCertified: true,
            dryRunCertified: sandboxDryRun.conflictState !== "manual_review",
            targetHealthy: true,
            redisHealthy: true,
            playFabHealthy: true,
            rollbackPlanValid: true,
            canaryCertified: false
        },
        scannerBaselineDigest: scannerDigest,
        sandboxTitleId: DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        dryRunPlanHash,
        providerDigest,
        healthChecks,
        testDigest,
        issuedAtUtc: issued,
        expiresAtUtc: expires,
        targetContract: CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET
    });
}
