import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "redis";

import {
    DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID,
    DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID,
    DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID,
    runDiamondsSandboxCanaryApplyHarness
} from "./src/diamonds-sandbox-canary-apply-harness.js";
import {
    createDiamondsSandboxCanaryMigrationExecutor,
    createPlayFabDiamondsSandboxMigrationStore
} from "./src/diamonds-sandbox-canary-migration-executor.js";
import { createDiamondsCanaryXsd2Composition } from "./src/diamonds-canary-xsd2-composition.js";
import { createRealDiamondsCanonicalRuntime } from "./src/diamonds-domain-server-composition.js";
import { createDiamondsDomainTargetAdapter } from "./src/diamonds-domain-target-adapter.js";
import { assertDiamondsLiveUnitySourceClean } from "./src/diamonds-live-source-scanner.js";
import { createPaymentLedger } from "./src/payment-ledger.js";
import { createRedisPaymentLedgerStore } from "./src/payment-ledger-redis-store.js";
import { createPlayFabFinancialProfileClient } from "./src/playfab-financial-profile-store.js";
import { getXsollaDiamondReceiptKey } from "./src/playfab-xsolla-diamond-receipt-store.js";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "./src/playfab-xsolla-diamond-receipt-v2-store.js";
import { createPlayFabXsollaV2ReceiptReader } from "./src/playfab-xsolla-v2-receipt-reader.js";
import {
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    planProgressiveFinancialDomainMigration,
    validateFinancialDomainReadinessCertificate
} from "./src/progressive-financial-domain-migration.js";
import { createRedisServerEconomyPocPlayerLeases } from "./src/server-economy-poc-redis-player-leases.js";
import {
    CANARY02_SPEND10_RECOVERY_CONTRACT,
    createRedisCanary02Spend10RecoveryImporter
} from "./src/server-economy-poc-original-operation-recovery.js";
import { createXsollaLedgeredReceiptProcessor } from "./src/xsolla-ledgered-receipt-processor.js";
import { getXsollaProductPlan } from "./src/xsolla-product-plan-registry.js";

