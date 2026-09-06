import "./fixtures/diamonds-canary-payment.mjs";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createDiamondsCanaryXsd2PaymentProducer
} from "../src/diamonds-canary-xsd2-payment-producer.js";
import { createFinancialShadowPaymentProducer } from "../src/financial-shadow-payment-producer.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import {
    getXsollaStarterReceiptV2Key,
    serializeXsollaStarterReceiptV2
} from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { createMemoryServerEconomyPocOperationInbox } from "../src/server-economy-poc-memory-stores.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";

const CANARY = "C5BD37AA141B3C4E";
const OTHER_PLAYER = "TESTONLY0000000001";
const TITLE = "1D0C16";
const PRODUCTION_TITLE = "142853";
const CREATED_AT = "2026-08-24T12:00:00.000Z";

function paidReceipt({ playFabId = CANARY, sku = "seabyss_diamond_pack_1", transactionId }) {
    const product = getXsollaProductPlan(sku, 1);
    const receipt = {
        playFabId,
        transactionId,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: playFabId,
        createdAtUtc: CREATED_AT,
        environment: "sandbox",
        notificationType: "payment",
        orderId: transactionId,
        productId: product.productId,
        xsollaSku: sku,
        productType: product.productType,
        source: "xsolla_sandbox",
        productPlanVersion: product.planVersion,
        currency: product.currency,
        unitAmountMinor: product.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: product.unitAmountMinor,
        promotionPolicy: "disabled"
    };
    if (product.productType === "starter_pack") {
        const rewards = getStarterRewardPlan(sku);
        receipt.rewardPlanVersion = rewards.planVersion;
        receipt.rewardPlanHash = rewards.rewardPlanHash;
        receipt.rewards = rewards.rewards;
    }
    return receipt;
}

function ready(overrides = {}) {
    return {
        ready: true,
        domain: "Diamonds",
        titleId: TITLE,
        playFabId: CANARY,
        certificateValid: true,
        migrationProofValid: true,
        redisHealthy: true,
        playFabHealthy: true,
        scannerForbiddenCount: 0,
        ...overrides
    };
}

function harness({ readiness = ready(), targetCapabilities = {}, targetResult = null } = {}) {
    const now = Date.parse(CREATED_AT) + 1_000;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => now
    });
    const receipts = new Map();
    const inbox = createMemoryServerEconomyPocOperationInbox({ nowMilliseconds: () => now });
    let targetCalls = 0;
    let shadowCalls = 0;
    let balance = 0;
    let revision = 0;
    const applied = new Map();
    const persist = createXsollaLedgeredReceiptProcessor({
        ledger,
        async persistStarterPackReceiptV2(receipt) {
            const key = getXsollaStarterReceiptV2Key(receipt.transactionId);
            const value = serializeXsollaStarterReceiptV2(receipt);
            const existing = receipts.has(key);
            receipts.set(key, value);
            return { key, value, existing };
        },
        async persistDiamondPackReceiptV2(receipt) {
            const key = getXsollaDiamondReceiptV2Key(receipt.transactionId);
            const value = serializeXsollaDiamondReceiptV2(receipt);
            const existing = receipts.has(key);
            receipts.set(key, value);
            return { key, value, existing };
        },
        workerOptions: { nowMilliseconds: () => now }
    });
    async function loadXsollaV2Receipt({ receiptId }) {
        const value = receipts.get(receiptId);
        return value === undefined ? null : { key: receiptId, value };
    }
    const baseShadow = createFinancialShadowPaymentProducer({
        ledger,
        loadXsollaV2Receipt,
        policy: {
            enabled: true,
            shadowEnvironment: "sandbox",
            allowlist: new Set([CANARY, OTHER_PLAYER])
        },
        async enqueueCanonicalProjection(operation) {
            shadowCalls += 1;
            return inbox.submit(operation);
        }
    });
    const shadowProducer = {
        ...baseShadow,
        async projectTransaction(input) {
            return baseShadow.projectTransaction(input);
        }
    };
    const targetExecutor = {
        capabilities: {
            authoritative: true,
            cas: true,
            durableCompletion: true,
            exactlyOnce: true,
            fencing: true,
            migrationProofRequired: true,
            ...targetCapabilities
        },
        async executeTrustedXsd2(command) {
            targetCalls += 1;
            if (targetResult) return targetResult(command);
            const existing = applied.get(command.operationId);
            if (existing) {
                assert.deepEqual(command, existing.command);
                return {
                    ...existing.result,
                    status: "AlreadyApplied"
                };
            }
            balance += command.delta;
            revision += 1;
            const result = {
                status: "Applied",
                authoritative: true,
                providerConfirmed: true,
                transactionState: "Completed",
                playFabId: command.playFabId,
                operationId: command.operationId,
                delta: command.delta,
                balance,
                revision,
                fencingEpoch: 7
            };
            applied.set(command.operationId, { command, result });
            return result;
        }
    };
    const producer = createDiamondsCanaryXsd2PaymentProducer({
        ledger,
        loadXsollaV2Receipt,
        shadowProducer,
        targetExecutor,
        async verifyCanaryReadiness() { return readiness; },
        policy: {
            enabled: true,
            environment: "sandbox",
            titleId: TITLE,
            forbiddenTitleIds: [PRODUCTION_TITLE],
            canaryPlayFabIds: [CANARY]
        }
    });
    return {
        ledger,
        receipts,
        persist,
        producer,
        targetExecutor,
        balance: () => balance,
        targetCalls: () => targetCalls,
        shadowCalls: () => shadowCalls
    };
}

