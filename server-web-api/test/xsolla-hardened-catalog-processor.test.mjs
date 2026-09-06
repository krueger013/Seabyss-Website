import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createXsollaHardenedCatalogEventProcessor
} from "../src/xsolla-hardened-catalog-processor.js";
import { createXsollaStarterPaidCoordinator } from "../src/xsolla-starter-paid-coordinator.js";
import {
    createMemoryXsollaStarterReservationStore
} from "../src/xsolla-starter-reservation-store.js";
import { getStarterRewardPlan } from "../src/xsolla-starter-reward-plan-registry.js";

const playFabId = "4DF88C225D91FE06";
const starterSku = "seabyss_starter_pack_1";

function starterOrderPaid({
    transactionId = "800001",
    orderId = "700001",
    reservationId = "reservation-1",
    amount = "3.99",
    currency = "USD"
} = {}) {
    return {
        notification_type: "order_paid",
        order: {
            id: orderId,
            status: "paid",
            currency_type: "real",
            mode: "sandbox",
            amount,
            currency,
            custom_parameters: {
                seabyss_reservation_id: reservationId
            }
        },
        billing: {
            notification_type: "payment",
            transaction: { id: transactionId, dry_run: 1, payment_date: "2026-08-22T00:00:00.000Z" }
        },
        items: [{
            sku: starterSku,
            type: "virtual_good",
            is_pre_order: false,
            quantity: 1,
            price: { amount, currency }
        }]
    };
}

function diamondOrderPaid() {
    return {
        notification_type: "order_paid",
        order: {
            id: "700010",
            status: "paid",
            currency_type: "real",
            mode: "default",
            amount: "3.99",
            currency: "USD"
        },
        billing: {
            notification_type: "payment",
            transaction: { id: "800010", payment_date: "2026-08-22T00:00:00.000Z" }
        },
        items: [
            {
                sku: "seabyss_diamond_pack_2",
                type: "bundle",
                quantity: 1,
                price: { amount: "3.99", currency: "USD" }
            },
            {
                sku: "seabyss_diamonds",
                type: "virtual_currency",
                quantity: 1200
            }
        ]
    };
}

function starterEvent(payload = starterOrderPaid()) {
    return { payload, notificationType: "order_paid", userId: playFabId };
}

