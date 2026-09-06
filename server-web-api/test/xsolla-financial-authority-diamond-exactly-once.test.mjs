import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { PaymentWorkerCrash } from "../src/payment-worker.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { getXsollaDiamondReceiptV2Key } from "../src/playfab-xsolla-diamond-receipt-v2-store.js";
import { createInitialFinancialAuthority } from "../src/financial-authority-v2.js";
import {
    createPlayFabEconomyV2GrantAdapter,
    PlayFabEconomyV2GrantError
} from "../src/playfab-economy-v2-grant-adapter.js";
import { createPlayFabFinancialAuthorityGrantAdapter } from "../src/playfab-financial-authority-grant-adapter.js";
import { createXsollaFinancialAuthorityWorker } from "../src/xsolla-financial-authority-worker.js";

const playFabId = "46789223F9CB1BB9";
const transactionId = "850000500";
const nowUtc = "2026-08-23T00:00:00.000Z";

for (const [number, quantity, price] of [[1,1000,199],[2,2500,399],[3,5000,699],[4,8000,999],[5,20000,1899]]) {
    test(`approved Diamond ${number}: current xsd2 grants ${quantity}, completes, replays once and rejects altered economics`, async () => {
        const h = await harness({
            expectedQuantity: quantity,
            receiptOverrides: {
                productId: `diamond_pack_${number}`,
                xsollaSku: `seabyss_diamond_pack_${number}`,
                productPlanVersion: 2,
                unitAmountMinor: price,
                totalAmountMinor: price
            }
        });
        const worker = h.makeWorker("approved-diamond");
        const results = await worker.processPending();
        assert.equal(results[0].status, "completed");
        assertCompletedWithProof(await storedTransaction(h));
        assert.equal(h.provider.diamonds(), quantity);
        assert.equal(h.provider.effects.size, 1);
        const calls = h.provider.requests.length;
        await h.processReceipt(h.receipt);
        await h.makeWorker("approved-diamond-after-restart").processPending();
        assert.equal(h.provider.diamonds(), quantity);
        assert.equal(h.provider.requests.length, calls);
        await assert.rejects(h.processReceipt({ ...h.receipt, totalAmountMinor: price + 1 }));
        assert.equal(h.provider.diamonds(), quantity);
        assert.equal(h.provider.requests.length, calls);
    });
}


function diamondReceipt() {
    return {
        schemaVersion: 2,
        playFabId,
        transactionId,
        provider: "xsolla",
        providerTransactionId: transactionId,
        userId: playFabId,
        createdAtUtc: "2026-08-22T20:00:00.000Z",
        environment: "sandbox",
        notificationType: "payment",
        orderId: "850000501",
        productId: "diamond_pack_1",
        xsollaSku: "seabyss_diamond_pack_1",
        productType: "diamond_pack",
        source: "xsolla_sandbox",
        productPlanVersion: 1,
        currency: "USD",
        unitAmountMinor: 199,
        quantity: 1,
        totalAmountMinor: 199,
        promotionPolicy: "disabled"
    };
}

function economyProvider({ ambiguousOnce = false, expectedQuantity = 500 } = {}) {
    const effects = new Map();
    const requests = [];
    let diamonds = 0;
    let ambiguityThrown = false;
    return {
        effects,
        requests,
        diamonds: () => diamonds,
        async getUserAccountInfo(id) {
            return {
                UserInfo: {
                    PlayFabId: id,
                    TitleInfo: { TitlePlayerAccount: { Id: "TPA-DIAMOND-500" } }
                }
            };
        },
        async getEntityToken() {
            return { EntityToken: "local-title-entity-token" };
        },
        async executeInventoryOperations(_token, request) {
            requests.push(structuredClone(request));
            if (!effects.has(request.IdempotencyId)) {
                const amounts = request.Operations.map((operation) => operation.Add?.Amount ?? 0);
                assert.deepEqual(amounts, [expectedQuantity]);
                diamonds += amounts.reduce((total, amount) => total + amount, 0);
                effects.set(request.IdempotencyId, {
                    IdempotencyId: request.IdempotencyId,
                    TransactionIds: ["economy-v2-diamond-effect-once"],
                    ETag: "economy-v2-diamond-etag-once"
                });
            }
            if (ambiguousOnce && !ambiguityThrown) {
                ambiguityThrown = true;
                throw new PlayFabEconomyV2GrantError(
                    "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS",
                    "Simulated lost response after provider commit.",
                    { retryable: true, ambiguous: true }
                );
            }
            return structuredClone(effects.get(request.IdempotencyId));
        }
    };
}

