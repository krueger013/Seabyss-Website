import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryPaymentLedgerStore } from "../src/payment-ledger-memory-store.js";
import { createPaymentLedger } from "../src/payment-ledger.js";
import { PaymentWorkerCrash } from "../src/payment-worker.js";
import { createXsollaLedgeredReceiptProcessor } from "../src/xsolla-ledgered-receipt-processor.js";
import { getXsollaStarterReceiptV2Key } from "../src/playfab-xsolla-starter-receipt-v2-store.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";
import { createInitialFinancialAuthority } from "../src/financial-authority-v2.js";
import { createPlayFabFinancialAuthorityGrantAdapter } from "../src/playfab-financial-authority-grant-adapter.js";
import { createXsollaFinancialAuthorityWorker } from "../src/xsolla-financial-authority-worker.js";

const playFabId = "46789223F9CB1BB9";

function receipt() {
    const plan = getStarterRewardPlan("seabyss_starter_pack_1");
    return {
        schemaVersion: 2,
        playFabId,
        transactionId: "706956443",
        provider: "xsolla",
        providerTransactionId: "706956443",
        userId: playFabId,
        createdAtUtc: "2026-08-22T20:00:00.000Z",
        environment: "sandbox",
        notificationType: "payment",
        orderId: "706956443",
        productId: "starter_pack_1",
        xsollaSku: "seabyss_starter_pack_1",
        productType: "starter_pack",
        source: "xsolla_sandbox",
        productPlanVersion: 1,
        rewardPlanVersion: plan.planVersion,
        rewardPlanHash: plan.rewardPlanHash,
        rewards: plan.rewards,
        currency: "USD",
        unitAmountMinor: 399,
        quantity: 1,
        totalAmountMinor: 399,
        promotionPolicy: "disabled"
    };
}

function economyAdapter() {
    const effects = new Map();
    const calls = [];
    async function execute(input, status) {
        calls.push(structuredClone(input));
        if (!effects.has(input.operationId)) {
            effects.set(input.operationId, {
                idempotencyId: input.operationId,
                transactionIds: ["economy-transaction-once"],
                etag: "etag-once",
                rewards: structuredClone(input.rewards)
            });
        }
        return { status, operationId: input.operationId, ...structuredClone(effects.get(input.operationId)) };
    }
    return {
        grant: (input) => execute(input, "confirmed"),
        verify: (input) => execute(input, "verified"),
        health: () => ({ healthy: true, configured: true }),
        probe: async () => ({ ok: true }),
        effects,
        calls
    };
}

function authorityStore({ migrated = true } = {}) {
    let objectVersion = migrated ? 1 : 0;
    let value = migrated ? createInitialFinancialAuthority({
        playFabId,
        migratedAtUtc: "2026-08-22T00:00:00.000Z",
        sourceDigests: { profileV1: "a".repeat(64), financialV1: "b".repeat(64), legacyDm: "c".repeat(64) }
    }) : null;
    let writes = 0;
    return {
        async read() {
            return { migrated, objectVersion, financialRevision: value?.financialRevision ?? 0,
                authority: value ? structuredClone(value) : null };
        },
        async compareAndSet({ expectedObjectVersion, expectedFinancialRevision, authority, operationId, fencingToken }) {
            if (value.appliedOperations.includes(operationId)) {
                return { applied: false, reason: "already_applied", migrated: true, objectVersion,
                    financialRevision: value.financialRevision, authority: structuredClone(value) };
            }
            if (fencingToken <= value.lastFencingToken) {
                return { applied: false, reason: "stale_fencing", migrated: true, objectVersion,
                    financialRevision: value.financialRevision, authority: structuredClone(value) };
            }
            if (expectedObjectVersion !== objectVersion || expectedFinancialRevision !== value.financialRevision) {
                return { applied: false, reason: "version_conflict", migrated: true, objectVersion,
                    financialRevision: value.financialRevision, authority: structuredClone(value) };
            }
            value = structuredClone(authority);
            objectVersion += 1;
            writes += 1;
            return { applied: true, reason: "applied", migrated: true, objectVersion,
                financialRevision: value.financialRevision, authority: structuredClone(value) };
        },
        probe: async () => true,
        snapshot: () => structuredClone(value),
        writes: () => writes
    };
}

