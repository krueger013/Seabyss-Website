import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createLiveDiamondsSandboxCanaryDependencies } from "./diamonds-sandbox-canary-apply.mjs";
import {
    readCanary02Spend10AofEvidence,
    runCanary02Spend10RecoveryHarness
} from "./src/diamonds-canary-spend10-recovery-harness.js";
import { CANARY02_SPEND10_RECOVERY_CONTRACT } from "./src/server-economy-poc-original-operation-recovery.js";

const C = CANARY02_SPEND10_RECOVERY_CONTRACT;
const AOF_FILENAME = "financial-canary.aof.1.incr.aof";
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
    "FINANCIAL_PREMIUM_CANARY_ENABLED", "SEABYSS_DIAMONDS_SANDBOX_CANARY_APPLY_ENABLED",
    "SEABYSS_DIAMONDS_SANDBOX_CANARY_FINISH_ENABLED",
    "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED"
]);

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function text(value, name, maximum = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw coded("DIAMONDS_RECOVERY_ENV_INVALID", name + " is absent or invalid.");
    }
    return value;
}

function requireFalse(environment, name) {
    const value = environment[name];
    if (value === undefined || value === null || value === "" || value === "false") return;
    throw coded("DIAMONDS_RECOVERY_UNSAFE_GATE", name + " must remain false.");
}

function requireTrue(environment, name) {
    if (environment[name] !== "true") {
        throw coded("DIAMONDS_RECOVERY_EXPLICIT_ENABLE_REQUIRED", name + "=true is required in this process only.");
    }
}

function loopbackRedisUrl(value) {
    const selected = text(value, "FINANCIAL_REDIS_URL", 8192);
    let parsed;
    try { parsed = new URL(selected); } catch {
        throw coded("DIAMONDS_RECOVERY_REDIS_INVALID", "Redis URL is invalid.");
    }
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) ||
        !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) || !parsed.password) {
        throw coded("DIAMONDS_RECOVERY_REDIS_NOT_ISOLATED",
            "Recovery requires authenticated loopback-only Redis.");
    }
    return selected;
}

function exactAofPath(environment) {
    const localAppData = resolve(text(environment.LOCALAPPDATA, "LOCALAPPDATA", 1024));
    const expectedRoot = resolve(localAppData, "SeabyssCodex", "financial-canary-memurai", "canary02");
    const defaultPath = resolve(expectedRoot, "runtime", "data", "appendonlydir", AOF_FILENAME);
    const configured = environment.SEABYSS_DIAMONDS_RECOVERY_AOF_PATH || defaultPath;
    const actual = resolve(text(configured, "SEABYSS_DIAMONDS_RECOVERY_AOF_PATH", 4096));
    const pathRelative = relative(expectedRoot, actual);
    if (!isAbsolute(actual) || pathRelative === "" || pathRelative.startsWith(".." + sep) ||
        pathRelative === ".." || isAbsolute(pathRelative) || basename(actual) !== AOF_FILENAME) {
        throw coded("DIAMONDS_RECOVERY_AOF_PATH_INVALID",
            "Recovery AOF must be the exact canary02 isolated append-only file.");
    }
    return actual;
}

export function readCanary02Spend10RecoveryEnvironment(environment = process.env) {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
        throw new TypeError("Recovery environment is invalid.");
    }
    const titleId = text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID", 64);
    if (titleId !== C.titleId || titleId === C.productionTitleId) {
        throw coded("DIAMONDS_RECOVERY_TITLE_INVALID", "Only isolated Sandbox 1D0C16 is accepted.");
    }
    const singular = text(environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID,
        "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID", 64);
    const compatibility = text(environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS,
        "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS", 64);
    if (singular !== C.playFabId || compatibility !== C.playFabId || singular !== compatibility ||
        singular.includes("*") || singular.includes(",")) {
        throw coded("DIAMONDS_RECOVERY_CANARY_INVALID", "One exact canary_02 PlayFabId is required.");
    }
    if (environment.NODE_ENV === "production" || environment.FINANCIAL_DIAMONDS_MODE !== "Canary" ||
        environment.FINANCIAL_DIAMONDS_CANARY_ENABLED !== "true" ||
        environment.FINANCIAL_ELITE_MODE !== "Legacy" || environment.FINANCIAL_PREMIUM_MODE !== "Legacy") {
        throw coded("DIAMONDS_RECOVERY_MODE_INVALID", "Exact Canary/Legacy domain modes are required.");
    }
    for (const gate of OFF_GATES) requireFalse(environment, gate);
    requireTrue(environment, "SEABYSS_DIAMONDS_ORIGINAL_RECOVERY_ENABLED");
    requireTrue(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED");
    return Object.freeze({
        mode: "finish",
        phase: "spend10-recovery",
        titleId,
        secretKey: text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
            "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY"),
        playFabId: C.playFabId,
        redisUrl: loopbackRedisUrl(environment.FINANCIAL_REDIS_URL || environment.TEST_REDIS_URL),
        certificatePath: resolve(environment.FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH ||
            "config/diamonds-domain-readiness-certificate.local.json"),
        unityRoot: environment.SEABYSS_UNITY_ROOT || undefined,
        aofPath: exactAofPath(environment),
        providerWritesEnabled: true,
        staleLegacyWriteEnabled: false,
        migrationApplyEnabled: false,
        explicitEnabled: true
    });
}

export async function runLiveCanary02Spend10Recovery({
    environment = process.env,
    dependencyFactory = createLiveDiamondsSandboxCanaryDependencies,
    readAofEvidence = readCanary02Spend10AofEvidence
} = {}) {
    const configuration = readCanary02Spend10RecoveryEnvironment(environment);
    // AOF validation is deliberately completed before Redis/PlayFab dependencies
    // are constructed, so incomplete evidence cannot trigger a network call.
    const aofEvidence = readAofEvidence(configuration.aofPath);
    const live = await dependencyFactory(configuration);
    try {
        return await runCanary02Spend10RecoveryHarness({
            explicitlyEnabled: true,
            providerWritesEnabled: true,
            aofEvidence,
            dependencies: live.dependencies
        });
    } finally {
        await live.close();
    }
}

async function main() {
    const result = await runLiveCanary02Spend10Recovery();
    process.stdout.write(JSON.stringify(result) + "\n");
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(JSON.stringify({
            code: error?.code || "DIAMONDS_ORIGINAL_RECOVERY_FAILED",
            message: error?.message || "Diamonds original-operation recovery failed."
        }) + "\n");
        process.exitCode = 1;
    });
}