function authorityStore() {
    let objectVersion = 1;
    let value = createInitialFinancialAuthority({
        playFabId,
        migratedAtUtc: "2026-08-22T00:00:00.000Z",
        sourceDigests: {
            profileV1: "a".repeat(64),
            financialV1: "b".repeat(64),
            legacyDm: "c".repeat(64)
        }
    });
    let writes = 0;
    return {
        async read() {
            return {
                migrated: true,
                objectVersion,
                financialRevision: value.financialRevision,
                authority: structuredClone(value)
            };
        },
        async compareAndSet({
            expectedObjectVersion,
            expectedFinancialRevision,
            authority,
            operationId,
            fencingToken
        }) {
            if (value.appliedOperations.includes(operationId)) {
                return {
                    applied: false,
                    reason: "already_applied",
                    migrated: true,
                    objectVersion,
                    financialRevision: value.financialRevision,
                    authority: structuredClone(value)
                };
            }
            if (fencingToken <= value.lastFencingToken) {
                return {
                    applied: false,
                    reason: "stale_fencing",
                    migrated: true,
                    objectVersion,
                    financialRevision: value.financialRevision,
                    authority: structuredClone(value)
                };
            }
            if (expectedObjectVersion !== objectVersion ||
                expectedFinancialRevision !== value.financialRevision) {
                return {
                    applied: false,
                    reason: "version_conflict",
                    migrated: true,
                    objectVersion,
                    financialRevision: value.financialRevision,
                    authority: structuredClone(value)
                };
            }
            value = structuredClone(authority);
            objectVersion += 1;
            writes += 1;
            return {
                applied: true,
                reason: "applied",
                migrated: true,
                objectVersion,
                financialRevision: value.financialRevision,
                authority: structuredClone(value)
            };
        },
        probe: async () => true,
        writes: () => writes
    };
}

async function harness({ faultInjector = async () => {}, ambiguousOnce = false,
    receiptOverrides = {}, expectedQuantity = 500 } = {}) {
    let clock = 1_800_000_000_000;
    let receiptWrites = 0;
    let receiptPersisted = false;
    const ledger = createPaymentLedger({
        store: createMemoryPaymentLedgerStore(),
        nowMilliseconds: () => clock
    });
    const receipt = { ...diamondReceipt(), ...receiptOverrides };
    const receiptKey = getXsollaDiamondReceiptV2Key(receipt.transactionId);
    const processReceipt = createXsollaLedgeredReceiptProcessor({
        ledger,
        persistStarterPackReceiptV2: async () => {
            throw new Error("Starter receipt is not expected in the Diamond xsd2 test.");
        },
        persistDiamondPackReceiptV2: async () => {
            const existing = receiptPersisted;
            if (!existing) {
                receiptPersisted = true;
                receiptWrites += 1;
            }
            return { key: receiptKey, existing };
        },
        workerOptions: {
            nowMilliseconds: () => clock,
            leaseTtlMilliseconds: 100,
            leaseRenewIntervalMilliseconds: 0,
            playerLeaseWaitMilliseconds: 0
        }
    });
    const firstReceipt = await processReceipt(receipt);
    const provider = economyProvider({ ambiguousOnce, expectedQuantity });
    const economy = createPlayFabEconomyV2GrantAdapter({
        client: provider,
        catalogMappings: {
            diamonds: { kind: "currency", itemId: "economy-v2-dm", stackId: "default" }
        },
        nowMilliseconds: () => Date.parse(nowUtc)
    });
    const entitlements = authorityStore();
    const adapter = createPlayFabFinancialAuthorityGrantAdapter({
        economyAdapter: economy,
        authorityStore: entitlements,
        loadReceipt: async () => receipt,
        nowUtc: () => new Date(nowUtc)
    });
    const makeWorker = (workerId, injector = faultInjector) =>
        createXsollaFinancialAuthorityWorker({
            ledger,
            grantAdapter: adapter,
            workerId,
            workerOptions: {
                nowMilliseconds: () => clock,
                leaseTtlMilliseconds: 100,
                leaseRenewIntervalMilliseconds: 0,
                playerLeaseWaitMilliseconds: 0,
                faultInjector: injector
            }
        });
    return {
        ledger,
        receipt,
        receiptKey,
        processReceipt,
        firstReceipt,
        provider,
        entitlements,
        makeWorker,
        receiptWrites: () => receiptWrites,
        advance(milliseconds) { clock += milliseconds; }
    };
}

