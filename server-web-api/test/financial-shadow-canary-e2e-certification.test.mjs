import test from "node:test";
import assert from "node:assert/strict";
import {
    CANARY_PLAYFAB_ID,
    CONTROL_PATH,
    canaryActionRuntimeOptions,
    loadCanaryE2eConfiguration,
    createProjectionControlHandler,
    certificationReceipt,
    createCertificationV2OnlyReceiptStore,
    prepareLegacyCanaryBaseline,
    restoreLegacyCanaryBaseline,
    upgradeLegacyCanaryCurrencies
} from "../financial-shadow-canary-e2e-certification.mjs";

test("maintenance actions never start HTTP or financial schedulers", () => {
    assert.deepEqual(canaryActionRuntimeOptions("serve"), {
        startHttp: true, startSchedulers: true
    });
    for (const action of ["prepare-legacy", "restore-legacy", "capture-provider",
        "restore-provider", "prepare-diamond-i", "prepare-starter-i"]) {
        assert.deepEqual(canaryActionRuntimeOptions(action), {
            startHttp: false, startSchedulers: false
        });
    }
});
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";

function environment(overrides = {}) {
    return {
        NODE_ENV: "test",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "1D0C16",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: "sandbox-secret-not-logged",
        FINANCIAL_SHADOW_CANARY_E2E_ENABLED: "true",
        FINANCIAL_SHADOW_CANARY_E2E_MUTATION_ENABLED: "true",
        FINANCIAL_SHADOW_MODE_ENABLED: "true",
        FINANCIAL_SHADOW_ENVIRONMENT: "sandbox",
        FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS: CANARY_PLAYFAB_ID,
        FINANCIAL_SHADOW_CANARY_E2E_REDIS_URL: "redis://127.0.0.1:63879",
        FINANCIAL_SHADOW_CANARY_E2E_RUN_ID: "unit-test-run",
        FINANCIAL_SHADOW_CANARY_E2E_CONTROL_TOKEN: "x".repeat(40),
        PURCHASES_GLOBAL_ENABLED: "false",
        PURCHASES_DIAMOND_ENABLED: "false",
        PURCHASES_STARTER_ENABLED: "false",
        PURCHASES_PREMIUM_ENABLED: "false",
        PURCHASES_DOUBLER_ENABLED: "false",
        XSOLLA_CHECKOUT_SANDBOX_ENABLED: "false",
        XSOLLA_CHECKOUT_PRODUCTION_ENABLED: "false",
        PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "false",
        ...overrides
    };
}

test("canary configuration accepts only Sandbox 1D0C16, one exact canary, loopback Redis, and all gates off", () => {
    const configuration = loadCanaryE2eConfiguration(environment());
    assert.equal(configuration.titleId, "1D0C16");
    assert.equal(configuration.canaryPlayFabId, CANARY_PLAYFAB_ID);
    assert.match(configuration.redisPrefix, /^seabyss:cert:shadow-e2e:1d0c16:/u);
    assert.equal(configuration.presenceTtlMs, 3_000);
    for (const unsafe of [
        { PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "142853" },
        { FINANCIAL_SHADOW_ALLOWED_PLAYFAB_IDS: `${CANARY_PLAYFAB_ID},OTHER` },
        { FINANCIAL_SHADOW_CANARY_E2E_REDIS_URL: "redis://example.com:6379" },
        { PURCHASES_GLOBAL_ENABLED: "true" },
        { FINANCIAL_SHADOW_MODE_ENABLED: "false" },
        { PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED: "true" },
        { FINANCIAL_SHADOW_CANARY_E2E_PRESENCE_TTL_MS: "999" }
    ]) {
        assert.throws(() => loadCanaryE2eConfiguration(environment(unsafe)));
    }
});

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        status(value) { this.statusCode = value; return this; },
        set(name, value) { this.headers[name] = value; return this; },
        json(value) { this.body = value; return this; }
    };
}

