import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("Production cutover refuses startup when Economy v2, Unity alignment or migration proof is absent", async () => {
    const child = spawn(process.execPath, ["src/server.js"], {
        cwd: new URL("..", import.meta.url),
        windowsHide: true,
        env: {
            ...process.env,
            NODE_ENV: "production",
            HOST: "127.0.0.1",
            PORT: "0",
            SESSION_SECRET: "local-test-secret-with-at-least-32-bytes",
            PLAYFAB_TITLE_ID: "local-test-title",
            PLAYFAB_SECRET_KEY: "local-test-key",
            REDIS_URL: "redis://127.0.0.1:1",
            PURCHASES_GLOBAL_ENABLED: "true",
            PURCHASES_DIAMOND_ENABLED: "true",
            PURCHASES_STARTER_ENABLED: "true",
            PURCHASES_PREMIUM_ENABLED: "true",
            PURCHASES_DOUBLER_ENABLED: "true",
            XSOLLA_HARDENED_CATALOG_ENABLED: "true",
            PLAYFAB_FINANCIAL_PROFILE_ENABLED: "true",
            PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "true",
            PLAYFAB_ECONOMY_V2_ENABLED: "false",
            PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED: "false",
            UNITY_FINANCIAL_AUTHORITY_VERSION: "legacy_profile_v1",
            PLAYFAB_FINANCIAL_MIGRATION_VERSION: "none",
            PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED: "false",
            PLAYFAB_FINANCIAL_SERVER_OWNED_FIELDS_ENABLED: "false",
            PLAYFAB_FINANCIAL_REFRESH_ENABLED: "false",
            PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON: "{}",
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
    assert.match(stderr, /PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=true is unsafe/);
    assert.match(stderr, /PLAYFAB_ECONOMY_V2_ENABLED=true/);
    assert.match(stderr, /UNITY_FINANCIAL_AUTHORITY_VERSION=financial_v2/);
    assert.doesNotMatch(stdout, /listening/i);
});