async function storedTransaction(h) {
    return h.ledger.requireTransaction({
        provider: "xsolla",
        providerTransactionId: h.receipt.transactionId
    });
}

function assertExactlyFiveHundredOnce(provider) {
    assert.equal(provider.diamonds(), 500);
    assert.equal(provider.effects.size, 1);
    assert.ok(provider.requests.length >= 1);
    assert.equal(new Set(provider.requests.map((request) => request.IdempotencyId)).size, 1);
    assert.ok(provider.requests.every((request) =>
        request.Operations.length === 1 && request.Operations[0].Add.Amount === 500
    ));
}

function assertCompletedWithProof(transaction) {
    assert.equal(transaction.state, "Completed");
    assert.ok(transaction.checkpoints.receipt_persisted);
    assert.ok(transaction.checkpoints.economy_v2_granted);
    assert.ok(transaction.checkpoints.entitlements_granted);
    assert.ok(transaction.checkpoints.profile_granted);
    assert.equal(transaction.checkpoints.profile_granted.result.status, "verified");
}

test("xsd2 Diamond I normal grant is exactly +500 and completes only with final proof", async () => {
    const h = await harness();
    assert.equal(h.firstReceipt.status, "checkpoints_pending");
    const result = await h.makeWorker("diamond-normal").processPending();
    assert.equal(result.length, 1);
    assert.equal(result[0].status, "completed");
    assertExactlyFiveHundredOnce(h.provider);
    assertCompletedWithProof(await storedTransaction(h));
    assert.equal(h.entitlements.writes(), 1);
});

test("duplicate xsd2 receipt before and after completion never duplicates +500", async () => {
    const h = await harness();
    const duplicatePending = await h.processReceipt(h.receipt);
    assert.equal(duplicatePending.status, "checkpoints_pending");
    assert.equal(h.receiptWrites(), 1);
    const completed = await h.makeWorker("diamond-duplicate").processTransaction({
        provider: "xsolla",
        providerTransactionId: h.receipt.transactionId
    });
    assert.equal(completed.status, "completed");
    const duplicateCompleted = await h.processReceipt(h.receipt);
    assert.equal(duplicateCompleted.status, "already_completed");
    assert.equal(h.receiptWrites(), 1);
    assertExactlyFiveHundredOnce(h.provider);
    assertCompletedWithProof(await storedTransaction(h));
});

