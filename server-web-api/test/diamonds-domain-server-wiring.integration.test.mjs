import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function safeEnvironment(overrides = {}) {
    return {
        ...process.env,
        NODE_ENV: "development",
        HOST: "127.0.0.1",
        PLAYFAB_TITLE_ID: "",
        PLAYFAB_SECRET_KEY: "",
        REDIS_URL: "",
        SESSION_SECRET: "test-only-session-secret-not-used-production",
        XSOLLA_WEBHOOK_SECRET: "",
        XSOLLA_PROJECT_ID: "",
        XSOLLA_API_KEY: "",
        PURCHASES_GLOBAL_ENABLED: "false",
        PURCHASES_DIAMOND_ENABLED: "false",
        PURCHASES_STARTER_ENABLED: "false",
        PURCHASES_PREMIUM_ENABLED: "false",
        PURCHASES_DOUBLER_ENABLED: "false",
        XSOLLA_HARDENED_CATALOG_ENABLED: "false",
        XSOLLA_CHECKOUT_SANDBOX_ENABLED: "false",
        XSOLLA_CHECKOUT_PRODUCTION_ENABLED: "false",
        FINANCIAL_SHADOW_MODE_ENABLED: "false",
        PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "false",
        PAYMENT_WORKER_ENABLED: "false",
        FINANCIAL_ELITE_MODE: "Legacy",
        FINANCIAL_ELITE_CANARY_ENABLED: "false",
        FINANCIAL_ELITE_CUTOVER_ENABLED: "false",
        FINANCIAL_ELITE_MIGRATION_ENABLED: "false",
        FINANCIAL_ELITE_CANARY_PLAYFAB_IDS: "",
        FINANCIAL_PREMIUM_MODE: "Legacy",
        FINANCIAL_PREMIUM_CANARY_ENABLED: "false",
        FINANCIAL_PREMIUM_CUTOVER_ENABLED: "false",
        FINANCIAL_PREMIUM_MIGRATION_ENABLED: "false",
        FINANCIAL_PREMIUM_CANARY_PLAYFAB_IDS: "",
        ...overrides
    };
}

function launch(environment) {
    const child = spawn(process.execPath, ["src/server.js"], {
        cwd: new URL("..", import.meta.url),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return {
        child,
        output: () => ({ stdout, stderr }),
        exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
    };
}

function rejectAfter(milliseconds, message) {
    return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref?.();
    });
}

async function waitForListening(process, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (process.output().stdout.includes("Seabyss web API listening")) return;
        if (process.child.exitCode !== null) {
            throw new Error(`server exited early: ${JSON.stringify(process.output())}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`server did not listen: ${JSON.stringify(process.output())}`);
}

async function stop(process) {
    if (process.child.exitCode === null) process.child.kill("SIGTERM");
    await Promise.race([
        process.exited,
        rejectAfter(10_000, "server shutdown timeout")
    ]);
}

test("real server keeps Diamonds Target routes absent and performs no Target construction in Legacy", async () => {
    const port = await freePort();
    const process = launch(safeEnvironment({
        PORT: String(port),
        FINANCIAL_DIAMONDS_MODE: "Legacy",
        FINANCIAL_DIAMONDS_CANARY_ENABLED: "false",
        FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "false",
        FINANCIAL_DIAMONDS_MIGRATION_ENABLED: "false",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "",
        FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH: "must-not-be-read.json",
        FINANCIAL_DIAMONDS_GAME_SERVER_ID: "",
        FINANCIAL_DIAMONDS_GAME_SERVER_TOKEN: ""
    }));
    try {
        await waitForListening(process);
        const response = await fetch(`http://127.0.0.1:${port}/financial/domains/diamonds/v1/read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playFabId: "61AD15CDA4137EA9" })
        });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { message: "Not found." });
        const output = JSON.stringify(process.output());
        assert.doesNotMatch(output, /must-not-be-read/u);
        assert.doesNotMatch(output, /DIAMONDS_TARGET_RUNTIME_DEPENDENCY_MISSING/u);
    } finally {
        await stop(process);
    }
});

test("real server refuses Canary activation before listening when readiness evidence is missing", async () => {
    const port = await freePort();
    const process = launch(safeEnvironment({
        PORT: String(port),
        FINANCIAL_DIAMONDS_MODE: "Canary",
        FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
        FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "false",
        FINANCIAL_DIAMONDS_MIGRATION_ENABLED: "false",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "61AD15CDA4137EA9",
        FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH: "definitely-missing-readiness.json"
    }));
    const exited = await Promise.race([
        process.exited,
        rejectAfter(10_000, "unsafe server did not exit")
    ]);
    assert.notEqual(exited.code, 0);
    assert.doesNotMatch(process.output().stdout, /Seabyss web API listening/u);
    assert.match(process.output().stderr, /Diamonds readiness certificate cannot be read/u);
});