describe("hardened Xsolla catalog event processor", () => {
    test("keeps every grant gate false by default", async () => {
        let calls = 0;
        const process = createXsollaHardenedCatalogEventProcessor({
            async validateUser() { calls += 1; return true; },
            async persistStarterPackReceiptV2() { calls += 1; }
        });
        assert.equal(await process(starterEvent()), "ignored_dry_run");
        assert.equal(calls, 0);
    });

    test("validates, settles, snapshots and persists one allowed Starter payment", async () => {
        const reservationStore = createMemoryXsollaStarterReservationStore();
        await reservationStore.reserve({
            playFabId,
            xsollaSku: starterSku,
            reservationId: "reservation-1"
        });
        const reconciliation = [];
        const coordinator = createXsollaStarterPaidCoordinator({
            reservationStore,
            async persistReconciliationCase(record) {
                reconciliation.push(record);
                return { key: "xsr1_local" };
            }
        });
        const receipts = [];
        let userChecks = 0;
        const process = createXsollaHardenedCatalogEventProcessor({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId],
            async validateUser(candidate) {
                userChecks += 1;
                assert.equal(candidate, playFabId);
                return true;
            },
            starterPaidCoordinator: coordinator,
            async persistStarterPackReceiptV2(receipt) { receipts.push(receipt); }
        });

        assert.equal(await process(starterEvent()), "starter_pack_sandbox_granted");
        assert.equal(userChecks, 1);
        assert.equal(reconciliation.length, 0);
        assert.equal(receipts.length, 1);
        const receipt = receipts[0];
        const rewardPlan = getStarterRewardPlan(starterSku);
        assert.deepEqual({
            playFabId: receipt.playFabId,
            transactionId: receipt.transactionId,
            provider: receipt.provider,
            providerTransactionId: receipt.providerTransactionId,
            userId: receipt.userId,
            createdAtUtc: receipt.createdAtUtc,
            environment: receipt.environment,
            orderId: receipt.orderId,
            productId: receipt.productId,
            xsollaSku: receipt.xsollaSku,
            productType: receipt.productType,
            source: receipt.source,
            productPlanVersion: receipt.productPlanVersion,
            currency: receipt.currency,
            unitAmountMinor: receipt.unitAmountMinor,
            quantity: receipt.quantity,
            totalAmountMinor: receipt.totalAmountMinor,
            promotionPolicy: receipt.promotionPolicy,
            rewardPlanVersion: receipt.rewardPlanVersion,
            rewardPlanHash: receipt.rewardPlanHash
        }, {
            playFabId,
            transactionId: "800001",
            orderId: "700001",
            provider: "xsolla",
            providerTransactionId: "800001",
            userId: playFabId,
            createdAtUtc: "2026-08-22T00:00:00.000Z",
            environment: "sandbox",
            productId: "starter_pack_1",
            xsollaSku: starterSku,
            productType: "starter_pack",
            source: "xsolla_sandbox",
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled",
            rewardPlanVersion: 1,
            rewardPlanHash: rewardPlan.rewardPlanHash
        });
        assert.deepEqual(receipt.rewards, rewardPlan.rewards);
    });

    test("rejects bad economics before user validation, settlement or persistence", async () => {
        let calls = 0;
        const quarantined = [];
        const process = createXsollaHardenedCatalogEventProcessor({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId],
            async validateUser() { calls += 1; return true; },
            starterPaidCoordinator: {
                async settlePaid() { calls += 1; return { status: "accepted" }; }
            },
            async persistStarterPackReceiptV2() { calls += 1; },
            async recordFinancialException(record) { quarantined.push(record); }
        });
        for (const payload of [
            starterOrderPaid({ amount: "-1" }),
            starterOrderPaid({ amount: "0" }),
            starterOrderPaid({ amount: "999999999999999999999.99" }),
            starterOrderPaid({ currency: "EUR" }),
            {
                ...starterOrderPaid(),
                items: [{
                    ...starterOrderPaid().items[0],
                    price: { amount: "3.98", currency: "USD" }
                }]
            }
        ]) {
            await assert.rejects(process(starterEvent(payload)));
        }
        assert.equal(calls, 5);
        assert.equal(quarantined.length, 5);
        assert.ok(quarantined.every((record) =>
            record.state === "Quarantined" &&
            record.reason === "economic_mismatch" &&
            record.transactionId === "800001"
        ));
    });

    test("turns a second paid order for an owned Starter into reconciliation without a grant", async () => {
        const reservationStore = createMemoryXsollaStarterReservationStore();
        await reservationStore.reserve({
            playFabId,
            xsollaSku: starterSku,
            reservationId: "reservation-1"
        });
        const cases = [];
        const coordinator = createXsollaStarterPaidCoordinator({
            reservationStore,
            async persistReconciliationCase(record) {
                cases.push(record);
                return { key: "xsr1_duplicate" };
            }
        });
        const receipts = [];
        const exceptions = [];
        const process = createXsollaHardenedCatalogEventProcessor({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId],
            async validateUser() { return true; },
            starterPaidCoordinator: coordinator,
            async persistStarterPackReceiptV2(receipt) { receipts.push(receipt); },
            async recordFinancialException(record) { exceptions.push(record); }
        });
        assert.equal(await process(starterEvent()), "starter_pack_sandbox_granted");
        assert.equal(await process(starterEvent(starterOrderPaid({
            transactionId: "800002",
            orderId: "700002"
        }))), "starter_pack_manual_reconciliation_required");
        assert.equal(receipts.length, 1);
        assert.equal(cases.length, 1);
        assert.equal(cases[0].reason, "duplicate_paid");
        assert.equal(cases[0].transactionId, "800002");
        assert.equal(exceptions.length, 1);
        assert.equal(exceptions[0].state, "DuplicatePaid");
        assert.equal(exceptions[0].reason, "duplicate_paid");
        assert.equal(exceptions[0].reconciliationCaseKey, "xsr1_duplicate");
        assert.equal(exceptions[0].transactionId, "800002");
    });

    test("persists exact repeatable Diamond economic contract in production", async () => {
        const receipts = [];
        const process = createXsollaHardenedCatalogEventProcessor({
            allowDiamondProductionGrants: true,
            async validateUser() { return true; },
            async persistDiamondPackReceiptV2(receipt) { receipts.push(receipt); }
        });
        assert.equal(await process({
            payload: diamondOrderPaid(),
            notificationType: "order_paid",
            userId: playFabId
        }), "diamond_pack_granted");
        assert.deepEqual(receipts, [{
            playFabId,
            transactionId: "800010",
            productId: "diamond_pack_2",
            provider: "xsolla",
            providerTransactionId: "800010",
            userId: playFabId,
            createdAtUtc: "2026-08-22T00:00:00.000Z",
            environment: "production",
            xsollaSku: "seabyss_diamond_pack_2",
            productType: "diamond_pack",
            source: "xsolla_production",
            productPlanVersion: 2,
            notificationType: "order_paid",
            orderId: "700010",
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        }]);
    });

    test("delegates non-catalog events to the compatibility processor", async () => {
        const seen = [];
        const process = createXsollaHardenedCatalogEventProcessor({
            async fallbackProcessor(event) {
                seen.push(event);
                return "legacy-result";
            }
        });
        const event = { payload: {}, notificationType: "refund", userId: playFabId };
        assert.equal(await process(event), "legacy-result");
        assert.deepEqual(seen, [event]);
    });
});