test("crash before Economy v2 call recovers to exactly +500, never +1000", async () => {
    let crash = true;
    const h = await harness({
        faultInjector: async (stage, context) => {
            if (stage === "before_checkpoint_effect" &&
                context.step === "economy_v2_granted" && crash) {
                crash = false;
                throw new PaymentWorkerCrash(stage);
            }
        }
    });
    await assert.rejects(
        h.makeWorker("diamond-before-call").processTransaction({
            provider: "xsolla",
            providerTransactionId: h.receipt.transactionId
        }),
        PaymentWorkerCrash
    );
    assert.equal(h.provider.requests.length, 0);
    assert.equal(h.provider.diamonds(), 0);
    assert.notEqual((await storedTransaction(h)).state, "Completed");
    h.advance(101);
    const recovered = await h.makeWorker("diamond-before-call-recover", async () => {})
        .processTransaction({ provider: "xsolla", providerTransactionId: h.receipt.transactionId });
    assert.equal(recovered.status, "completed");
    assertExactlyFiveHundredOnce(h.provider);
    assertCompletedWithProof(await storedTransaction(h));
});

test("crash after provider before checkpoint replays one idempotency ID and stays +500", async () => {
    let crash = true;
    const h = await harness({
        faultInjector: async (stage, context) => {
            if (stage === "after_effect_before_checkpoint" &&
                context.step === "economy_v2_granted" && crash) {
                crash = false;
                throw new PaymentWorkerCrash(stage);
            }
        }
    });
    await assert.rejects(
        h.makeWorker("diamond-after-provider").processTransaction({
            provider: "xsolla",
            providerTransactionId: h.receipt.transactionId
        }),
        PaymentWorkerCrash
    );
    assertExactlyFiveHundredOnce(h.provider);
    assert.notEqual((await storedTransaction(h)).state, "Completed");
    h.advance(101);
    const recovered = await h.makeWorker("diamond-after-provider-recover", async () => {})
        .processTransaction({ provider: "xsolla", providerTransactionId: h.receipt.transactionId });
    assert.equal(recovered.status, "completed");
    assertExactlyFiveHundredOnce(h.provider);
    assertCompletedWithProof(await storedTransaction(h));
});

test("ambiguous timeout after provider commit cannot complete until identical replay confirms +500", async () => {
    const h = await harness({ ambiguousOnce: true });
    const error = await h.makeWorker("diamond-ambiguous").processTransaction({
        provider: "xsolla",
        providerTransactionId: h.receipt.transactionId
    }).catch((value) => value);
    assert.equal(error.code, "PLAYFAB_ECONOMY_OUTCOME_AMBIGUOUS");
    assert.equal(error.ambiguous, true);
    assertExactlyFiveHundredOnce(h.provider);
    const failed = await storedTransaction(h);
    assert.equal(failed.state, "Failed");
    assert.equal(failed.checkpoints.economy_v2_granted, undefined);
    assert.equal(failed.checkpoints.profile_granted, undefined);

    const recovered = await h.makeWorker("diamond-ambiguous-recover").processTransaction({
        provider: "xsolla",
        providerTransactionId: h.receipt.transactionId
    });
    assert.equal(recovered.status, "completed");
    assertExactlyFiveHundredOnce(h.provider);
    assertCompletedWithProof(await storedTransaction(h));
});

test("two and ten concurrent workers each produce one winner and exactly +500", async (t) => {
    for (const workerCount of [2, 10]) {
        await t.test(`${workerCount} workers`, async () => {
            const h = await harness();
            const workers = Array.from({ length: workerCount }, (_value, index) =>
                h.makeWorker(`diamond-concurrent-${workerCount}-${index}`)
            );
            const results = await Promise.all(workers.map((worker) => worker.processTransaction({
                provider: "xsolla",
                providerTransactionId: h.receipt.transactionId
            })));
            assert.equal(results.filter((result) => result.status === "completed").length, 1);
            assert.ok(results.every((result) =>
                ["completed", "busy", "already_completed"].includes(result.status)
            ));
            assertExactlyFiveHundredOnce(h.provider);
            assert.equal(h.entitlements.writes(), 1);
            assertCompletedWithProof(await storedTransaction(h));
        });
    }
});
