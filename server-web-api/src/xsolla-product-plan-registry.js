import { createHash } from "node:crypto";

export const XSOLLA_PRODUCT_PLAN_VERSION = 1;

const USD_CURRENCY = "USD";
const ALLOWED_ENVIRONMENTS = deepFreeze(["sandbox", "production"]);
const PROMOTION_POLICY_DISABLED = deepFreeze({
    mode: "disabled",
    discountsAllowed: false,
    couponsAllowed: false,
    priceOverridesAllowed: false,
    approvedSnapshotId: null
});

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(",")}}`;
    }
    return JSON.stringify(value);
}

function calculatePlanHash(plan) {
    return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

function hasExactAllowedEnvironments(value) {
    return Array.isArray(value) &&
        value.length === ALLOWED_ENVIRONMENTS.length &&
        value.every((environment, index) =>
            environment === ALLOWED_ENVIRONMENTS[index]
        );
}

function isCanonicalIdentifier(value, maximumLength = 255) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= maximumLength &&
        value === value.trim() &&
        /^[a-z0-9_]+$/.test(value);
}

function createProductPlan({
    sku,
    productId,
    productType,
    catalogItemType,
    purchasePolicy,
    repeatable,
    unitAmountMinor,
    catalogEnabled,
    allowedEnvironments = ALLOWED_ENVIRONMENTS,
    entitlementDurationDays = null
}) {
    if (!isCanonicalIdentifier(sku) || !isCanonicalIdentifier(productId)) {
        throw new TypeError("Product plan identifiers must be canonical.");
    }
    if (productType !== "starter_pack" && productType !== "diamond_pack" &&
        productType !== "premium") {
        throw new TypeError("Product plan type is unsupported.");
    }
    const expectedCatalogItemType = productType === "diamond_pack"
        ? "bundle"
        : "virtual_good";
    if (catalogItemType !== expectedCatalogItemType) {
        throw new TypeError("Product plan catalog item type is invalid.");
    }
    const expectedPurchasePolicy = productType === "starter_pack"
        ? "one_time"
        : "repeatable";
    if (purchasePolicy !== expectedPurchasePolicy ||
        repeatable !== (purchasePolicy === "repeatable")) {
        throw new TypeError("Product plan purchase policy is inconsistent.");
    }
    if (!Number.isSafeInteger(unitAmountMinor) || unitAmountMinor <= 0) {
        throw new TypeError("Product plan price must be positive integer minor units.");
    }
    if (typeof catalogEnabled !== "boolean") {
        throw new TypeError("Product plan catalog availability must be explicit.");
    }
    if (!hasExactAllowedEnvironments(allowedEnvironments)) {
        throw new TypeError("Product plan environments are invalid.");
    }
    if ((productType === "premium" && entitlementDurationDays !== 30) ||
        (productType !== "premium" && entitlementDurationDays !== null)) {
        throw new TypeError("Product plan entitlement duration is invalid.");
    }

    const plan = {
        schemaVersion: 1,
        planVersion: XSOLLA_PRODUCT_PLAN_VERSION,
        sku,
        productId,
        productType,
        catalogItemType,
        purchasePolicy,
        repeatable,
        catalogEnabled,
        allowedEnvironments: [...allowedEnvironments],
        currency: USD_CURRENCY,
        unitAmountMinor,
        minorUnitScale: 2,
        promotionPolicy: PROMOTION_POLICY_DISABLED,
        ...(productType === "premium" ? { entitlementDurationDays } : {})
    };
    return deepFreeze({ ...plan, planHash: calculatePlanHash(plan) });
}

const productPlans = deepFreeze([
    createProductPlan({
        sku: "seabyss_starter_pack_1",
        productId: "starter_pack_1",
        productType: "starter_pack",
        catalogItemType: "virtual_good",
        purchasePolicy: "one_time",
        repeatable: false,
        unitAmountMinor: 399,
        catalogEnabled: true
    }),
    createProductPlan({
        sku: "seabyss_starter_pack_2",
        productId: "starter_pack_2",
        productType: "starter_pack",
        catalogItemType: "virtual_good",
        purchasePolicy: "one_time",
        repeatable: false,
        unitAmountMinor: 699,
        catalogEnabled: true
    }),
    createProductPlan({
        sku: "seabyss_starter_pack_3",
        productId: "starter_pack_3",
        productType: "starter_pack",
        catalogItemType: "virtual_good",
        purchasePolicy: "one_time",
        repeatable: false,
        unitAmountMinor: 1099,
        catalogEnabled: true
    }),
    createProductPlan({
        sku: "seabyss_diamond_pack_1",
        productId: "diamond_pack_1",
        productType: "diamond_pack",
        catalogItemType: "bundle",
        purchasePolicy: "repeatable",
        repeatable: true,
        unitAmountMinor: 199,
        catalogEnabled: true
    }),
    createProductPlan({
        sku: "seabyss_diamond_pack_2",
        productId: "diamond_pack_2",
        productType: "diamond_pack",
        catalogItemType: "bundle",
        purchasePolicy: "repeatable",
        repeatable: true,
        unitAmountMinor: 399,
        catalogEnabled: true
    }),
    createProductPlan({
        sku: "seabyss_diamond_pack_3",
        productId: "diamond_pack_3",
        productType: "diamond_pack",
        catalogItemType: "bundle",
        purchasePolicy: "repeatable",
        repeatable: true,
        unitAmountMinor: 799,
        catalogEnabled: true
    }),
    createProductPlan({
        sku: "seabyss_premium_bronze",
        productId: "premium",
        productType: "premium",
        catalogItemType: "virtual_good",
        purchasePolicy: "repeatable",
        repeatable: true,
        unitAmountMinor: 199,
        catalogEnabled: false,
        entitlementDurationDays: 30
    }),
    createProductPlan({
        sku: "seabyss_premium_silver",
        productId: "premium",
        productType: "premium",
        catalogItemType: "virtual_good",
        purchasePolicy: "repeatable",
        repeatable: true,
        unitAmountMinor: 399,
        catalogEnabled: false,
        entitlementDurationDays: 30
    }),
    createProductPlan({
        sku: "seabyss_premium_gold",
        productId: "premium",
        productType: "premium",
        catalogItemType: "virtual_good",
        purchasePolicy: "repeatable",
        repeatable: true,
        unitAmountMinor: 799,
        catalogEnabled: false,
        entitlementDurationDays: 30
    })
]);

const productPlanBySku = Object.freeze(Object.fromEntries(
    productPlans.map((plan) => [plan.sku, plan])
));

function requireCurrentVersion(planVersion) {
    if (planVersion !== XSOLLA_PRODUCT_PLAN_VERSION) {
        throw new RangeError("Unsupported Xsolla product plan version.");
    }
}

export function getXsollaProductPlan(
    sku,
    planVersion = XSOLLA_PRODUCT_PLAN_VERSION
) {
    requireCurrentVersion(planVersion);
    if (!isCanonicalIdentifier(sku) || !Object.hasOwn(productPlanBySku, sku)) {
        throw new RangeError("Unknown Xsolla product SKU.");
    }
    return productPlanBySku[sku];
}

export function listXsollaProductPlans(
    planVersion = XSOLLA_PRODUCT_PLAN_VERSION
) {
    requireCurrentVersion(planVersion);
    return productPlans;
}
