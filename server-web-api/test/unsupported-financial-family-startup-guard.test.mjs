import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const rewardIds = [
    "diamonds",
    "elite_ball",
    "poison_cannonball",
    "thors_wrath",
    "green_amulet",
    "blue_amulet",
    "red_amulet",
    "diamond_offensive_powder",
    "diamond_armor_plate",
    "harpoon_diamond_250",
    "star_dust",
    "carronade",
    "long_range_cannon"
];

const catalogMappings = Object.fromEntries(rewardIds.map((rewardId) => [
    rewardId,
    {
        kind: rewardId === "diamonds" ? "currency" : "inventory",
        itemId: `test-${rewardId}`
    }
]));

async function expectProductionRefusal({ premium, doubler, message }) {
    const child = spawn(process.execPath, ["src/server.js"], {
        cwd: new URL("..", import.meta.url),
        windowsHide: true,
        env: {
            ...process.env,
            NODE_OPTIONS: "",
            NODE_ENV: "production",
            HOST: "127.0.0.1",
            PORT: "0",
            SESSION_SECRET: "local-test-secret-with-at-least-32-bytes",
            PLAYFAB_TITLE_ID: "local-test-title",
            PLAYFAB_SECRET_KEY: "local-test-key",
            REDIS_URL: "redis://127.0.0.1:1",
            PURCHASES_GLOBAL_ENABLED: "true",
            PURCHASES_DIAMOND_ENABLED: "false",
            PURCHASES_STARTER_ENABLED: "false",
            PURCHASES_PREMIUM_ENABLED: premium ? "true" : "false",
            PURCHASES_DOUBLER_ENABLED: doubler ? "true" : "false",
            XSOLLA_HARDENED_CATALOG_ENABLED: "true",
            PLAYFAB_FINANCIAL_PROFILE_ENABLED: "true",
            PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "true",
            PLAYFAB_ECONOMY_V2_ENABLED: "true",
            PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED: "true",
            PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON: JSON.stringify(catalogMappings),
            UNITY_FINANCIAL_AUTHORITY_VERSION: "financial_v2",
            PLAYFAB_FINANCIAL_MIGRATION_VERSION: "financial_v2",
            PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED: "true",
            PLAYFAB_FINANCIAL_SERVER_OWNED_FIELDS_ENABLED: "true",
            PLAYFAB_FINANCIAL_REFRESH_ENABLED: "true",
            PAYMENT_WORKER_ENABLED: "true",
            XSOLLA_CHECKOUT_MODE: "production",
            XSOLLA_CHECKOUT_PRODUCTION_ENABLED: "true",
            XSOLLA_WEBHOOK_SECRET: "local-webhook-secret",
            XSOLLA_PROJECT_ID: "310966",
            XSOLLA_PREMIUM_PLAN_ID: "local-premium-plan"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.notEqual(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.match(stderr, message);
    assert.doesNotMatch(stdout, /listening/iu);
}

test("Production refuses standalone Premium until immutable v2 receipts reach the authority worker", async () => {
    await expectProductionRefusal({
        premium: true,
        doubler: false,
        message: /standalone Premium purchases require immutable v2 receipt worker support/iu
    });
});

test("Production refuses Doubler until immutable v2 receipts reach the authority worker", async () => {
    await expectProductionRefusal({
        premium: false,
        doubler: true,
        message: /Doubler purchases require immutable v2 receipt worker support/iu
    });
});
