import "./fixtures/diamonds-canary-legacy.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
    createDiamondsCanarySyntheticXsd2Receipt,
    createDiamondsCanaryV2OnlyReceiptStore,
    interpretDiamondsCanaryTargetOperationResult,
    readDiamondsSandboxCanaryApplyEnvironment,
    runLiveDiamondsSandboxCanary
} from "../diamonds-sandbox-canary-apply.mjs";
import { getXsollaDiamondReceiptKey } from "../src/playfab-xsolla-diamond-receipt-store.js";

const SECRET = "sandbox-fixture-secret-never-output";
const TRANSACTION = {
    provider: "xsolla",
    providerTransactionId: "810000000000000001",
    playFabId: "61AD15CDA4137EA9",
    environment: "sandbox",
    state: "Completed",
    receiptId: "xsd2_fixture",
    checkpoints: {
        receipt_persisted: {},
        diamonds_target_granted: {},
        profile_granted: {}
    }
};

function environment(mode = "apply", overrides = {}) {
    return {
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "1D0C16",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: SECRET,
        FINANCIAL_REDIS_URL: "redis://canary:fixture-password@127.0.0.1:6397/0",
        FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH: "C:/sandbox/canary-readiness-fixture.json",
        FINANCIAL_DIAMONDS_MODE: "Canary",
        FINANCIAL_DIAMONDS_CANARY_ENABLED: "true",
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "61AD15CDA4137EA9",
        FINANCIAL_DIAMONDS_CUTOVER_ENABLED: "false",
        FINANCIAL_DIAMONDS_MIGRATION_ENABLED: "false",
        FINANCIAL_ELITE_MODE: "Legacy",
        FINANCIAL_PREMIUM_MODE: "Legacy",
        SEABYSS_DIAMONDS_SANDBOX_CANARY_APPLY_ENABLED: mode === "apply" ? "true" : "false",
        SEABYSS_DIAMONDS_SANDBOX_CANARY_VERIFY_ENABLED: mode === "verify" ? "true" : "false",
        SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED: mode === "apply" ? "true" : "false",
        SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED: mode === "apply" ? "true" : "false",
        PURCHASES_GLOBAL_ENABLED: "false",
        PURCHASES_DIAMOND_ENABLED: "false",
        PURCHASES_STARTER_ENABLED: "false",
        PURCHASES_PREMIUM_ENABLED: "false",
        PURCHASES_DOUBLER_ENABLED: "false",
        XSOLLA_CHECKOUT_SANDBOX_ENABLED: "false",
        XSOLLA_CHECKOUT_PRODUCTION_ENABLED: "false",
        ...overrides
    };
}

test("CLI is inert by default and fails before constructing any provider dependency", async () => {
    let factories = 0;
    await assert.rejects(runLiveDiamondsSandboxCanary({
        mode: "apply",
        environment: {},
        async dependencyFactory() { factories += 1; throw new Error("must not run"); }
    }));
    assert.equal(factories, 0);
});

test("apply environment requires exact Sandbox, canary, explicit writes and loopback Redis", () => {
    const selected = readDiamondsSandboxCanaryApplyEnvironment({
        environment: environment("apply"),
        mode: "apply"
    });
    assert.equal(selected.titleId, "1D0C16");
    assert.equal(selected.playFabId, "61AD15CDA4137EA9");
    assert.equal(selected.providerWritesEnabled, true);
    assert.equal(selected.secretKey, SECRET);
    assert.throws(() => readDiamondsSandboxCanaryApplyEnvironment({
        environment: environment("apply", {
            PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "142853"
        }),
        mode: "apply"
    }), { code: "DIAMONDS_CANARY_SANDBOX_TITLE_MISMATCH" });
    assert.throws(() => readDiamondsSandboxCanaryApplyEnvironment({
        environment: environment("apply", { FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "*" }),
        mode: "apply"
    }), { code: "DIAMONDS_CANARY_ALLOWLIST_INVALID" });
    assert.throws(() => readDiamondsSandboxCanaryApplyEnvironment({
        environment: environment("apply", { FINANCIAL_REDIS_URL: "redis://user:pass@prod.example:6379" }),
        mode: "apply"
    }), { code: "DIAMONDS_CANARY_REDIS_NOT_ISOLATED" });
    assert.throws(() => readDiamondsSandboxCanaryApplyEnvironment({
        environment: environment("apply", { PURCHASES_GLOBAL_ENABLED: "true" }),
        mode: "apply"
    }), { code: "DIAMONDS_CANARY_UNSAFE_GATE" });
});

test("synthetic xsd2 identity is stable and contains no caller-provided reward projection", () => {
    const certificate = {
        certificateHash: "a".repeat(64),
        issuedAtUtc: "2026-08-24T13:36:03.620Z"
    };
    const first = createDiamondsCanarySyntheticXsd2Receipt({ certificate });
    const second = createDiamondsCanarySyntheticXsd2Receipt({ certificate });
    assert.deepEqual(first, second);
    assert.equal(first.xsollaSku, "seabyss_diamond_pack_1");
    assert.equal(first.environment, "sandbox");
    assert.equal(first.playFabId, "61AD15CDA4137EA9");
    assert.match(first.transactionId, /^[1-9][0-9]+$/u);
    assert.equal(Object.hasOwn(first, "reward"), false);
    assert.equal(Object.hasOwn(first, "rewards"), false);
    assert.doesNotMatch(JSON.stringify(first), /fixture-secret|authorization|entity.?token/iu);
});

