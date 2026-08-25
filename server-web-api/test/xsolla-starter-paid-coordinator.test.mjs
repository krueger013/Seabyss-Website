import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createPlayFabXsollaReconciliationCaseStore,
    getXsollaReconciliationCaseKey,
    serializeXsollaReconciliationCase
} from "../src/playfab-xsolla-reconciliation-case-store.js";
import { createXsollaStarterPaidCoordinator } from "../src/xsolla-starter-paid-coordinator.js";
import {
    createMemoryXsollaStarterReservationStore
} from "../src/xsolla-starter-reservation-store.js";

const playFabId = "4DF88C225D91FE06";
const product = Object.freeze({
    productId: "starter_pack_1",
    xsollaSku: "seabyss_starter_pack_1",
    productType: "starter_pack"
});
const economicContract = Object.freeze({
    productPlanVersion: 1,
    notificationType: "order_paid",
    orderId: "700001",
    currency: "USD",
    unitAmountMinor: 399,
    quantity: 1,
    totalAmountMinor: 399,
    promotionPolicy: "disabled"
});

function paidInput(overrides = {}) {
    return {
        payload: {
            order: {
                custom_parameters: { seabyss_reservation_id: "reservation-1" }
            }
        },
        playFabId,
        transactionId: "800001",
        product,
        source: "xsolla_sandbox",
        economicContract,
        ...overrides
    };
}

function response(payload) {
    return { ok: true, async json() { return payload; } };
}

