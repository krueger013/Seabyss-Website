import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { XsollaInvalidUserError, parseXsollaPayload } from "../src/xsolla-webhook.js";
import { createPlayFabPremiumEntitlementStore } from "../src/playfab-premium-entitlement-store.js";
import {
    addOneUtcCalendarMonth,
    createXsollaPremiumEventProcessor,
    isSeabyssPremiumPlan,
    resolveXsollaPremiumPeriod
} from "../src/xsolla-premium-processor.js";

const premiumPlanId = "321178";
const premiumPlanExternalId = "NZSorpSt";
const masterPlayFabId = "4DF88C225D91FE06";

function paymentPayload({
    transactionId = 4300000000,
    planId = premiumPlanId,
    externalId = premiumPlanExternalId,
    paymentDate = "2026-08-09T12:00:00Z",
    nextChargeDate = "2026-09-09T12:00:00Z",
    transactionExtra = {},
    subscriptionExtra = {}
} = {}) {
    const subscription = {
        plan_id: planId,
        date_next_charge: nextChargeDate,
        ...subscriptionExtra
    };
    if (externalId !== undefined) {
        subscription.external_id = externalId;
    }
    const transaction = {
        id: transactionId,
        payment_date: paymentDate,
        ...transactionExtra
    };
    return {
        notification_type: "payment",
        user: { id: masterPlayFabId },
        transaction,
        purchase: { subscription }
    };
}

function createHarness(options = {}) {
    const persisted = [];
    const validated = [];
    const processor = createXsollaPremiumEventProcessor({
        premiumPlanId: options.premiumPlanId ?? premiumPlanId,
        premiumPlanExternalId: options.premiumPlanExternalId ?? premiumPlanExternalId,
        allowSandboxGrants: options.allowSandboxGrants ?? false,
        sandboxTestPlayFabIds: options.sandboxTestPlayFabIds ?? [],
        async validateUser(userId) {
            validated.push(userId);
            if (options.validationError) {
                throw options.validationError;
            }
            return options.userExists ?? true;
        },
        async persistPremiumEntitlement(record) {
            persisted.push(record);
        },
        now: options.now || (() => new Date("2026-08-09T12:30:00.000Z"))
    });
    return { processor, persisted, validated };
}

async function processPayment(harness, payload = paymentPayload()) {
    return harness.processor({
        payload,
        notificationType: payload.notification_type,
        userId: payload.user.id
    });
}

