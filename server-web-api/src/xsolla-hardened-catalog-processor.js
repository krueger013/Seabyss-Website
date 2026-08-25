import { XsollaInvalidUserError } from "./xsolla-webhook.js";
import {
    hasXsollaDiamondItemContainer,
    resolveXsollaDiamondPack
} from "./xsolla-diamond-packs.js";
import { resolveXsollaStarterPack } from "./xsolla-starter-packs.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";
import {
    validateXsollaEconomicContract,
    XsollaEconomicContractError
} from "./xsolla-economic-contract.js";

function canonicalIdentifier(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 160 &&
        value === value.trim() && !/\s/.test(value)
        ? value
        : null;
}

function canonicalTransactionId(value) {
    let normalized;
    if (typeof value === "string") normalized = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) normalized = String(value);
    else if (typeof value === "bigint") normalized = String(value);
    else return null;
    if (normalized !== normalized.trim() || !/^[1-9][0-9]*$/.test(normalized)) return null;
    try {
        return BigInt(normalized) <= 9223372036854775807n ? normalized : null;
    } catch {
        return null;
    }
}

function paymentMode(payload, notificationType) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, "dry_run")) return "invalid";
    if (notificationType === "payment") {
        if (!Object.prototype.hasOwnProperty.call(payload?.transaction || {}, "dry_run")) {
            return "production";
        }
        return payload.transaction.dry_run === 1 ? "sandbox" : "invalid";
    }
    if (notificationType === "order_paid") {
        const hasBillingDryRun = Object.prototype.hasOwnProperty.call(
            payload?.billing?.transaction || {},
            "dry_run"
        );
        if (payload?.order?.mode === "sandbox") {
            return hasBillingDryRun && payload.billing.transaction.dry_run === 1
                ? "sandbox"
                : "invalid";
        }
        if (payload?.order?.mode === "default") {
            return hasBillingDryRun ? "invalid" : "production";
        }
    }
    return "invalid";
}

function assertPaidOrderEnvelope(payload, notificationType) {
    if (notificationType !== "order_paid") return;
    if (payload?.order?.status !== "paid" || payload?.order?.currency_type !== "real" ||
        payload?.billing?.notification_type !== "payment") {
        throw new Error("Xsolla order_paid envelope is not a settled real-currency payment.");
    }
}

function allowedUsers(values) {
    if (!Array.isArray(values)) return new Set();
    return new Set(values.map(canonicalIdentifier).filter(Boolean));
}
function providerCreatedAtUtc(payload, notificationType, now) {
    const candidate = notificationType === "payment"
        ? payload?.transaction?.payment_date
        : payload?.billing?.transaction?.payment_date;
    if (candidate !== undefined && candidate !== null) {
        if (typeof candidate !== "string" || !candidate.endsWith("Z")) {
            throw new Error("Xsolla provider payment timestamp is invalid.");
        }
        const milliseconds = Date.parse(candidate);
        if (!Number.isFinite(milliseconds)) {
            throw new Error("Xsolla provider payment timestamp is invalid.");
        }
        return new Date(milliseconds).toISOString();
    }
    const current = now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
        throw new Error("Xsolla receipt server clock is unavailable.");
    }
    return new Date(current.getTime()).toISOString();
}


