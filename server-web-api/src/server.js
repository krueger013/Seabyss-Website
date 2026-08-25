import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";
import {
    createMemoryXsollaEventStore,
    createRedisXsollaEventStore,
    createXsollaWebhookHandler
} from "./xsolla-webhook.js";
import { createPlayFabUserValidator } from "./playfab-user-validator.js";
import { createPlayFabPremiumEntitlementStore } from "./playfab-premium-entitlement-store.js";
import { createPlayFabXsollaDiamondReceiptStore } from "./playfab-xsolla-diamond-receipt-store.js";
import { createPlayFabXsollaStarterReceiptStore } from "./playfab-xsolla-starter-receipt-store.js";
import { createPlayFabXsollaPremiumProductReceiptStore } from "./playfab-xsolla-premium-product-receipt-store.js";
import { createXsollaPremiumEventProcessor } from "./xsolla-premium-processor.js";
import {
    createCachedPlayFabSessionTicketAuthenticator,
    createPlayFabSessionTicketAuthenticator
} from "./playfab-session-ticket-authenticator.js";
import { createPlayFabStarterOwnershipReader } from "./playfab-starter-ownership-reader.js";
import { createXsollaAdminPaymentTokenProvider } from "./xsolla-admin-payment-token-provider.js";
import { createXsollaCheckoutService } from "./xsolla-checkout-service.js";
import { createXsollaCheckoutHttpHandler } from "./xsolla-checkout-http.js";
import { createCheckoutRateLimiter } from "./checkout-rate-limiter.js";
import {
    createMemoryXsollaStarterReservationStore,
    createRedisXsollaStarterReservationStore
} from "./xsolla-starter-reservation-store.js";
import { createPlayFabXsollaDiamondReceiptV2Store } from "./playfab-xsolla-diamond-receipt-v2-store.js";
import { createPlayFabXsollaStarterReceiptV2Store } from "./playfab-xsolla-starter-receipt-v2-store.js";
import { createPlayFabXsollaReconciliationCaseStore } from "./playfab-xsolla-reconciliation-case-store.js";
import { createXsollaStarterPaidCoordinator } from "./xsolla-starter-paid-coordinator.js";
import { createXsollaHardenedCatalogEventProcessor } from "./xsolla-hardened-catalog-processor.js";
import { createMemoryPaymentLedgerStore } from "./payment-ledger-memory-store.js";
import { createRedisPaymentLedgerStore } from "./payment-ledger-redis-store.js";
import { createPaymentLedger } from "./payment-ledger.js";
import { createXsollaLedgeredReceiptProcessor } from "./xsolla-ledgered-receipt-processor.js";
import { createPaymentReversalService } from "./payment-reversal-service.js";
import { createXsollaReversalEventProcessor } from "./xsolla-reversal-event-processor.js";
import { createXsollaPurchaseGateProcessor } from "./xsolla-purchase-gate-processor.js";
import { createPaymentMetrics } from "./payment-observability.js";
import { createPaymentScanners } from "./payment-scanners.js";
import { createXsollaFinancialExceptionRecorder } from "./xsolla-financial-exception-recorder.js";
import { createPlayFabXsollaV2ReceiptReader } from "./playfab-xsolla-v2-receipt-reader.js";
import { createPaymentWorkerService } from "./payment-worker-service.js";
import { createPlayFabEconomyV2GrantAdapter } from "./playfab-economy-v2-grant-adapter.js";
import { createPlayFabFinancialAuthorityStore } from "./playfab-financial-authority-store.js";
import { createPlayFabFinancialAuthorityGrantAdapter } from "./playfab-financial-authority-grant-adapter.js";
import { createXsollaFinancialAuthorityWorker } from "./xsolla-financial-authority-worker.js";
import { evaluateFinancialAuthorityReadiness, parseEconomyV2CatalogMappings } from "./financial-authority-readiness.js";
import { createPlayFabFinancialReadinessVerifier } from "./playfab-financial-readiness-verifier.js";
import { evaluateFinancialShadowPolicy } from "./financial-shadow-policy.js";
import { createFinancialShadowMetrics } from "./financial-shadow-model.js";
import { createRedisFinancialShadowStateStore } from "./financial-shadow-store.js";
import { createFinancialShadowRuntime } from "./financial-shadow-runtime.js";
import {
    createFinancialShadowHttpHandlers,
    financialShadowRateLimitKey,
    registerFinancialShadowRoutes
} from "./financial-shadow-http.js";
import { createRedisCompatibleServerEconomyPocOperationInbox } from "./server-economy-poc-redis-stores.js";
import { createFinancialShadowPocInboxService } from "./financial-shadow-poc-inbox-service.js";
import { createFinancialShadowPaymentProducer } from "./financial-shadow-payment-producer.js";
import { wrapLedgeredReceiptProcessorWithFinancialShadow } from "./financial-shadow-payment-hook.js";
import { evaluateFinancialDomainStartupSafety } from "./progressive-financial-domain-migration.js";
import {
    createDiamondsDomainServerComposition,
    loadDiamondsReadinessCertificate
} from "./diamonds-domain-server-composition.js";
import { registerDiamondsDomainTargetRoutes } from "./diamonds-domain-target-http.js";
import {
    createDiamondsCanaryXsd2Composition
} from "./diamonds-canary-xsd2-composition.js";

const app = express();

