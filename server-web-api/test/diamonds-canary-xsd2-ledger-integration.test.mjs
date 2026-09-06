import "./fixtures/diamonds-canary-payment.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createDiamondsCanaryXsd2Composition } from "../src/diamonds-canary-xsd2-composition.js";
import {
    DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT,
    DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT
} from "../src/diamonds-canary-xsd2-ledger-executor.js";
import { createFinancialShadowPaymentProducer } from "../src/financial-shadow-payment-producer.js";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { PaymentWorkerCrash } from "../src/payment-worker.js";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import { createCanonicalMemoryServerEconomyPocHarness } from "../src/server-economy-poc-canonical.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { getXsollaProductPlan } from "../src/xsolla-product-plan-registry.js";

const CANARY = "C5BD37AA141B3C4E";
const TITLE = "1D0C16";
const CREATED_AT = "2026-08-24T13:00:00.000Z";

function receipt(transactionId) {
    const product = getXsollaProductPlan("seabyss_diamond_pack_1", 1);
    return {
        playFabId: CANARY,
        transactionId,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: CANARY,
        createdAtUtc: CREATED_AT,
        environment: "sandbox",
        notificationType: "payment",
        orderId: transactionId,
        productId: product.productId,
        xsollaSku: product.sku,
        productType: product.productType,
        source: "xsolla_sandbox",
        productPlanVersion: product.planVersion,
        currency: product.currency,
        unitAmountMinor: product.unitAmountMinor,
        quantity: 1,
        totalAmountMinor: product.unitAmountMinor,
        promotionPolicy: "disabled"
    };
}

function harness({ crashOnceAfterProvider = false, failOnceBeforeProvider = false } = {}) {
    const clock = { now: Date.parse(CREATED_AT) + 1_000 };
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => clock.now
    });
    const receipts = new Map();
    const persist = createXsollaLedgeredReceiptProcessor({
        ledger,
        async persistStarterPackReceiptV2() { throw new Error("Starter is outside this test."); },
        async persistDiamondPackReceiptV2(value) {
            const key = getXsollaDiamondReceiptV2Key(value.transactionId);
            const serialized = serializeXsollaDiamondReceiptV2(value);
            const existing = receipts.has(key);
            receipts.set(key, serialized);
            return { key, value: serialized, existing };
        },
        workerOptions: { nowMilliseconds: () => clock.now }
    });
    async function loadXsollaV2Receipt({ receiptId }) {
        const value = receipts.get(receiptId);
        return value === undefined ? null : { key: receiptId, value };
    }

    const canonicalHarness = createCanonicalMemoryServerEconomyPocHarness({ clock });
    const proofs = new Map();
    let providerCalls = 0;
    let providerFailureArmed = failOnceBeforeProvider;
    let preferOnline = null;
    const canonicalRuntime = {
        mapValidatedXsollaReceipt: canonicalHarness.poc.mapValidatedXsollaReceipt,
        readSnapshot: canonicalHarness.poc.readSnapshot,
        async consumeValidatedXsollaReceipt(projection, options) {
            providerCalls += 1;
            preferOnline = options?.preferOnline;
            if (providerFailureArmed) {
                providerFailureArmed = false;
                throw new Error("simulated provider unavailable before mutation");
            }
            const result = await canonicalHarness.poc.consumeValidatedXsollaReceipt(projection, options);
            if (!proofs.has(result.operation.operationId)) {
                proofs.set(result.operation.operationId, {
                    operationHash: result.submitted.record.operation.immutableHash,
                    delta: result.operation.diamonds,
                    operation: result.submitted.record.operation,
                    count: 1
                });
            }
            return result;
        }
    };
    const migrationProofCompanion = {
        capabilities: {
            atomicStateProofCas: true,
            fencing: true,
            migrationProof: true
        },
        async verifyTrustedOperation({ playFabId, operationId, operationHash, delta }) {
            const proof = proofs.get(operationId);
            const snapshot = await canonicalHarness.poc.readSnapshot(playFabId);
            assert.equal(proof?.operationHash, operationHash, JSON.stringify(proof?.operation));
            assert.equal(proof?.delta, delta);
            return {
                verified: Boolean(proof && proof.operationHash === operationHash && proof.delta === delta),
                playFabId,
                operationId,
                operationHash,
                delta,
                balance: snapshot.diamonds,
                revision: snapshot.revision,
                fencingEpoch: snapshot.fencingEpoch,
                targetOnlyOperationCount: proof?.count || 0
            };
        }
    };
    canonicalRuntime.proofCapabilities = migrationProofCompanion.capabilities;
    canonicalRuntime.verifyTrustedOperation =
        migrationProofCompanion.verifyTrustedOperation.bind(migrationProofCompanion);
    const shadow = createFinancialShadowPaymentProducer({
        ledger,
        loadXsollaV2Receipt,
        policy: { enabled: true, shadowEnvironment: "sandbox", allowlist: new Set([CANARY]) },
        async enqueueCanonicalProjection() { throw new Error("Canary xsd2 must not route Shadow."); }
    });
    let crashArmed = crashOnceAfterProvider;
    const composition = createDiamondsCanaryXsd2Composition({
        ledger,
        loadXsollaV2Receipt,
        shadowProducer: shadow,
        canonicalRuntime,
        workerId: "diamonds-canary-xsd2-integration",
        workerOptions: {
            nowMilliseconds: () => clock.now,
            async faultInjector(stage) {
                if (stage === "after_effect_before_checkpoint" && crashArmed) {
                    crashArmed = false;
                    throw new PaymentWorkerCrash(stage);
                }
            }
        },
        async verifyCanaryReadiness() {
            return {
                ready: true,
                domain: "Diamonds",
                titleId: TITLE,
                playFabId: CANARY,
                certificateValid: true,
                migrationProofValid: true,
                redisHealthy: true,
                playFabHealthy: true,
                scannerForbiddenCount: 0
            };
        },
        policy: {
            enabled: true,
            environment: "sandbox",
            titleId: TITLE,
            forbiddenTitleIds: ["142853"],
            canaryPlayFabIds: [CANARY]
        }
    });
    return {
        canonicalHarness,
        clock,
        ledger,
        persist,
        producer: composition.producer,
        providerCalls: () => providerCalls,
        preferOnline: () => preferOnline
    };
}