test("live Target result translation requires Applied and maps adapter Insufficient to the canonical error", () => {
    const applied = {
        status: "Applied",
        playFabId: "61AD15CDA4137EA9",
        providerConfirmed: true,
        balance: 25
    };
    assert.equal(interpretDiamondsCanaryTargetOperationResult({ result: applied, delta: 25 }), applied);
    assert.throws(() => interpretDiamondsCanaryTargetOperationResult({
        result: { ...applied, status: "Insufficient", balance: 15 },
        delta: -16
    }), { code: "POC_INSUFFICIENT_DIAMONDS", statusCode: 409 });
    assert.throws(() => interpretDiamondsCanaryTargetOperationResult({
        result: { ...applied, status: "AlreadyApplied" },
        delta: 25
    }), { code: "DIAMONDS_CANARY_TARGET_RESULT_INVALID" });
});

test("certification receipt store writes xsd2 only and proves matching xsd1 absent", async () => {
    const certificate = {
        certificateHash: "c".repeat(64),
        issuedAtUtc: "2026-08-24T13:36:03.620Z"
    };
    const receipt = createDiamondsCanarySyntheticXsd2Receipt({ certificate });
    const values = {};
    const updates = [];
    const fetchImpl = async (url, options) => {
        const endpoint = new URL(url).pathname;
        const body = JSON.parse(options.body);
        if (endpoint.endsWith("/Server/GetUserInternalData")) {
            return {
                ok: true,
                async json() {
                    return { code: 200, data: { Data: Object.fromEntries(body.Keys
                        .filter((key) => Object.hasOwn(values, key))
                        .map((key) => [key, { Value: values[key] }])) } };
                }
            };
        }
        if (endpoint.endsWith("/Server/UpdateUserInternalData")) {
            updates.push(structuredClone(body.Data));
            Object.assign(values, body.Data);
            return { ok: true, async json() { return { code: 200, data: { DataVersion: 1 } }; } };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
    };
    const persist = createDiamondsCanaryV2OnlyReceiptStore({
        titleId: "1D0C16",
        secretKey: SECRET,
        fetchImpl
    });
    const first = await persist(receipt);
    const replay = await persist(receipt);
    assert.equal(first.certificationV2Only, true);
    assert.equal(first.legacyReceiptBefore, false);
    assert.equal(first.legacyReceiptAfter, false);
    assert.equal(first.legacyReceiptWritten, false);
    assert.equal(replay.existing, true);
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0]), [first.key]);
    assert.match(first.key, /^xsd2_/u);
    assert.equal(Object.hasOwn(values, getXsollaDiamondReceiptKey(receipt.transactionId)), false);
    assert.equal(Object.keys(values).some((key) => /^xsd1_/u.test(key)), false);
});

test("xsd2-only receipt store refuses a pre-existing matching xsd1 before any write", async () => {
    const certificate = {
        certificateHash: "d".repeat(64),
        issuedAtUtc: "2026-08-24T13:36:03.620Z"
    };
    const receipt = createDiamondsCanarySyntheticXsd2Receipt({ certificate });
    const legacyKey = getXsollaDiamondReceiptKey(receipt.transactionId);
    let updates = 0;
    const persist = createDiamondsCanaryV2OnlyReceiptStore({
        titleId: "1D0C16",
        secretKey: SECRET,
        async fetchImpl(url) {
            if (new URL(url).pathname.endsWith("/Server/UpdateUserInternalData")) updates += 1;
            return {
                ok: true,
                async json() { return { code: 200, data: { Data: { [legacyKey]: { Value: "legacy" } } } }; }
            };
        }
    });
    await assert.rejects(persist(receipt), { code: "DIAMONDS_CANARY_LEGACY_RECEIPT_PRESENT" });
    assert.equal(updates, 0);
});

test("verify mode composes only after fail-closed validation and always closes its dependency", async () => {
    let closes = 0;
    let factories = 0;
    const result = await runLiveDiamondsSandboxCanary({
        mode: "verify",
        environment: environment("verify"),
        async dependencyFactory(configuration) {
            factories += 1;
            assert.equal(configuration.providerWritesEnabled, false);
            return {
                dependencies: {
                    async readTarget() { return { diamonds: 515, revision: 4, fencingEpoch: 7 }; },
                    async readMigrationProof() {
                        return {
                            schemaVersion: 1,
                            state: "Completed",
                            titleId: "1D0C16",
                            playFabId: "61AD15CDA4137EA9",
                            domain: "Diamonds",
                            planHash: "a".repeat(64),
                            legacyValue: 0,
                            targetValue: 515,
                            targetOnlyOperationCount: 3
                        };
                    },
                    async getSyntheticProviderTransactionId() { return TRANSACTION.providerTransactionId; },
                    async projectTrustedXsd2(input) {
                        assert.deepEqual(input, { providerTransactionId: TRANSACTION.providerTransactionId });
                        return { status: "already_applied", authoritative: true };
                    },
                    async readLedgerTransaction() { return TRANSACTION; },
                    async assertStaleLegacyWriteBlocked() {
                        return { blocked: true, legacyValue: 0, targetBalance: 515 };
                    }
                },
                async close() { closes += 1; }
            };
        }
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(factories, 1);
    assert.equal(closes, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|fixture-password/iu);
});
