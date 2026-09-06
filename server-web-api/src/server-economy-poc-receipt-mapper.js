import { createHash } from "node:crypto";
import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";
import { getXsollaProductPlan, getXsollaDiamondRewardQuantity } from "./xsolla-product-plan-registry.js";
import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

const PREMIUM_TIERS = Object.freeze({
    seabyss_premium_bronze: "bronze",
    seabyss_premium_silver: "silver",
    seabyss_premium_gold: "gold",
    premium_bronze: "bronze",
    premium_silver: "silver",
    premium_gold: "gold"
});
const FORBIDDEN_CALLER_ECONOMICS = Object.freeze([
    "diamonds", "eliteBall", "premium", "deltas", "effects", "balances", "rewards"
]);

function stableId(providerTransactionId, sku) {
    return createHash("sha256")
        .update(`xsolla\u0000${providerTransactionId}\u0000${sku}`, "utf8")
        .digest("hex");
}

function requireValidatedProjection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        serverEconomyPocFail("POC_RECEIPT_INVALID", "Validated receipt projection is required.", { statusCode: 400 });
    }
    for (const key of FORBIDDEN_CALLER_ECONOMICS) {
        if (Object.hasOwn(value, key)) {
            serverEconomyPocFail(
                "POC_CLIENT_ECONOMICS_REJECTED",
                "Economic effects must be derived from the immutable server plan.",
                { statusCode: 400 }
            );
        }
    }
    if (value.provider !== "xsolla" || value.source !== "durable_immutable_receipt" ||
        value.receiptPersisted !== true || value.economicValidationPassed !== true) {
        serverEconomyPocFail(
            "POC_RECEIPT_NOT_VALIDATED",
            "Only a persisted and economically validated server receipt projection is accepted.",
            { statusCode: 403 }
        );
    }
    return value;
}

function starterEffects(plan) {
    const diamonds = plan.rewards.find((reward) => reward.rewardId === "diamonds");
    const eliteBall = plan.rewards.find((reward) => reward.rewardId === "elite_ball");
    const premium = plan.rewards.find((reward) => reward.rewardType === "PremiumDays");
    if (!diamonds || !premium ||
        diamonds.grantMode !== "additive" ||
        (eliteBall && eliteBall.grantMode !== "additive") ||
        premium.grantMode !== "duration_extension") {
        serverEconomyPocFail("POC_PLAN_UNSUPPORTED", "Starter plan lacks the three POC economic domains.");
    }
    return {
        diamonds: diamonds.quantity,
        eliteBall: eliteBall?.quantity || 0,
        premium: {
            tier: PREMIUM_TIERS[premium.rewardId],
            durationSeconds: premium.durationDays * 24 * 60 * 60
        }
    };
}

export function mapValidatedXsollaReceiptToServerEconomyPocOperation(projection) {
    const receipt = requireValidatedProjection(projection);
    const playFabId = serverEconomyPocId(receipt.playFabId, "playFabId", 160);
    const providerTransactionId = serverEconomyPocId(
        receipt.providerTransactionId,
        "providerTransactionId",
        200
    );
    const sku = serverEconomyPocId(receipt.sku, "sku", 255);
    const effectiveAtUnixMs = serverEconomyPocNonNegative(
        receipt.effectiveAtUnixMs,
        "effectiveAtUnixMs"
    );
    let product;
    try {
        if (!Number.isSafeInteger(receipt.productPlanVersion)) throw new TypeError("Explicit receipt plan version required.");
        product = getXsollaProductPlan(sku, receipt.productPlanVersion);
    } catch {
        serverEconomyPocFail("POC_PLAN_MISMATCH", "Product plan is unavailable.");
    }
    if (receipt.currency !== product.currency || receipt.amountMinor !== product.unitAmountMinor ||
        receipt.quantity !== 1 || receipt.productPlanHash !== product.planHash) {
        serverEconomyPocFail("POC_ECONOMIC_MISMATCH", "Validated receipt differs from the server product plan.");
    }

    let effects;
    if (product.productType === "starter_pack") {
        let plan;
        try { plan = getStarterRewardPlan(sku, receipt.rewardPlanVersion); }
        catch { serverEconomyPocFail("POC_PLAN_MISMATCH", "Starter reward plan is unavailable."); }
        if (receipt.rewardPlanHash !== plan.rewardPlanHash) {
            serverEconomyPocFail("POC_PLAN_MISMATCH", "Starter reward plan hash differs.");
        }
        effects = starterEffects(plan);
    } else if (product.productType === "diamond_pack") {
        effects = { diamonds: getXsollaDiamondRewardQuantity(sku, product.planVersion), eliteBall: 0, premium: null };
    } else if (Object.hasOwn(PREMIUM_TIERS, sku) && product.productType === "premium") {
        effects = {
            diamonds: 0,
            eliteBall: 0,
            premium: {
                tier: PREMIUM_TIERS[sku],
                durationSeconds: product.entitlementDurationDays * 24 * 60 * 60
            }
        };
    } else {
        serverEconomyPocFail("POC_PRODUCT_UNSUPPORTED", "Product is outside the three-domain POC.");
    }

    const identity = stableId(providerTransactionId, sku);
    return serverEconomyPocReadonly({
        playFabId,
        operationId: `poc_xsolla_${identity}`,
        eventId: `xsolla_${identity}`,
        reason: `xsolla_${product.productType}`,
        ...effects,
        effectiveAtUnixMs,
        source: "server_product_plan",
        sku,
        providerTransactionId
    });
}

export async function enqueueValidatedXsollaReceiptIntoServerEconomyPoc({ engine, projection } = {}) {
    if (typeof engine?.enqueueAuthoritativeHighValueOperation !== "function") {
        throw new TypeError("Authoritative POC engine is required.");
    }
    const operation = mapValidatedXsollaReceiptToServerEconomyPocOperation(projection);
    const submitted = await engine.enqueueAuthoritativeHighValueOperation(operation);
    return serverEconomyPocReadonly({ operation, submitted });
}

export function createValidatedServerEconomyPocReceiptProjectionForTests({
    playFabId,
    providerTransactionId,
    sku,
    effectiveAtUnixMs,
    productPlanVersion = 1,
    rewardPlanVersion = 1
} = {}) {
    const product = getXsollaProductPlan(sku, productPlanVersion);
    const projection = {
        provider: "xsolla",
        source: "durable_immutable_receipt",
        receiptPersisted: true,
        economicValidationPassed: true,
        playFabId,
        providerTransactionId,
        sku,
        effectiveAtUnixMs,
        quantity: 1,
        currency: product.currency,
        amountMinor: product.unitAmountMinor,
        productPlanVersion,
        productPlanHash: product.planHash
    };
    if (product.productType === "starter_pack") {
        const plan = getStarterRewardPlan(sku, rewardPlanVersion);
        projection.rewardPlanVersion = rewardPlanVersion;
        projection.rewardPlanHash = plan.rewardPlanHash;
    }
    return serverEconomyPocReadonly(projection);
}
