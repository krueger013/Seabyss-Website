import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createLiveDiamondsSandboxCanaryDependencies } from "./diamonds-sandbox-canary-apply.mjs";
import {
    FINISH_PLAYFAB_ID,
    FINISH_PRODUCTION_TITLE_ID,
    FINISH_TITLE_ID,
    runDiamondsSandboxCanaryFinishHarness
} from "./src/diamonds-sandbox-canary-finish-harness.js";

const MODES = new Set(["preflight", "spend", "insufficient", "xsd2", "stale"]);
const PROVIDER_WRITE_MODES = new Set(["spend", "insufficient", "xsd2"]);
const OFF_GATES = Object.freeze([
    "ShopPurchasesEnabled", "SHOP_PURCHASES_ENABLED", "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED", "PURCHASES_STARTER_ENABLED", "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED", "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED", "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS", "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS", "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "PAYMENT_WORKER_ENABLED", "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED", "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED", "FINANCIAL_DIAMONDS_CUTOVER_ENABLED",
    "FINANCIAL_DIAMONDS_MIGRATION_ENABLED", "FINANCIAL_ELITE_CUTOVER_ENABLED",
    "FINANCIAL_PREMIUM_CUTOVER_ENABLED", "FINANCIAL_ELITE_CANARY_ENABLED",
    "FINANCIAL_PREMIUM_CANARY_ENABLED"
]);

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function text(value, name, maximum = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw coded("DIAMONDS_FINISH_ENV_INVALID", `${name} is absent or invalid.`);
    }
    return value;
}

function requireOff(environment, name) {
    const value = environment[name];
    if (value === undefined || value === null || value === "" || value === "false") return;
    throw coded("DIAMONDS_FINISH_UNSAFE_GATE", `${name} must remain false.`);
}

function exactTrue(environment, name) {
    if (environment[name] !== "true") throw coded("DIAMONDS_FINISH_EXPLICIT_ENABLE_REQUIRED", `${name}=true is required.`);
}

function redisUrl(value) {
    const selected = text(value, "FINANCIAL_REDIS_URL", 8192);
    let parsed;
    try { parsed = new URL(selected); } catch { throw coded("DIAMONDS_FINISH_REDIS_INVALID", "Redis URL is invalid."); }
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) ||
        !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) || !parsed.password) {
        throw coded("DIAMONDS_FINISH_REDIS_NOT_ISOLATED", "Redis must be authenticated and loopback-only.");
    }
    return selected;
}

export function readDiamondsSandboxCanaryFinishEnvironment({ mode, environment = process.env } = {}) {
    if (!MODES.has(mode)) throw new TypeError("Diamonds finish mode is invalid.");
    const titleId = text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID", 64);
    if (titleId !== FINISH_TITLE_ID || titleId === FINISH_PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_FINISH_TITLE_INVALID", "Only Sandbox 1D0C16 is accepted.");
    }
    if (environment.NODE_ENV === "production" || environment.FINANCIAL_DIAMONDS_MODE !== "Canary" ||
        environment.FINANCIAL_DIAMONDS_CANARY_ENABLED !== "true" ||
        environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS !== FINISH_PLAYFAB_ID ||
        environment.FINANCIAL_ELITE_MODE && environment.FINANCIAL_ELITE_MODE !== "Legacy" ||
        environment.FINANCIAL_PREMIUM_MODE && environment.FINANCIAL_PREMIUM_MODE !== "Legacy") {
        throw coded("DIAMONDS_FINISH_CANARY_INVALID", "Exact Canary identity/domain modes are required.");
    }
    for (const gate of OFF_GATES) requireOff(environment, gate);
    exactTrue(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_FINISH_ENABLED");
    const providerWritesEnabled = PROVIDER_WRITE_MODES.has(mode);
    const staleLegacyWriteEnabled = mode === "stale";
    if (providerWritesEnabled) exactTrue(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED");
    else requireOff(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED");
    if (staleLegacyWriteEnabled) exactTrue(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED");
    else requireOff(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED");
    return Object.freeze({
        mode: "finish",
        phase: mode,
        titleId,
        secretKey: text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
            "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY"),
        playFabId: FINISH_PLAYFAB_ID,
        redisUrl: redisUrl(environment.FINANCIAL_REDIS_URL || environment.TEST_REDIS_URL),
        certificatePath: resolve(environment.FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH ||
            "config/diamonds-domain-readiness-certificate.local.json"),
        unityRoot: environment.SEABYSS_UNITY_ROOT || undefined,
        providerWritesEnabled,
        staleLegacyWriteEnabled,
        migrationApplyEnabled: false,
        explicitEnabled: true
    });
}

export async function runLiveDiamondsSandboxCanaryFinish({ mode, environment = process.env,
    dependencyFactory = createLiveDiamondsSandboxCanaryDependencies } = {}) {
    const configuration = readDiamondsSandboxCanaryFinishEnvironment({ mode, environment });
    const live = await dependencyFactory(configuration);
    try {
        return await runDiamondsSandboxCanaryFinishHarness({
            mode,
            explicitlyEnabled: true,
            providerWritesEnabled: configuration.providerWritesEnabled,
            staleLegacyWriteEnabled: configuration.staleLegacyWriteEnabled,
            dependencies: live.dependencies
        });
    } finally {
        await live.close();
    }
}

async function main() {
    const result = await runLiveDiamondsSandboxCanaryFinish({ mode: process.argv[2] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            code: error?.code || "DIAMONDS_SANDBOX_CANARY_FINISH_FAILED",
            message: error?.message || "Diamonds Sandbox Canary finish failed."
        })}\n`);
        process.exitCode = 1;
    });
}
