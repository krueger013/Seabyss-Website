import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
    STARTER_REWARD_PLAN_VERSION,
    getStarterRewardPlan,
    listStarterRewardPlans
} from "../src/xsolla-starter-reward-plan-registry.js";

const additive = (rewardType, rewardId, quantity) => ({
    rewardType, rewardId, quantity, durationDays: 0, grantMode: "additive"
});
const premium = (rewardId, durationDays) => ({
    rewardType: "PremiumDays", rewardId, quantity: 0,
    durationDays, grantMode: "duration_extension"
});
const unique = (rewardType, rewardId) => ({
    rewardType, rewardId, quantity: 1, durationDays: 0, grantMode: "unique_unlock"
});

const expectedRewards = Object.freeze({
    seabyss_starter_pack_1: [
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
    ],
    seabyss_starter_pack_2: [
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
    ],
    seabyss_starter_pack_3: [
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
    ]
});

describe("Starter reward plan registry v1", () => {
    test("pins the exact grantable contents of Starter I, II, and III", () => {
        assert.equal(STARTER_REWARD_PLAN_VERSION, 1);
        const plans = listStarterRewardPlans();
        assert.deepEqual(plans.map((plan) => plan.sku), Object.keys(expectedRewards));

        for (const plan of plans) {
            assert.equal(plan.schemaVersion, 1);
            assert.equal(plan.planVersion, 1);
            assert.equal(plan.productId, plan.sku.replace("seabyss_", ""));
            assert.deepEqual(plan.rewards, expectedRewards[plan.sku]);

            const snapshot = {
                schemaVersion: plan.schemaVersion,
                planVersion: plan.planVersion,
                sku: plan.sku,
                productId: plan.productId,
                rewards: plan.rewards
            };
            assert.equal(plan.rewardPlanHash, createHash("sha256")
                .update(JSON.stringify(snapshot), "utf8")
                .digest("hex"));
            assert.match(plan.rewardPlanHash, /^[0-9a-f]{64}$/);
        }
    });

    test("uses Harpoon II exclusively and models real markers as unique unlocks", () => {
        const expectedHarpoons = [100, 250, 500];
        for (const [index, plan] of listStarterRewardPlans().entries()) {
            const harpoons = plan.rewards.filter((reward) =>
                reward.rewardId === "harpoon_diamond_250");
            assert.equal(harpoons.length, 1);
            assert.equal(harpoons[0].quantity, expectedHarpoons[index]);
            assert.equal(harpoons[0].grantMode, "additive");

            const markers = plan.rewards.filter((reward) =>
                reward.rewardId === "destination_red_point" ||
                reward.rewardId === "destination_blue_point");
            assert.equal(markers.length, index === 0 ? 1 : 2);
            for (const marker of markers) {
                assert.equal(marker.quantity, 1);
                assert.equal(marker.grantMode, "unique_unlock");
            }

            const serialized = JSON.stringify(plan).toLowerCase();
            for (const forbidden of [
                "harpoon_iii", "harpoon iii", "destination_markers",
                "unavailable", "blocker", "placeholder"
            ]) {
                assert.equal(serialized.includes(forbidden), false);
            }
        }
    });

    test("looks up only exact Starter SKUs and the exact historical version", () => {
        for (const sku of Object.keys(expectedRewards)) {
            assert.equal(getStarterRewardPlan(sku), getStarterRewardPlan(sku, 1));
        }
        for (const sku of [
            "seabyss_diamond_pack_1",
            "seabyss_starter_pack_4",
            " seabyss_starter_pack_1",
            "seabyss_starter_pack_1 ",
            "constructor",
            "toString",
            "",
            null,
            undefined,
            new String("seabyss_starter_pack_1")
        ]) {
            assert.throws(() => getStarterRewardPlan(sku), RangeError);
        }
        for (const version of [0, 2, -1, "1", 1n, null, {}, []]) {
            assert.throws(
                () => getStarterRewardPlan("seabyss_starter_pack_1", version),
                RangeError
            );
            assert.throws(() => listStarterRewardPlans(version), RangeError);
        }
    });

    test("keeps plans, rewards, and their hashes immutable", () => {
        const plans = listStarterRewardPlans();
        const plan = getStarterRewardPlan("seabyss_starter_pack_3");
        const originalHash = plan.rewardPlanHash;
        assert.equal(Object.isFrozen(plans), true);
        assert.equal(Object.isFrozen(plan), true);
        assert.equal(Object.isFrozen(plan.rewards), true);
        assert.ok(plan.rewards.every(Object.isFrozen));

        assert.throws(() => plans.pop(), TypeError);
        assert.throws(() => { plan.planVersion = 2; }, TypeError);
        assert.throws(() => { plan.rewards[0].quantity = 1; }, TypeError);
        assert.throws(() => plan.rewards.push(plan.rewards[0]), TypeError);
        assert.equal(getStarterRewardPlan(plan.sku).rewardPlanHash, originalHash);
        assert.equal(getStarterRewardPlan(plan.sku).rewards[0].quantity, 3500);
    });
});
