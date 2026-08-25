import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { requiredEconomyV2RewardIds } from "../src/financial-authority-readiness.js";

const catalogMappings = Object.fromEntries(requiredEconomyV2RewardIds().map((rewardId) => [
    rewardId,
    {
        kind: rewardId === "diamonds" ? "currency" : "inventory",
        itemId: `startup-${rewardId}`,
        stackId: "default"
    }
]));

test("cutover startup fails closed before network when published-policy proof is not configured", async () => {
    const child = spawn(process.execPath, ["src/server.js"], {
        cwd: new URL("..", import.meta.url),
        windowsHide: true,
        env: {
            ...process.env,
            NODE_OPTIONS: "",
            NODE_ENV: "development",
            HOST: "127.0.0.1",
            PORT: "0",
            REDIS_URL: "",
            SESSION_SECRET: "local-test-secret-with-at-least-32-bytes",
            PLAYFAB_TITLE_ID: "local-test-title",
            PLAYFAB_SECRET_KEY: "local-test-key",
            PURCHASES_GLOBAL_ENABLED: "false",
            PURCHASES_DIAMOND_ENABLED: "false",
            PURCHASES_STARTER_ENABLED: "false",
            PURCHASES_PREMIUM_ENABLED: "false",
            PURCHASES_DOUBLER_ENABLED: "false",
            PLAYFAB_FINANCIAL_PROFILE_ENABLED: "false",
            PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "true",
            PLAYFAB_ECONOMY_V2_ENABLED: "true",
            PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED: "true",
            PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON: JSON.stringify(catalogMappings),
            PLAYFAB_FINANCIAL_AUTHORITY_POLICY_RESOURCE: "",
            UNITY_FINANCIAL_AUTHORITY_VERSION: "financial_v2",
            PLAYFAB_FINANCIAL_MIGRATION_VERSION: "financial_v2",
            PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED: "true",
            PLAYFAB_FINANCIAL_SERVER_OWNED_FIELDS_ENABLED: "true",
            PLAYFAB_FINANCIAL_REFRESH_ENABLED: "true",
            PAYMENT_WORKER_ENABLED: "false",
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
    const timeout = setTimeout(() => child.kill(), 5_000);
    const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);

    assert.notEqual(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.match(stderr, /lacks verified PlayFab evidence/u);
    assert.match(stderr, /PLAYFAB_FINANCIAL_AUTHORITY_POLICY_RESOURCE/u);
    assert.doesNotMatch(stderr, /PLAYFAB_READINESS_UNAVAILABLE/u);
    assert.doesNotMatch(stdout, /listening/iu);
});