const TARGET_REDIS_PREFIX = "seabyss:financial:diamonds:sandbox-canary:v1:";
const LEDGER_REDIS_PREFIX = "seabyss:payments:diamonds:sandbox-canary:v1:";
export const DIAMONDS_SANDBOX_CANARY_SPEND_OPERATION_ID = "diamonds-canary-v1:spend-10";
export const DIAMONDS_SANDBOX_CANARY_INSUFFICIENT_OPERATION_ID = "diamonds-canary-v1:insufficient-16";
const PURCHASE_GATES = Object.freeze([
    "ShopPurchasesEnabled",
    "SHOP_PURCHASES_ENABLED",
    "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED",
    "PURCHASES_STARTER_ENABLED",
    "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED",
    "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED",
    "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS",
    "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "PAYMENT_WORKER_ENABLED",
    "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED",
    "FINANCIAL_DIAMONDS_CUTOVER_ENABLED",
    "FINANCIAL_DIAMONDS_MIGRATION_ENABLED",
    "FINANCIAL_ELITE_CUTOVER_ENABLED",
    "FINANCIAL_PREMIUM_CUTOVER_ENABLED"
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

function canonical(value, name, maximumLength = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is absent or invalid.`);
    }
    return value;
}

function off(environment, name) {
    const value = environment[name];
    if (value === undefined || value === null || value === "" || value === "false") return true;
    throw coded("DIAMONDS_CANARY_UNSAFE_GATE", `${name} must remain false.`);
}

function exactTrue(environment, name) {
    if (environment[name] !== "true") {
        throw coded("DIAMONDS_CANARY_EXPLICIT_ENABLE_REQUIRED", `${name}=true is required in this process only.`);
    }
}

function loopbackRedisUrl(value) {
    const selected = canonical(value, "FINANCIAL_REDIS_URL", 8192);
    let parsed;
    try { parsed = new URL(selected); } catch { throw new TypeError("FINANCIAL_REDIS_URL is invalid."); }
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) ||
        !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) ||
        !parsed.password) {
        throw coded("DIAMONDS_CANARY_REDIS_NOT_ISOLATED",
            "Canary Redis must be authenticated and bound to loopback.");
    }
    return selected;
}

export function readDiamondsSandboxCanaryApplyEnvironment({
    environment = process.env,
    mode = "apply"
} = {}) {
    if (!plain(environment) || !["apply", "verify"].includes(mode)) {
        throw new TypeError("Diamonds Canary CLI environment or mode is invalid.");
    }
    const titleId = canonical(
        environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID",
        64
    );
    if (titleId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID ||
        titleId === DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_CANARY_SANDBOX_TITLE_MISMATCH", "Only isolated PlayFab Sandbox 1D0C16 is accepted.");
    }
    const secretKey = canonical(
        environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY"
    );
    if (environment.FINANCIAL_DIAMONDS_MODE !== "Canary" ||
        environment.FINANCIAL_DIAMONDS_CANARY_ENABLED !== "true" ||
        environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS !==
            DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID) {
        throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID",
            "Diamonds mode must be Canary with the one exact Sandbox PlayFabId.");
    }
    if (environment.FINANCIAL_ELITE_MODE && environment.FINANCIAL_ELITE_MODE !== "Legacy" ||
        environment.FINANCIAL_PREMIUM_MODE && environment.FINANCIAL_PREMIUM_MODE !== "Legacy") {
        throw coded("DIAMONDS_CANARY_OTHER_DOMAIN_NOT_LEGACY", "Elite and Premium must remain Legacy.");
    }
    for (const gate of PURCHASE_GATES) off(environment, gate);
    off(environment, "FINANCIAL_ELITE_CANARY_ENABLED");
    off(environment, "FINANCIAL_PREMIUM_CANARY_ENABLED");
    if (environment.NODE_ENV === "production") {
        throw coded("DIAMONDS_CANARY_PRODUCTION_PROCESS_FORBIDDEN", "Canary CLI cannot run with NODE_ENV=production.");
    }
    exactTrue(environment, mode === "apply"
        ? "SEABYSS_DIAMONDS_SANDBOX_CANARY_APPLY_ENABLED"
        : "SEABYSS_DIAMONDS_SANDBOX_CANARY_VERIFY_ENABLED");
    if (mode === "apply") {
        exactTrue(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED");
        exactTrue(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED");
    } else {
        off(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED");
        off(environment, "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED");
    }
    return Object.freeze({
        mode,
        titleId,
        secretKey,
        playFabId: DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID,
        redisUrl: loopbackRedisUrl(environment.FINANCIAL_REDIS_URL || environment.TEST_REDIS_URL),
        certificatePath: resolve(canonical(
            environment.FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH,
            "FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH"
        )),
        unityRoot: environment.SEABYSS_UNITY_ROOT || undefined,
        explicitEnabled: true,
        providerWritesEnabled: mode === "apply"
    });
}

function canaryConfiguration() {
    return Object.freeze({
        domain: "Diamonds",
        mode: "Canary",
        canaryEnabled: true,
        cutoverEnabled: false,
        migrationEnabled: false,
        canaryPlayFabIds: Object.freeze([DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID])
    });
}

function stableSyntheticTransactionId({ titleId, playFabId }) {
    const digest = createHash("sha256").update(JSON.stringify({
        namespace: "seabyss-synthetic-xsd2-canary-v2",
        titleId: canonical(titleId, "titleId", 64),
        playFabId: canonical(playFabId, "playFabId", 160),
        sku: "seabyss_diamond_pack_1",
        scenarioVersion: 1
    }), "utf8").digest("hex");
    const suffix = BigInt(`0x${digest.slice(0, 15)}`) % 10_000_000_000_000_000n;
    const transactionId = String(8_200_000_000_000_000_000n + suffix);
    if (transactionId === "8108648083537037216") {
        throw coded("DIAMONDS_CANARY_XSD2_ID_COLLISION", "Synthetic transaction collided with canary_01.");
    }
    return transactionId;
}

export function createDiamondsCanarySyntheticXsd2Receipt({ certificate } = {}) {
    if (!plain(certificate) || !/^[a-f0-9]{64}$/u.test(certificate.certificateHash || "")) {
        throw new TypeError("A valid Diamonds readiness certificate is required.");
    }
    const product = getXsollaProductPlan("seabyss_diamond_pack_1");
    const transactionId = stableSyntheticTransactionId({
        titleId: DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID,
        playFabId: DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID
    });
    return Object.freeze({
        playFabId: DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID,
        transactionId,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID,
        createdAtUtc: certificate.issuedAtUtc,
        environment: "sandbox",
        notificationType: "payment",
        orderId: transactionId,
        productId: product.productId,
        xsollaSku: product.sku,
        productType: product.productType,
        source: "xsolla_sandbox",
        productPlanVersion: product.planVersion,
        currency: product.currency,
        unitAmountMinor: product.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: product.unitAmountMinor,
        promotionPolicy: "disabled"
    });
}

export function interpretDiamondsCanaryTargetOperationResult({ result, delta } = {}) {
    if (!Number.isSafeInteger(delta) || delta === 0 || !plain(result) ||
        result.playFabId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID ||
        result.providerConfirmed !== true) {
        throw coded("DIAMONDS_CANARY_TARGET_RESULT_INVALID",
            "Canonical Target adapter returned an invalid canary result.");
    }
    if (result.status === "Insufficient" && delta < 0) {
        const error = coded("POC_INSUFFICIENT_DIAMONDS",
            "Trusted Diamond spend exceeds the canonical balance.");
        error.statusCode = 409;
        throw error;
    }
    if (result.status !== "Applied") {
        throw coded("DIAMONDS_CANARY_TARGET_RESULT_INVALID",
            `Fresh canary operation expected Applied and received ${result.status || "unknown"}.`);
    }
    return result;
}

/** Certification-only store: writes xsd2 and proves the matching xsd1 key is absent. */
export function createDiamondsCanaryV2OnlyReceiptStore({
    titleId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 8_000
} = {}) {
    if (titleId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_TITLE_ID ||
        titleId === DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID ||
        typeof secretKey !== "string" || secretKey.length === 0 ||
        typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0) {
        throw new TypeError("Diamonds Canary xsd2-only receipt store is not configured.");
    }
    async function post(endpoint, body) {
        const response = await fetchImpl(`https://${titleId}.playfabapi.com/Server/${endpoint}`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMilliseconds),
            headers: { "Content-Type": "application/json", "X-SecretKey": secretKey },
            body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200) {
            throw coded("DIAMONDS_CANARY_XSD2_STORE_FAILED", `PlayFab ${endpoint} failed.`);
        }
        return payload.data;
    }
    async function read(playFabId, keys) {
        const result = await post("GetUserInternalData", { PlayFabId: playFabId, Keys: keys });
        return Object.fromEntries(keys.map((key) => {
            const entry = result?.Data?.[key];
            if (entry === undefined) return [key, null];
            if (!entry || typeof entry.Value !== "string") {
                throw coded("DIAMONDS_CANARY_XSD2_READBACK_INVALID", "Receipt readback is malformed.");
            }
            return [key, entry.Value];
        }));
    }
    async function inspect(receipt) {
        if (receipt?.playFabId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID ||
            receipt?.userId !== DIAMONDS_SANDBOX_CANARY_EXPECTED_PLAYFAB_ID) {
            throw coded("DIAMONDS_CANARY_XSD2_IDENTITY_REFUSED", "Receipt belongs to another player.");
        }
        const key = getXsollaDiamondReceiptV2Key(receipt.transactionId);
        const legacyKey = getXsollaDiamondReceiptKey(receipt.transactionId);
        const values = await read(receipt.playFabId, [key, legacyKey]);
        return Object.freeze({ key, legacyKey, v2Value: values[key], legacyValue: values[legacyKey] });
    }
    async function persistDiamondsCanaryV2OnlyReceipt(receipt) {
        const inspected = await inspect(receipt);
        const { key, legacyKey } = inspected;
        const value = serializeXsollaDiamondReceiptV2(receipt);
        if (inspected.legacyValue !== null) {
            throw coded("DIAMONDS_CANARY_LEGACY_RECEIPT_PRESENT",
                "Matching xsd1 exists; canary refuses any possible Legacy login grant.");
        }
        if (inspected.v2Value !== null && inspected.v2Value !== value) {
            throw coded("DIAMONDS_CANARY_XSD2_CONFLICT", "Immutable xsd2 receipt conflicts.");
        }
        if (inspected.v2Value === null) {
            await post("UpdateUserInternalData", {
                PlayFabId: receipt.playFabId,
                Data: { [key]: value }
            });
        }
        const after = await read(receipt.playFabId, [key, legacyKey]);
        if (after[key] !== value || after[legacyKey] !== null) {
            throw coded("DIAMONDS_CANARY_XSD2_READBACK_INVALID",
                "xsd2-only persistence or xsd1 absence did not verify.");
        }
        return Object.freeze({
            key,
            value,
            existing: inspected.v2Value !== null,
            certificationV2Only: true,
            legacyKey,
            legacyReceiptBefore: false,
            legacyReceiptAfter: false,
            legacyReceiptWritten: false
        });
    }
    return Object.freeze(Object.assign(persistDiamondsCanaryV2OnlyReceipt, { inspect }));
}