test("canonical xsd2 route uses inbox/WAL, checkpoints proof, and completes ledger exactly once", async () => {
    const h = harness();
    const paid = receipt("930000001");
    await h.persist(paid);

    const first = await h.producer.projectTransaction({ providerTransactionId: paid.transactionId });
    const replay = await h.producer.projectTransaction({ providerTransactionId: paid.transactionId });
    const snapshot = await h.canonicalHarness.poc.readSnapshot(CANARY);
    const transaction = await h.ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: paid.transactionId
    });

    assert.equal(first.status, "applied");
    assert.equal(replay.status, "already_applied");
    assert.equal(snapshot.diamonds, 500);
    assert.equal(snapshot.revision, 1);
    assert.equal(h.providerCalls(), 1, "Completed replay must use ledger proof without provider call");
    assert.equal(h.preferOnline(), false);
    assert.equal(transaction.state, "Completed");
    assert.ok(transaction.checkpoints[DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT]);
    assert.ok(transaction.checkpoints[DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT]);
});

test("crash after Target CAS before ledger checkpoint replays provider operation once then completes", async () => {
    const h = harness({ crashOnceAfterProvider: true });
    const paid = receipt("930000002");
    await h.persist(paid);

    await assert.rejects(
        h.producer.projectTransaction({ providerTransactionId: paid.transactionId }),
        PaymentWorkerCrash
    );
    assert.equal((await h.canonicalHarness.poc.readSnapshot(CANARY)).diamonds, 500);
    h.clock.now += 31_000;

    const recovered = await h.producer.projectTransaction({ providerTransactionId: paid.transactionId });
    const finalReplay = await h.producer.projectTransaction({ providerTransactionId: paid.transactionId });
    const snapshot = await h.canonicalHarness.poc.readSnapshot(CANARY);
    const transaction = await h.ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: paid.transactionId
    });

    assert.equal(recovered.status, "already_applied");
    assert.equal(finalReplay.status, "already_applied");
    assert.equal(snapshot.diamonds, 500);
    assert.equal(snapshot.revision, 1);
    assert.equal(h.providerCalls(), 2, "one ambiguous retry, then Completed replay stays local");
    assert.equal(transaction.state, "Completed");
    assert.ok(transaction.checkpoints[DIAMONDS_CANARY_TARGET_GRANTED_CHECKPOINT]);
    assert.ok(transaction.checkpoints[DIAMONDS_CANARY_PROFILE_GRANTED_CHECKPOINT]);
});

test("a transient provider failure persists Failed and webhook retry safely reaches Completed", async () => {
    const h = harness({ failOnceBeforeProvider: true });
    const paid = receipt("930000003");
    await h.persist(paid);
    await assert.rejects(
        h.producer.projectTransaction({ providerTransactionId: paid.transactionId }),
        /simulated provider unavailable/u
    );
    assert.equal((await h.ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: paid.transactionId
    })).state, "Failed");

    const retry = await h.producer.projectTransaction({ providerTransactionId: paid.transactionId });
    assert.equal(retry.status, "applied");
    assert.equal((await h.canonicalHarness.poc.readSnapshot(CANARY)).diamonds, 500);
    assert.equal((await h.ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: paid.transactionId
    })).state, "Completed");
    assert.equal(h.providerCalls(), 2);
});