export function createXsollaHardenedCatalogEventProcessor({
    allowDiamondSandboxGrants = false,
    diamondSandboxTestPlayFabIds = [],
    allowDiamondProductionGrants = false,
    allowStarterSandboxGrants = false,
    starterSandboxTestPlayFabIds = [],
    allowStarterProductionGrants = false,
    validateUser,
    persistDiamondPackReceiptV2,
    persistStarterPackReceiptV2,
    persistCatalogReceipt = null,
    starterPaidCoordinator = null,
    recordFinancialException = null,
    fallbackProcessor = null,
    resolveProductPlan = getXsollaProductPlan,
    resolveStarterRewardPlan = getStarterRewardPlan,
    validateEconomicContract = validateXsollaEconomicContract,
    now = () => new Date()
} = {}) {
    const diamondSandboxUsers = allowedUsers(diamondSandboxTestPlayFabIds);
    const starterSandboxUsers = allowedUsers(starterSandboxTestPlayFabIds);
    const diamondSandboxEnabled = allowDiamondSandboxGrants === true;
    const diamondProductionEnabled = allowDiamondProductionGrants === true;
    const starterSandboxEnabled = allowStarterSandboxGrants === true;
    const starterProductionEnabled = allowStarterProductionGrants === true;
    if (typeof resolveProductPlan !== "function" ||
        typeof resolveStarterRewardPlan !== "function" ||
        typeof validateEconomicContract !== "function" ||
        typeof now !== "function" ||
        (recordFinancialException !== null &&
            typeof recordFinancialException !== "function")) {
        throw new TypeError("Hardened Xsolla Catalog processor dependencies are invalid.");
    }

    return async function processHardenedCatalogEvent(event = {}) {
        const { payload, notificationType, userId } = event;
        if (notificationType !== "payment" && notificationType !== "order_paid") {
            return typeof fallbackProcessor === "function"
                ? fallbackProcessor(event)
                : "validated_no_grant";
        }
        if (!hasXsollaDiamondItemContainer(payload, notificationType)) {
            return typeof fallbackProcessor === "function"
                ? fallbackProcessor(event)
                : "validated_no_grant";
        }

        const starterPack = resolveXsollaStarterPack(payload, notificationType);
        const diamondPack = resolveXsollaDiamondPack(payload, notificationType);
        const products = [starterPack, diamondPack].filter(Boolean);
        if (products.length !== 1) {
            return typeof fallbackProcessor === "function"
                ? fallbackProcessor(event)
                : (products.length > 1
                    ? "ignored_ambiguous_product"
                    : "ignored_unrecognized_product");
        }
        const product = products[0];
        const mode = paymentMode(payload, notificationType);
        if (mode === "invalid") return "ignored_dry_run";
        const playFabId = canonicalIdentifier(userId);
        if (!playFabId) {
            throw new Error("Xsolla payment user identity is invalid.");
        }
        const sandbox = mode === "sandbox";
        if (product.productType === "starter_pack") {
            if ((sandbox && (!starterSandboxEnabled || !starterSandboxUsers.has(playFabId))) ||
                (!sandbox && !starterProductionEnabled)) {
                return sandbox ? "ignored_dry_run" : "ignored_unrecognized_product";
            }
        } else if ((sandbox && (!diamondSandboxEnabled || !diamondSandboxUsers.has(playFabId))) ||
            (!sandbox && !diamondProductionEnabled)) {
            return sandbox ? "ignored_dry_run" : "ignored_unrecognized_product";
        }

        assertPaidOrderEnvelope(payload, notificationType);
        const plan = resolveProductPlan(product.xsollaSku);
        const transactionId = canonicalTransactionId(
            notificationType === "payment"
                ? payload?.transaction?.id
                : payload?.billing?.transaction?.id
        );
        if (!transactionId || typeof validateUser !== "function") {
            throw new Error("Xsolla Catalog payment validation is not configured.");
        }
        const userExists = await validateUser(playFabId);
        if (userExists === false) throw new XsollaInvalidUserError();
        if (userExists !== true) {
            throw new Error("Xsolla user validation returned an invalid result.");
        }
        const source = sandbox ? "xsolla_sandbox" : "xsolla_production";
        const environment = sandbox ? "sandbox" : "production";
        const createdAtUtc = providerCreatedAtUtc(payload, notificationType, now);
        let economicContract;
        try {
            economicContract = validateEconomicContract({
                payload,
                notificationType,
                product,
                productPlan: plan
            });
        } catch (error) {
            if (error instanceof XsollaEconomicContractError &&
                typeof recordFinancialException === "function") {
                await recordFinancialException({
                    state: "Quarantined",
                    reason: "economic_mismatch",
                    errorCode: error.code,
                    playFabId,
                    transactionId,
                    product,
                    productPlan: plan,
                    source,
                    environment,
                    createdAtUtc,
                    notificationType
                });
            }
            throw error;
        }

        if (product.productType === "starter_pack") {
            if (!starterPaidCoordinator || typeof starterPaidCoordinator.settlePaid !== "function" ||
                (typeof persistCatalogReceipt !== "function" &&
                    typeof persistStarterPackReceiptV2 !== "function")) {
                throw new Error("Hardened Starter payment processing is not configured.");
            }
            const settlement = await starterPaidCoordinator.settlePaid({
                payload,
                playFabId,
                transactionId,
                product,
                source,
                economicContract
            });
            if (settlement?.status === "manual_reconciliation") {
                if (settlement.reason === "duplicate_paid" &&
                    typeof recordFinancialException === "function") {
                    await recordFinancialException({
                        state: "DuplicatePaid",
                        reason: "duplicate_paid",
                        reconciliationCaseKey: settlement.caseKey,
                        playFabId,
                        transactionId,
                        product,
                        productPlan: plan,
                        source,
                        environment,
                        createdAtUtc,
                        notificationType
                    });
                }
                return "starter_pack_manual_reconciliation_required";
            }
            if (![
                "accepted",
                "accepted_unreserved",
                "replayed"
            ].includes(settlement?.status)) {
                throw new Error("Starter paid coordinator returned an invalid result.");
            }
            const rewardPlan = resolveStarterRewardPlan(product.xsollaSku);
            const receipt = {
                playFabId,
                transactionId,
                ...product,
                source,
                ...economicContract,
                provider: "xsolla",
                providerTransactionId: transactionId,
                userId: playFabId,
                createdAtUtc,
                environment,
                rewardPlanVersion: rewardPlan.planVersion,
                rewardPlanHash: rewardPlan.rewardPlanHash,
                rewards: rewardPlan.rewards
            };
            if (typeof persistCatalogReceipt === "function") {
                await persistCatalogReceipt(receipt);
            } else {
                await persistStarterPackReceiptV2(receipt);
            }
            return sandbox ? "starter_pack_sandbox_granted" : "starter_pack_granted";
        }

        if (typeof persistCatalogReceipt !== "function" &&
            typeof persistDiamondPackReceiptV2 !== "function") {
            throw new Error("Hardened Diamond payment processing is not configured.");
        }
        const receipt = {
            playFabId,
            transactionId,
            ...product,
            source,
            ...economicContract,
            provider: "xsolla",
            providerTransactionId: transactionId,
            userId: playFabId,
            createdAtUtc,
            environment
        };
        if (typeof persistCatalogReceipt === "function") {
            await persistCatalogReceipt(receipt);
        } else {
            await persistDiamondPackReceiptV2(receipt);
        }
        return sandbox ? "diamond_pack_sandbox_granted" : "diamond_pack_granted";
    };
}