test(`control ${CONTROL_PATH} is loopback/token/exact-schema only and never accepts caller rewards`, async () => {
    const seen = [];
    const handler = createProjectionControlHandler({
        controlToken: "t".repeat(40),
        producer: {
            async projectTransaction(input) {
                seen.push(input);
                return {
                    status: "projected",
                    operation: { operationId: "CANONICAL_OPERATION" },
                    submitted: { status: "submitted" }
                };
            }
        }
    });
    const valid = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-shadow-certification-token": "t".repeat(40) },
        get(name) { return this.headers[name.toLowerCase()]; },
        body: { providerTransactionId: "900001" }
    };
    const res = responseRecorder();
    let error = null;
    await handler(valid, res, (value) => { error = value; });
    assert.equal(error, null);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(seen, [{ providerTransactionId: "900001" }]);
    for (const request of [
        { ...valid, socket: { remoteAddress: "10.0.0.8" } },
        { ...valid, headers: { "x-shadow-certification-token": "bad" } },
        { ...valid, body: { providerTransactionId: "900002", diamonds: 500 } },
        { ...valid, body: { providerTransactionId: "900002", rewards: { diamonds: 500 } } }
    ]) {
        let rejected = null;
        await handler(request, responseRecorder(), (value) => { rejected = value; });
        assert.ok(rejected);
    }
    assert.equal(seen.length, 1);
});

function playFabResponse(data) {
    return { ok: true, status: 200, async json() { return { code: 200, data }; } };
}