describe("Xsolla Premium event processor", () => {
    test("grants only a live payment for the exact configured plan after Master PlayFabId validation", async () => {
        const harness = createHarness();
        assert.equal(await processPayment(harness), "premium_granted");
        assert.deepEqual(harness.validated, [masterPlayFabId]);
        assert.deepEqual(harness.persisted, [{
            playFabId: masterPlayFabId,
            transactionId: "4300000000",
            activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
        }]);
    });

    test("recognizes only the official numeric or external Premium plan identifiers", () => {
        const matches = (payload) => isSeabyssPremiumPlan(
            payload,
            premiumPlanId,
            premiumPlanExternalId
        );

        assert.equal(matches(paymentPayload({
            planId: premiumPlanId,
            externalId: undefined
        })), true);
        assert.equal(matches(paymentPayload({
            planId: 321178,
            externalId: undefined
        })), true);
        assert.equal(matches(paymentPayload({
            planId: premiumPlanExternalId,
            externalId: undefined
        })), true);
        assert.equal(matches(paymentPayload({
            planId: premiumPlanId,
            externalId: premiumPlanExternalId
        })), true);
        assert.equal(matches({
            purchase: {
                subscription: { external_id: premiumPlanExternalId }
            }
        }), true);

        assert.equal(matches(paymentPayload({
            planId: "999999",
            externalId: undefined
        })), false);
        assert.equal(matches(paymentPayload({
            planId: "other-plan",
            externalId: undefined
        })), false);
        assert.equal(matches(paymentPayload({
            planId: premiumPlanId,
            externalId: "other-plan"
        })), false);
        assert.equal(matches({
            purchase: {
                subscription: {
                    external_id: "other-plan"
                }
            }
        }), false);
        assert.equal(matches({
            purchase: {
                subscription: {
                    plan_id: premiumPlanExternalId,
                    external_id: "other-plan"
                }
            }
        }), false);
    });

    test("preserves int64 max exactly through raw parsing, processing, and persistence", async () => {
        const payload = parseXsollaPayload(Buffer.from(
            "{\"notification_type\":\"payment\",\"user\":{\"id\":\"4DF88C225D91FE06\"}," +
            "\"transaction\":{\"id\":9223372036854775807,\"payment_date\":\"2026-08-09T12:00:00Z\"}," +
            "\"purchase\":{\"subscription\":{\"plan_id\":321178,\"external_id\":\"NZSorpSt\"," +
            "\"date_next_charge\":\"2026-09-09T12:00:00Z\"}}}"
        ));
        let updateBody;
        let storedKey;
        let storedValue;
        const persistPremiumEntitlement = createPlayFabPremiumEntitlementStore({
            titleId: "local-title",
            secretKey: "local-secret",
            async fetchImpl(url, options) {
                const body = JSON.parse(options.body);
                if (url.endsWith("/Server/UpdateUserInternalData")) {
                    updateBody = body;
                    storedKey = Object.keys(body.Data)[0];
                    storedValue = body.Data[storedKey];
                    return {
                        ok: true,
                        async json() {
                            return { code: 200, data: { DataVersion: 1 } };
                        }
                    };
                }
                return {
                    ok: true,
                    async json() {
                        return { code: 200, data: { Data: { [storedKey]: { Value: storedValue } } } };
                    }
                };
            }
        });
        const processor = createXsollaPremiumEventProcessor({
            premiumPlanId,
            premiumPlanExternalId,
            validateUser: async () => true,
            persistPremiumEntitlement
        });
        const expectedTransactionId = "9223372036854775807";
        const expectedKey = "xsp1_" + createHash("sha256")
            .update(expectedTransactionId, "utf8")
            .digest("base64url");

        assert.equal(typeof payload.transaction.id, "string");
        assert.equal(await processPayment({ processor }, payload), "premium_granted");
        assert.equal(storedKey, expectedKey);
        assert.deepEqual(updateBody, {
            PlayFabId: masterPlayFabId,
            Data: {
                [expectedKey]: JSON.stringify({
                    schemaVersion: 1,
                    transactionId: expectedTransactionId,
                    activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
                    expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
                })
            }
        });
    });

    test("prefers date_next_charge and otherwise adds one clamped UTC calendar month", async () => {
        assert.deepEqual(resolveXsollaPremiumPeriod(paymentPayload()), {
            activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
        });
        assert.equal(
            addOneUtcCalendarMonth(new Date("2028-01-31T23:45:00.000Z")).toISOString(),
            "2028-02-29T23:45:00.000Z"
        );

        const payload = paymentPayload({
            paymentDate: "2027-01-31T23:45:00Z",
            subscriptionExtra: { date_next_charge: undefined }
        });
        delete payload.purchase.subscription.date_next_charge;
        const harness = createHarness();
        await processPayment(harness, payload);
        assert.equal(harness.persisted[0].expiresAtUtcIso8601, "2027-02-28T23:45:00.000Z");
    });

    test("uses the server clock only for activation when official next charge exists without payment_date", async () => {
        const payload = paymentPayload();
        delete payload.transaction.payment_date;
        const harness = createHarness({ now: () => new Date("2026-08-10T01:02:03.000Z") });
        await processPayment(harness, payload);
        assert.equal(harness.persisted[0].activatedAtUtcIso8601, "2026-08-10T01:02:03.000Z");
        assert.equal(harness.persisted[0].expiresAtUtcIso8601, "2026-09-09T12:00:00.000Z");
    });

    test("two renewal transactions persist two independent periods without shortening an earlier record", async () => {
        const harness = createHarness();
        await processPayment(harness, paymentPayload({
            transactionId: 101,
            nextChargeDate: "2026-10-09T12:00:00Z"
        }));
        await processPayment(harness, paymentPayload({
            transactionId: 102,
            paymentDate: "2026-09-09T12:00:00Z",
            nextChargeDate: "2026-11-09T12:00:00Z"
        }));
        assert.deepEqual(harness.persisted.map((entry) => ({
            transactionId: entry.transactionId,
            expiresAt: entry.expiresAtUtcIso8601
        })), [
            { transactionId: "101", expiresAt: "2026-10-09T12:00:00.000Z" },
            { transactionId: "102", expiresAt: "2026-11-09T12:00:00.000Z" }
        ]);
    });

    test("unknown plan, mismatched secondary plan ID, and dry runs never validate or persist", async () => {
        const payloads = [
            paymentPayload({ planId: "999999" }),
            paymentPayload({ externalId: "other-plan" }),
            paymentPayload({ subscriptionExtra: { plan_external_id: "other-plan" } }),
            paymentPayload({ transactionExtra: { dry_run: 1 } }),
            { ...paymentPayload(), dry_run: 1 }
        ];
        for (const payload of payloads) {
            const harness = createHarness();
            assert.match(await processPayment(harness, payload), /^(ignored_non_premium_plan|ignored_dry_run)$/);
            assert.equal(harness.validated.length, 0);
            assert.equal(harness.persisted.length, 0);
        }
    });

    test("an allowlisted dry_run=1 grants once with sandbox metadata and the official expiration", async () => {
        const harness = createHarness({
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: [masterPlayFabId]
        });
        const result = await processPayment(harness, paymentPayload({
            planId: premiumPlanExternalId,
            externalId: undefined,
            transactionId: "2115295060",
            transactionExtra: { dry_run: 1 }
        }));

        assert.equal(result, "premium_sandbox_granted");
        assert.deepEqual(harness.validated, [masterPlayFabId]);
        assert.deepEqual(harness.persisted, [{
            playFabId: masterPlayFabId,
            transactionId: "2115295060",
            grantSource: "xsolla_sandbox",
            activatedAtUtcIso8601: "2026-08-09T12:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-09T12:00:00.000Z"
        }]);
    });

    test("sandbox grants stay fail-closed for disabled, non-allowlisted, and non-canonical dry-run inputs", async () => {
        const cases = [
            {
                options: { allowSandboxGrants: false, sandboxTestPlayFabIds: [masterPlayFabId] },
                payload: paymentPayload({ transactionExtra: { dry_run: 1 } })
            },
            {
                options: { allowSandboxGrants: true, sandboxTestPlayFabIds: ["OTHERPLAYER"] },
                payload: paymentPayload({ transactionExtra: { dry_run: 1 } })
            },
            {
                options: { allowSandboxGrants: true, sandboxTestPlayFabIds: [masterPlayFabId] },
                payload: paymentPayload({ transactionExtra: { dry_run: "1" } })
            },
            {
                options: { allowSandboxGrants: true, sandboxTestPlayFabIds: [masterPlayFabId] },
                payload: paymentPayload({ transactionExtra: { dry_run: true } })
            },
            {
                options: { allowSandboxGrants: true, sandboxTestPlayFabIds: [masterPlayFabId] },
                payload: { ...paymentPayload(), dry_run: 1 }
            }
        ];
        for (const scenario of cases) {
            const harness = createHarness(scenario.options);
            assert.equal(await processPayment(harness, scenario.payload), "ignored_dry_run");
            assert.deepEqual(harness.validated, []);
            assert.deepEqual(harness.persisted, []);
        }
    });

    test("an allowlisted sandbox payment still rejects the wrong plan and an invalid PlayFab user", async () => {
        const wrongPlan = createHarness({
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: [masterPlayFabId]
        });
        assert.equal(await processPayment(wrongPlan, paymentPayload({
            planId: "999999",
            transactionExtra: { dry_run: 1 }
        })), "ignored_non_premium_plan");
        assert.deepEqual(wrongPlan.validated, []);
        assert.deepEqual(wrongPlan.persisted, []);

        const invalidUser = createHarness({
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: [masterPlayFabId],
            userExists: false
        });
        await assert.rejects(processPayment(invalidUser, paymentPayload({
            transactionExtra: { dry_run: 1 }
        })), XsollaInvalidUserError);
        assert.deepEqual(invalidUser.persisted, []);
    });

    test("an absent optional secondary ID is accepted, but conflicting supplied IDs are rejected", async () => {
        const accepted = createHarness();
        assert.equal(await processPayment(accepted, paymentPayload({ externalId: undefined })), "premium_granted");

        const rejected = createHarness();
        const conflict = paymentPayload({
            externalId: premiumPlanExternalId,
            subscriptionExtra: { plan_external_id: "other-plan" }
        });
        assert.equal(await processPayment(rejected, conflict), "ignored_non_premium_plan");
        assert.equal(rejected.persisted.length, 0);
    });

    test("an invalid player is a typed INVALID_USER failure and upstream validation fails closed", async () => {
        const invalid = createHarness({ userExists: false });
        await assert.rejects(processPayment(invalid), XsollaInvalidUserError);
        assert.equal(invalid.persisted.length, 0);

        const unavailable = createHarness({ validationError: new Error("upstream unavailable") });
        await assert.rejects(processPayment(unavailable));
        assert.equal(unavailable.persisted.length, 0);

        const unexpected = createHarness({ userExists: "yes" });
        await assert.rejects(processPayment(unexpected));
        assert.equal(unexpected.persisted.length, 0);
    });

    test("rejects non-canonical or out-of-range transaction IDs without persistence", async () => {
        for (const transactionId of [0, "0", "001", "+1", "1.0", "1e3", " 1", 9007199254740992, "9223372036854775808"]) {
            const harness = createHarness();
            await assert.rejects(processPayment(harness, paymentPayload({ transactionId })), undefined, String(transactionId));
            assert.equal(harness.persisted.length, 0);
        }
    });

    test("present invalid billing dates and missing fallback dates fail closed", async () => {
        const payloads = [
            paymentPayload({ paymentDate: "not-a-date" }),
            paymentPayload({ nextChargeDate: "not-a-date" }),
            paymentPayload({ paymentDate: "2026-09-10T00:00:00Z", nextChargeDate: "2026-09-09T00:00:00Z" })
        ];
        const missing = paymentPayload();
        delete missing.transaction.payment_date;
        delete missing.purchase.subscription.date_next_charge;
        payloads.push(missing);
        for (const payload of payloads) {
            const harness = createHarness();
            await assert.rejects(processPayment(harness, payload));
            assert.equal(harness.persisted.length, 0);
        }
    });

    test("subscription lifecycle, cancel, refund, and order events never grant Premium", async () => {
        for (const notificationType of [
            "create_subscription",
            "update_subscription",
            "cancel_subscription",
            "refund",
            "order_paid",
            "order_canceled"
        ]) {
            const harness = createHarness();
            const payload = paymentPayload();
            payload.notification_type = notificationType;
            assert.equal(await processPayment(harness, payload), "validated_no_grant");
            assert.equal(harness.validated.length, 0);
            assert.equal(harness.persisted.length, 0);
        }
    });
});