async function harness({ now = 1_800_000_000_000, faultInjector = async () => {}, migrated = true } = {}) {
    let clock = now;
    const ledger = createPaymentLedger({ store: createMemoryPaymentLedgerStore(), nowMilliseconds: () => clock });
    const r = receipt();
    const key = getXsollaStarterReceiptV2Key(r.transactionId);
    const processReceipt = createXsollaLedgeredReceiptProcessor({ ledger,
        persistStarterPackReceiptV2: async () => ({ key, existing: false }),
        persistDiamondPackReceiptV2: async () => { throw new Error("unexpected"); } });
    await processReceipt(r);
    const economy = economyAdapter();
    const authority = authorityStore({ migrated });
    const adapter = createPlayFabFinancialAuthorityGrantAdapter({ economyAdapter: economy,
        authorityStore: authority, loadReceipt: async () => r,
        nowUtc: () => new Date("2026-08-23T00:00:00.000Z") });
    const makeWorker = (workerId, injector = faultInjector) => createXsollaFinancialAuthorityWorker({
        ledger,
        grantAdapter: adapter,
        workerId,
        workerOptions: { nowMilliseconds: () => clock, leaseTtlMilliseconds: 100,
            leaseRenewIntervalMilliseconds: 0, playerLeaseWaitMilliseconds: 0, faultInjector: injector }
    });
    return { ledger, r, economy, authority, makeWorker, advance(amount) { clock += amount; } };
}

test("Starter I completes only after Economy v2, entitlements and final authority checkpoints", async () => {
    const h = await harness();
    const result = await h.makeWorker("financial-v2").processPending();
    assert.equal(result[0].status, "completed");
    const stored = await h.ledger.requireTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId });
    assert.equal(stored.state, "Completed");
    assert.ok(stored.checkpoints.receipt_persisted);
    assert.ok(stored.checkpoints.economy_v2_granted);
    assert.ok(stored.checkpoints.entitlements_granted);
    assert.ok(stored.checkpoints.profile_granted);
    assert.equal(h.economy.effects.size, 1);
    assert.deepEqual([...h.economy.effects.values()][0].rewards, [
        { rewardId: "diamonds", quantity: 1000 },
        { rewardId: "elite_ball", quantity: 13000 },
        { rewardId: "thors_wrath", quantity: 5 },
        { rewardId: "green_amulet", quantity: 10 },
        { rewardId: "diamond_offensive_powder", quantity: 100 },
        { rewardId: "diamond_armor_plate", quantity: 100 },
        { rewardId: "carronade", quantity: 2 },
        { rewardId: "harpoon_diamond_250", quantity: 100 },
        { rewardId: "star_dust", quantity: 12 }
    ]);
    assert.equal(h.authority.snapshot().premium.tier, 1);
    assert.deepEqual(h.authority.snapshot().paidDestinationMarkerIds, ["destination_red_point"]);
    assert.deepEqual(h.authority.snapshot().ownedStarterSkus, ["seabyss_starter_pack_1"]);
});

test("crash after Economy v2 success replays the same idempotency key without a second provider effect", async () => {
    let crash = true;
    const h = await harness({ faultInjector: async (stage, context) => {
        if (stage === "after_effect_before_checkpoint" && context.step === "economy_v2_granted" && crash) {
            crash = false;
            throw new PaymentWorkerCrash(stage);
        }
    } });
    await assert.rejects(h.makeWorker("crash").processTransaction({ provider: "xsolla",
        providerTransactionId: h.r.transactionId }), PaymentWorkerCrash);
    assert.equal(h.economy.effects.size, 1);
    h.advance(101);
    const recovered = await h.makeWorker("recover", async () => {}).processTransaction({ provider: "xsolla",
        providerTransactionId: h.r.transactionId });
    assert.equal(recovered.status, "completed");
    assert.equal(h.economy.effects.size, 1);
    assert.equal(h.authority.writes(), 1);
});

test("ten workers have one winner, one quantitative effect and one entitlement CAS", async () => {
    const h = await harness();
    const workers = Array.from({ length: 10 }, (_, index) => h.makeWorker(`financial-${index}`));
    const results = await Promise.all(workers.map((worker) => worker.processTransaction({ provider: "xsolla",
        providerTransactionId: h.r.transactionId })));
    assert.equal(results.filter((result) => result.status === "completed").length, 1);
    assert.ok(results.every((result) => ["completed", "busy", "already_completed"].includes(result.status)));
    assert.equal(h.economy.effects.size, 1);
    assert.equal(h.authority.writes(), 1);
});

test("unmigrated players fail closed and can never become Completed", async () => {
    const h = await harness({ migrated: false });
    const error = await h.makeWorker("unmigrated").processTransaction({ provider: "xsolla",
        providerTransactionId: h.r.transactionId }).catch((value) => value);
    assert.equal(error.code, "FINANCIAL_AUTHORITY_NOT_MIGRATED");
    const stored = await h.ledger.requireTransaction({ provider: "xsolla", providerTransactionId: h.r.transactionId });
    assert.equal(stored.state, "Failed");
    assert.equal(h.economy.calls.length, 0);
    assert.equal(h.economy.effects.size, 0);
    assert.equal(stored.checkpoints.profile_granted, undefined);
});