async function redisHealth(redis) {
    if (await redis.ping() !== "PONG") throw coded("DIAMONDS_CANARY_REDIS_UNHEALTHY", "Redis PING failed.");
    const info = await redis.info("server");
    const major = Number(/^redis_version:(\d+)/mu.exec(info)?.[1]);
    const [appendOnly, eviction, protectedMode] = await Promise.all([
        redis.configGet("appendonly"),
        redis.configGet("maxmemory-policy"),
        redis.configGet("protected-mode")
    ]);
    const config = { ...appendOnly, ...eviction, ...protectedMode };
    if (!Number.isSafeInteger(major) || major < 7 || config.appendonly !== "yes" ||
        config["maxmemory-policy"] !== "noeviction" || config["protected-mode"] !== "yes") {
        throw coded("DIAMONDS_CANARY_REDIS_UNSAFE",
            "Redis must be 7+, AOF, noeviction and protected-mode=yes.");
    }
    return Object.freeze({ major, aof: true, noeviction: true, protectedMode: true });
}

async function allLedgerTransactions(ledger) {
    const items = [];
    let cursor = null;
    do {
        const page = await ledger.scanTransactions({ cursor: cursor || "0", limit: 100 });
        items.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor !== null);
    return items;
}

function certificateEvidence(certificate, scanner, plan) {
    const validation = validateFinancialDomainReadinessCertificate({
        certificate,
        configuration: canaryConfiguration()
    });
    if (validation.valid !== true || certificate.scannerBaselineDigest !== scanner.scannerDigest ||
        certificate.dryRunPlanHash !== plan.planHash ||
        certificate.providerDigest !== plan.providerStateDigest || scanner.forbiddenRouteCount !== 0) {
        throw coded("DIAMONDS_CANARY_READINESS_INVALID",
            "Readiness certificate, scanner, fresh plan or provider digest no longer matches.",
            { certificateErrors: validation.errors });
    }
    return Object.freeze({ valid: true, certificate });
}