describe("Diamonds canary trusted xsd2 Target routing", () => {
    test("Diamond I is reconstructed as +500 and replay is authoritative exactly once", async () => {
        const h = harness();
        const receipt = paidReceipt({ transactionId: "920000001" });
        await h.persist(receipt);

        const first = await h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });
        const replay = await h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });

        assert.equal(first.route, "target_diamonds_canary");
        assert.equal(first.authoritative, true);
        assert.equal(first.operation.diamonds, 500);
        assert.equal(first.operation.eliteBall, 0);
        assert.equal(first.operation.premium, null);
        assert.equal(first.target.status, "Applied");
        assert.equal(replay.status, "already_applied");
        assert.equal(replay.target.status, "AlreadyApplied");
        assert.equal(h.balance(), 500);
        assert.equal(h.targetCalls(), 2);
        assert.equal(h.shadowCalls(), 0);
    });

    test("non-canary xsd2 keeps the existing Shadow route and never reaches Target", async () => {
        const h = harness();
        const receipt = paidReceipt({ playFabId: OTHER_PLAYER, transactionId: "920000002" });
        await h.persist(receipt);
        const result = await h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });
        assert.equal(result.route, "shadow");
        assert.equal(result.authoritative, false);
        assert.equal(result.operation.diamonds, 500);
        assert.equal(h.targetCalls(), 0);
        assert.equal(h.shadowCalls(), 1);
    });

    test("non-canary is a strict no-op when the pre-existing Shadow producer is off", async () => {
        const h = harness();
        const receipt = paidReceipt({ playFabId: OTHER_PLAYER, transactionId: "920000042" });
        await h.persist(receipt);
        const producer = createDiamondsCanaryXsd2PaymentProducer({
            ledger: h.ledger,
            async loadXsollaV2Receipt({ receiptId }) {
                const value = h.receipts.get(receiptId);
                return value === undefined ? null : { key: receiptId, value };
            },
            shadowProducer: null,
            targetExecutor: h.targetExecutor,
            async verifyCanaryReadiness() { return ready(); },
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: TITLE,
                forbiddenTitleIds: [PRODUCTION_TITLE],
                canaryPlayFabIds: [CANARY]
            }
        });
        const result = await producer.projectTransaction({ providerTransactionId: receipt.transactionId });
        assert.deepEqual(result, {
            status: "not_projected",
            route: "none",
            authoritative: false,
            requiresPlayerPresence: false
        });
        assert.equal(h.targetCalls(), 0);
        assert.equal(h.shadowCalls(), 0);
    });

    test("canary xss2 Starter remains Shadow because only xsd2 is cut over", async () => {
        const h = harness();
        const receipt = paidReceipt({ sku: "seabyss_starter_pack_1", transactionId: "920000003" });
        await h.persist(receipt);
        const result = await h.producer.projectTransaction({ providerTransactionId: receipt.transactionId });
        assert.equal(result.route, "shadow");
        assert.equal(result.operation.diamonds, 1000);
        assert.equal(result.operation.eliteBall, 13000);
        assert.equal(h.targetCalls(), 0);
        assert.equal(h.shadowCalls(), 1);
    });

    test("certificate, migration proof, health and zero-forbidden scanner are fail-closed", async () => {
        for (const unavailable of [
            { certificateValid: false },
            { migrationProofValid: false },
            { redisHealthy: false },
            { playFabHealthy: false },
            { scannerForbiddenCount: 1 }
        ]) {
            const h = harness({ readiness: ready(unavailable) });
            const receipt = paidReceipt({ transactionId: String(920000010 + h.targetCalls()) });
            await h.persist(receipt);
            await assert.rejects(
                h.producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
                { code: "DIAMONDS_CANARY_PAYMENT_NOT_READY" }
            );
            assert.equal(h.targetCalls(), 0);
            assert.equal(h.shadowCalls(), 0);
        }
    });

    test("caller cannot provide player, reward, amount or balance", async () => {
        const h = harness();
        await assert.rejects(h.producer.projectTransaction({
            providerTransactionId: "920000020",
            playFabId: CANARY,
            diamonds: 999999,
            balance: 999999
        }), { code: "DIAMONDS_CANARY_PAYMENT_INPUT_REJECTED" });
        assert.equal(h.targetCalls(), 0);
        assert.equal(h.shadowCalls(), 0);
    });

    test("exact allowlist, forbidden Production Title and executor guarantees are enforced at composition", () => {
        const dependency = {
            ledger: { async requireTransaction() { throw new Error("unused"); } },
            loadXsollaV2Receipt: async () => null,
            shadowProducer: { authoritative: false, async projectTransaction() {} },
            verifyCanaryReadiness: async () => ready(),
            targetExecutor: {
                capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map((name) => [name, true])),
                async executeTrustedXsd2() {}
            }
        };
        assert.throws(() => createDiamondsCanaryXsd2PaymentProducer({
            ...dependency,
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: TITLE,
                forbiddenTitleIds: [PRODUCTION_TITLE],
                canaryPlayFabIds: [CANARY, OTHER_PLAYER]
            }
        }), { code: "DIAMONDS_CANARY_PAYMENT_POLICY_INVALID" });
        assert.throws(() => createDiamondsCanaryXsd2PaymentProducer({
            ...dependency,
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: PRODUCTION_TITLE,
                forbiddenTitleIds: [PRODUCTION_TITLE],
                canaryPlayFabIds: [CANARY]
            }
        }), { code: "DIAMONDS_CANARY_PAYMENT_TITLE_FORBIDDEN" });
        assert.throws(() => createDiamondsCanaryXsd2PaymentProducer({
            ...dependency,
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: "BAD999",
                forbiddenTitleIds: [PRODUCTION_TITLE],
                canaryPlayFabIds: [CANARY]
            }
        }), { code: "DIAMONDS_CANARY_PAYMENT_TITLE_FORBIDDEN" });
        assert.throws(() => createDiamondsCanaryXsd2PaymentProducer({
            ...dependency,
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: TITLE,
                forbiddenTitleIds: [PRODUCTION_TITLE],
                canaryPlayFabIds: [OTHER_PLAYER]
            }
        }), { code: "DIAMONDS_CANARY_PAYMENT_TITLE_FORBIDDEN" });
        assert.throws(() => createDiamondsCanaryXsd2PaymentProducer({
            ...dependency,
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: TITLE,
                forbiddenTitleIds: [],
                canaryPlayFabIds: [CANARY]
            }
        }), { code: "DIAMONDS_CANARY_PAYMENT_TITLE_FORBIDDEN" });
        assert.throws(() => createDiamondsCanaryXsd2PaymentProducer({
            ...dependency,
            targetExecutor: {
                capabilities: { ...dependency.targetExecutor.capabilities, exactlyOnce: false },
                async executeTrustedXsd2() {}
            },
            policy: {
                enabled: true,
                environment: "sandbox",
                titleId: TITLE,
                forbiddenTitleIds: [PRODUCTION_TITLE],
                canaryPlayFabIds: [CANARY]
            }
        }), { code: "DIAMONDS_CANARY_PAYMENT_TARGET_UNSAFE" });
    });

    test("Target must report durable Completed CAS/fencing result", async () => {
        const h = harness({
            targetResult(command) {
                return {
                    status: "Applied",
                    authoritative: true,
                    providerConfirmed: true,
                    transactionState: "Processing",
                    playFabId: command.playFabId,
                    operationId: command.operationId,
                    delta: command.delta,
                    balance: 500,
                    revision: 1,
                    fencingEpoch: 7
                };
            }
        });
        const receipt = paidReceipt({ transactionId: "920000030" });
        await h.persist(receipt);
        await assert.rejects(
            h.producer.projectTransaction({ providerTransactionId: receipt.transactionId }),
            { code: "DIAMONDS_CANARY_PAYMENT_TARGET_RESULT_INVALID" }
        );
    });

    test("disabled canary requires an empty allowlist and delegates every payment to Shadow", async () => {
        const h = harness();
        const disabled = createDiamondsCanaryXsd2PaymentProducer({
            ledger: h.ledger,
            async loadXsollaV2Receipt({ receiptId }) {
                const value = h.receipts.get(receiptId);
                return value === undefined ? null : { key: receiptId, value };
            },
            shadowProducer: {
                authoritative: false,
                async projectTransaction(input) {
                    return { status: "projected", operation: { providerTransactionId: input.providerTransactionId } };
                }
            },
            policy: { enabled: false, canaryPlayFabIds: [] }
        });
        const receipt = paidReceipt({ transactionId: "920000040" });
        await h.persist(receipt);
        const result = await disabled.projectTransaction({ providerTransactionId: receipt.transactionId });
        assert.equal(result.route, "shadow");
        assert.equal(result.authoritative, false);
        assert.equal(disabled.policy.canaryPlayFabIds.length, 0);
    });
});

const REQUIRED_CAPABILITIES = Object.freeze([
    "authoritative", "cas", "durableCompletion", "exactlyOnce", "fencing", "migrationProofRequired"
]);
