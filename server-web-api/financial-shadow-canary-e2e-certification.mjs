import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { createClient } from "redis";
import { evaluateFinancialShadowPolicy } from "./src/financial-shadow-policy.js";
import { createFinancialShadowMetrics } from "./src/financial-shadow-model.js";
import { createRedisFinancialShadowStateStore } from "./src/financial-shadow-store.js";
import { createFinancialShadowRuntime } from "./src/financial-shadow-runtime.js";
import { createFinancialShadowHttpHandlers, registerFinancialShadowRoutes } from "./src/financial-shadow-http.js";
import {
    createCachedPlayFabSessionTicketAuthenticator,
    createPlayFabSessionTicketAuthenticator
} from "./src/playfab-session-ticket-authenticator.js";
import {
    createRedisCompatibleServerEconomyPocOperationInbox,
    createRedisCompatibleServerEconomyPocWalStore
} from "./src/server-economy-poc-redis-stores.js";
import { createRedisServerEconomyPocPlayerLeases } from "./src/server-economy-poc-redis-player-leases.js";
import {
    createServerEconomyPocPlayFabFencedPlayerLeases
} from "./src/server-economy-poc-playfab-snapshot-store.js";
import {
    createObservedServerEconomyPocPlayFabSnapshotStore
} from "./src/server-economy-poc-playfab-snapshot-store-observed.js";
import { createServerEconomyPocRuntimeEngine } from "./src/server-economy-poc-runtime-engine.js";
import {
    createRoutedServerEconomyPocBatchService,
    createRoutedServerEconomyPocConsumerHub
} from "./src/server-economy-poc-routed-consumers.js";
import { createMemoryServerEconomyPocMetrics } from "./src/server-economy-poc-metrics.js";
import { createPlayFabFinancialProfileClient } from "./src/playfab-financial-profile-store.js";
import { createFinancialShadowPocInboxService } from "./src/financial-shadow-poc-inbox-service.js";
import { createFinancialShadowPaymentProducer } from "./src/financial-shadow-payment-producer.js";
import { createRedisPaymentLedgerStore } from "./src/payment-ledger-redis-store.js";
import { createPaymentLedger } from "./src/payment-ledger.js";
import { createPlayFabXsollaV2ReceiptReader } from "./src/playfab-xsolla-v2-receipt-reader.js";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "./src/playfab-xsolla-diamond-receipt-v2-store.js";
import {
    getXsollaStarterReceiptV2Key,
    serializeXsollaStarterReceiptV2
} from "./src/playfab-xsolla-starter-receipt-v2-store.js";
import { createXsollaLedgeredReceiptProcessor } from "./src/xsolla-ledgered-receipt-processor.js";
import { getXsollaProductPlan } from "./src/xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "./src/xsolla-starter-reward-plan-registry.js";

export const SANDBOX_TITLE_ID = "1D0C16";
export const PRODUCTION_TITLE_ID = "142853";
export const CANARY_PLAYFAB_ID = "61AD15CDA4137EA9";
export const CANARY_ENTITY_ID = "714E7F12EDBEA385";
export const CONTROL_PATH = "/financial/shadow/certification/v1/project";

export function canaryActionRuntimeOptions(action) {
    const serve = action === "serve";
    return Object.freeze({ startHttp: serve, startSchedulers: serve });
}

const PURCHASE_GATES = Object.freeze([
    "ShopPurchasesEnabled", "SHOP_PURCHASES_ENABLED", "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED", "PURCHASES_STARTER_ENABLED", "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED", "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED", "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS", "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS", "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "PAYMENT_WORKER_ENABLED", "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED", "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED"
]);
const TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE = new Set(["", "0", "false", "no", "off", "disabled"]);
const SAFE_PREFIX = "seabyss:cert:shadow-e2e:1d0c16:";

const PROVIDER_OBJECT_NAMES = Object.freeze([
    "SeabyssEconomyStateV1",
    "SeabyssEconomyFenceV1",
    "SeabyssEconomyProofV1",
    "SeabyssEconomyAmmoProofV1"
]);
function fail(code, message, statusCode = 500) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    throw error;
}

function required(value, name, maximum = 4096) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
        fail("SHADOW_E2E_CONFIGURATION_INVALID", `${name} is required.`);
    }
    return value.trim();
}

function enabled(value, name, absent = false) {
    if (value === undefined || value === null) return absent;
    const normalized = String(value).trim().toLowerCase();
    if (TRUE.has(normalized)) return true;
    if (FALSE.has(normalized)) return false;
    fail("SHADOW_E2E_CONFIGURATION_INVALID", `${name} must be an explicit boolean.`);
}

function safeId(value, name, maximum = 160) {
    const normalized = required(value, name, maximum);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(normalized)) {
        fail("SHADOW_E2E_CONFIGURATION_INVALID", `${name} contains unsafe characters.`);
    }
    return normalized;
}

function positiveInteger(value, name, fallback, maximum = 65_535) {
    if (value === undefined || value === null || value === "") return fallback;
    if (!/^\d+$/u.test(String(value))) fail("SHADOW_E2E_CONFIGURATION_INVALID", `${name} is invalid.`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
        fail("SHADOW_E2E_CONFIGURATION_INVALID", `${name} is outside its safe range.`);
    }
    return parsed;
}