function createLegacyExactRewriteProbe({ titleId, secretKey, playFabId, migrationStore }) {
    async function post(endpoint, body) {
        const response = await fetch(`https://${titleId}.playfabapi.com/Server/${endpoint}`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(8_000),
            headers: { "Content-Type": "application/json", "X-SecretKey": secretKey },
            body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200) {
            throw coded("DIAMONDS_CANARY_STALE_LEGACY_PROBE_FAILED", `PlayFab ${endpoint} failed.`);
        }
        return payload.data;
    }
    async function readLegacyRaw() {
        const current = await post("GetUserInternalData", { PlayFabId: playFabId, Keys: ["profile_v1"] });
        const existing = current?.Data?.profile_v1?.Value;
        const raw = typeof existing === "string" ? existing : JSON.stringify({ diamonds: 0 });
        let profile;
        try { profile = JSON.parse(raw); } catch {
            throw coded("DIAMONDS_CANARY_STALE_LEGACY_PROFILE_INVALID", "profile_v1 is malformed.");
        }
        if (!plain(profile) || !Number.isSafeInteger(profile.diamonds) || profile.diamonds < 0) {
            throw coded("DIAMONDS_CANARY_STALE_LEGACY_PROFILE_INVALID",
                "profile_v1 has no canonical legacy Diamonds projection.");
        }
        return Object.freeze({ raw, profileDiamonds: profile.diamonds });
    }
    return Object.freeze({
        async preflight() {
            const legacy = await readLegacyRaw();
            return Object.freeze({ ready: true, profileDiamonds: legacy.profileDiamonds });
        },
        async assertStaleLegacyWriteBlocked({ performWrite }) {
            const legacy = await readLegacyRaw();
            const raw = legacy.raw;
            if (performWrite) {
            await post("UpdateUserInternalData", { PlayFabId: playFabId, Data: { profile_v1: raw } });
            const readback = await post("GetUserInternalData", { PlayFabId: playFabId, Keys: ["profile_v1"] });
            if (readback?.Data?.profile_v1?.Value !== raw) {
                throw coded("DIAMONDS_CANARY_STALE_LEGACY_READBACK_MISMATCH",
                    "Exact stale Legacy profile rewrite did not read back unchanged.");
            }
        }
        const observation = await migrationStore.readObservation(playFabId);
        return Object.freeze({
            blocked: observation.legacyValue === 0 && observation.targetValue === 515,
            legacyValue: observation.legacyValue,
            targetBalance: observation.targetValue,
            exactLegacyRewritePerformed: performWrite === true,
            legacyProfileDiamonds: legacy.profileDiamonds
        });
        }
    });
}