const config = {
    nodeEnv: process.env.NODE_ENV || "development",
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 3000),
    publicOrigins: String(process.env.PUBLIC_SITE_ORIGIN || "http://localhost:8080")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    playFabTitleId: process.env.PLAYFAB_TITLE_ID,
    playFabSecretKey: process.env.PLAYFAB_SECRET_KEY,
    sessionSecret: process.env.SESSION_SECRET,
    seabyssEnv: process.env.SEABYSS_ENV || "beta",
    redisUrl: process.env.REDIS_URL,
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 86400),
    upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 8000),
    xsollaWebhookSecret: process.env.XSOLLA_WEBHOOK_SECRET,
    xsollaProjectId: process.env.XSOLLA_PROJECT_ID,
    xsollaPremiumPlanId: process.env.XSOLLA_PREMIUM_PLAN_ID,
    xsollaPremiumPlanExternalId: process.env.XSOLLA_PREMIUM_PLAN_EXTERNAL_ID,
    xsollaAllowSandboxGrants: process.env.XSOLLA_ALLOW_SANDBOX_GRANTS === "true",
    xsollaSandboxTestPlayFabIds: String(process.env.XSOLLA_SANDBOX_TEST_PLAYFAB_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    xsollaAllowStarterSandboxGrants: process.env.XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS === "true",
    xsollaStarterSandboxTestPlayFabIds: String(process.env.XSOLLA_STARTER_SANDBOX_TEST_PLAYFAB_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    xsollaAllowStarterProductionGrants: process.env.XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS === "true",
    xsollaAllowDiamondProductionGrants: process.env.XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS === "true",
    xsollaEnableStandalonePremiumProducts: process.env.XSOLLA_ENABLE_STANDALONE_PREMIUM_PRODUCTS === "true",
    purchasesGlobalEnabled: process.env.PURCHASES_GLOBAL_ENABLED === "true",
    purchasesDiamondEnabled: process.env.PURCHASES_DIAMOND_ENABLED === "true",
    purchasesStarterEnabled: process.env.PURCHASES_STARTER_ENABLED === "true",
    purchasesPremiumEnabled: process.env.PURCHASES_PREMIUM_ENABLED === "true",
    purchasesDoublerEnabled: process.env.PURCHASES_DOUBLER_ENABLED === "true",
    xsollaHardenedCatalogEnabled: process.env.XSOLLA_HARDENED_CATALOG_ENABLED === "true",
    xsollaCheckoutMode: process.env.XSOLLA_CHECKOUT_MODE || "sandbox",
    xsollaCheckoutSandboxEnabled: process.env.XSOLLA_CHECKOUT_SANDBOX_ENABLED === "true",
    xsollaCheckoutProductionEnabled: process.env.XSOLLA_CHECKOUT_PRODUCTION_ENABLED === "true",
    xsollaCheckoutAllowedSkus: String(process.env.XSOLLA_CHECKOUT_ALLOWED_SKUS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    xsollaApiKey: process.env.XSOLLA_API_KEY,
    playFabFinancialProfileEnabled: process.env.PLAYFAB_FINANCIAL_PROFILE_ENABLED === "true",
    playFabFinancialAuthorityCutoverEnabled:
        process.env.PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED === "true",
    playFabEconomyV2Enabled: process.env.PLAYFAB_ECONOMY_V2_ENABLED === "true",
    playFabFinancialAuthorityV2Enabled:
        process.env.PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED === "true",
    playFabEconomyV2CatalogMappingsJson:
        process.env.PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON || "{}",
    playFabEconomyV2CollectionId: process.env.PLAYFAB_ECONOMY_V2_COLLECTION_ID || "default",
    unityFinancialAuthorityVersion: process.env.UNITY_FINANCIAL_AUTHORITY_VERSION || "legacy_profile_v1",
    playFabFinancialMigrationVersion: process.env.PLAYFAB_FINANCIAL_MIGRATION_VERSION || "none",
    playFabFinancialRevisionCasEnabled: process.env.PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED === "true",
    playFabFinancialServerOwnedFieldsEnabled: process.env.PLAYFAB_FINANCIAL_SERVER_OWNED_FIELDS_ENABLED === "true",
    playFabFinancialRefreshEnabled: process.env.PLAYFAB_FINANCIAL_REFRESH_ENABLED === "true",
    playFabFinancialAuthorityPolicyResource:
        process.env.PLAYFAB_FINANCIAL_AUTHORITY_POLICY_RESOURCE || "",
    paymentWorkerEnabled: process.env.PAYMENT_WORKER_ENABLED === "true",
    paymentWorkerPollIntervalMs: Number(process.env.PAYMENT_WORKER_POLL_INTERVAL_MS || 5000),
    paymentWorkerBatchSize: Number(process.env.PAYMENT_WORKER_BATCH_SIZE || 8),
    paymentWorkerMaximumRetries: Number(process.env.PAYMENT_WORKER_MAXIMUM_RETRIES || 12),
    paymentWorkerBackoffBaseMs: Number(process.env.PAYMENT_WORKER_BACKOFF_BASE_MS || 1000),
    paymentWorkerBackoffMaximumMs: Number(process.env.PAYMENT_WORKER_BACKOFF_MAXIMUM_MS || 1800000),
    paymentWorkerLeaseTtlMs: Number(process.env.PAYMENT_WORKER_LEASE_TTL_MS || 30000),
    paymentWorkerLeaseRenewMs: Number(process.env.PAYMENT_WORKER_LEASE_RENEW_MS || 10000),
    paymentWorkerCasAttempts: Number(process.env.PAYMENT_WORKER_CAS_ATTEMPTS || 5),
    paymentFinancialProfileMaxBytes: Number(process.env.PAYMENT_FINANCIAL_PROFILE_MAX_BYTES || 65536),
    paymentFinancialOperationHistoryLimit: Number(process.env.PAYMENT_FINANCIAL_OPERATION_HISTORY_LIMIT || 1024),
    financialShadowModeEnabled: process.env.FINANCIAL_SHADOW_MODE_ENABLED === "true",
    financialShadowEnvironment: process.env.FINANCIAL_SHADOW_ENVIRONMENT || "sandbox",
    financialShadowAllowedPlayFabIds: String(process.env.FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    financialShadowServerId: process.env.FINANCIAL_SHADOW_SERVER_ID || "",
    financialShadowPresenceLeaseTtlMs: Number(process.env.FINANCIAL_SHADOW_PRESENCE_LEASE_TTL_MS || 15000),
    financialShadowAuthCacheTtlMs: Number(process.env.FINANCIAL_SHADOW_AUTH_CACHE_TTL_MS || 5000),
    financialShadowAuthCacheMaximumEntries: Number(process.env.FINANCIAL_SHADOW_AUTH_CACHE_MAXIMUM_ENTRIES || 2000),
    financialShadowPerTicketRateLimit: Number(process.env.FINANCIAL_SHADOW_PER_TICKET_RATE_LIMIT || 600),
    financialShadowGlobalRateLimit: Number(process.env.FINANCIAL_SHADOW_GLOBAL_RATE_LIMIT || 30000),
    financialShadowPocMirrorPollIntervalMs: Number(process.env.FINANCIAL_SHADOW_POC_MIRROR_POLL_INTERVAL_MS || 2000),
    financialShadowMaximumCasAttempts: Number(process.env.FINANCIAL_SHADOW_MAXIMUM_CAS_ATTEMPTS || 12),
    financialShadowMaximumHistoryEntries: Number(process.env.FINANCIAL_SHADOW_MAXIMUM_HISTORY_ENTRIES || 2000),
    diamondsReadinessCertificatePath: process.env.FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH || "",
    diamondsTargetRedisPrefix:
        process.env.FINANCIAL_DIAMONDS_TARGET_REDIS_PREFIX || "seabyss:financial:diamonds:target:v1:",
    diamondsGameServerId: process.env.FINANCIAL_DIAMONDS_GAME_SERVER_ID || "",
    diamondsGameServerToken: process.env.FINANCIAL_DIAMONDS_GAME_SERVER_TOKEN || ""
};

const allowedNodeEnvironments = new Set(["development", "test", "production"]);
if (!allowedNodeEnvironments.has(config.nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production.");
}

const isProduction = config.nodeEnv === "production";
const sessionCookieName = isProduction ? "__Host-seabyss.sid" : "seabyss.sid";

if (isProduction && (
    !config.sessionSecret ||
    Buffer.byteLength(config.sessionSecret, "utf8") < 32 ||
    config.sessionSecret === "change_me_long_random_secret"
)) {
    throw new Error("SESSION_SECRET must contain at least 32 random bytes in production.");
}

if (isProduction && !config.playFabTitleId) {
    throw new Error("PLAYFAB_TITLE_ID is required in production.");
}

if (isProduction && !config.playFabSecretKey) {
    throw new Error("PLAYFAB_SECRET_KEY is required in production.");
}

if (isProduction && !config.redisUrl) {
    throw new Error("REDIS_URL is required in production.");
}

if (!Number.isFinite(config.sessionTtlSeconds) || config.sessionTtlSeconds < 300) {
    throw new Error("SESSION_TTL_SECONDS must be a number of at least 300 seconds.");
}

if (!Number.isInteger(config.upstreamTimeoutMs) || config.upstreamTimeoutMs < 1000 || config.upstreamTimeoutMs > 30000) {
    throw new Error("UPSTREAM_TIMEOUT_MS must be an integer between 1000 and 30000 milliseconds.");
}

if (config.xsollaCheckoutMode !== "sandbox" && config.xsollaCheckoutMode !== "production") {
    throw new Error("XSOLLA_CHECKOUT_MODE must be sandbox or production.");
}

for (const [name, value, minimum, maximum] of [
    ["PAYMENT_WORKER_POLL_INTERVAL_MS", config.paymentWorkerPollIntervalMs, 250, 60_000],
    ["PAYMENT_WORKER_BATCH_SIZE", config.paymentWorkerBatchSize, 1, 100],
    ["PAYMENT_WORKER_MAXIMUM_RETRIES", config.paymentWorkerMaximumRetries, 1, 100],
    ["PAYMENT_WORKER_BACKOFF_BASE_MS", config.paymentWorkerBackoffBaseMs, 1, 60_000],
    ["PAYMENT_WORKER_BACKOFF_MAXIMUM_MS", config.paymentWorkerBackoffMaximumMs, 1, 3_600_000],
    ["PAYMENT_WORKER_LEASE_TTL_MS", config.paymentWorkerLeaseTtlMs, 1_000, 300_000],
    ["PAYMENT_WORKER_CAS_ATTEMPTS", config.paymentWorkerCasAttempts, 1, 20],
    ["PAYMENT_FINANCIAL_PROFILE_MAX_BYTES", config.paymentFinancialProfileMaxBytes, 1024, 1024 * 1024],
    ["PAYMENT_FINANCIAL_OPERATION_HISTORY_LIMIT", config.paymentFinancialOperationHistoryLimit, 1, 100_000],
    ["FINANCIAL_SHADOW_PRESENCE_LEASE_TTL_MS", config.financialShadowPresenceLeaseTtlMs, 1000, 300_000],
    ["FINANCIAL_SHADOW_AUTH_CACHE_TTL_MS", config.financialShadowAuthCacheTtlMs, 250, 60_000],
    ["FINANCIAL_SHADOW_AUTH_CACHE_MAXIMUM_ENTRIES", config.financialShadowAuthCacheMaximumEntries, 1, 100_000],
    ["FINANCIAL_SHADOW_PER_TICKET_RATE_LIMIT", config.financialShadowPerTicketRateLimit, 10, 10_000],
    ["FINANCIAL_SHADOW_GLOBAL_RATE_LIMIT", config.financialShadowGlobalRateLimit, 100, 100_000],
    ["FINANCIAL_SHADOW_POC_MIRROR_POLL_INTERVAL_MS", config.financialShadowPocMirrorPollIntervalMs, 250, 60_000],
    ["FINANCIAL_SHADOW_MAXIMUM_CAS_ATTEMPTS", config.financialShadowMaximumCasAttempts, 1, 100],
    ["FINANCIAL_SHADOW_MAXIMUM_HISTORY_ENTRIES", config.financialShadowMaximumHistoryEntries, 1, 100_000]
]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} is outside its safe range.`);
    }
}
if (!Number.isSafeInteger(config.paymentWorkerLeaseRenewMs) ||
    config.paymentWorkerLeaseRenewMs < 0 ||
    config.paymentWorkerLeaseRenewMs >= config.paymentWorkerLeaseTtlMs) {
    throw new Error("PAYMENT_WORKER_LEASE_RENEW_MS must be non-negative and below the lease TTL.");
}
if (config.paymentWorkerBackoffBaseMs > config.paymentWorkerBackoffMaximumMs) {
    throw new Error("Payment worker retry backoff is inconsistent.");
}
if (config.paymentWorkerEnabled && !config.playFabFinancialProfileEnabled) {
    throw new Error("PAYMENT_WORKER_ENABLED requires PLAYFAB_FINANCIAL_PROFILE_ENABLED=true.");
}
if (config.paymentWorkerEnabled && !config.playFabFinancialAuthorityCutoverEnabled) {
    throw new Error("PAYMENT_WORKER_ENABLED requires PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=true.");
}
const financialAuthorityReadiness = evaluateFinancialAuthorityReadiness({
    cutoverEnabled: config.playFabFinancialAuthorityCutoverEnabled,
    economyV2Enabled: config.playFabEconomyV2Enabled,
    authorityV2Enabled: config.playFabFinancialAuthorityV2Enabled,
    unityAuthorityVersion: config.unityFinancialAuthorityVersion,
    migrationVersion: config.playFabFinancialMigrationVersion,
    revisionCasEnabled: config.playFabFinancialRevisionCasEnabled,
    serverOwnedFieldsEnabled: config.playFabFinancialServerOwnedFieldsEnabled,
    financialRefreshEnabled: config.playFabFinancialRefreshEnabled,
    catalogMappings: config.playFabEconomyV2CatalogMappingsJson
});
if (financialAuthorityReadiness.activationRequested && !financialAuthorityReadiness.ready) {
    throw new Error(
        "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=true is unsafe: " +
        financialAuthorityReadiness.errors.join(", ")
    );
}

// Legacy never reads a certificate. Any future Diamonds Shadow/Canary/Cutover
// request must load and verify explicit local readiness evidence before Redis
// or PlayFab runtime construction is even considered.
const diamondsReadinessCertificate = config.diamondsReadinessCertificatePath
    ? loadDiamondsReadinessCertificate({
        mode: process.env.FINANCIAL_DIAMONDS_MODE || "Legacy",
        certificatePath: config.diamondsReadinessCertificatePath
    })
    : null;
const progressiveDomainStartupSafety = evaluateFinancialDomainStartupSafety({
    environment: process.env,
    readinessByDomain: diamondsReadinessCertificate
        ? { Diamonds: diamondsReadinessCertificate }
        : {}
});
if (!progressiveDomainStartupSafety.safe) {
    const details = Object.values(progressiveDomainStartupSafety.domains)
        .flatMap((domain) => domain.errors)
        .join(", ");
    throw new Error(`Progressive financial domain activation is unsafe: ${details}`);
}

const financialShadowPolicy = evaluateFinancialShadowPolicy({
    enabled: config.financialShadowModeEnabled,
    nodeEnv: config.nodeEnv,
    shadowEnvironment: config.financialShadowEnvironment,
    allowlistedPlayFabIds: config.financialShadowAllowedPlayFabIds,
    serverId: config.financialShadowServerId,
    redisConfigured: Boolean(config.redisUrl),
    playFabConfigured: Boolean(config.playFabTitleId && config.playFabSecretKey),
    purchasesGlobalEnabled: config.purchasesGlobalEnabled,
    purchasesDiamondEnabled: config.purchasesDiamondEnabled,
    purchasesStarterEnabled: config.purchasesStarterEnabled,
    purchasesPremiumEnabled: config.purchasesPremiumEnabled,
    purchasesDoublerEnabled: config.purchasesDoublerEnabled,
    checkoutSandboxEnabled: config.xsollaCheckoutSandboxEnabled,
    checkoutProductionEnabled: config.xsollaCheckoutProductionEnabled,
    hardenedCatalogEnabled: config.xsollaHardenedCatalogEnabled,
    financialAuthorityCutoverEnabled: config.playFabFinancialAuthorityCutoverEnabled
});

if (isProduction && config.purchasesGlobalEnabled && !config.xsollaHardenedCatalogEnabled) {
    throw new Error("Production purchases require XSOLLA_HARDENED_CATALOG_ENABLED=true.");
}

if (isProduction && config.purchasesGlobalEnabled && !config.redisUrl) {
    throw new Error("Production purchases require Redis.");
}

const anyPurchaseFamilyEnabled = config.purchasesDiamondEnabled ||
    config.purchasesStarterEnabled || config.purchasesPremiumEnabled ||
    config.purchasesDoublerEnabled;
if (isProduction && anyPurchaseFamilyEnabled && !config.purchasesGlobalEnabled) {
    throw new Error("Production purchase family gates require PURCHASES_GLOBAL_ENABLED=true.");
}
if (isProduction && config.purchasesGlobalEnabled && !anyPurchaseFamilyEnabled) {
    throw new Error("Production purchases require at least one explicit family gate.");
}
if (isProduction && config.purchasesGlobalEnabled &&
    !config.playFabFinancialProfileEnabled) {
    throw new Error("Production purchases require PLAYFAB_FINANCIAL_PROFILE_ENABLED=true.");
}
if (isProduction && config.purchasesGlobalEnabled && !config.paymentWorkerEnabled) {
    throw new Error("Production purchases require PAYMENT_WORKER_ENABLED=true.");
}
if (isProduction && config.purchasesGlobalEnabled &&
    !config.playFabFinancialAuthorityCutoverEnabled) {
    throw new Error("Production purchases require PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=true.");
}
if (isProduction && config.purchasesGlobalEnabled && config.purchasesPremiumEnabled) {
    throw new Error("Production standalone Premium purchases require immutable v2 receipt worker support.");
}
if (isProduction && config.purchasesGlobalEnabled && config.purchasesDoublerEnabled) {
    throw new Error("Production Doubler purchases require immutable v2 receipt worker support.");
}
if (isProduction && config.purchasesGlobalEnabled &&
    (config.xsollaCheckoutMode !== "production" ||
        !config.xsollaCheckoutProductionEnabled)) {
    throw new Error("Production purchases require the explicit Production checkout gate.");
}

if (!config.playFabTitleId) {
    console.warn("PLAYFAB_TITLE_ID is not configured. Login will fail until the server .env is completed.");
}

if (!config.xsollaWebhookSecret) {
    console.error("XSOLLA_WEBHOOK_SECRET is not configured. The Xsolla webhook endpoint will reject all requests.");
}

if (!config.xsollaProjectId) {
    console.error("XSOLLA_PROJECT_ID is not configured. The Xsolla webhook endpoint will reject all requests.");
}

if (!config.xsollaPremiumPlanId) {
    console.error("XSOLLA_PREMIUM_PLAN_ID is not configured. Premium payment events will fail closed.");
}

if (config.xsollaAllowSandboxGrants) {
    console.warn("Xsolla Sandbox grants are enabled for an explicit test allowlist.", {
        allowlistedUserCount: new Set(config.xsollaSandboxTestPlayFabIds).size
    });
}

if (config.xsollaAllowStarterSandboxGrants) {
    console.warn("Xsolla Starter Pack Sandbox grants are enabled for an explicit test allowlist.", {
        allowlistedUserCount: new Set(config.xsollaStarterSandboxTestPlayFabIds).size
    });
}

console.info("Payment gates initialized.", {
    global: config.purchasesGlobalEnabled,
    diamond: config.purchasesDiamondEnabled,
    starter: config.purchasesStarterEnabled,
    premium: config.purchasesPremiumEnabled,
    doubler: config.purchasesDoublerEnabled,
    checkoutMode: config.xsollaCheckoutMode,
    checkoutSandbox: config.xsollaCheckoutSandboxEnabled,
    checkoutProduction: config.xsollaCheckoutProductionEnabled,
    checkoutSkuCount: new Set(config.xsollaCheckoutAllowedSkus).size
});

app.set("trust proxy", isProduction ? 1 : 0);
app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
    origin(origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }

        if (origin && config.publicOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        const error = new Error("CORS origin not allowed.");
        error.publicStatus = 403;
        callback(error);
    },
    credentials: true
}));

app.use([
    "/register",
    "/auth/login",
    "/auth/logout",
    "/auth/session",
    "/me"
], preventSensitiveResponseCaching);

let xsollaWebhookHandler = null;
app.post(
    "/xsolla/webhook",
    preventSensitiveResponseCaching,
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res, next) => {
        try {
            if (!xsollaWebhookHandler) {
                throw new Error("Xsolla webhook handler is not initialized.");
            }
            await xsollaWebhookHandler(req, res);
        } catch (error) {
            next(error);
        }
    }
);

app.use(express.json({ limit: "16kb" }));

let xsollaCheckoutHandler = null;
app.post(
    "/payments/checkout",
    preventSensitiveResponseCaching,
    requireJsonObject,
    async (req, res, next) => {
        try {
            if (!xsollaCheckoutHandler) {
                throw new Error("Xsolla checkout handler is not initialized.");
            }
            await xsollaCheckoutHandler(req, res);
        } catch (error) {
            next(error);
        }
    }
);

async function createSessionStore() {
    if (!config.redisUrl) {
        if (isProduction) {
            throw new Error("Redis session store is required in production.");
        }

        console.warn("REDIS_URL is not configured. Using MemoryStore for local development only.");
        return {
            sessionStore: undefined,
            redisClient: null
        };
    }

    const redisClient = createClient({
        url: config.redisUrl,
        socket: {
            reconnectStrategy(retries) {
                return Math.min(retries * 50, 1000);
            }
        }
    });

    redisClient.on("error", (error) => {
        console.error("Redis session store error", {
            message: error.message
        });
    });

    try {
        await redisClient.connect();
        await redisClient.ping();
    } catch (error) {
        if (isProduction) {
            throw new Error(`Redis session store unavailable: ${error.message}`);
        }

        console.warn("Redis unavailable. Using MemoryStore for local development only.");
        return {
            sessionStore: undefined,
            redisClient: null
        };
    }

    return {
        sessionStore: new RedisStore({
            client: redisClient,
            prefix: "seabyss:web:sess:",
            ttl: config.sessionTtlSeconds
        }),
        redisClient
    };
}

const sessionInfrastructure = await createSessionStore();
const sessionStore = sessionInfrastructure.sessionStore;
const diamondsDomainTarget = await createDiamondsDomainServerComposition({
    configuration: progressiveDomainStartupSafety.domains.Diamonds,
    readinessCertificate: diamondsReadinessCertificate,
    redis: sessionInfrastructure.redisClient,
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    redisPrefix: config.diamondsTargetRedisPrefix,
    gameServerId: config.diamondsGameServerId,
    gameServerToken: config.diamondsGameServerToken,
    timeoutMs: config.upstreamTimeoutMs
});
app.locals.diamondsDomainTarget = Object.freeze({
    mode: diamondsDomainTarget.mode,
    active: diamondsDomainTarget.active,
    mutationActive: diamondsDomainTarget.mutationActive === true,
    targetAdapterComposed: diamondsDomainTarget.targetAdapterComposed === true,
    routesRegistered: diamondsDomainTarget.handlers !== null,
    runtimeDiagnostics: diamondsDomainTarget.runtimeDiagnostics
});
const xsollaEventStore = createRedisXsollaEventStore(sessionInfrastructure.redisClient) ||
    (!isProduction ? createMemoryXsollaEventStore() : null);
const paymentMetrics = createPaymentMetrics();
function observePaymentLog(level, ...args) {
    const details = args.find((value) => value && typeof value === "object" && !Array.isArray(value));
    const event = details?.event;
    const result = details?.result;
    try {
        if (event === "checkout_created") {
            paymentMetrics.record("checkout_created", {
                labels: { environment: details.mode || config.xsollaCheckoutMode }
            });
        } else if (event === "checkout_denied") {
            paymentMetrics.record("checkout_denied", {
                labels: { reason: String(details.reason || "unknown").toLowerCase() }
            });
        } else if (result === "invalid_signature") {
            paymentMetrics.record("webhook_rejected_signature");
        } else if (result === "invalid_project") {
            paymentMetrics.record("webhook_invalid_project");
        }
    } catch {
        // Observability must never alter payment semantics.
    }
    console[level](...args);
}
const paymentLogger = Object.freeze({
    info(...args) { observePaymentLog("info", ...args); },
    warn(...args) { observePaymentLog("warn", ...args); },
    error(...args) { observePaymentLog("error", ...args); }
});
const xsollaStarterReservationStore = sessionInfrastructure.redisClient
    ? createRedisXsollaStarterReservationStore(sessionInfrastructure.redisClient)
    : (!isProduction ? createMemoryXsollaStarterReservationStore() : null);
const authenticateCheckoutSession = createPlayFabSessionTicketAuthenticator({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const financialShadowAuthenticationCache = createCachedPlayFabSessionTicketAuthenticator({
    authenticate: authenticateCheckoutSession,
    ttlMilliseconds: config.financialShadowAuthCacheTtlMs,
    maximumEntries: config.financialShadowAuthCacheMaximumEntries
});
const financialShadowMetrics = createFinancialShadowMetrics();
const financialShadowStateStore = financialShadowPolicy.enabled
    ? createRedisFinancialShadowStateStore({
        redisClient: sessionInfrastructure.redisClient,
        prefix: "seabyss:financial:shadow:v1:"
    })
    : null;
const financialShadowRuntime = financialShadowPolicy.enabled
    ? createFinancialShadowRuntime({
        stateStore: financialShadowStateStore,
        policy: financialShadowPolicy,
        metrics: financialShadowMetrics,
        presenceLeaseTtlMilliseconds: config.financialShadowPresenceLeaseTtlMs,
        maximumCasAttempts: config.financialShadowMaximumCasAttempts,
        maximumHistoryEntries: config.financialShadowMaximumHistoryEntries
    })
    : null;
const financialShadowPocMirrorInbox = financialShadowPolicy.enabled
    ? Object.freeze({
        ...createRedisCompatibleServerEconomyPocOperationInbox({
            redis: sessionInfrastructure.redisClient,
            prefix: "seabyss:financial:shadow:poc-mirror:v1:"
        }),
        shadowProjectionOnly: true
    })
    : null;
const financialShadowPocInboxService = financialShadowPolicy.enabled
    ? createFinancialShadowPocInboxService({
        operationInbox: financialShadowPocMirrorInbox,
        runtime: financialShadowRuntime,
        serverId: financialShadowPolicy.serverId,
        intervalMilliseconds: config.financialShadowPocMirrorPollIntervalMs,
        hooks: {
            onLoopError(error) {
                console.warn("Financial Shadow POC mirror loop failed.", {
                    errorCode: error?.code || "FINANCIAL_SHADOW_POC_LOOP_FAILED"
                });
            }
        }
    })
    : null;
financialShadowPocInboxService?.start();
app.locals.financialShadowPocProjection = financialShadowPocInboxService
    ? Object.freeze({ enqueueCanonicalProjection: financialShadowPocInboxService.enqueueCanonicalProjection })
    : null;
const financialShadowHttpHandlers = createFinancialShadowHttpHandlers({
    policy: financialShadowPolicy,
    runtime: financialShadowRuntime,
    authenticateSessionTicket: financialShadowAuthenticationCache.authenticate,
    authenticationDiagnostics: financialShadowAuthenticationCache.diagnostics
});
if (financialShadowPolicy.enabled) {
    console.warn("Financial Shadow mode enabled for an explicit Sandbox allowlist.", {
        allowlistedUserCount: financialShadowPolicy.allowlistedPlayFabIds.length,
        authoritative: false,
        targetPlayFabWritesAllowed: false,
        canonicalPocMirrorWorker: true
    });
}
const readStarterPurchaseState = createPlayFabStarterOwnershipReader({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const createXsollaPaymentToken = createXsollaAdminPaymentTokenProvider({
    projectId: config.xsollaProjectId,
    apiKey: config.xsollaApiKey,
    mode: config.xsollaCheckoutMode,
    timeoutMs: config.upstreamTimeoutMs
});
const checkoutRateLimiter = createCheckoutRateLimiter({
    environment: config.nodeEnv,
    redisClient: sessionInfrastructure.redisClient,
    windowSeconds: 60,
    userLimit: 4,
    ipLimit: 20
});
const prepareXsollaCheckout = createXsollaCheckoutService({
    enabled: config.purchasesGlobalEnabled,
    allowSandbox: config.xsollaCheckoutSandboxEnabled,
    mode: config.xsollaCheckoutMode,
    allowProduction: config.xsollaCheckoutProductionEnabled,
    allowedSkus: config.xsollaCheckoutAllowedSkus,
    reservationStore: xsollaStarterReservationStore,
    readPurchaseState: readStarterPurchaseState,
    familyGates: {
        starter_pack: config.purchasesStarterEnabled,
        diamond_pack: config.purchasesDiamondEnabled,
        premium: config.purchasesPremiumEnabled,
        doubler: config.purchasesDoublerEnabled
    },
    createProviderToken: createXsollaPaymentToken
});
xsollaCheckoutHandler = createXsollaCheckoutHttpHandler({
    authenticateSessionTicket: authenticateCheckoutSession,
    rateLimiter: checkoutRateLimiter,
    prepareCheckout: prepareXsollaCheckout,
    logger: paymentLogger
});
const validateXsollaUser = createPlayFabUserValidator({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const persistXsollaPremiumEntitlement = createPlayFabPremiumEntitlementStore({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const persistXsollaDiamondReceipt = createPlayFabXsollaDiamondReceiptStore({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const persistXsollaStarterReceipt = createPlayFabXsollaStarterReceiptStore({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const persistXsollaPremiumProductReceipt = createPlayFabXsollaPremiumProductReceiptStore({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const legacyXsollaEventProcessor = createXsollaPremiumEventProcessor({
    premiumPlanId: config.xsollaPremiumPlanId,
    premiumPlanExternalId: config.xsollaPremiumPlanExternalId,
    allowSandboxGrants: config.xsollaAllowSandboxGrants,
    sandboxTestPlayFabIds: config.xsollaSandboxTestPlayFabIds,
    allowStarterSandboxGrants: config.xsollaAllowStarterSandboxGrants,
    starterSandboxTestPlayFabIds: config.xsollaStarterSandboxTestPlayFabIds,
    allowStarterProductionGrants: config.xsollaAllowStarterProductionGrants,
    enableStandalonePremiumProducts: config.xsollaEnableStandalonePremiumProducts,
    validateUser: validateXsollaUser,
    persistPremiumEntitlement: persistXsollaPremiumEntitlement,
    persistDiamondPackReceipt: persistXsollaDiamondReceipt,
    persistStarterPackReceipt: persistXsollaStarterReceipt,
    persistPremiumProductReceipt: persistXsollaPremiumProductReceipt
});
const persistXsollaDiamondReceiptV2 = createPlayFabXsollaDiamondReceiptV2Store({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const persistXsollaStarterReceiptV2 = createPlayFabXsollaStarterReceiptV2Store({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const persistXsollaReconciliationCase = createPlayFabXsollaReconciliationCaseStore({
    titleId: config.playFabTitleId,
    secretKey: config.playFabSecretKey,
    timeoutMs: config.upstreamTimeoutMs
});
const starterPaidCoordinator = createXsollaStarterPaidCoordinator({
    reservationStore: xsollaStarterReservationStore,
    persistReconciliationCase: persistXsollaReconciliationCase,
    requireReservation: true
});
const paymentLedgerStore = sessionInfrastructure.redisClient
    ? createRedisPaymentLedgerStore(sessionInfrastructure.redisClient)
    : (!isProduction ? createMemoryPaymentLedgerStore() : null);
if (!paymentLedgerStore) {
    throw new Error("A durable payment ledger store is required in production.");
}
const paymentLedger = createPaymentLedger({ store: paymentLedgerStore });
const playFabEconomyV2CatalogMappings = config.playFabFinancialAuthorityCutoverEnabled
    ? parseEconomyV2CatalogMappings(config.playFabEconomyV2CatalogMappingsJson)
    : null;
const playFabFinancialReadinessVerifier = config.playFabFinancialAuthorityCutoverEnabled
    ? createPlayFabFinancialReadinessVerifier({
        titleId: config.playFabTitleId,
        secretKey: config.playFabSecretKey,
        timeoutMilliseconds: config.upstreamTimeoutMs,
        catalogMappings: playFabEconomyV2CatalogMappings,
        protectedResource: config.playFabFinancialAuthorityPolicyResource
    })
    : null;
let latestPlayFabFinancialReadinessEvidence = null;
if (playFabFinancialReadinessVerifier) {
    latestPlayFabFinancialReadinessEvidence = await playFabFinancialReadinessVerifier.verify();
    if (!latestPlayFabFinancialReadinessEvidence.ready) {
        throw new Error(
            "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=true lacks verified PlayFab evidence: " +
            latestPlayFabFinancialReadinessEvidence.errors.join(", ")
        );
    }
}
const playFabEconomyV2GrantAdapter = config.playFabFinancialAuthorityCutoverEnabled
    ? createPlayFabEconomyV2GrantAdapter({
        titleId: config.playFabTitleId,
        secretKey: config.playFabSecretKey,
        timeoutMilliseconds: config.upstreamTimeoutMs,
        catalogMappings: playFabEconomyV2CatalogMappings,
        collectionId: config.playFabEconomyV2CollectionId
    })
    : null;
const playFabFinancialAuthorityStore = config.playFabFinancialAuthorityCutoverEnabled
    ? createPlayFabFinancialAuthorityStore({
        titleId: config.playFabTitleId,
        secretKey: config.playFabSecretKey,
        timeoutMs: config.upstreamTimeoutMs,
        maximumObjectBytes: config.paymentFinancialProfileMaxBytes,
        maximumAppliedOperations: config.paymentFinancialOperationHistoryLimit,
        maximumAppliedTransactions: config.paymentFinancialOperationHistoryLimit
    })
    : null;
const diamondsCanaryTargetActive = diamondsDomainTarget.mode === "Canary" &&
    diamondsDomainTarget.mutationActive === true;
const loadXsollaV2Receipt = (config.playFabFinancialAuthorityCutoverEnabled ||
    financialShadowPolicy.enabled || diamondsCanaryTargetActive)
    ? createPlayFabXsollaV2ReceiptReader({
        titleId: config.playFabTitleId,
        secretKey: config.playFabSecretKey,
        timeoutMilliseconds: config.upstreamTimeoutMs
    })
    : null;
const playFabFinancialAuthorityGrantAdapter = config.playFabFinancialAuthorityCutoverEnabled
    ? createPlayFabFinancialAuthorityGrantAdapter({
        economyAdapter: playFabEconomyV2GrantAdapter,
        authorityStore: playFabFinancialAuthorityStore,
        loadReceipt: loadXsollaV2Receipt,
        maximumCasAttempts: config.paymentWorkerCasAttempts,
        metrics: paymentMetrics
    })
    : null;
const offlineProfileGrantWorker = config.paymentWorkerEnabled
    ? createXsollaFinancialAuthorityWorker({
        ledger: paymentLedger,
        grantAdapter: playFabFinancialAuthorityGrantAdapter,
        workerId: `xsolla-financial-authority-${process.pid}-${randomUUID()}`,
        metrics: paymentMetrics,
        logger: paymentLogger,
        workerOptions: {
            leaseTtlMilliseconds: config.paymentWorkerLeaseTtlMs,
            leaseRenewIntervalMilliseconds: config.paymentWorkerLeaseRenewMs
        }
    })
    : null;
const paymentWorkerService = offlineProfileGrantWorker
    ? createPaymentWorkerService({
        worker: offlineProfileGrantWorker,
        ledger: paymentLedger,
        serviceId: `payment-service-${process.pid}-${randomUUID()}`,
        pollIntervalMilliseconds: config.paymentWorkerPollIntervalMs,
        retryBackoffBaseMilliseconds: config.paymentWorkerBackoffBaseMs,
        retryBackoffMaximumMilliseconds: config.paymentWorkerBackoffMaximumMs,
        maximumTransactionsPerBatch: config.paymentWorkerBatchSize,
        maximumRetries: config.paymentWorkerMaximumRetries,
        metrics: paymentMetrics,
        logger: paymentLogger
    })
    : null;
if (isProduction && config.purchasesGlobalEnabled) {
    await paymentLedger.ping();
    await playFabFinancialAuthorityGrantAdapter.probe();
    if (!paymentWorkerService) {
        throw new Error("Production payment worker service is unavailable.");
    }
    const startResult = paymentWorkerService.start();
    if (startResult.status !== "started") {
        throw new Error("Production payment worker service failed to start.");
    }
} else {
    paymentWorkerService?.start();
}
const recordXsollaFinancialException = createXsollaFinancialExceptionRecorder({
    ledger: paymentLedger,
    metrics: paymentMetrics,
    logger: paymentLogger
});
const financialShadowPaymentProducer = financialShadowPocInboxService
    ? createFinancialShadowPaymentProducer({
        ledger: paymentLedger,
        loadXsollaV2Receipt,
        enqueueCanonicalProjection: financialShadowPocInboxService.enqueueCanonicalProjection,
        policy: financialShadowPolicy
    })
    : null;
const diamondsCanaryXsd2Composition = diamondsCanaryTargetActive
    ? createDiamondsCanaryXsd2Composition({
        ledger: paymentLedger,
        loadXsollaV2Receipt,
        shadowProducer: financialShadowPaymentProducer,
        canonicalRuntime: diamondsDomainTarget.canonicalRuntime,
        verifyCanaryReadiness: diamondsDomainTarget.verifyPaymentCanaryReadiness,
        policy: {
            enabled: true,
            environment: "sandbox",
            titleId: config.playFabTitleId,
            forbiddenTitleIds: ["142853"],
            canaryPlayFabIds: diamondsDomainTarget.canaryPlayFabIds
        },
        workerId: `diamonds-canary-xsd2-${process.pid}-${randomUUID()}`,
        workerOptions: {
            leaseTtlMilliseconds: config.paymentWorkerLeaseTtlMs,
            leaseRenewIntervalMilliseconds: config.paymentWorkerLeaseRenewMs
        }
    })
    : null;
const trustedXsollaV2ProjectionProducer = diamondsCanaryXsd2Composition?.producer ||
    financialShadowPaymentProducer;
app.locals.diamondsCanaryXsd2 = Object.freeze({
    active: diamondsCanaryXsd2Composition !== null,
    route: diamondsCanaryXsd2Composition?.route || "shadow_or_disabled"
});
const persistLedgeredXsollaReceiptOnly = createXsollaLedgeredReceiptProcessor({
    ledger: paymentLedger,
    persistStarterPackReceiptV2: persistXsollaStarterReceiptV2,
    persistDiamondPackReceiptV2: persistXsollaDiamondReceiptV2,
    metrics: paymentMetrics,
    logger: paymentLogger
});
const persistLedgeredXsollaReceipt = wrapLedgeredReceiptProcessorWithFinancialShadow({
    processReceipt: persistLedgeredXsollaReceiptOnly,
    producer: trustedXsollaV2ProjectionProducer
});
const hardenedXsollaEventProcessor = createXsollaHardenedCatalogEventProcessor({
    allowDiamondSandboxGrants: config.xsollaAllowSandboxGrants,
    diamondSandboxTestPlayFabIds: config.xsollaSandboxTestPlayFabIds,
    allowDiamondProductionGrants: config.xsollaAllowDiamondProductionGrants,
    allowStarterSandboxGrants: config.xsollaAllowStarterSandboxGrants,
    starterSandboxTestPlayFabIds: config.xsollaStarterSandboxTestPlayFabIds,
    allowStarterProductionGrants: config.xsollaAllowStarterProductionGrants,
    validateUser: validateXsollaUser,
    persistDiamondPackReceiptV2: persistXsollaDiamondReceiptV2,
    persistStarterPackReceiptV2: persistXsollaStarterReceiptV2,
    persistCatalogReceipt: persistLedgeredXsollaReceipt,
    starterPaidCoordinator,
    recordFinancialException: recordXsollaFinancialException
});
const paymentReversalService = createPaymentReversalService({
    ledger: paymentLedger,
    metrics: paymentMetrics,
    logger: paymentLogger
});
const reversalXsollaEventProcessor = createXsollaReversalEventProcessor({
    reversalService: paymentReversalService
});
const gatedXsollaEventProcessor = createXsollaPurchaseGateProcessor({
    globalEnabled: config.purchasesGlobalEnabled,
    familyGates: {
        starter_pack: config.purchasesStarterEnabled,
        diamond_pack: config.purchasesDiamondEnabled,
        premium: config.purchasesPremiumEnabled,
        doubler: config.purchasesDoublerEnabled
    },
    allowedSkus: config.xsollaCheckoutAllowedSkus,
    hardenedEnabled: config.xsollaHardenedCatalogEnabled,
    hardenedProcessor: hardenedXsollaEventProcessor,
    legacyProcessor: legacyXsollaEventProcessor,
    reversalProcessor: reversalXsollaEventProcessor
});
const processXsollaEvent = async (event) => {
    paymentMetrics.record("webhook_received", {
        labels: { type: String(event?.notificationType || "unknown").toLowerCase() }
    });
    const result = await gatedXsollaEventProcessor(event);
    paymentWorkerService?.wake();
    return result;
};
const paymentScanners = createPaymentScanners({
    ledger: paymentLedger,
    metrics: paymentMetrics
});
let latestPaymentScannerReport = null;
let latestPaymentScannerError = "not_started";
let paymentScannerRunning = false;
async function refreshPaymentScannerReport() {
    if (paymentScannerRunning) return;
    paymentScannerRunning = true;
    try {
        latestPaymentScannerReport = await paymentScanners.scan();
        latestPaymentScannerError = null;
    } catch (error) {
        latestPaymentScannerError = error?.code || error?.name || "scan_failed";
    } finally {
        paymentScannerRunning = false;
    }
}
await refreshPaymentScannerReport();
const paymentScannerInterval = setInterval(() => {
    void refreshPaymentScannerReport();
}, 60_000);
paymentScannerInterval.unref?.();
xsollaWebhookHandler = createXsollaWebhookHandler({
    webhookSecret: config.xsollaWebhookSecret,
    projectId: config.xsollaProjectId,
    eventStore: xsollaEventStore,
    validateUser: validateXsollaUser,
    processEvent: processXsollaEvent,
    logger: paymentLogger
});

app.use(session({
    name: sessionCookieName,
    store: sessionStore,
    secret: config.sessionSecret || "development-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        path: "/",
        maxAge: config.sessionTtlSeconds * 1000
    }
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many login attempts. Please try again later." }
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many account creation attempts. Please try again later." }
});

const profileLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator(req) {
        return String(req.session.player.playFabId || req.sessionID);
    },
    message: { message: "Too many profile requests. Please try again later." }
});

const financialShadowGlobalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.financialShadowGlobalRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !financialShadowPolicy.enabled,
    message: { message: "Financial Shadow global request limit reached." }
});
const financialShadowSessionLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.financialShadowPerTicketRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !financialShadowPolicy.enabled,
    keyGenerator: financialShadowRateLimitKey,
    validate: { ip: false },
    message: { message: "Financial Shadow session request limit reached." }
});
const diamondsTargetLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.financialShadowGlobalRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => diamondsDomainTarget.handlers === null,
    message: { message: "Diamonds Target game-server request limit reached." }
});
registerFinancialShadowRoutes(app, {
    handlers: financialShadowHttpHandlers,
    preventSensitiveResponseCaching,
    requireJsonObject,
    limiter: [financialShadowGlobalLimiter, financialShadowSessionLimiter]
});
if (diamondsDomainTarget.handlers) {
    registerDiamondsDomainTargetRoutes(app, {
        handlers: diamondsDomainTarget.handlers,
        preventSensitiveResponseCaching,
        requireJsonObject,
        limiter: diamondsTargetLimiter
    });
}

const combatGradeThresholds = [
    { min: 1000, grade: "Legende Abyssale" },
    { min: 750, grade: "Couronne Or" },
    { min: 500, grade: "Couronne Argent" },
    { min: 300, grade: "Couronne Bronze" },
    { min: 200, grade: "Crane Or" },
    { min: 150, grade: "Crane Argent" },
    { min: 100, grade: "Crane Bronze" },
    { min: 75, grade: "Bouclier Or" },
    { min: 50, grade: "Bouclier Argent" },
    { min: 30, grade: "Bouclier Bronze" },
    { min: 20, grade: "Or I" },
    { min: 10, grade: "Argent I" },
    { min: 1, grade: "Bronze I" }
];

const shipNameById = {
    elite_1: "Elite Ship 1"
};

const cannonNameById = {
    carronade: "Carronade",
    long_range_cannon: "Long Range Cannon",
    iron_cannon: "Iron Cannon"
};

function maskEmail(email) {
    if (!email || !email.includes("@")) {
        return undefined;
    }

    const [name, domain] = email.split("@");
    const visible = name.slice(0, 2);
    return `${visible}${"*".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

function maskPlayFabId(playFabId) {
    if (!playFabId || playFabId.length < 8) {
        return undefined;
    }
    return `${playFabId.slice(0, 4)}...${playFabId.slice(-4)}`;
}

function toReadableId(id) {
    if (typeof id !== "string" || !id.trim()) {
        return null;
    }

    return id
        .trim()
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
    const number = toPublicNumber(value);
    return number === null ? null : new Intl.NumberFormat("en-US").format(number);
}

function formatDateTime(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function deriveCombatGrade(combatPoints) {
    const points = toPublicNumber(combatPoints);
    if (!points || points <= 0) {
        return "Unranked";
    }

    const match = combatGradeThresholds.find((grade) => points >= grade.min);
    return match ? match.grade : "Unranked";
}

function publicSession(req) {
    if (!req.session.player) {
        return { loggedIn: false };
    }

    return {
        loggedIn: true,
        displayName: req.session.player.displayName || "Captain",
        environment: config.seabyssEnv
    };
}

function requireAuth(req, res, next) {
    if (!req.session.player) {
        res.status(401).json({ message: "Authentication required." });
        return;
    }
    next();
}

function preventSensitiveResponseCaching(req, res, next) {
    res.set({
        "Cache-Control": "private, no-store",
        Pragma: "no-cache"
    });
    next();
}

function requireJsonObject(req, res, next) {
    if (!req.is("application/json")) {
        res.status(415).json({ message: "Content-Type must be application/json." });
        return;
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        res.status(400).json({ message: "Request body must be a JSON object." });
        return;
    }

    next();
}

function validateLoginInput(req, res, next) {
    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password || email.length > 254 || password.length > 256) {
        res.status(400).json({ message: "Invalid email or password." });
        return;
    }

    req.loginInput = { email, password };
    next();
}

function isLikelyEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateRegistrationInput(req, res, next) {
    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : undefined;
    const displayName = typeof req.body.displayName === "string" ? req.body.displayName.trim() : "";

    if (!email || email.length > 254 || !isLikelyEmail(email)) {
        res.status(400).json({ message: "Enter a valid email address." });
        return;
    }

    if (!password || password.length < 8 || password.length > 256) {
        res.status(400).json({ message: "Password must be at least 8 characters." });
        return;
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
        res.status(400).json({ message: "Passwords do not match." });
        return;
    }

    if (displayName && (displayName.length < 3 || displayName.length > 25)) {
        res.status(400).json({ message: "Player name must be between 3 and 25 characters." });
        return;
    }

    if (displayName && !/^[a-zA-Z0-9 _.-]+$/.test(displayName)) {
        res.status(400).json({ message: "Player name can only use letters, numbers, spaces, dots, underscores, and hyphens." });
        return;
    }

    req.registrationInput = {
        email,
        password,
        displayName: displayName || undefined
    };
    next();
}

function emptyGameplayProfile() {
    return {
        gold: null,
        diamonds: null,
        sirenTears: null,
        xp: null,
        level: null,
        elitePoints: null,
        combatPoints: null,
        combatGrade: null,
        equippedShip: null,
        equippedShipId: null,
        equippedCannons: [],
        npcKills: null,
        boardingCount: null,
        playerKills: null
    };
}

function toPublicNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function calculateLevel(xp) {
    const safeXp = Math.max(0, Number(xp) || 0);
    return Math.max(1, Math.floor(Math.sqrt(safeXp / 100)) + 1);
}

function summarizeEquippedCannons(cannons) {
    if (!Array.isArray(cannons)) {
        return [];
    }

    return cannons
        .map((cannon) => ({
            id: typeof cannon.id === "string" ? cannon.id : null,
            name: cannonNameById[cannon.id] || toReadableId(cannon.id),
            equipped: toPublicNumber(cannon.equipped)
        }))
        .filter((cannon) => cannon.id && cannon.equipped && cannon.equipped > 0);
}

function buildGameplaySummary(rawProfile) {
    if (!rawProfile || typeof rawProfile !== "object") {
        return emptyGameplayProfile();
    }

    const xp = toPublicNumber(rawProfile.xp);
    const equippedShipId = typeof rawProfile.equippedEliteShipId === "string" && rawProfile.equippedEliteShipId
        ? rawProfile.equippedEliteShipId
        : null;
    const playerKills = toPublicNumber(rawProfile.playerKills);
    const storedCombatPoints = toPublicNumber(rawProfile.combatPoints);
    // PlayerProfileData.playerKills is currently the available persisted score for the web combat profile.
    const combatPoints = storedCombatPoints === null ? playerKills : storedCombatPoints;
    const storedCombatGrade = typeof rawProfile.combatGrade === "string" && rawProfile.combatGrade
        ? rawProfile.combatGrade
        : null;

    return {
        gold: toPublicNumber(rawProfile.gold),
        diamonds: toPublicNumber(rawProfile.diamonds),
        sirenTears: toPublicNumber(rawProfile.sirenTears),
        xp,
        level: xp === null ? null : calculateLevel(xp),
        elitePoints: toPublicNumber(rawProfile.elitePoints),
        combatPoints,
        combatGrade: storedCombatGrade || deriveCombatGrade(combatPoints),
        equippedShip: equippedShipId ? shipNameById[equippedShipId] || toReadableId(equippedShipId) : null,
        equippedShipId,
        equippedCannons: summarizeEquippedCannons(rawProfile.cannons),
        npcKills: toPublicNumber(rawProfile.npcKills),
        boardingCount: toPublicNumber(rawProfile.boardingCount),
        playerKills
    };
}

async function getGameplayProfile(playFabId) {
    if (!playFabId || !config.playFabTitleId || !config.playFabSecretKey) {
        return emptyGameplayProfile();
    }

    try {
        const response = await fetch(`https://${config.playFabTitleId}.playfabapi.com/Server/GetUserInternalData`, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(config.upstreamTimeoutMs),
            headers: {
                "Content-Type": "application/json",
                "X-SecretKey": config.playFabSecretKey
            },
            body: JSON.stringify({
                PlayFabId: playFabId,
                Keys: ["profile_v1"]
            })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.code !== 200) {
            console.error("PlayFab gameplay profile request failed", {
                playFabId: maskPlayFabId(playFabId),
                status: response.status,
                code: payload.error || "unknown"
            });
            return emptyGameplayProfile();
        }

        const rawValue = payload.data &&
            payload.data.Data &&
            payload.data.Data.profile_v1 &&
            payload.data.Data.profile_v1.Value;

        if (!rawValue) {
            return emptyGameplayProfile();
        }

        try {
            return buildGameplaySummary(JSON.parse(rawValue));
        } catch (error) {
            console.error("PlayFab gameplay profile JSON invalid", {
                playFabId: maskPlayFabId(playFabId),
                message: error.message
            });
            return emptyGameplayProfile();
        }
    } catch (error) {
        console.error("PlayFab gameplay profile unavailable", {
            playFabId: maskPlayFabId(playFabId),
            message: error.message
        });
        return emptyGameplayProfile();
    }
}

async function loginWithPlayFab(email, password) {
    if (!config.playFabTitleId) {
        const error = new Error("PlayFab title is not configured.");
        error.publicStatus = 503;
        throw error;
    }

    const response = await fetch(`https://${config.playFabTitleId}.playfabapi.com/Client/LoginWithEmailAddress`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            TitleId: config.playFabTitleId,
            Email: email,
            Password: password,
            InfoRequestParameters: {
                GetPlayerProfile: true,
                GetUserAccountInfo: true,
                GetUserData: false,
                GetUserInventory: false,
                GetUserVirtualCurrency: false
            }
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200) {
        const error = new Error("Invalid email or password.");
        error.publicStatus = 401;
        throw error;
    }

    return payload.data;
}

function createRegistrationError(playFabError, statusCode) {
    const errorCode = playFabError && playFabError.error;
    const error = new Error("Registration failed. Please try again.");
    error.publicStatus = statusCode || 400;

    if (errorCode === "AccountAlreadyExists" || errorCode === "EmailAddressNotAvailable") {
        error.message = "An account already exists for this email.";
        error.publicStatus = 409;
        return error;
    }

    if (errorCode === "InvalidEmailAddress") {
        error.message = "Enter a valid email address.";
        error.publicStatus = 400;
        return error;
    }

    if (errorCode === "InvalidPassword" || errorCode === "PasswordTooShort") {
        error.message = "Password does not meet the account requirements.";
        error.publicStatus = 400;
        return error;
    }

    if (errorCode === "InvalidParams" || errorCode === "NameNotAvailable" || errorCode === "InvalidUsername") {
        error.message = "Check the account details and try again.";
        error.publicStatus = 400;
        return error;
    }

    if (statusCode >= 500) {
        error.message = "Account service unavailable. Please try again later.";
        error.publicStatus = 503;
    }

    return error;
}

async function registerWithPlayFab(email, password, displayName) {
    if (!config.playFabTitleId) {
        const error = new Error("PlayFab title is not configured.");
        error.publicStatus = 503;
        throw error;
    }

    const requestBody = {
        TitleId: config.playFabTitleId,
        Email: email,
        Password: password,
        RequireBothUsernameAndEmail: false
    };

    if (displayName) {
        requestBody.DisplayName = displayName;
    }

    const response = await fetch(`https://${config.playFabTitleId}.playfabapi.com/Client/RegisterPlayFabUser`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200) {
        throw createRegistrationError(payload, response.ok ? 502 : response.status);
    }

    return payload.data;
}

function createPlayerSession(req, player) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((regenerateError) => {
            if (regenerateError) {
                reject(regenerateError);
                return;
            }

            req.session.player = player;
            resolve();
        });
    });
}

async function buildProfile(sessionPlayer) {
    const gameplay = await getGameplayProfile(sessionPlayer.playFabId);
    const equippedCannonsLabel = gameplay.equippedCannons.length
        ? gameplay.equippedCannons.map((cannon) => `${cannon.name || cannon.id} x${formatNumber(cannon.equipped)}`).join(", ")
        : null;

    return {
        displayName: sessionPlayer.displayName || "Captain",
        playFabId: maskPlayFabId(sessionPlayer.playFabId),
        email: maskEmail(sessionPlayer.email),
        createdAt: formatDateTime(sessionPlayer.createdAt),
        lastLoginAt: formatDateTime(sessionPlayer.lastLoginAt),
        level: formatNumber(gameplay.level),
        xp: formatNumber(gameplay.xp),
        gold: formatNumber(gameplay.gold),
        diamonds: formatNumber(gameplay.diamonds),
        sirenTears: formatNumber(gameplay.sirenTears),
        combatGrade: gameplay.combatGrade,
        elitePoints: formatNumber(gameplay.elitePoints),
        equippedShip: gameplay.equippedShip,
        equippedCannons: equippedCannonsLabel,
        stats: {
            "Combat points": formatNumber(gameplay.combatPoints),
            "Player kills": formatNumber(gameplay.playerKills),
            "NPC kills": formatNumber(gameplay.npcKills),
            "Boardings": formatNumber(gameplay.boardingCount)
        },
        gameplay,
        environment: config.seabyssEnv
    };
}

app.get("/health/live", (req, res) => {
    res.json({
        status: "alive",
        environment: config.seabyssEnv,
        version: "0.1.0"
    });
});

app.get("/health/ready", async (req, res) => {
    const checks = [];
    const diamondsTargetDiagnostics = diamondsDomainTarget.runtimeDiagnostics();
    const diamondsTargetLegacySafe = diamondsDomainTarget.mode === "Legacy" &&
        diamondsDomainTarget.targetAdapterComposed === true &&
        diamondsDomainTarget.active === false && diamondsDomainTarget.handlers === null &&
        diamondsTargetDiagnostics.constructed === false;
    checks.push({
        component: "diamonds_domain_target",
        ok: diamondsTargetLegacySafe || diamondsDomainTarget.health?.ready === true,
        reason: diamondsTargetLegacySafe
            ? "legacy_composed_inactive_no_runtime_probe"
            : diamondsDomainTarget.health?.ready === true
                ? "certified_target_runtime_ready"
                : "diamonds_target_runtime_unsafe",
        details: {
            mode: diamondsDomainTarget.mode,
            active: diamondsDomainTarget.active,
            targetAdapterComposed: diamondsDomainTarget.targetAdapterComposed,
            routesRegistered: diamondsDomainTarget.handlers !== null,
            runtimeConstructed: diamondsTargetDiagnostics.constructed
        }
    });
    checks.push({
        component: "progressive_financial_domains",
        ok: progressiveDomainStartupSafety.safe === true,
        reason: progressiveDomainStartupSafety.safe === true
            ? "all_domains_legacy_fail_closed"
            : "domain_activation_unsafe",
        details: Object.fromEntries(Object.entries(progressiveDomainStartupSafety.domains)
            .map(([domain, value]) => [domain, {
                mode: value.mode,
                activationRequested: value.activationRequested,
                safe: value.safe
            }]))
    });
    try {
        await paymentLedger.ping();
        checks.push({ component: "payment_ledger", ok: true });
    } catch {
        checks.push({ component: "payment_ledger", ok: false, reason: "probe_failed" });
    }
    if (sessionInfrastructure.redisClient) {
        try {
            const pong = await sessionInfrastructure.redisClient.ping();
            checks.push({ component: "redis", ok: pong === "PONG" });
        } catch {
            checks.push({ component: "redis", ok: false, reason: "probe_failed" });
        }
    } else {
        checks.push({
            component: "redis",
            ok: !isProduction,
            reason: isProduction ? "required" : "development_memory_store"
        });
    }
    if (financialShadowPolicy.enabled) {
        try {
            const shadow = await financialShadowRuntime.health();
            checks.push({
                component: "financial_shadow_runtime",
                ok: shadow.healthy === true,
                reason: shadow.healthy === true ? "sandbox_shadow_ready" : "shadow_store_unavailable",
                details: { authoritative: false, durable: shadow.durable, redis: shadow.redis }
            });
        } catch {
            checks.push({ component: "financial_shadow_runtime", ok: false, reason: "probe_failed" });
        }
        const mirrorHealth = financialShadowPocInboxService?.health();
        checks.push({
            component: "financial_shadow_poc_mirror",
            ok: mirrorHealth?.healthy === true,
            reason: mirrorHealth?.healthy === true ? "projection_only_worker_running" : "mirror_worker_unhealthy",
            details: mirrorHealth ? {
                durable: mirrorHealth.durable,
                projectionOnly: mirrorHealth.projectionOnly,
                lastErrorCode: mirrorHealth.lastErrorCode
            } : null
        });
    }
    if (playFabFinancialReadinessVerifier) {
        try {
            latestPlayFabFinancialReadinessEvidence = await playFabFinancialReadinessVerifier.verify();
            checks.push({
                component: "playfab_financial_readiness_evidence",
                ok: latestPlayFabFinancialReadinessEvidence.ready,
                reason: latestPlayFabFinancialReadinessEvidence.ready
                    ? "verified"
                    : latestPlayFabFinancialReadinessEvidence.errors[0] || "proof_missing",
                details: {
                    catalog: latestPlayFabFinancialReadinessEvidence.catalog,
                    policy: latestPlayFabFinancialReadinessEvidence.policy,
                    checkedAtUnixMs: latestPlayFabFinancialReadinessEvidence.checkedAtUnixMs
                }
            });
        } catch {
            checks.push({
                component: "playfab_financial_readiness_evidence",
                ok: false,
                reason: "probe_failed"
            });
        }
    } else {
        checks.push({
            component: "playfab_financial_readiness_evidence",
            ok: false,
            reason: "cutover_disabled"
        });
    }
    if (playFabFinancialAuthorityGrantAdapter) {
        try {
            await playFabFinancialAuthorityGrantAdapter.probe();
            checks.push({ component: "playfab_financial_adapter", ok: true });
        } catch (error) {
            checks.push({
                component: "playfab_financial_adapter",
                ok: false,
                reason: error?.code || "probe_failed"
            });
        }
    } else {
        checks.push({
            component: "playfab_financial_adapter",
            ok: false,
            reason: "configuration_missing"
        });
    }
    const workerHealth = paymentWorkerService?.health() || null;
    checks.push({
        component: "offline_grant_worker",
        ok: workerHealth?.healthy === true,
        reason: workerHealth?.healthy === true
            ? "running"
            : (config.purchasesGlobalEnabled
                ? "production_profile_cas_adapter_not_configured"
                : (paymentWorkerService ? workerHealth?.state || "not_healthy" : "worker_disabled")),
        details: workerHealth ? {
            state: workerHealth.state,
            running: workerHealth.running,
            consecutiveFailures: workerHealth.consecutiveFailures,
            lastLoopSucceededAtUnixMs: workerHealth.lastLoopSucceededAtUnixMs,
            lastErrorCode: workerHealth.lastErrorCode
        } : null
    });
    checks.push({
        component: "playfab_financial_authority_cutover",
        ok: config.playFabFinancialAuthorityCutoverEnabled,
        reason: config.playFabFinancialAuthorityCutoverEnabled
            ? "enabled"
            : "kill_switch_disabled"
    });
    const scannerHealthy = latestPaymentScannerError === null &&
        latestPaymentScannerReport !== null &&
        latestPaymentScannerReport.truncated !== true;
    checks.push({
        component: "payment_scanners",
        ok: scannerHealthy,
        reason: latestPaymentScannerError ||
            (latestPaymentScannerReport?.truncated ? "scan_truncated" : "scheduled_scan_current")
    });
    const ready = checks.every((check) => check.ok);
    res.status(ready ? 200 : 503).json({
        status: ready ? "ready" : "not_ready",
        environment: config.seabyssEnv,
        checks,
        scannerCounts: latestPaymentScannerReport?.counts || null,
        scannerTruncated: latestPaymentScannerReport?.truncated === true,
        worker: workerHealth
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        environment: config.seabyssEnv,
        version: "0.1.0",
        payments: {
            globalEnabled: config.purchasesGlobalEnabled,
            activationReady: Boolean(
                config.playFabFinancialAuthorityCutoverEnabled &&
                latestPlayFabFinancialReadinessEvidence?.ready === true &&
                config.playFabFinancialProfileEnabled && config.paymentWorkerEnabled &&
                sessionInfrastructure.redisClient &&
                paymentWorkerService?.health().healthy === true && latestPaymentScannerError === null
            )
        },
        progressiveFinancialDomains: Object.fromEntries(
            Object.entries(progressiveDomainStartupSafety.domains).map(([domain, value]) => [domain, {
                mode: value.mode,
                activationRequested: value.activationRequested,
                safe: value.safe
            }])),
        ...(financialShadowPolicy.enabled ? {
            financialShadow: {
                enabled: true,
                environment: financialShadowPolicy.shadowEnvironment,
                authoritative: false,
                targetPlayFabWritesAllowed: false
            }
        } : {})
    });
});

app.post("/auth/login", preventSensitiveResponseCaching, loginLimiter, requireJsonObject, validateLoginInput, async (req, res, next) => {
    try {
        const { email, password } = req.loginInput;
        const data = await loginWithPlayFab(email, password);
        const accountInfo = data.InfoResultPayload && data.InfoResultPayload.AccountInfo;
        const playerProfile = data.InfoResultPayload && data.InfoResultPayload.PlayerProfile;

        await createPlayerSession(req, {
            playFabId: data.PlayFabId,
            email,
            displayName: data.NewlyCreated ? undefined : (playerProfile && playerProfile.DisplayName),
            createdAt: accountInfo && accountInfo.Created,
            lastLoginAt: new Date().toISOString()
        });

        res.json(publicSession(req));
    } catch (error) {
        if (error.publicStatus === 401) {
            res.status(401).json({ message: "Invalid email or password." });
            return;
        }
        next(error);
    }
});

app.post("/register", preventSensitiveResponseCaching, registerLimiter, requireJsonObject, validateRegistrationInput, async (req, res, next) => {
    try {
        const { email, password, displayName } = req.registrationInput;
        const data = await registerWithPlayFab(email, password, displayName);

        await createPlayerSession(req, {
            playFabId: data.PlayFabId,
            email,
            displayName: displayName || data.Username,
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString()
        });

        res.status(201).json({
            ...publicSession(req),
            created: true,
            message: "Account created. You can now login in the launcher and game."
        });
    } catch (error) {
        next(error);
    }
});

app.post("/auth/logout", preventSensitiveResponseCaching, (req, res, next) => {
    req.session.destroy((destroyError) => {
        res.clearCookie(sessionCookieName, {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax",
            path: "/"
        });

        if (isProduction) {
            res.clearCookie("seabyss.sid", {
                httpOnly: true,
                secure: true,
                sameSite: "lax",
                domain: ".seabyss.com",
                path: "/"
            });
        }

        if (destroyError) {
            destroyError.publicStatus = 503;
            next(destroyError);
            return;
        }

        res.json({ success: true });
    });
});

app.get("/auth/session", preventSensitiveResponseCaching, (req, res) => {
    res.json(publicSession(req));
});

app.get("/me", preventSensitiveResponseCaching, requireAuth, profileLimiter, async (req, res, next) => {
    try {
        res.json(await buildProfile(req.session.player));
    } catch (error) {
        next(error);
    }
});

app.use((req, res) => {
    res.status(404).json({ message: "Not found." });
});

app.use((error, req, res, next) => {
    const status = error.publicStatus || error.status || error.statusCode || 500;
    if (status >= 500) {
        console.error("Request failed", {
            path: req.path,
            method: req.method,
            message: error.message
        });
    }

    if (error.type === "entity.parse.failed") {
        res.status(400).json({ message: "Invalid JSON request body." });
        return;
    }

    res.status(status).json({
        message: status >= 500 ? "Server unavailable. Please try again later." : error.message
    });
});

const httpServer = app.listen(config.port, config.host, () => {
    console.log(`Seabyss web API listening on ${config.host}:${config.port} (${config.seabyssEnv}).`);
});

let shutdownPromise = null;
async function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        clearInterval(paymentScannerInterval);
        await financialShadowPocInboxService?.stop();
        const workerStop = paymentWorkerService
            ? await paymentWorkerService.stop({ drainTimeoutMilliseconds: 30_000 })
            : { status: "already_stopped", timedOut: false };
        await new Promise((resolve) => {
            httpServer.close(() => resolve());
            setTimeout(() => {
                httpServer.closeIdleConnections?.();
                resolve();
            }, 5_000).unref?.();
        });
        if (sessionInfrastructure.redisClient?.isOpen) {
            await sessionInfrastructure.redisClient.quit().catch(() => {
                sessionInfrastructure.redisClient.disconnect?.();
            });
        }
        console.log("Seabyss web API stopped.", {
            signal,
            paymentWorkerDrainTimedOut: workerStop.timedOut === true
        });
    })();
    return shutdownPromise;
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        void shutdown(signal).then(
            () => process.exit(0),
            (error) => {
                console.error("Seabyss web API shutdown failed.", {
                    signal,
                    errorCode: error?.code || "SHUTDOWN_ERROR"
                });
                process.exit(1);
            }
        );
    });
}