function loopbackRedisUrl(value) {
    const raw = required(value, "FINANCIAL_SHADOW_CANARY_E2E_REDIS_URL");
    let parsed;
    try { parsed = new URL(raw); } catch { fail("SHADOW_E2E_REDIS_URL_INVALID", "Redis URL is invalid."); }
    if (!["redis:", "rediss:"].includes(parsed.protocol) ||
        !["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase())) {
        fail("SHADOW_E2E_REDIS_NOT_ISOLATED", "Certification Redis must be loopback-only.");
    }
    return raw;
}

export function loadCanaryE2eConfiguration(environment = process.env) {
    if (!enabled(environment.FINANCIAL_SHADOW_CANARY_E2E_ENABLED,
        "FINANCIAL_SHADOW_CANARY_E2E_ENABLED")) {
        fail("SHADOW_E2E_DISABLED", "Explicit canary E2E enable is required.");
    }
    if (!enabled(environment.FINANCIAL_SHADOW_CANARY_E2E_MUTATION_ENABLED,
        "FINANCIAL_SHADOW_CANARY_E2E_MUTATION_ENABLED")) {
        fail("SHADOW_E2E_MUTATION_DISABLED", "Explicit isolated Sandbox mutation opt-in is required.");
    }
    if (String(environment.NODE_ENV || "").trim().toLowerCase() === "production") {
        fail("SHADOW_E2E_PRODUCTION_ENV_REFUSED", "NODE_ENV=production is forbidden.");
    }
    const titleId = required(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID", 64);
    if (titleId === PRODUCTION_TITLE_ID || titleId !== SANDBOX_TITLE_ID) {
        fail("SHADOW_E2E_TITLE_REFUSED", "Only isolated PlayFab Sandbox 1D0C16 is allowed.");
    }
    if (environment.PLAYFAB_TITLE_ID && environment.PLAYFAB_TITLE_ID !== titleId) {
        fail("SHADOW_E2E_AMBIENT_TITLE_CONFLICT", "Ambient PLAYFAB_TITLE_ID differs from the Sandbox title.");
    }
    const secretKey = required(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY");
    const canary = required(environment.FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS,
        "FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS", 160);
    if (canary !== CANARY_PLAYFAB_ID || /[,;\s]/u.test(canary)) {
        fail("SHADOW_E2E_ALLOWLIST_REFUSED", "Allowlist must contain only the dedicated canary.");
    }
    if (!enabled(environment.FINANCIAL_SHADOW_MODE_ENABLED, "FINANCIAL_SHADOW_MODE_ENABLED")) {
        fail("SHADOW_E2E_SHADOW_DISABLED", "Shadow must be explicitly enabled for this isolated process.");
    }
    if (String(environment.FINANCIAL_SHADOW_ENVIRONMENT || "sandbox").trim().toLowerCase() !== "sandbox") {
        fail("SHADOW_E2E_ENVIRONMENT_REFUSED", "Shadow environment must be sandbox.");
    }
    for (const gate of PURCHASE_GATES) {
        if (enabled(environment[gate], gate)) fail("SHADOW_E2E_ACTIVE_GATE_REFUSED", `${gate} must remain false.`);
    }
    const runId = safeId(environment.FINANCIAL_SHADOW_CANARY_E2E_RUN_ID,
        "FINANCIAL_SHADOW_CANARY_E2E_RUN_ID", 80);
    const controlToken = required(environment.FINANCIAL_SHADOW_CANARY_E2E_CONTROL_TOKEN,
        "FINANCIAL_SHADOW_CANARY_E2E_CONTROL_TOKEN", 1024);
    if (Buffer.byteLength(controlToken) < 32) {
        fail("SHADOW_E2E_CONTROL_TOKEN_WEAK", "Control token must contain at least 32 bytes.");
    }
    const presenceTtlMs = positiveInteger(
        environment.FINANCIAL_SHADOW_CANARY_E2E_PRESENCE_TTL_MS,
        "FINANCIAL_SHADOW_CANARY_E2E_PRESENCE_TTL_MS", 3_000, 30_000);
    if (presenceTtlMs < 1_000) fail("SHADOW_E2E_PRESENCE_TTL_INVALID",
        "Certification presence TTL must be between 1000 and 30000 milliseconds.");
    return Object.freeze({
        titleId, secretKey, canaryPlayFabId: canary, canaryEntityId: CANARY_ENTITY_ID,
        redisUrl: loopbackRedisUrl(environment.FINANCIAL_SHADOW_CANARY_E2E_REDIS_URL),
        redisPrefix: `${SAFE_PREFIX}${runId}:`, runId, controlToken, presenceTtlMs,
        port: positiveInteger(environment.FINANCIAL_SHADOW_CANARY_E2E_PORT,
            "FINANCIAL_SHADOW_CANARY_E2E_PORT", 0),
        providerTimeoutMs: positiveInteger(environment.FINANCIAL_SHADOW_CANARY_E2E_PROVIDER_TIMEOUT_MS,
            "FINANCIAL_SHADOW_CANARY_E2E_PROVIDER_TIMEOUT_MS", 8_000, 60_000)
    });
}

function loopbackRequest(req) {
    const address = String(req?.socket?.remoteAddress || "").toLowerCase();
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sameSecret(actual, expected) {
    if (typeof actual !== "string") return false;
    const left = Buffer.from(actual, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
}

function exactTransactionInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).join(",") !== "providerTransactionId" ||
        typeof value.providerTransactionId !== "string" ||
        !/^[1-9][0-9]*$/u.test(value.providerTransactionId)) {
        fail("SHADOW_E2E_CONTROL_SCHEMA", "Only {providerTransactionId} is accepted.", 400);
    }
    return Object.freeze({ providerTransactionId: value.providerTransactionId });
}

export function createProjectionControlHandler({ producer, controlToken } = {}) {
    if (typeof producer?.projectTransaction !== "function" || typeof controlToken !== "string") {
        throw new TypeError("Canary projection control dependencies are incomplete.");
    }
    return async function projectionControl(req, res, next) {
        try {
            if (!loopbackRequest(req)) fail("SHADOW_E2E_CONTROL_LOOPBACK_ONLY", "Not found.", 404);
            if (!sameSecret(req.get?.("X-Shadow-Certification-Token") ||
                req.headers?.["x-shadow-certification-token"], controlToken)) {
                fail("SHADOW_E2E_CONTROL_UNAUTHORIZED", "Not found.", 404);
            }
            const input = exactTransactionInput(req.body);
            const result = await producer.projectTransaction(input);
            res.status(202).set("Cache-Control", "no-store").json({
                schemaVersion: 1,
                authoritative: false,
                grantsLegacy: false,
                status: result.status,
                providerTransactionId: input.providerTransactionId,
                operationId: result.operation.operationId,
                submitted: result.submitted
            });
        } catch (error) { next(error); }
    };
}

export function createCanonicalProjectionFanout({
    canaryPlayFabId = CANARY_PLAYFAB_ID,
    providerInbox,
    providerRuntime,
    mirrorService
} = {}) {
    if (typeof providerInbox?.submit !== "function" ||
        typeof providerRuntime?.drainHighValue !== "function" ||
        typeof mirrorService?.enqueueCanonicalProjection !== "function" ||
        typeof mirrorService?.drainOnce !== "function") {
        throw new TypeError("Canonical projection fanout dependencies are incomplete.");
    }
    let serial = Promise.resolve();
    return function enqueueCanonicalProjection(operation) {
        const run = serial.then(async () => {
            if (!operation || operation.playFabId !== canaryPlayFabId ||
                operation.kind !== "xsolla_entitlement" || typeof operation.immutableHash !== "string") {
                fail("SHADOW_E2E_CANONICAL_OPERATION_REFUSED", "Only the canary canonical entitlement is accepted.");
            }
            const provider = await providerInbox.submit(operation);
            const mirror = await mirrorService.enqueueCanonicalProjection(operation);
            const providerResults = await providerRuntime.drainHighValue(canaryPlayFabId, {
                consumer: "shadow_canary_certification",
                maximumOperations: 20
            });
            const mirrorResult = await mirrorService.drainOnce();
            return Object.freeze({
                status: provider.status === "existing" && mirror.status === "existing" ? "existing" : "submitted",
                provider: Object.freeze({ status: provider.status, processed: providerResults.length }),
                mirror: Object.freeze({ status: mirror.status, loop: mirrorResult.status })
            });
        });
        serial = run.catch(() => {});
        return run;
    };
}

export function createCertificationProviderScheduler({
    providerRuntime,
    metrics = createMemoryServerEconomyPocMetrics(),
    intervalMilliseconds = 500,
    maximumPlayers = 20
} = {}) {
    const consumers = createRoutedServerEconomyPocConsumerHub({
        engine: providerRuntime,
        metrics
    });
    const service = createRoutedServerEconomyPocBatchService({
        consumerHub: consumers,
        intervalMilliseconds,
        maximumPlayers
    });
    return Object.freeze({ consumers, service, metrics });
}

export function certificationReceipt(scenario, providerTransactionId, createdAt = new Date()) {
    const sku = scenario === "diamond-i" ? "seabyss_diamond_pack_1" :
        scenario === "starter-i" ? "seabyss_starter_pack_1" : null;
    if (!sku) fail("SHADOW_E2E_SCENARIO_REFUSED", "Scenario must be diamond-i or starter-i.");
    const plan = getXsollaProductPlan(sku);
    const common = {
        playFabId: CANARY_PLAYFAB_ID,
        transactionId: providerTransactionId,
        provider: "xsolla",
        providerTransactionId,
        userId: CANARY_PLAYFAB_ID,
        createdAtUtc: createdAt.toISOString(),
        environment: "sandbox",
        notificationType: "payment",
        orderId: providerTransactionId,
        productId: plan.productId,
        xsollaSku: plan.sku,
        productType: plan.productType,
        source: "xsolla_sandbox",
        productPlanVersion: plan.planVersion,
        currency: plan.currency,
        unitAmountMinor: plan.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: plan.unitAmountMinor,
        promotionPolicy: "disabled"
    };
    if (scenario === "diamond-i") return Object.freeze(common);
    const reward = getStarterRewardPlan(sku);
    return Object.freeze({
        ...common,
        rewardPlanVersion: reward.planVersion,
        rewardPlanHash: reward.rewardPlanHash,
        rewards: reward.rewards
    });
}

function createLegacyCanaryBaseline(now = new Date()) {
    return Object.freeze({
        schemaVersion: 12,
        playerAccountId: CANARY_PLAYFAB_ID,
        updatedUtc: now.toISOString(),
        starterGrantVersion: 1,
        gold: 0, xp: 0, diamonds: 0, playFabCurrencyMigratedV1: true,
        sirenTears: 0, elitePoints: 0,
        ammo: [], cannons: [], usableItems: [], captains: [], hotbarSlots: [], harpoons: {},
        ownedDestinationMarkerIds: ["destination_default"], ownedShipDesignIds: [],
        shopEntitlements: [], pendingXsollaStarterPackReceipts: [],
        appliedXsollaStarterPackRewardStepIds: [], redeemedCodes: [],
        goldPirateHpBuckets: [], diamondPirateHpBuckets: [], completedPirateExamIds: [],
        grantedPirateExamRewardIds: [], attemptedPirateExamIds: [], recentBossDefeatReceiptIds: [],
        durableEconomyTransactions: [], durableGuildDepositReceipts: []
    });
}

async function playFabPost(configuration, family, endpoint, body) {
    const response = await fetch(`https://${configuration.titleId}.playfabapi.com/${family}/${endpoint}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(configuration.providerTimeoutMs),
        headers: { "Content-Type": "application/json", "X-SecretKey": configuration.secretKey },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 200) {
        fail("SHADOW_E2E_PLAYFAB_CALL_FAILED", `PlayFab ${family}/${endpoint} failed.`);
    }
    return payload.data;
}

export function createCertificationV2OnlyReceiptStore(configuration, receiptType) {
    if (configuration?.titleId !== SANDBOX_TITLE_ID ||
        configuration?.canaryPlayFabId !== CANARY_PLAYFAB_ID ||
        !["diamond", "starter"].includes(receiptType)) {
        throw new TypeError("Certification-only v2 receipt store is restricted to the exact Sandbox canary.");
    }
    const diamond = receiptType === "diamond";
    const keyFor = diamond ? getXsollaDiamondReceiptV2Key : getXsollaStarterReceiptV2Key;
    const serialize = diamond ? serializeXsollaDiamondReceiptV2 : serializeXsollaStarterReceiptV2;
    const prefix = diamond ? "xsd2_" : "xss2_";
    return async function persistCertificationV2OnlyReceipt(receipt) {
        if (receipt?.playFabId !== CANARY_PLAYFAB_ID || receipt?.userId !== CANARY_PLAYFAB_ID) {
            fail("SHADOW_E2E_RECEIPT_IDENTITY_REFUSED", "Certification receipt belongs to another player.");
        }
        const key = keyFor(receipt.transactionId);
        const value = serialize(receipt);
        if (!key.startsWith(prefix)) {
            fail("SHADOW_E2E_RECEIPT_KEY_REFUSED", "Certification receipt key is not immutable v2.");
        }
        const read = async () => {
            const data = await playFabPost(configuration, "Server", "GetUserInternalData", {
                PlayFabId: CANARY_PLAYFAB_ID,
                Keys: [key]
            });
            const entry = data?.Data?.[key];
            if (entry === undefined) return null;
            if (!entry || typeof entry.Value !== "string") {
                fail("SHADOW_E2E_RECEIPT_READBACK_INVALID", "Certification v2 receipt readback is malformed.");
            }
            return entry.Value;
        };
        const existing = await read();
        if (existing !== null && existing !== value) {
            fail("SHADOW_E2E_RECEIPT_CONFLICT", "Immutable certification v2 receipt conflicts.");
        }
        if (existing === null) {
            await playFabPost(configuration, "Server", "UpdateUserInternalData", {
                PlayFabId: CANARY_PLAYFAB_ID,
                Data: { [key]: value }
            });
            if (await read() !== value) {
                fail("SHADOW_E2E_RECEIPT_READBACK_INVALID", "Certification v2 receipt readback differs.");
            }
        }
        return Object.freeze({ key, value, existing: existing !== null,
            certificationV2Only: true, legacyReceiptWritten: false });
    };
}

async function assertCanaryIdentityTwice(configuration) {
    const first = await playFabPost(configuration, "Server", "GetUserAccountInfo", {
        PlayFabId: CANARY_PLAYFAB_ID
    });
    const second = await playFabPost(configuration, "Server", "GetUserAccountInfo", {
        PlayFabId: CANARY_PLAYFAB_ID
    });
    for (const account of [first, second]) {
        if (account?.UserInfo?.PlayFabId !== CANARY_PLAYFAB_ID ||
            account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id !== CANARY_ENTITY_ID) {
            fail("SHADOW_E2E_CANARY_IDENTITY_MISMATCH", "PlayFab returned another canary identity.");
        }
    }
}

function normalizedStatistics(value) {
    return (Array.isArray(value) ? value : []).map((entry) => ({
        StatisticName: required(entry?.StatisticName, "StatisticName", 160),
        Value: Number(entry?.Value)
    })).sort((left, right) => left.StatisticName.localeCompare(right.StatisticName));
}

const LEGACY_CURRENCIES = Object.freeze([
    Object.freeze({ code: "GD", displayName: "Gold", existedField: "gdExisted", balanceField: "gdBalance" }),
    Object.freeze({ code: "DM", displayName: "Diamonds", existedField: "dmExisted", balanceField: "dmBalance" })
]);

function listedLegacyCurrencies(value) {
    const entries = Array.isArray(value?.VirtualCurrencies) ? value.VirtualCurrencies : [];
    return new Map(entries.map((entry) => [entry?.CurrencyCode, entry]));
}

function legacyCurrencyBalance(inventory, code) {
    const value = Number(inventory?.VirtualCurrency?.[code] ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) {
        fail("SHADOW_E2E_LEGACY_CURRENCY_INVALID", `${code} balance is invalid.`);
    }
    return value;
}

function legacyCurrencyType(definition) {
    return {
        CurrencyCode: definition.code,
        DisplayName: definition.displayName,
        InitialDeposit: 0,
        RechargeRate: 0,
        RechargeMax: 0
    };
}

async function addLegacyCurrencyTypes(configuration, definitions) {
    if (definitions.length === 0) return;
    await playFabPost(configuration, "Admin", "AddVirtualCurrencyTypes", {
        VirtualCurrencies: definitions.map(legacyCurrencyType)
    });
}

async function zeroLegacyCurrencyBalances(configuration, inventory) {
    for (const definition of LEGACY_CURRENCIES) {
        const balance = legacyCurrencyBalance(inventory, definition.code);
        if (balance > 0) {
            await playFabPost(configuration, "Server", "SubtractUserVirtualCurrency", {
                PlayFabId: CANARY_PLAYFAB_ID,
                VirtualCurrency: definition.code,
                Amount: balance
            });
        }
    }
}

function legacyCompatibilityMarker(raw, baselineRaw) {
    if (!raw) return null;
    let marker;
    try { marker = JSON.parse(raw); } catch { marker = null; }
    const expectedHash = createHash("sha256").update(baselineRaw).digest("hex");
    if (!marker || marker.schemaVersion !== 1 || marker.baselineHash !== expectedHash ||
        marker.playFabId !== CANARY_PLAYFAB_ID || marker.entityId !== CANARY_ENTITY_ID ||
        marker.gdExisted !== false || marker.gdBalance !== 0) {
        fail("SHADOW_E2E_LEGACY_COMPATIBILITY_INVALID", "Legacy currency compatibility evidence is invalid.");
    }
    return marker;
}

function resolvedLegacyCurrencyBaseline(baseline, baselineRaw, compatibilityRaw, currencyTypes, inventory) {
    const output = {};
    for (const definition of LEGACY_CURRENCIES) {
        let existed = baseline[definition.existedField];
        let balance = baseline[definition.balanceField];
        if (definition.code === "GD" && existed === undefined && balance === undefined) {
            const compatibility = legacyCompatibilityMarker(compatibilityRaw, baselineRaw);
            if (compatibility) {
                existed = false;
                balance = 0;
            } else if (!currencyTypes.has("GD") && legacyCurrencyBalance(inventory, "GD") === 0) {
                // The schema-1 active certification baseline predates GD support. Absence
                // in both the provider type registry and inventory is the only safe
                // marker-free inference; an existing GD type is deliberately ambiguous.
                existed = false;
                balance = 0;
            } else {
                fail("SHADOW_E2E_GD_BASELINE_AMBIGUOUS",
                    "Pre-GD baseline cannot be restored while live GD origin is ambiguous.");
            }
        }
        if (typeof existed !== "boolean" || !Number.isSafeInteger(balance) || balance < 0 ||
            !existed && balance !== 0) {
            fail("SHADOW_E2E_LEGACY_BASELINE_INVALID", `${definition.code} baseline is invalid.`);
        }
        output[definition.code] = Object.freeze({ definition, existed, balance });
    }
    return Object.freeze(output);
}

export async function prepareLegacyCanaryBaseline(configuration, redis) {
    const key = `${configuration.redisPrefix}legacy-baseline`;
    await assertCanaryIdentityTwice(configuration);
    if (await redis.get(key)) fail("SHADOW_E2E_BASELINE_ALREADY_CAPTURED", "Legacy baseline is already captured.");
    const [data, inventory, currencies, statistics] = await Promise.all([
        playFabPost(configuration, "Server", "GetUserInternalData", { PlayFabId: CANARY_PLAYFAB_ID, Keys: ["profile_v1"] }),
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID }),
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {}),
        playFabPost(configuration, "Server", "GetPlayerStatistics", { PlayFabId: CANARY_PLAYFAB_ID })
    ]);
    const profile = data?.Data?.profile_v1?.Value ?? null;
    const currencyTypes = listedLegacyCurrencies(currencies);
    const currencyState = Object.fromEntries(LEGACY_CURRENCIES.map((definition) => [definition.code, {
        existed: currencyTypes.has(definition.code),
        balance: legacyCurrencyBalance(inventory, definition.code)
    }]));
    const baseline = {
        schemaVersion: 1, playFabId: CANARY_PLAYFAB_ID, entityId: CANARY_ENTITY_ID,
        profile,
        gdExisted: currencyState.GD.existed, gdBalance: currencyState.GD.balance,
        dmExisted: currencyState.DM.existed, dmBalance: currencyState.DM.balance,
        statistics: normalizedStatistics(statistics?.Statistics), capturedAtUtc: new Date().toISOString()
    };
    const raw = JSON.stringify(baseline);
    if (await redis.set(key, raw, { NX: true }) !== "OK" || await redis.get(key) !== raw) {
        fail("SHADOW_E2E_BASELINE_CAPTURE_FAILED", "Legacy baseline was not captured atomically.");
    }
    const created = LEGACY_CURRENCIES.filter((definition) => !currencyTypes.has(definition.code));
    await addLegacyCurrencyTypes(configuration, created);
    await zeroLegacyCurrencyBalances(configuration, inventory);
    const value = JSON.stringify(createLegacyCanaryBaseline());
    await playFabPost(configuration, "Server", "UpdateUserInternalData", {
        PlayFabId: CANARY_PLAYFAB_ID, Data: { profile_v1: value }
    });
    const [verifyData, verifyInventory, verifyCurrencies] = await Promise.all([
        playFabPost(configuration, "Server", "GetUserInternalData", { PlayFabId: CANARY_PLAYFAB_ID, Keys: ["profile_v1"] }),
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID }),
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {})
    ]);
    const verifiedTypes = listedLegacyCurrencies(verifyCurrencies);
    if (verifyData?.Data?.profile_v1?.Value !== value ||
        LEGACY_CURRENCIES.some((definition) => !verifiedTypes.has(definition.code) ||
            legacyCurrencyBalance(verifyInventory, definition.code) !== 0)) {
        fail("SHADOW_E2E_LEGACY_BASELINE_VERIFY_FAILED", "Legacy baseline readback differs.");
    }
    return Object.freeze({ status: "prepared",
        profileHash: createHash("sha256").update(value).digest("hex"),
        gdCreated: created.some((entry) => entry.code === "GD"),
        dmCreated: created.some((entry) => entry.code === "DM") });
}

export async function upgradeLegacyCanaryCurrencies(configuration, redis) {
    const key = `${configuration.redisPrefix}legacy-baseline`;
    const compatibilityKey = `${key}:currency-compatibility-v2`;
    const [rawA, rawB] = await Promise.all([redis.get(key), redis.get(key)]);
    if (!rawA || rawA !== rawB) fail("SHADOW_E2E_BASELINE_MISSING", "Captured Legacy baseline is absent or unstable.");
    const baseline = JSON.parse(rawA);
    if (baseline.playFabId !== CANARY_PLAYFAB_ID || baseline.entityId !== CANARY_ENTITY_ID) {
        fail("SHADOW_E2E_BASELINE_IDENTITY_MISMATCH", "Captured Legacy baseline belongs to another identity.");
    }
    const hasGdExisted = baseline.gdExisted !== undefined;
    const hasGdBalance = baseline.gdBalance !== undefined;
    if (hasGdExisted !== hasGdBalance) {
        fail("SHADOW_E2E_LEGACY_BASELINE_INVALID", "Partial GD baseline is refused.");
    }
    if (hasGdExisted) {
        return Object.freeze({ status: "current_baseline", baselineUnchanged: true });
    }
    await assertCanaryIdentityTwice(configuration);
    let compatibilityRaw = await redis.get(compatibilityKey);
    if (!compatibilityRaw) {
        const [currencies, inventory] = await Promise.all([
            playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {}),
            playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID })
        ]);
        if (listedLegacyCurrencies(currencies).has("GD") || legacyCurrencyBalance(inventory, "GD") !== 0) {
            fail("SHADOW_E2E_GD_BASELINE_AMBIGUOUS",
                "GD must be absent and zero before upgrading the pre-GD baseline.");
        }
        compatibilityRaw = JSON.stringify({
            schemaVersion: 1, playFabId: CANARY_PLAYFAB_ID, entityId: CANARY_ENTITY_ID,
            baselineHash: createHash("sha256").update(rawA).digest("hex"),
            gdExisted: false, gdBalance: 0, capturedAtUtc: new Date().toISOString()
        });
        if (await redis.set(compatibilityKey, compatibilityRaw, { NX: true }) !== "OK") {
            compatibilityRaw = await redis.get(compatibilityKey);
        }
    }
    legacyCompatibilityMarker(compatibilityRaw, rawA);
    const [currencies, inventory] = await Promise.all([
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {}),
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID })
    ]);
    const currencyTypes = listedLegacyCurrencies(currencies);
    await addLegacyCurrencyTypes(configuration,
        LEGACY_CURRENCIES.filter((definition) => !currencyTypes.has(definition.code)));
    await zeroLegacyCurrencyBalances(configuration, inventory);
    const [verifiedCurrencies, verifiedInventory] = await Promise.all([
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {}),
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID })
    ]);
    const verifiedTypes = listedLegacyCurrencies(verifiedCurrencies);
    if (LEGACY_CURRENCIES.some((definition) => !verifiedTypes.has(definition.code) ||
        legacyCurrencyBalance(verifiedInventory, definition.code) !== 0)) {
        fail("SHADOW_E2E_LEGACY_BASELINE_VERIFY_FAILED", "GD/DM compatibility preparation differs.");
    }
    if (await redis.get(key) !== rawA) {
        fail("SHADOW_E2E_BASELINE_CHANGED", "Legacy baseline changed during compatibility preparation.");
    }
    return Object.freeze({ status: "upgraded", baselineUnchanged: true,
        gdCreated: !currencyTypes.has("GD"), dmCreated: !currencyTypes.has("DM") });
}

export async function restoreLegacyCanaryBaseline(configuration, redis) {
    const key = `${configuration.redisPrefix}legacy-baseline`;
    const [rawA, rawB, compatibilityRaw] = await Promise.all([
        redis.get(key), redis.get(key), redis.get(`${key}:currency-compatibility-v2`)
    ]);
    if (!rawA || rawA !== rawB) fail("SHADOW_E2E_BASELINE_MISSING", "Captured Legacy baseline is absent or unstable.");
    const baseline = JSON.parse(rawA);
    if (baseline.playFabId !== CANARY_PLAYFAB_ID || baseline.entityId !== CANARY_ENTITY_ID) {
        fail("SHADOW_E2E_BASELINE_IDENTITY_MISMATCH", "Captured Legacy baseline belongs to another identity.");
    }
    await assertCanaryIdentityTwice(configuration);
    const [initialInventory, initialCurrencies] = await Promise.all([
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID }),
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {})
    ]);
    let currencyTypes = listedLegacyCurrencies(initialCurrencies);
    const desired = resolvedLegacyCurrencyBaseline(
        baseline, rawA, compatibilityRaw, currencyTypes, initialInventory);
    await addLegacyCurrencyTypes(configuration, LEGACY_CURRENCIES.filter((definition) =>
        desired[definition.code].existed && !currencyTypes.has(definition.code)));
    if (LEGACY_CURRENCIES.some((definition) => desired[definition.code].existed && !currencyTypes.has(definition.code))) {
        currencyTypes = listedLegacyCurrencies(await playFabPost(
            configuration, "Admin", "ListVirtualCurrencyTypes", {}));
    }
    const currentInventory = await playFabPost(configuration, "Server", "GetUserInventory", {
        PlayFabId: CANARY_PLAYFAB_ID
    });
    for (const definition of LEGACY_CURRENCIES) {
        const target = desired[definition.code];
        const current = legacyCurrencyBalance(currentInventory, definition.code);
        if (!currencyTypes.has(definition.code) && (current !== 0 || target.balance !== 0)) {
            fail("SHADOW_E2E_LEGACY_CURRENCY_INVALID", `${definition.code} type is absent with a non-zero balance.`);
        }
        const delta = target.balance - current;
        if (delta !== 0) {
            await playFabPost(configuration, "Server", delta > 0 ? "AddUserVirtualCurrency" : "SubtractUserVirtualCurrency", {
                PlayFabId: CANARY_PLAYFAB_ID, VirtualCurrency: definition.code, Amount: Math.abs(delta)
            });
        }
    }
    await playFabPost(configuration, "Server", "UpdateUserInternalData", baseline.profile === null ? {
        PlayFabId: CANARY_PLAYFAB_ID, KeysToRemove: ["profile_v1"]
    } : { PlayFabId: CANARY_PLAYFAB_ID, Data: { profile_v1: baseline.profile } });
    await playFabPost(configuration, "Admin", "ResetUserStatistics", { PlayFabId: CANARY_PLAYFAB_ID });
    if (baseline.statistics.length > 0) {
        await playFabPost(configuration, "Server", "UpdatePlayerStatistics", {
            PlayFabId: CANARY_PLAYFAB_ID, Statistics: baseline.statistics
        });
    }
    const [dataA, dataB, inventoryA, statistics, currenciesBeforeRemoval] = await Promise.all([
        playFabPost(configuration, "Server", "GetUserInternalData", { PlayFabId: CANARY_PLAYFAB_ID, Keys: ["profile_v1"] }),
        playFabPost(configuration, "Server", "GetUserInternalData", { PlayFabId: CANARY_PLAYFAB_ID, Keys: ["profile_v1"] }),
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID }),
        playFabPost(configuration, "Server", "GetPlayerStatistics", { PlayFabId: CANARY_PLAYFAB_ID }),
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {})
    ]);
    const restoredProfileA = dataA?.Data?.profile_v1?.Value ?? null;
    const restoredProfileB = dataB?.Data?.profile_v1?.Value ?? null;
    const restoredBalances = Object.fromEntries(LEGACY_CURRENCIES.map((definition) =>
        [definition.code, legacyCurrencyBalance(inventoryA, definition.code)]));
    if (restoredProfileA !== baseline.profile || restoredProfileB !== baseline.profile ||
        LEGACY_CURRENCIES.some((definition) => restoredBalances[definition.code] !== desired[definition.code].balance) ||
        JSON.stringify(normalizedStatistics(statistics?.Statistics)) !== JSON.stringify(baseline.statistics)) {
        fail("SHADOW_E2E_LEGACY_RESTORE_VERIFY_FAILED", "Legacy profile, GD/DM, or statistics restore differs.");
    }
    const beforeRemovalTypes = listedLegacyCurrencies(currenciesBeforeRemoval);
    const removeDefinitions = LEGACY_CURRENCIES.filter((definition) =>
        !desired[definition.code].existed && beforeRemovalTypes.has(definition.code));
    for (const definition of removeDefinitions) {
        if (restoredBalances[definition.code] !== 0) {
            fail("SHADOW_E2E_CURRENCY_REMOVE_REFUSED", `${definition.code} may be removed only at zero balance.`);
        }
    }
    if (removeDefinitions.length > 0) {
        await playFabPost(configuration, "Admin", "RemoveVirtualCurrencyTypes", {
            VirtualCurrencies: removeDefinitions.map(legacyCurrencyType)
        });
    }
    const [finalCurrencies, finalInventory] = await Promise.all([
        playFabPost(configuration, "Admin", "ListVirtualCurrencyTypes", {}),
        playFabPost(configuration, "Server", "GetUserInventory", { PlayFabId: CANARY_PLAYFAB_ID })
    ]);
    const finalTypes = listedLegacyCurrencies(finalCurrencies);
    for (const definition of LEGACY_CURRENCIES) {
        const target = desired[definition.code];
        if (finalTypes.has(definition.code) !== target.existed ||
            legacyCurrencyBalance(finalInventory, definition.code) !== target.balance) {
            fail("SHADOW_E2E_CURRENCY_REMOVE_VERIFY_FAILED",
                `${definition.code} type/balance differs after restore.`);
        }
    }
    await redis.set(`${key}:restored`, JSON.stringify({ restoredAtUtc: new Date().toISOString(),
        baselineHash: createHash("sha256").update(rawA).digest("hex") }));
    return Object.freeze({ status: "restored",
        gdRemoved: !desired.GD.existed, dmRemoved: !desired.DM.existed });
}

async function playFabEntityPost(configuration, entityToken, endpoint, body) {
    const response = await fetch(`https://${configuration.titleId}.playfabapi.com/Object/${endpoint}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(configuration.providerTimeoutMs),
        headers: { "Content-Type": "application/json", "X-EntityToken": entityToken },
        body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 200) {
        fail("SHADOW_E2E_PLAYFAB_OBJECT_CALL_FAILED", `PlayFab Object/${endpoint} failed.`);
    }
    return payload.data;
}

async function providerContext(configuration) {
    await assertCanaryIdentityTwice(configuration);
    const token = await playFabPost(configuration, "Authentication", "GetEntityToken", {
        Entity: { Id: configuration.titleId, Type: "title" }
    });
    return Object.freeze({
        entity: Object.freeze({ Id: CANARY_ENTITY_ID, Type: "title_player_account" }),
        entityToken: required(token?.EntityToken, "EntityToken", 8192)
    });
}

function providerObjects(result) {
    const output = {};
    for (const name of PROVIDER_OBJECT_NAMES) {
        output[name] = result?.Objects?.[name]?.DataObject ?? null;
    }
    return output;
}

function providerObjectsHash(objects) {
    return createHash("sha256").update(JSON.stringify(Object.fromEntries(
        Object.keys(objects).sort().map((key) => [key, objects[key]])
    ))).digest("hex");
}

export async function captureProviderCanaryBaseline(configuration, redis) {
    const key = `${configuration.redisPrefix}provider-baseline`;
    if (await redis.get(key)) fail("SHADOW_E2E_PROVIDER_BASELINE_EXISTS", "Provider baseline is already captured.");
    const context = await providerContext(configuration);
    const first = await playFabEntityPost(configuration, context.entityToken, "GetObjects", { Entity: context.entity });
    const second = await playFabEntityPost(configuration, context.entityToken, "GetObjects", { Entity: context.entity });
    const objects = providerObjects(first);
    if (first?.ProfileVersion !== second?.ProfileVersion ||
        providerObjectsHash(objects) !== providerObjectsHash(providerObjects(second))) {
        fail("SHADOW_E2E_PROVIDER_BASELINE_UNSTABLE", "Provider objects changed during baseline capture.");
    }
    const baseline = {
        schemaVersion: 1, playFabId: CANARY_PLAYFAB_ID, entityId: CANARY_ENTITY_ID,
        capturedProfileVersion: first.ProfileVersion, objects,
        objectsHash: providerObjectsHash(objects), capturedAtUtc: new Date().toISOString()
    };
    const raw = JSON.stringify(baseline);
    if (await redis.set(key, raw, { NX: true }) !== "OK" || await redis.get(key) !== raw) {
        fail("SHADOW_E2E_PROVIDER_BASELINE_CAPTURE_FAILED", "Provider baseline was not captured atomically.");
    }
    return Object.freeze({ status: "captured", objectsHash: baseline.objectsHash,
        profileVersion: baseline.capturedProfileVersion });
}

export async function restoreProviderCanaryBaseline(configuration, redis) {
    const key = `${configuration.redisPrefix}provider-baseline`;
    const [rawA, rawB] = await Promise.all([redis.get(key), redis.get(key)]);
    if (!rawA || rawA !== rawB) fail("SHADOW_E2E_PROVIDER_BASELINE_MISSING", "Provider baseline is absent or unstable.");
    const baseline = JSON.parse(rawA);
    if (baseline.playFabId !== CANARY_PLAYFAB_ID || baseline.entityId !== CANARY_ENTITY_ID ||
        baseline.objectsHash !== providerObjectsHash(baseline.objects) ||
        Object.keys(baseline.objects).sort().join(",") !== [...PROVIDER_OBJECT_NAMES].sort().join(",")) {
        fail("SHADOW_E2E_PROVIDER_BASELINE_INVALID", "Provider baseline identity/hash/object whitelist is invalid.");
    }
    const context = await providerContext(configuration);
    const beforeA = await playFabEntityPost(configuration, context.entityToken, "GetObjects", { Entity: context.entity });
    const beforeB = await playFabEntityPost(configuration, context.entityToken, "GetObjects", { Entity: context.entity });
    if (beforeA?.ProfileVersion !== beforeB?.ProfileVersion ||
        providerObjectsHash(providerObjects(beforeA)) !== providerObjectsHash(providerObjects(beforeB))) {
        fail("SHADOW_E2E_PROVIDER_RESTORE_RACE", "Provider objects changed before restore CAS.");
    }
    const writes = PROVIDER_OBJECT_NAMES.map((ObjectName) => baseline.objects[ObjectName] === null
        ? { ObjectName, DeleteObject: true }
        : { ObjectName, DataObject: baseline.objects[ObjectName] });
    await playFabEntityPost(configuration, context.entityToken, "SetObjects", {
        Entity: context.entity,
        ExpectedProfileVersion: beforeA.ProfileVersion,
        Objects: writes
    });
    const afterA = await playFabEntityPost(configuration, context.entityToken, "GetObjects", { Entity: context.entity });
    const afterB = await playFabEntityPost(configuration, context.entityToken, "GetObjects", { Entity: context.entity });
    const hashA = providerObjectsHash(providerObjects(afterA));
    const hashB = providerObjectsHash(providerObjects(afterB));
    if (hashA !== baseline.objectsHash || hashB !== baseline.objectsHash || hashA !== hashB) {
        fail("SHADOW_E2E_PROVIDER_RESTORE_VERIFY_FAILED", "Provider object restore readback differs.");
    }
    await redis.set(`${key}:restored`, JSON.stringify({
        restoredAtUtc: new Date().toISOString(), objectsHash: hashA,
        profileVersion: afterA.ProfileVersion
    }));
    return Object.freeze({ status: "restored", objectsHash: hashA,
        profileVersion: afterA.ProfileVersion });
}

export async function createCanaryE2eHarness(configuration, {
    startHttp = false,
    startSchedulers = true,
    serverInstanceId = null,
    nowMilliseconds = () => Date.now(),
    decorateRedisClient = (client) => client,
    maximumHistoryEntries = 2000
} = {}) {
    if (typeof startSchedulers !== "boolean" || typeof nowMilliseconds !== "function" ||
        typeof decorateRedisClient !== "function") {
        throw new TypeError("Canary E2E harness test hooks are invalid.");
    }
    const resolvedServerId = serverInstanceId === null
        ? `shadow-e2e-${configuration.runId}`
        : safeId(serverInstanceId, "serverInstanceId", 160);
    const redis = decorateRedisClient(createClient({ url: configuration.redisUrl }));
    if (!redis || typeof redis.connect !== "function" || typeof redis.quit !== "function") {
        throw new TypeError("Canary E2E Redis decorator returned an invalid client.");
    }
    redis.on("error", () => {});
    await redis.connect();
    if (await redis.ping() !== "PONG") fail("SHADOW_E2E_REDIS_UNAVAILABLE", "Redis did not return PONG.");
    if (startHttp) {
        const [legacyBaseline, providerBaseline] = await Promise.all([
            redis.get(`${configuration.redisPrefix}legacy-baseline`),
            redis.get(`${configuration.redisPrefix}provider-baseline`)
        ]);
        if (!legacyBaseline || !providerBaseline) fail("SHADOW_E2E_BASELINE_REQUIRED",
            "Legacy and provider baselines must be captured before starting the certification HTTP process.");
    }
    const policy = evaluateFinancialShadowPolicy({
        enabled: true, nodeEnv: "test", shadowEnvironment: "sandbox",
        allowlistedPlayFabIds: [CANARY_PLAYFAB_ID], serverId: resolvedServerId,
        redisConfigured: true, playFabConfigured: true
    });
    const metrics = createFinancialShadowMetrics();
    const stateStore = createRedisFinancialShadowStateStore({
        redisClient: redis, prefix: `${configuration.redisPrefix}shadow-state:`
    });
    const shadowRuntime = createFinancialShadowRuntime({
        stateStore, policy, metrics, presenceLeaseTtlMilliseconds: configuration.presenceTtlMs,
        nowMilliseconds, maximumHistoryEntries,
        allowOfflineSourceAttestedProjection: true,
        offlineSourceAttestedPlayFabId: CANARY_PLAYFAB_ID
    });
    const mirrorInbox = Object.freeze({
        ...createRedisCompatibleServerEconomyPocOperationInbox({
            redis, prefix: `${configuration.redisPrefix}shadow-mirror:`, nowMilliseconds
        }), shadowProjectionOnly: true
    });
    const mirrorService = createFinancialShadowPocInboxService({
        operationInbox: mirrorInbox, runtime: shadowRuntime, serverId: policy.serverId, intervalMilliseconds: 500
    });
    if (startSchedulers) mirrorService.start();
    const playFab = createPlayFabFinancialProfileClient({
        titleId: configuration.titleId, secretKey: configuration.secretKey,
        timeoutMs: configuration.providerTimeoutMs
    });
    const account = await playFab.getUserAccountInfo(CANARY_PLAYFAB_ID);
    if (account?.UserInfo?.PlayFabId !== CANARY_PLAYFAB_ID ||
        account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id !== CANARY_ENTITY_ID) {
        fail("SHADOW_E2E_CANARY_IDENTITY_MISMATCH", "PlayFab returned another canary identity.");
    }
    const candidateLeases = createRedisServerEconomyPocPlayerLeases({
        redis, prefix: `${configuration.redisPrefix}provider:`
    });
    const assertPlayerFence = (input) => candidateLeases.assertCurrent(input);
    const snapshotStore = createObservedServerEconomyPocPlayFabSnapshotStore({
        client: playFab, assertPlayerFence, nowMilliseconds
    });
    const metadata = await snapshotStore.readWithMetadata(CANARY_PLAYFAB_ID);
    if (!metadata.exists) fail("SHADOW_E2E_PROVIDER_SNAPSHOT_MISSING", "PlayFab POC snapshot must be initialized explicitly.");
    const providerInbox = createRedisCompatibleServerEconomyPocOperationInbox({
        redis, prefix: `${configuration.redisPrefix}provider:`, assertPlayerFence, nowMilliseconds
    });
    const providerRuntime = createServerEconomyPocRuntimeEngine({
        snapshotStore,
        operationInbox: providerInbox,
        walStore: createRedisCompatibleServerEconomyPocWalStore({ redis, prefix: `${configuration.redisPrefix}provider:` }),
        playerLeases: createServerEconomyPocPlayFabFencedPlayerLeases({ candidateLeases, snapshotStore }),
        workerId: resolvedServerId
    });
    const providerScheduler = createCertificationProviderScheduler({ providerRuntime });
    if (startSchedulers) providerScheduler.service.start();
    const ledger = createPaymentLedger({
        store: createRedisPaymentLedgerStore(redis, { prefix: `${configuration.redisPrefix}ledger:` })
    });
    const fanout = createCanonicalProjectionFanout({ providerInbox, providerRuntime, mirrorService });
    const producer = createFinancialShadowPaymentProducer({
        ledger,
        loadXsollaV2Receipt: createPlayFabXsollaV2ReceiptReader({
            titleId: configuration.titleId, secretKey: configuration.secretKey,
            timeoutMilliseconds: configuration.providerTimeoutMs
        }),
        enqueueCanonicalProjection: fanout,
        policy
    });
    const processReceipt = createXsollaLedgeredReceiptProcessor({
        ledger,
        persistStarterPackReceiptV2: createCertificationV2OnlyReceiptStore(
            configuration, "starter"),
        persistDiamondPackReceiptV2: createCertificationV2OnlyReceiptStore(
            configuration, "diamond"),
        workerId: `shadow-e2e-receipt-${configuration.runId}`
    });
    const authenticate = createCachedPlayFabSessionTicketAuthenticator({
        authenticate: createPlayFabSessionTicketAuthenticator({
            titleId: configuration.titleId, secretKey: configuration.secretKey,
            timeoutMs: configuration.providerTimeoutMs
        })
    });
    const handlers = createFinancialShadowHttpHandlers({
        policy, runtime: shadowRuntime, authenticateSessionTicket: authenticate.authenticate,
        authenticationDiagnostics: authenticate.diagnostics
    });
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "16kb", strict: true }));
    registerFinancialShadowRoutes(app, { handlers });
    app.post(CONTROL_PATH, createProjectionControlHandler({ producer, controlToken: configuration.controlToken }));
    app.use((error, _req, res, _next) => res.status(error?.statusCode || 500).json({
        error: "financial_shadow_canary_e2e_failed",
        code: typeof error?.code === "string" ? error.code : "SHADOW_E2E_INTERNAL"
    }));
    let server = null;
    if (startHttp) {
        server = await new Promise((resolve, reject) => {
            const candidate = app.listen(configuration.port, "127.0.0.1", () => resolve(candidate));
            candidate.once("error", reject);
        });
    }
    async function close() {
        await providerScheduler.service.stop();
        await mirrorService.stop();
        if (server) await new Promise((resolve) => server.close(resolve));
        await redis.quit();
    }
    return Object.freeze({
        app, server, redis, policy, metrics, shadowRuntime, mirrorService,
        providerRuntime, providerScheduler, snapshotStore, ledger, producer,
        stores: Object.freeze({
            shadowState: stateStore,
            mirrorInbox,
            providerInbox: providerRuntime.stores.operationInbox,
            providerWal: providerRuntime.stores.walStore,
            providerLeases: candidateLeases
        }),
        prepareReceipt(scenario, providerTransactionId) {
            return processReceipt(certificationReceipt(scenario, providerTransactionId));
        },
        close
    });
}