export async function createLiveDiamondsSandboxCanaryDependencies(configuration, {
    redisFactory = (options) => createClient(options)
} = {}) {
    const redis = redisFactory({ url: configuration.redisUrl });
    await redis.connect();
    let closed = false;
    try {
        const redisEvidence = await redisHealth(redis);
        const certificate = JSON.parse(readFileSync(configuration.certificatePath, "utf8"));
        const scanner = await assertDiamondsLiveUnitySourceClean(
            configuration.unityRoot ? { unityRoot: configuration.unityRoot } : {}
        );
        const basePlayFab = createPlayFabFinancialProfileClient({
            titleId: configuration.titleId,
            secretKey: configuration.secretKey
        });
        const playerLeases = createRedisServerEconomyPocPlayerLeases({
            redis,
            prefix: TARGET_REDIS_PREFIX
        });
        const migrationStore = createPlayFabDiamondsSandboxMigrationStore({
            client: basePlayFab,
            titleId: configuration.titleId,
            assertPlayerFence: (input) => playerLeases.assertCurrent(input)
        });
        const ledger = createPaymentLedger({
            store: createRedisPaymentLedgerStore(redis, { prefix: LEDGER_REDIS_PREFIX })
        });
        let currentPlan = null;
        async function freshPlan() {
            const observation = await migrationStore.readObservation(configuration.playFabId);
            const plan = planProgressiveFinancialDomainMigration({
                domain: "Diamonds",
                playFabId: configuration.playFabId,
                titleId: configuration.titleId,
                migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
                legacyValue: observation.legacyValue,
                targetValue: observation.targetValue,
                targetRevision: observation.targetRevision,
                providerProfileVersion: observation.providerProfileVersion,
                providerStateDigest: observation.providerStateDigest,
                migrationProof: observation.migrationProof
            });
            currentPlan = plan;
            return { observation, plan };
        }
        const migrationExecutor = createDiamondsSandboxCanaryMigrationExecutor({
            enabled: configuration.migrationApplyEnabled ?? configuration.mode === "apply",
            providerWritesEnabled: configuration.providerWritesEnabled,
            titleId: configuration.titleId,
            canaryPlayFabIds: [configuration.playFabId],
            playerLeases,
            migrationStore,
            async verifyReadiness() {
                if (!currentPlan) throw coded("DIAMONDS_CANARY_PLAN_REQUIRED", "Fresh plan was not read.");
                return certificateEvidence(certificate, scanner, currentPlan);
            }
        });
        const runtimeStack = createRealDiamondsCanonicalRuntime({
            redis,
            titleId: configuration.titleId,
            secretKey: configuration.secretKey,
            redisPrefix: TARGET_REDIS_PREFIX,
            gameServerId: "diamonds-sandbox-canary-cli",
            gameServerToken: randomBytes(48).toString("base64url"),
            canaryPlayFabIds: [configuration.playFabId],
            migrationProofRequired: true
        });
        const recoveryImporter = createRedisCanary02Spend10RecoveryImporter({
            redis,
            prefix: TARGET_REDIS_PREFIX
        });
        const targetAdapter = createDiamondsDomainTargetAdapter({
            canonicalRuntime: runtimeStack.canonicalRuntime
        });
        const persistDiamondReceiptV2 = createDiamondsCanaryV2OnlyReceiptStore({
            titleId: configuration.titleId,
            secretKey: configuration.secretKey
        });
        const loadXsollaV2Receipt = createPlayFabXsollaV2ReceiptReader({
            titleId: configuration.titleId,
            secretKey: configuration.secretKey
        });
        const persistLedgeredReceipt = createXsollaLedgeredReceiptProcessor({
            ledger,
            async persistStarterPackReceiptV2() {
                throw coded("DIAMONDS_CANARY_STARTER_FORBIDDEN", "Starter is outside Diamonds Canary.");
            },
            persistDiamondPackReceiptV2: persistDiamondReceiptV2,
            workerId: "diamonds-sandbox-canary-receipt"
        });
        const xsd2 = createDiamondsCanaryXsd2Composition({
            ledger,
            loadXsollaV2Receipt,
            shadowProducer: null,
            canonicalRuntime: runtimeStack.canonicalRuntime,
            migrationProofCompanion: runtimeStack.proofAwarePlayFab,
            async verifyCanaryReadiness({ playFabId }) {
                const observed = await migrationStore.verifyProof(playFabId);
                const health = await redisHealth(redis);
                const validation = validateFinancialDomainReadinessCertificate({
                    certificate,
                    configuration: canaryConfiguration()
                });
                return Object.freeze({
                    ready: observed.verified === true && validation.valid === true &&
                        scanner.forbiddenRouteCount === 0 && health.major >= 7,
                    domain: "Diamonds",
                    titleId: configuration.titleId,
                    playFabId,
                    certificateValid: validation.valid === true,
                    migrationProofValid: observed.verified === true,
                    redisHealthy: true,
                    playFabHealthy: true,
                    scannerForbiddenCount: scanner.forbiddenRouteCount
                });
            },
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: configuration.titleId,
                forbiddenTitleIds: [DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID],
                canaryPlayFabIds: [configuration.playFabId]
            },
            workerId: "diamonds-sandbox-canary-xsd2"
        });
        const syntheticReceipt = createDiamondsCanarySyntheticXsd2Receipt({ certificate });
        const legacyProbe = createLegacyExactRewriteProbe({
            titleId: configuration.titleId,
            secretKey: configuration.secretKey,
            playFabId: configuration.playFabId,
            migrationStore
        });
        let operationEpoch = 1;
        const dependencies = {
            async preflight() {
                const { observation, plan } = await freshPlan();
                const readiness = certificateEvidence(certificate, scanner, plan);
                const transactions = await allLedgerTransactions(ledger);
                const legacyProfile = await legacyProbe.preflight();
                const receiptKeys = await persistDiamondReceiptV2.inspect(syntheticReceipt);
                const proofExists = observation.migrationProof !== null;
                return {
                    titleId: configuration.titleId,
                    productionTitleId: DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID,
                    productionTitleUntouched: true,
                    playFabId: configuration.playFabId,
                    certificateValid: readiness.valid === true,
                    legacyReceiptAbsent: receiptKeys.legacyValue === null,
                    playFabHealthy: true,
                    redisHealthy: true,
                    redisVersionMajor: redisEvidence.major,
                    rollbackAvailable: plan.rollback?.available === true,
                    scannerZeroForbidden: scanner.forbiddenRouteCount === 0,
                    syntheticV2ReceiptAbsent: receiptKeys.v2Value === null,
                    scannerForbiddenCount: scanner.forbiddenRouteCount,
                    scannerHash: scanner.scannerDigest,
                    zeroPendingPayment: transactions.length === 0,
                    pendingCount: transactions.filter((item) => item.state !== "Completed").length,
                    legacyValue: observation.legacyValue,
                    legacyProfileDiamonds: legacyProfile.profileDiamonds,
                    targetValue: observation.targetValue,
                    migrationProofExists: proofExists,
                    plan
                };
            },
            applyMigration(input) { return migrationExecutor.execute(input); },
            readTarget() { return runtimeStack.canonicalRuntime.readSnapshot(configuration.playFabId); },
            async inspectTargetQueueState() {
                const [pendingPlayers, wal] = await Promise.all([
                    runtimeStack.operationInbox.listPlayersWithPending({ limit: 100 }),
                    runtimeStack.walStore.status(configuration.playFabId)
                ]);
                return Object.freeze({
                    pending: pendingPlayers.includes(configuration.playFabId) ? 1 : 0,
                    pendingPlayers: Object.freeze([...pendingPlayers]),
                    walPending: wal.pendingCount,
                    wal
                });
            },
            async inspectFinishState() {
                const snapshot = await runtimeStack.canonicalRuntime.readSnapshot(configuration.playFabId);
                const operation = await runtimeStack.operationInbox.get(
                    configuration.playFabId,
                    DIAMONDS_SANDBOX_CANARY_SPEND_OPERATION_ID
                );
                const resolution = await runtimeStack.canonicalRuntime.gameplay.resolutionStore.get(
                    configuration.playFabId,
                    DIAMONDS_SANDBOX_CANARY_SPEND_OPERATION_ID
                );
                const lease = await runtimeStack.candidateLeases.inspect(configuration.playFabId);
                const observation = await migrationStore.readObservation(configuration.playFabId);
                const migration = await runtimeStack.proofAwarePlayFab.readDiamondsMigrationProof(
                    configuration.playFabId
                );
                const providerProof = operation?.operation?.immutableHash
                    ? await runtimeStack.proofAwarePlayFab.verifyTrustedOperation({
                        playFabId: configuration.playFabId,
                        operationId: DIAMONDS_SANDBOX_CANARY_SPEND_OPERATION_ID,
                        operationHash: operation.operation.immutableHash
                    })
                    : null;
                const receiptKeys = await persistDiamondReceiptV2.inspect(syntheticReceipt);
                const transaction = await ledger.getTransaction({
                    provider: "xsolla",
                    providerTransactionId: syntheticReceipt.transactionId
                });
                const legacyProfile = await legacyProbe.preflight();
                return Object.freeze({
                    titleId: configuration.titleId,
                    productionTitleId: DIAMONDS_SANDBOX_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID,
                    productionTitleUntouched: true,
                    playFabId: configuration.playFabId,
                    legacyValue: observation.legacyValue,
                    legacyProfileDiamonds: legacyProfile.profileDiamonds,
                    providerProfileVersion: observation.providerProfileVersion,
                    providerStateDigest: observation.providerStateDigest,
                    providerFence: observation.fence,
                    target: snapshot,
                    migrationProof: migration.proof,
                    migrationProfileVersion: migration.profileVersion,
                    operation,
                    resolution,
                    activeLease: lease,
                    providerProof,
                    syntheticReceipt: Object.freeze({
                        providerTransactionId: syntheticReceipt.transactionId,
                        v2Present: receiptKeys.v2Value !== null,
                        v2Compatible: receiptKeys.v2Value === null ||
                            receiptKeys.v2Value === serializeXsollaDiamondReceiptV2(syntheticReceipt),
                        legacyPresent: receiptKeys.legacyValue !== null,
                        ledgerTransaction: transaction
                    })
                });
            },
            async readRecoveryRedisRecords() {
                const keys = recoveryImporter.keys;
                const raw = await redis.sendCommand([
                    "MGET", keys.operation, keys.resolution, keys.previousResolution,
                    keys.eventIndex, keys.audit
                ]);
                if (!Array.isArray(raw) || raw.length !== 5) {
                    throw coded("DIAMONDS_RECOVERY_REDIS_PROTOCOL",
                        "Recovery Redis evidence read returned invalid data.");
                }
                const parse = (value, label) => {
                    if (value === null) return null;
                    try {
                        const parsed = JSON.parse(value);
                        if (!plain(parsed)) throw new Error();
                        return parsed;
                    } catch {
                        throw coded("DIAMONDS_RECOVERY_REDIS_PROTOCOL", label + " is malformed.");
                    }
                };
                return Object.freeze({
                    operationRecord: parse(raw[0], "Recovery Inbox record"),
                    resolutionRecord: parse(raw[1], "Recovery resolution record"),
                    previousResolution: parse(raw[2], "Previous resolution record"),
                    eventIndexRecord: parse(raw[3], "Recovery event-index record"),
                    audit: parse(raw[4], "Recovery audit record")
                });
            },
            async acquireRecoveryPlayerLease() {
                if (configuration.titleId !== CANARY02_SPEND10_RECOVERY_CONTRACT.titleId ||
                    configuration.playFabId !== CANARY02_SPEND10_RECOVERY_CONTRACT.playFabId) {
                    throw coded("DIAMONDS_RECOVERY_IDENTITY_INVALID",
                        "Original-operation recovery is restricted to canary_02 Sandbox.");
                }
                return runtimeStack.playerLeases.acquire({
                    playFabId: configuration.playFabId,
                    owner: "diamonds-canary-original-recovery",
                    token: randomBytes(48).toString("base64url"),
                    ttlMilliseconds: 15_000
                });
            },
            importRecoveredOriginalOperation({ plan, lease }) {
                if (!plain(lease) || lease.playFabId !== configuration.playFabId) {
                    throw coded("DIAMONDS_RECOVERY_LEASE_INVALID", "Recovery lease is invalid.");
                }
                return recoveryImporter.importRecoveredOriginal({
                    plan,
                    playerLeaseToken: lease.token,
                    playerFencingEpoch: lease.epoch
                });
            },
            releaseRecoveryPlayerLease({ lease }) {
                if (!plain(lease) || lease.playFabId !== configuration.playFabId) {
                    throw coded("DIAMONDS_RECOVERY_LEASE_INVALID", "Recovery lease is invalid.");
                }
                return runtimeStack.playerLeases.release({
                    playFabId: configuration.playFabId,
                    token: lease.token,
                    epoch: lease.epoch
                });
            },
            readProviderHttpMetrics() {
                return runtimeStack.snapshotStore.httpMetricsSnapshot();
            },
            readProofWriteDiagnostics() {
                return runtimeStack.proofAwarePlayFab.proofWriteDiagnostics();
            },
            consumeExistingTargetOperation({ operationId, consumer = "diamonds-canary-finish" }) {
                return runtimeStack.canonicalRuntime.gameplay.consumeTrustedGameplayOperation({
                    playFabId: configuration.playFabId,
                    operationId,
                    consumer
                });
            },
            readTargetOperation({ operationId }) {
                return runtimeStack.operationInbox.get(configuration.playFabId, operationId);
            },
            verifyTargetOperation({ operationId, operationHash }) {
                return runtimeStack.proofAwarePlayFab.verifyTrustedOperation({
                    playFabId: configuration.playFabId, operationId, operationHash
                });
            },
            async verifyTerminalTargetOperation({ operationId }) {
                const record = await runtimeStack.operationInbox.get(configuration.playFabId, operationId);
                const metadata = await runtimeStack.snapshotStore.readWithMetadata(configuration.playFabId);
                const proof = metadata?.highValueProof;
                const operation = record?.operation;
                const verified = record?.state === "Acked" && metadata?.exists === true &&
                    proof?.schemaVersion === 1 && proof.playFabId === configuration.playFabId &&
                    proof.sequence === record.sequence && proof.operationId === operationId &&
                    proof.eventId === operation?.eventId && proof.immutableHash === operation?.immutableHash &&
                    metadata.snapshot?.highValueAppliedThroughSequence === record.sequence;
                return Object.freeze({
                    verified,
                    playFabId: configuration.playFabId,
                    operationId,
                    sequence: record?.sequence ?? null,
                    eventId: operation?.eventId ?? null,
                    operationHash: operation?.immutableHash ?? null,
                    delta: operation?.diamondsDelta ?? null,
                    outcome: record?.result?.status ?? null,
                    balance: metadata?.snapshot?.diamonds ?? null,
                    revision: metadata?.snapshot?.revision ?? null,
                    fencingEpoch: metadata?.snapshot?.fencingEpoch ?? null,
                    proof: proof || null
                });
            },
            async executeTargetOperation({ operation, operationId, eventId, delta }) {
                const result = await targetAdapter.mutate({
                    playFabId: configuration.playFabId,
                    sessionId: "diamonds-sandbox-canary-cli-session",
                    sessionEpoch: operationEpoch++,
                    operationId,
                    eventId,
                    delta,
                    reason: `canary_${operation}`,
                    contextId: `sandbox:${operation}`
                });
                return interpretDiamondsCanaryTargetOperationResult({ result, delta });
            },
            async ensureSyntheticXsd2() {
                await persistLedgeredReceipt(syntheticReceipt);
                return Object.freeze({ providerTransactionId: syntheticReceipt.transactionId });
            },
            projectTrustedXsd2(input) { return xsd2.producer.projectTransaction(input); },
            readLedgerTransaction({ providerTransactionId }) {
                return ledger.requireTransaction({ provider: "xsolla", providerTransactionId });
            },
            async readMigrationProof() {
                return (await runtimeStack.proofAwarePlayFab.readDiamondsMigrationProof(
                    configuration.playFabId
                )).proof;
            },
            async getSyntheticProviderTransactionId() { return syntheticReceipt.transactionId; },
            assertStaleLegacyWriteBlocked() {
                return legacyProbe.assertStaleLegacyWriteBlocked({
                    performWrite: configuration.staleLegacyWriteEnabled ?? configuration.mode === "apply"
                });
            }
        };
        return Object.freeze({
            dependencies,
            async close() {
                if (closed) return;
                closed = true;
                await redis.quit();
            }
        });
    } catch (error) {
        if (!closed) {
            closed = true;
            await redis.quit().catch(() => redis.disconnect());
        }
        throw error;
    }
}

export async function runLiveDiamondsSandboxCanary({
    mode,
    environment = process.env,
    dependencyFactory = createLiveDiamondsSandboxCanaryDependencies
} = {}) {
    const configuration = readDiamondsSandboxCanaryApplyEnvironment({ environment, mode });
    const live = await dependencyFactory(configuration);
    try {
        return await runDiamondsSandboxCanaryApplyHarness({
            mode,
            explicitlyEnabled: configuration.explicitEnabled,
            dependencies: live.dependencies
        });
    } finally {
        await live.close();
    }
}

async function main() {
    const mode = process.argv[2];
    const result = await runLiveDiamondsSandboxCanary({ mode });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            code: error?.code || "DIAMONDS_SANDBOX_CANARY_FAILED",
            message: error?.message || "Diamonds Sandbox Canary failed."
        })}\n`);
        process.exitCode = 1;
    });
}
