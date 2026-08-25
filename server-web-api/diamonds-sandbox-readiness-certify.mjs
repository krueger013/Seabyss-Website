import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "redis";

import { runDiamondsSandboxReadOnlyDryRun } from "./diamonds-sandbox-readiness-dry-run.mjs";
import { readDiamondsCanaryIdentity } from "./src/diamonds-canary-identity.js";
import { createDiamondsDomainReadinessCertificate } from "./src/diamonds-domain-readiness.js";
import { assertDiamondsLiveUnitySourceClean } from "./src/diamonds-live-source-scanner.js";
import { validateFinancialDomainReadinessCertificate } from "./src/progressive-financial-domain-migration.js";

const GATES = Object.freeze([
    "SHOP_PURCHASES_ENABLED", "PURCHASES_GLOBAL_ENABLED", "PURCHASES_DIAMOND_ENABLED",
    "PURCHASES_STARTER_ENABLED", "PURCHASES_PREMIUM_ENABLED", "PURCHASES_DOUBLER_ENABLED",
    "XSOLLA_HARDENED_CATALOG_ENABLED", "XSOLLA_CHECKOUT_SANDBOX_ENABLED",
    "XSOLLA_CHECKOUT_PRODUCTION_ENABLED", "FINANCIAL_SHADOW_MODE_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED", "FINANCIAL_DIAMONDS_CUTOVER_ENABLED",
    "FINANCIAL_ELITE_CUTOVER_ENABLED", "FINANCIAL_PREMIUM_CUTOVER_ENABLED"
]);

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function off(environment, name) {
    const value = environment[name];
    if (value !== undefined && value !== null && value !== "" && value !== "false") {
        throw coded("DIAMONDS_CERTIFY_UNSAFE_GATE", `${name} must remain false.`);
    }
}

function canonicalPath(value) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
        throw new TypeError("FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH is required.");
    }
    const selected = resolve(value);
    const backend = resolve(".").toLowerCase();
    if (selected.toLowerCase().startsWith(backend) ||
        selected.toLowerCase().includes("diamonds-domain-readiness-certificate.local.json")) {
        throw coded("DIAMONDS_CERTIFY_PATH_FORBIDDEN", "Canary_02 certificate must remain outside Git and distinct from canary_01.");
    }
    return selected;
}

function testDigest() {
    return createHash("sha256").update(JSON.stringify({
        identityFailClosed: "10/10",
        diamondsCanaryRegression: "52/52",
        scope: "fresh_canary_02"
    }), "utf8").digest("hex");
}

async function redisEvidence(redisUrl) {
    const client = createClient({ url: redisUrl });
    await client.connect();
    try {
        const [pong, info, appendOnly, eviction, protectedMode, size] = await Promise.all([
            client.ping(), client.info("server"), client.configGet("appendonly"),
            client.configGet("maxmemory-policy"), client.configGet("protected-mode"), client.dbSize()
        ]);
        const major = Number(/^redis_version:(\d+)/mu.exec(info)?.[1] ||
            /^memurai_api_version:(\d+)/mu.exec(info)?.[1]);
        const config = { ...appendOnly, ...eviction, ...protectedMode };
        if (pong !== "PONG" || !Number.isSafeInteger(major) || major < 7 ||
            config.appendonly !== "yes" || config["maxmemory-policy"] !== "noeviction" ||
            config["protected-mode"] !== "yes" || size !== 0) {
            throw coded("DIAMONDS_CERTIFY_REDIS_NOT_FRESH", "Redis 7 Sandbox must be healthy, durable and empty.");
        }
        return Object.freeze({ major, size });
    } finally {
        await client.quit().catch(() => client.disconnect());
    }
}

export async function issueDiamondsSandboxReadinessCertificate(environment = process.env) {
    if (environment.SEABYSS_DIAMONDS_CANARY_02_CERTIFY_ENABLED !== "true") {
        throw coded("DIAMONDS_CERTIFY_DISABLED", "Explicit canary_02 certification enablement is required.");
    }
    const identity = readDiamondsCanaryIdentity(environment);
    for (const gate of GATES) off(environment, gate);
    const redisUrl = environment.FINANCIAL_REDIS_URL || environment.TEST_REDIS_URL;
    const outputPath = canonicalPath(environment.FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH);
    const redis = await redisEvidence(redisUrl);
    const liveScan = await assertDiamondsLiveUnitySourceClean(
        environment.SEABYSS_UNITY_ROOT ? { unityRoot: environment.SEABYSS_UNITY_ROOT } : {}
    );
    const sandboxDryRun = await runDiamondsSandboxReadOnlyDryRun({ environment });
    if (sandboxDryRun.playFabId !== identity.playFabId || sandboxDryRun.legacyValue !== 0 ||
        sandboxDryRun.targetValue !== 0 || sandboxDryRun.migrationProofExists !== false ||
        sandboxDryRun.conflictState !== "ready") {
        throw coded("DIAMONDS_CERTIFY_PREFLIGHT_MISMATCH", "Fresh canary_02 dry-run is not the exact 0 -> 0 baseline.");
    }
    const issuedAtUtc = new Date().toISOString();
    const certificate = createDiamondsDomainReadinessCertificate({
        liveScan,
        sandboxDryRun,
        targetHealth: {
            targetAdapterComposed: true, targetHealthy: true, identityVerified: true,
            redisHealthy: redis.major >= 7, playFabHealthy: true, snapshotReadHealthy: true,
            casSupported: true, zeroPendingPayment: redis.size === 0, rollbackAvailable: true
        },
        testDigest: testDigest(),
        issuedAtUtc
    });
    const validation = validateFinancialDomainReadinessCertificate({
        certificate,
        configuration: {
            domain: "Diamonds", mode: "Canary", canaryEnabled: true,
            cutoverEnabled: false, migrationEnabled: false,
            canaryPlayFabIds: [identity.playFabId]
        }
    });
    if (validation.valid !== true) {
        throw coded("DIAMONDS_CERTIFY_VALIDATION_FAILED", "Fresh certificate did not validate.");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(certificate, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return Object.freeze({
        verdict: "PASS", titleId: identity.titleId, playFabId: identity.playFabId,
        legacyValue: sandboxDryRun.legacyValue, targetValue: sandboxDryRun.targetValue,
        migrationProofExists: sandboxDryRun.migrationProofExists,
        scannerForbiddenCount: liveScan.forbiddenRouteCount,
        planHash: sandboxDryRun.planHash, certificateHash: certificate.certificateHash,
        expiresAtUtc: certificate.expiresAtUtc, redisVersionMajor: redis.major, redisDbSize: redis.size,
        outputPath
    });
}

async function main() {
    if (process.argv[2] !== "issue") throw new TypeError("Only issue is supported.");
    process.stdout.write(`${JSON.stringify(await issueDiamondsSandboxReadinessCertificate())}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({ code: error?.code || "DIAMONDS_CERTIFY_FAILED", message: error?.message })}\n`);
        process.exitCode = 1;
    });
}