async function main() {
    const configuration = loadCanaryE2eConfiguration();
    const [action = "serve", argument] = process.argv.slice(2);
    const harness = await createCanaryE2eHarness(configuration, canaryActionRuntimeOptions(action));
    if (action === "serve") {
        let closing = false;
        const shutdown = async (signal) => {
            if (closing) return;
            closing = true;
            try {
                await harness.close();
                process.stdout.write(JSON.stringify({ status: "stopped", signal }) + "\n");
            } catch (error) {
                process.stderr.write(JSON.stringify({ status: "stop_failed",
                    code: error?.code || "SHADOW_E2E_STOP_FAILED" }) + "\n");
                process.exitCode = 1;
            }
        };
        process.once("SIGINT", () => { void shutdown("SIGINT"); });
        process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
        process.once("uncaughtException", (error) => { process.stderr.write(JSON.stringify({
            status: "failed", code: error?.code || "SHADOW_E2E_UNCAUGHT" }) + "\n"); void shutdown("uncaughtException"); });
        const address = harness.server.address();
        process.stdout.write(JSON.stringify({ status: "ready", host: "127.0.0.1", port: address.port,
            titleId: SANDBOX_TITLE_ID, canaryPlayFabId: CANARY_PLAYFAB_ID, authoritative: false }) + "\n");
        return;
    }
    try {
        if (action === "prepare-diamond-i" || action === "prepare-starter-i") {
            const input = exactTransactionInput({ providerTransactionId: argument });
            const result = await harness.prepareReceipt(action === "prepare-diamond-i" ? "diamond-i" : "starter-i",
                input.providerTransactionId);
            process.stdout.write(JSON.stringify({ status: result.status, receiptId: result.receiptId }) + "\n");
        } else if (action === "prepare-legacy") {
            process.stdout.write(JSON.stringify(await prepareLegacyCanaryBaseline(configuration, harness.redis)) + "\n");
        } else if (action === "upgrade-legacy-currencies") {
            process.stdout.write(JSON.stringify(await upgradeLegacyCanaryCurrencies(configuration, harness.redis)) + "\n");
        } else if (action === "restore-legacy") {
            process.stdout.write(JSON.stringify(await restoreLegacyCanaryBaseline(configuration, harness.redis)) + "\n");
        } else if (action === "capture-provider") {
            process.stdout.write(JSON.stringify(await captureProviderCanaryBaseline(configuration, harness.redis)) + "\n");
        } else if (action === "restore-provider") {
            process.stdout.write(JSON.stringify(await restoreProviderCanaryBaseline(configuration, harness.redis)) + "\n");
        } else {
            fail("SHADOW_E2E_ACTION_REFUSED", "Unknown certification action.");
        }
    } finally { await harness.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file:///${process.argv[1].replace(/\\/gu, "/")}`))) {
    main().catch((error) => {
        process.stderr.write(JSON.stringify({ status: "failed", code: error?.code || "SHADOW_E2E_FAILED" }) + "\n");
        process.exitCode = 1;
    });
}