test("certification receipt persistence writes immutable xsd2/xss2 only and never legacy xsd1/xss1", async () => {
    const configuration = loadCanaryE2eConfiguration(environment());
    const data = {};
    const updates = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        if (endpoint.endsWith("/Server/GetUserInternalData")) {
            return playFabResponse({ Data: Object.fromEntries(body.Keys
                .filter((key) => Object.hasOwn(data, key))
                .map((key) => [key, { Value: data[key] }])) });
        }
        if (endpoint.endsWith("/Server/UpdateUserInternalData")) {
            updates.push(structuredClone(body.Data));
            Object.assign(data, body.Data);
            return playFabResponse({ DataVersion: updates.length });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    try {
        const diamond = createCertificationV2OnlyReceiptStore(configuration, "diamond");
        const starter = createCertificationV2OnlyReceiptStore(configuration, "starter");
        const createdAt = new Date("2026-08-24T12:00:00.000Z");
        const firstDiamond = await diamond(certificationReceipt("diamond-i", "824202600000201", createdAt));
        const firstStarter = await starter(certificationReceipt("starter-i", "824202600000202", createdAt));
        assert.equal(firstDiamond.certificationV2Only, true);
        assert.equal(firstStarter.certificationV2Only, true);
        assert.equal(firstDiamond.legacyReceiptWritten, false);
        assert.equal(firstStarter.legacyReceiptWritten, false);
        assert.equal(updates.length, 2);
        assert.deepEqual(Object.keys(updates[0]), [firstDiamond.key]);
        assert.deepEqual(Object.keys(updates[1]), [firstStarter.key]);
        assert.match(firstDiamond.key, /^xsd2_/u);
        assert.match(firstStarter.key, /^xss2_/u);
        assert.equal(Object.keys(data).some((key) => /^xsd1_|^xss1_/u.test(key)), false);
        const replay = await diamond(certificationReceipt("diamond-i", "824202600000201", createdAt));
        assert.equal(replay.existing, true);
        assert.equal(updates.length, 2);
    } finally { globalThis.fetch = previousFetch; }
});


test("real Starter certification receipt passes canonical serializer and ledger receipt processor in memory", async () => {
    const configuration = loadCanaryE2eConfiguration(environment());
    const values = {};
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        if (endpoint.endsWith("/Server/GetUserInternalData")) {
            return playFabResponse({ Data: Object.fromEntries(body.Keys
                .filter((key) => Object.hasOwn(values, key))
                .map((key) => [key, { Value: values[key] }])) });
        }
        if (endpoint.endsWith("/Server/UpdateUserInternalData")) {
            Object.assign(values, body.Data);
            return playFabResponse({ DataVersion: 1 });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    try {
        const persistStarter = createCertificationV2OnlyReceiptStore(configuration, "starter");
        const processor = createXsollaLedgeredReceiptProcessor({
            ledger: createPaymentLedger({ store: createMemoryPaymentLedgerStore() }),
            persistStarterPackReceiptV2: persistStarter,
            persistDiamondPackReceiptV2: async () => { throw new Error("unexpected diamond persistence"); },
            workerId: "shadow-e2e-starter-unit"
        });
        const receipt = certificationReceipt("starter-i", "824202600000203",
            new Date("2026-08-24T12:00:00.000Z"));
        assert.match(receipt.rewardPlanHash, /^[a-f0-9]{64}$/u);
        const result = await processor(receipt);
        assert.equal(result.status, "checkpoints_pending");
        assert.match(result.receiptId, /^xss2_/u);
        assert.deepEqual(Object.keys(values), [result.receiptId]);
    } finally { globalThis.fetch = previousFetch; }
});
test("Legacy canary preparation captures, creates, zeroes and verifies both GD and DM", async () => {
    const configuration = loadCanaryE2eConfiguration(environment());
    const calls = [];
    let profile = null;
    const currencyTypes = new Set();
    const balances = { GD: 0, DM: 0 };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        calls.push({ endpoint, body });
        if (endpoint.endsWith("/Server/GetUserAccountInfo")) return playFabResponse({
            UserInfo: { PlayFabId: CANARY_PLAYFAB_ID,
                TitleInfo: { TitlePlayerAccount: { Id: "714E7F12EDBEA385" } } }
        });
        if (endpoint.endsWith("/Server/GetUserInternalData")) return playFabResponse({
            Data: profile === null ? {} : { profile_v1: { Value: profile } }
        });
        if (endpoint.endsWith("/Server/GetUserInventory")) return playFabResponse({
            VirtualCurrency: Object.fromEntries([...currencyTypes].map((code) => [code, balances[code]]))
        });
        if (endpoint.endsWith("/Admin/ListVirtualCurrencyTypes")) return playFabResponse({
            VirtualCurrencies: [...currencyTypes].map((CurrencyCode) => ({ CurrencyCode }))
        });
        if (endpoint.endsWith("/Server/GetPlayerStatistics")) return playFabResponse({ Statistics: [] });
        if (endpoint.endsWith("/Admin/AddVirtualCurrencyTypes")) {
            for (const entry of body.VirtualCurrencies) currencyTypes.add(entry.CurrencyCode);
            return playFabResponse({});
        }
        if (endpoint.endsWith("/Server/SubtractUserVirtualCurrency")) {
            balances[body.VirtualCurrency] -= body.Amount;
            return playFabResponse({ Balance: balances[body.VirtualCurrency] });
        }
        if (endpoint.endsWith("/Server/UpdateUserInternalData")) {
            profile = body.Data.profile_v1;
            return playFabResponse({ DataVersion: 1 });
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    const values = new Map();
    const redis = {
        async get(key) { return values.get(key) ?? null; },
        async set(key, value, options) {
            if (options?.NX && values.has(key)) return null;
            values.set(key, value);
            return "OK";
        }
    };
    try {
        const result = await prepareLegacyCanaryBaseline(configuration, redis);
        assert.equal(result.status, "prepared");
        assert.equal(result.dmCreated, true);
        assert.equal(result.gdCreated, true);
        assert.equal(JSON.parse(profile).schemaVersion, 12);
        assert.equal(JSON.parse(profile).starterGrantVersion, 1);
        assert.equal(JSON.parse(profile).playFabCurrencyMigratedV1, true);
        assert.equal(calls.some((call) => call.endpoint.endsWith("/Server/GetUserData")), false);
        assert.equal(calls.some((call) => call.endpoint.endsWith("/Server/UpdateUserData")), false);
        assert.equal(calls.filter((call) => call.endpoint.endsWith("/Admin/AddVirtualCurrencyTypes")).length, 1);
        const created = calls.find((call) => call.endpoint.endsWith("/Admin/AddVirtualCurrencyTypes")).body.VirtualCurrencies;
        assert.deepEqual(created.map((entry) => [entry.CurrencyCode, entry.DisplayName, entry.InitialDeposit]), [
            ["GD", "Gold", 0], ["DM", "Diamonds", 0]
        ]);
        assert.deepEqual([...currencyTypes].sort(), ["DM", "GD"]);
        assert.equal(balances.GD, 0);
        assert.equal(balances.DM, 0);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

function memoryRedis(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        async get(key) { return values.get(key) ?? null; },
        async set(key, value, options) {
            if (options?.NX && values.has(key)) return null;
            values.set(key, value);
            return "OK";
        }
    };
}

test("Legacy restore returns GD/DM balances and removes only currency types absent in the captured baseline", async () => {
    const configuration = loadCanaryE2eConfiguration(environment());
    const key = `${configuration.redisPrefix}legacy-baseline`;
    const baseline = {
        schemaVersion: 1, playFabId: CANARY_PLAYFAB_ID, entityId: "714E7F12EDBEA385",
        profile: "{\"legacy\":true}", gdExisted: true, gdBalance: 7,
        dmExisted: false, dmBalance: 0,
        statistics: [{ StatisticName: "LegacyWins", Value: 4 }], capturedAtUtc: new Date(0).toISOString()
    };
    const redis = memoryRedis({ [key]: JSON.stringify(baseline) });
    const currencyTypes = new Set(["GD", "DM"]);
    const balances = { GD: 2, DM: 9 };
    let profile = "{\"test\":true}";
    let statistics = [{ StatisticName: "Test", Value: 1 }];
    const calls = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        calls.push({ endpoint, body });
        if (endpoint.endsWith("/Server/GetUserAccountInfo")) return playFabResponse({
            UserInfo: { PlayFabId: CANARY_PLAYFAB_ID,
                TitleInfo: { TitlePlayerAccount: { Id: "714E7F12EDBEA385" } } }
        });
        if (endpoint.endsWith("/Server/GetUserInventory")) return playFabResponse({
            VirtualCurrency: Object.fromEntries([...currencyTypes].map((code) => [code, balances[code]]))
        });
        if (endpoint.endsWith("/Admin/ListVirtualCurrencyTypes")) return playFabResponse({
            VirtualCurrencies: [...currencyTypes].map((CurrencyCode) => ({ CurrencyCode }))
        });
        if (endpoint.endsWith("/Server/AddUserVirtualCurrency")) {
            balances[body.VirtualCurrency] += body.Amount;
            return playFabResponse({ Balance: balances[body.VirtualCurrency] });
        }
        if (endpoint.endsWith("/Server/SubtractUserVirtualCurrency")) {
            balances[body.VirtualCurrency] -= body.Amount;
            return playFabResponse({ Balance: balances[body.VirtualCurrency] });
        }
        if (endpoint.endsWith("/Server/UpdateUserInternalData")) {
            profile = body.Data?.profile_v1 ?? null;
            return playFabResponse({ DataVersion: 2 });
        }
        if (endpoint.endsWith("/Server/GetUserInternalData")) return playFabResponse({
            Data: profile === null ? {} : { profile_v1: { Value: profile } }
        });
        if (endpoint.endsWith("/Admin/ResetUserStatistics")) { statistics = []; return playFabResponse({}); }
        if (endpoint.endsWith("/Server/UpdatePlayerStatistics")) {
            statistics = structuredClone(body.Statistics);
            return playFabResponse({});
        }
        if (endpoint.endsWith("/Server/GetPlayerStatistics")) return playFabResponse({ Statistics: statistics });
        if (endpoint.endsWith("/Admin/RemoveVirtualCurrencyTypes")) {
            for (const entry of body.VirtualCurrencies) {
                assert.equal(balances[entry.CurrencyCode], 0);
                currencyTypes.delete(entry.CurrencyCode);
            }
            return playFabResponse({});
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    try {
        const result = await restoreLegacyCanaryBaseline(configuration, redis);
        assert.deepEqual(result, { status: "restored", gdRemoved: false, dmRemoved: true });
        assert.equal(balances.GD, 7);
        assert.equal(balances.DM, 0);
        assert.deepEqual([...currencyTypes], ["GD"]);
        assert.deepEqual(calls.find((call) => call.endpoint.endsWith("/Admin/RemoveVirtualCurrencyTypes"))
            .body.VirtualCurrencies, [{ CurrencyCode: "DM", DisplayName: "Diamonds",
                InitialDeposit: 0, RechargeRate: 0, RechargeMax: 0 }]);
    } finally { globalThis.fetch = previousFetch; }
});

test("pre-GD schema-1 baseline is augmented without overwrite and restores both temporary currency types", async () => {
    const configuration = loadCanaryE2eConfiguration(environment());
    const key = `${configuration.redisPrefix}legacy-baseline`;
    const baseline = {
        schemaVersion: 1, playFabId: CANARY_PLAYFAB_ID, entityId: "714E7F12EDBEA385",
        profile: null, dmExisted: false, dmBalance: 0, statistics: [], capturedAtUtc: new Date(0).toISOString()
    };
    const raw = JSON.stringify(baseline);
    const redis = memoryRedis({ [key]: raw });
    const currencyTypes = new Set(["DM"]);
    const balances = { GD: 0, DM: 0 };
    let profile = null;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        if (endpoint.endsWith("/Server/GetUserAccountInfo")) return playFabResponse({
            UserInfo: { PlayFabId: CANARY_PLAYFAB_ID,
                TitleInfo: { TitlePlayerAccount: { Id: "714E7F12EDBEA385" } } }
        });
        if (endpoint.endsWith("/Admin/ListVirtualCurrencyTypes")) return playFabResponse({
            VirtualCurrencies: [...currencyTypes].map((CurrencyCode) => ({ CurrencyCode }))
        });
        if (endpoint.endsWith("/Server/GetUserInventory")) return playFabResponse({
            VirtualCurrency: Object.fromEntries([...currencyTypes].map((code) => [code, balances[code]]))
        });
        if (endpoint.endsWith("/Admin/AddVirtualCurrencyTypes")) {
            for (const entry of body.VirtualCurrencies) currencyTypes.add(entry.CurrencyCode);
            return playFabResponse({});
        }
        if (endpoint.endsWith("/Server/SubtractUserVirtualCurrency")) {
            balances[body.VirtualCurrency] -= body.Amount;
            return playFabResponse({});
        }
        if (endpoint.endsWith("/Server/UpdateUserInternalData")) {
            profile = body.Data?.profile_v1 ?? null;
            return playFabResponse({});
        }
        if (endpoint.endsWith("/Server/GetUserInternalData")) return playFabResponse({ Data: {} });
        if (endpoint.endsWith("/Admin/ResetUserStatistics")) return playFabResponse({});
        if (endpoint.endsWith("/Server/GetPlayerStatistics")) return playFabResponse({ Statistics: [] });
        if (endpoint.endsWith("/Admin/RemoveVirtualCurrencyTypes")) {
            for (const entry of body.VirtualCurrencies) currencyTypes.delete(entry.CurrencyCode);
            return playFabResponse({});
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    try {
        const upgraded = await upgradeLegacyCanaryCurrencies(configuration, redis);
        assert.equal(upgraded.status, "upgraded");
        assert.equal(upgraded.baselineUnchanged, true);
        assert.equal(redis.values.get(key), raw);
        assert.deepEqual([...currencyTypes].sort(), ["DM", "GD"]);
        balances.GD = 4;
        balances.DM = 5;
        const restored = await restoreLegacyCanaryBaseline(configuration, redis);
        assert.deepEqual(restored, { status: "restored", gdRemoved: true, dmRemoved: true });
        assert.equal(profile, null);
        assert.deepEqual([...currencyTypes], []);
        assert.equal(redis.values.get(key), raw);
    } finally { globalThis.fetch = previousFetch; }
});