describe("Starter paid coordinator and reconciliation cases", () => {
    test("settles a matching reservation exactly once and replays safely", async () => {
        const reservationStore = createMemoryXsollaStarterReservationStore();
        await reservationStore.reserve({
            playFabId,
            xsollaSku: product.xsollaSku,
            reservationId: "reservation-1"
        });
        let cases = 0;
        const coordinator = createXsollaStarterPaidCoordinator({
            reservationStore,
            async persistReconciliationCase() { cases += 1; }
        });
        assert.deepEqual(await coordinator.settlePaid(paidInput()), {
            status: "accepted",
            reservationId: "reservation-1"
        });
        assert.deepEqual(await coordinator.settlePaid(paidInput()), {
            status: "replayed",
            reservationId: "reservation-1"
        });
        assert.equal(cases, 0);
    });

    test("routes a duplicate paid Starter into a durable reconciliation dossier", async () => {
        const reservationStore = createMemoryXsollaStarterReservationStore();
        await reservationStore.reserve({
            playFabId,
            xsollaSku: product.xsollaSku,
            reservationId: "reservation-1"
        });
        const persisted = [];
        const coordinator = createXsollaStarterPaidCoordinator({
            reservationStore,
            async persistReconciliationCase(record) {
                persisted.push(record);
                return { key: getXsollaReconciliationCaseKey(record.transactionId) };
            }
        });
        assert.equal((await coordinator.settlePaid(paidInput())).status, "accepted");
        const duplicate = await coordinator.settlePaid(paidInput({ transactionId: "800002" }));
        assert.equal(duplicate.status, "manual_reconciliation");
        assert.equal(duplicate.reason, "duplicate_paid");
        assert.match(duplicate.caseKey, /^xsr1_/);
        assert.equal(persisted.length, 1);
        assert.deepEqual(persisted[0], {
            playFabId,
            transactionId: "800002",
            orderId: "700001",
            productId: "starter_pack_1",
            xsollaSku: "seabyss_starter_pack_1",
            source: "xsolla_sandbox",
            reason: "duplicate_paid",
            reservationId: "reservation-1",
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        });
    });

    test("routes missing and conflicting reservations into reconciliation", async () => {
        const cases = [];
        const missingCoordinator = createXsollaStarterPaidCoordinator({
            reservationStore: createMemoryXsollaStarterReservationStore(),
            async persistReconciliationCase(record) {
                cases.push(record);
                return { key: "case-missing" };
            }
        });
        const missing = await missingCoordinator.settlePaid(paidInput({
            payload: {},
            transactionId: "800003"
        }));
        assert.equal(missing.reason, "reservation_missing");

        const reservationStore = createMemoryXsollaStarterReservationStore();
        await reservationStore.reserve({
            playFabId,
            xsollaSku: product.xsollaSku,
            reservationId: "reservation-a"
        });
        const conflictCoordinator = createXsollaStarterPaidCoordinator({
            reservationStore,
            async persistReconciliationCase(record) {
                cases.push(record);
                return { key: "case-conflict" };
            }
        });
        const conflict = await conflictCoordinator.settlePaid(paidInput({
            payload: {
                custom_parameters: { seabyss_reservation_id: "reservation-b" }
            },
            transactionId: "800004"
        }));
        assert.equal(conflict.reason, "pending_conflict");
        assert.deepEqual(cases.map((record) => record.reason), [
            "reservation_missing",
            "pending_conflict"
        ]);
    });

    test("rejects ambiguous or malformed reservation identity", async () => {
        const coordinator = createXsollaStarterPaidCoordinator({
            reservationStore: createMemoryXsollaStarterReservationStore(),
            async persistReconciliationCase() { throw new Error("must not persist"); }
        });
        await assert.rejects(coordinator.settlePaid(paidInput({
            payload: {
                custom_parameters: { seabyss_reservation_id: "reservation-a" },
                order: {
                    custom_parameters: { seabyss_reservation_id: "reservation-a" }
                }
            }
        })), /reservation identity is invalid/);
        await assert.rejects(coordinator.settlePaid(paidInput({
            payload: {
                custom_parameters: { seabyss_reservation_id: " bad" }
            }
        })), /reservation identity is invalid/);
    });

    test("serializes an immutable xsr1 case with canonical int64 identities", () => {
        const record = {
            transactionId: "9223372036854775807",
            orderId: null,
            productId: product.productId,
            xsollaSku: product.xsollaSku,
            source: "xsolla_production",
            reason: "duplicate_paid",
            reservationId: null,
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        };
        assert.match(getXsollaReconciliationCaseKey(record.transactionId), /^xsr1_/);
        assert.deepEqual(JSON.parse(serializeXsollaReconciliationCase(record)), {
            schemaVersion: 1,
            status: "open",
            ...record
        });
        for (const change of [
            { transactionId: "001" },
            { orderId: "9223372036854775808" },
            { reason: "refund" },
            { productId: "starter_pack_2" },
            { currency: "EUR" },
            { unitAmountMinor: -1 },
            { quantity: 2 },
            { promotionPolicy: "enabled" }
        ]) {
            assert.throws(() => serializeXsollaReconciliationCase({ ...record, ...change }));
        }
    });

    test("persists reconciliation cases immutably with exact readback", async () => {
        const data = new Map();
        let updates = 0;
        const fetchImpl = async (url, options) => {
            const body = JSON.parse(options.body);
            if (url.endsWith("/Server/UpdateUserInternalData")) {
                updates += 1;
                for (const [key, value] of Object.entries(body.Data)) data.set(key, value);
                return response({ code: 200, data: { DataVersion: updates } });
            }
            const selected = {};
            for (const key of body.Keys) {
                if (data.has(key)) selected[key] = { Value: data.get(key) };
            }
            return response({ code: 200, data: { Data: selected } });
        };
        const persist = createPlayFabXsollaReconciliationCaseStore({
            titleId: "local-title",
            secretKey: "local-secret",
            fetchImpl
        });
        const record = {
            playFabId,
            transactionId: "800005",
            orderId: "700005",
            productId: product.productId,
            xsollaSku: product.xsollaSku,
            source: "xsolla_sandbox",
            reason: "reservation_missing",
            reservationId: null,
            productPlanVersion: 1,
            currency: "USD",
            unitAmountMinor: 399,
            quantity: 1,
            totalAmountMinor: 399,
            promotionPolicy: "disabled"
        };
        assert.equal((await persist(record)).existing, false);
        assert.equal((await persist(record)).existing, true);
        assert.equal(updates, 1);
        await assert.rejects(
            persist({ ...record, reason: "duplicate_paid" }),
            /Immutable Xsolla reconciliation case conflict/
        );
        assert.equal(updates, 1);
    });
});
