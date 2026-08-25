import { createHash } from "node:crypto";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

export const STARTER_REWARD_PLAN_VERSION = 1;

const supportedRewardTypes = Object.freeze(new Set([
    "Diamonds",
    "Consumable",
    "PremiumDays",
    "ShipDesign",
    "Custom"
]));
const supportedGrantModes = Object.freeze(new Set([
    "additive",
    "duration_extension",
    "unique_unlock"
]));

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

function isCanonicalIdentifier(value, maximumLength = 255) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= maximumLength &&
        value === value.trim() &&
        /^[a-z0-9_]+$/.test(value);
}

function createReward(rewardType, rewardId, quantity, durationDays, grantMode) {
    if (!supportedRewardTypes.has(rewardType) ||
        !supportedGrantModes.has(grantMode) ||
        !isCanonicalIdentifier(rewardId)) {
        throw new TypeError("Starter reward identity or grant semantics are invalid.");
    }
    if (!Number.isSafeInteger(quantity) || quantity < 0 ||
        !Number.isSafeInteger(durationDays) || durationDays < 0) {
        throw new TypeError("Starter reward quantities must be safe non-negative integers.");
    }

    if (grantMode === "additive" && (quantity <= 0 || durationDays !== 0)) {
        throw new TypeError("Additive rewards require a positive quantity only.");
    }
    if (grantMode === "duration_extension" &&
        (rewardType !== "PremiumDays" || quantity !== 0 || durationDays <= 0)) {
        throw new TypeError("Premium rewards require a positive duration only.");
    }
    if (grantMode === "unique_unlock" &&
        (quantity !== 1 || durationDays !== 0 ||
            (rewardType !== "Custom" && rewardType !== "ShipDesign"))) {
        throw new TypeError("Unique unlock rewards require exactly one unlock.");
    }
    if ((rewardId === "destination_red_point" ||
        rewardId === "destination_blue_point") && grantMode !== "unique_unlock") {
        throw new TypeError("Destination markers must use unique unlock semantics.");
    }
    if (rewardType === "ShipDesign" && grantMode !== "unique_unlock") {
        throw new TypeError("Ship designs must use unique unlock semantics.");
    }

    return deepFreeze({ rewardType, rewardId, quantity, durationDays, grantMode });
}

function additive(rewardType, rewardId, quantity) {
    return createReward(rewardType, rewardId, quantity, 0, "additive");
}

function premium(rewardId, durationDays) {
    return createReward("PremiumDays", rewardId, 0, durationDays, "duration_extension");
}

function unique(rewardType, rewardId) {
    return createReward(rewardType, rewardId, 1, 0, "unique_unlock");
}

function createStarterRewardPlan(sku, productId, rewards) {
    const productPlan = getXsollaProductPlan(sku);
    if (productPlan.productType !== "starter_pack" ||
        productPlan.productId !== productId ||
        productPlan.purchasePolicy !== "one_time" ||
        productPlan.repeatable !== false) {
        throw new TypeError("Starter reward plan does not match its product plan.");
    }
    if (!Array.isArray(rewards) || rewards.length === 0 ||
        rewards.some((reward) => !reward || !Object.isFrozen(reward))) {
        throw new TypeError("Starter reward plan must contain frozen rewards.");
    }
    const rewardIds = rewards.map((reward) => reward.rewardId);
    if (new Set(rewardIds).size !== rewardIds.length) {
        throw new TypeError("Starter reward IDs must be unique within a plan.");
    }

    const snapshot = deepFreeze({
        schemaVersion: 1,
        planVersion: STARTER_REWARD_PLAN_VERSION,
        sku,
        productId,
        rewards: [...rewards]
    });
    const rewardPlanHash = createHash("sha256")
        .update(JSON.stringify(snapshot), "utf8")
        .digest("hex");
    return deepFreeze({ ...snapshot, rewardPlanHash });
}

const starterRewardPlans = deepFreeze([
    createStarterRewardPlan("seabyss_starter_pack_1", "starter_pack_1", [
        additive("Diamonds", "diamonds", 1000),
        additive("Consumable", "elite_ball", 13000),
        additive("Consumable", "thors_wrath", 5),
        additive("Consumable", "green_amulet", 10),
        additive("Consumable", "diamond_offensive_powder", 100),
        additive("Consumable", "diamond_armor_plate", 100),
        premium("premium_bronze", 1),
        unique("Custom", "destination_red_point"),
        additive("Consumable", "carronade", 2),
        additive("Consumable", "harpoon_diamond_250", 100),
        additive("Consumable", "star_dust", 12)
    ]),
    createStarterRewardPlan("seabyss_starter_pack_2", "starter_pack_2", [
        additive("Diamonds", "diamonds", 2000),
        additive("Consumable", "elite_ball", 23000),
        additive("Consumable", "thors_wrath", 10),
        additive("Consumable", "blue_amulet", 10),
        additive("Consumable", "diamond_offensive_powder", 200),
        additive("Consumable", "diamond_armor_plate", 200),
        premium("premium_silver", 2),
        unique("Custom", "destination_red_point"),
        unique("Custom", "destination_blue_point"),
        additive("Consumable", "carronade", 5),
        additive("Consumable", "harpoon_diamond_250", 250),
        additive("Consumable", "star_dust", 24)
    ]),
    createStarterRewardPlan("seabyss_starter_pack_3", "starter_pack_3", [
        additive("Diamonds", "diamonds", 3500),
        additive("Consumable", "poison_cannonball", 25000),
        additive("Consumable", "thors_wrath", 25),
        additive("Consumable", "red_amulet", 10),
        additive("Consumable", "diamond_offensive_powder", 500),
        additive("Consumable", "diamond_armor_plate", 500),
        premium("premium_gold", 7),
        unique("ShipDesign", "design_blaky"),
        unique("Custom", "destination_red_point"),
        unique("Custom", "destination_blue_point"),
        additive("Consumable", "carronade", 5),
        additive("Consumable", "long_range_cannon", 5),
        additive("Consumable", "harpoon_diamond_250", 500),
        additive("Consumable", "star_dust", 50)
    ])
]);

const starterRewardPlanBySku = Object.freeze(Object.fromEntries(
    starterRewardPlans.map((plan) => [plan.sku, plan])
));

function requireCurrentVersion(planVersion) {
    if (planVersion !== STARTER_REWARD_PLAN_VERSION) {
        throw new RangeError("Unsupported Starter reward plan version.");
    }
}

export function getStarterRewardPlan(
    sku,
    planVersion = STARTER_REWARD_PLAN_VERSION
) {
    requireCurrentVersion(planVersion);
    if (!isCanonicalIdentifier(sku) || !Object.hasOwn(starterRewardPlanBySku, sku)) {
        throw new RangeError("Unknown Starter Pack SKU.");
    }
    return starterRewardPlanBySku[sku];
}

export function listStarterRewardPlans(
    planVersion = STARTER_REWARD_PLAN_VERSION
) {
    requireCurrentVersion(planVersion);
    return starterRewardPlans;
}
