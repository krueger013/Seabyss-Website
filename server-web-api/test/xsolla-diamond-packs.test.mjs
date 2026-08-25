import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { XsollaInvalidUserError } from "../src/xsolla-webhook.js";
import {
    XSOLLA_DIAMOND_CURRENCY_SKU,
    XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID,
    resolveXsollaDiamondPack
} from "../src/xsolla-diamond-packs.js";
import { createXsollaPremiumEventProcessor } from "../src/xsolla-premium-processor.js";

const playFabId = "4DF88C225D91FE06";
const packs = Object.freeze([
    ["seabyss_diamond_pack_1", "diamond_pack_1"],
    ["seabyss_diamond_pack_2", "diamond_pack_2"],
    ["seabyss_diamond_pack_3", "diamond_pack_3"]
]);

function legacyPayment({
    sku = packs[0][0],
    transactionId = "2116000001",
    userId = playFabId,
    dryRun,
    lineitems
} = {}) {
    const transaction = { id: transactionId };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    return {
        notification_type: "payment",
        user: { id: userId },
        transaction,
        purchase: {
            order: {
                id: 501,
                lineitems: lineitems || [{
                    sku,
                    quantity: 999999,
                    price: { currency: "USD", amount: 1.99 }
                }]
            }
        }
    };
}

function combinedOrder({
    sku = packs[1][0],
    transactionId = "2116000002",
    userId = playFabId,
    mode = "default",
    items,
    billingDryRun
} = {}) {
    const transaction = { id: transactionId };
    if (billingDryRun !== undefined) {
        transaction.dry_run = billingDryRun;
    }
    return {
        notification_type: "order_paid",
        user: { external_id: userId },
        order: { id: 502, mode },
        billing: {
            settings: { project_id: 310966 },
            transaction
        },
        items: items || [
            { sku, type: "bundle", quantity: 999999 },
            {
                sku: XSOLLA_DIAMOND_CURRENCY_SKU,
                type: "virtual_currency",
                quantity: 1
            }
        ]
    };
}

function premiumPayment() {
    return {
        notification_type: "payment",
        user: { id: playFabId },
        transaction: {
            id: "2116000003",
            payment_date: "2026-08-10T12:00:00Z"
        },
        purchase: {
            subscription: {
                plan_id: "321178",
                external_id: "NZSorpSt",
                date_next_charge: "2026-09-10T12:00:00Z"
            }
        }
    };
}

function createHarness(options = {}) {
    const diamonds = [];
    const premium = [];
    const validated = [];
    const processor = createXsollaPremiumEventProcessor({
        premiumPlanId: "321178",
        premiumPlanExternalId: "NZSorpSt",
        allowSandboxGrants: options.allowSandboxGrants === true,
        sandboxTestPlayFabIds: options.sandboxTestPlayFabIds || [],
        async validateUser(value) {
            validated.push(value);
            if (options.validationError) {
                throw options.validationError;
            }
            return options.userExists ?? true;
        },
        async persistDiamondPackReceipt(receipt) {
            diamonds.push(receipt);
        },
        async persistPremiumEntitlement(receipt) {
            premium.push(receipt);
        }
    });
    return { processor, diamonds, premium, validated };
}

async function process(harness, payload) {
    return harness.processor({
        payload,
        notificationType: payload.notification_type,
        userId: payload.notification_type === "order_paid"
            ? payload.user?.external_id
            : payload.user?.id
    });
}

describe("Xsolla Diamond Pack processor", () => {
    test("uses the exact three-SKU mapping and never display names", () => {
        assert.deepEqual({ ...XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID }, {
            seabyss_diamond_pack_1: "diamond_pack_1",
            seabyss_diamond_pack_2: "diamond_pack_2",
            seabyss_diamond_pack_3: "diamond_pack_3"
        });
        assert.equal(Object.isFrozen(XSOLLA_DIAMOND_PACK_SKU_TO_PRODUCT_ID), true);
        assert.equal(resolveXsollaDiamondPack(legacyPayment({
            sku: "Diamond Pack I"
        }), "payment"), null);
    });

    test("maps each legacy payment SKU to its stable Unity product ID", async () => {
        for (let index = 0; index < packs.length; index += 1) {
            const [xsollaSku, productId] = packs[index];
            const harness = createHarness();
            const transactionId = String(2116000100 + index);
            const payload = legacyPayment({ xsollaSku, sku: xsollaSku, transactionId });

            assert.equal(await process(harness, payload), "diamond_pack_granted");
            assert.deepEqual(harness.validated, [playFabId]);
            assert.deepEqual(harness.diamonds, [{
                playFabId,
                transactionId,
                productId,
                xsollaSku,
                productType: "diamond_pack",
                source: "xsolla_production"
            }]);
            assert.equal(Object.hasOwn(harness.diamonds[0], "quantity"), false);
            assert.deepEqual(harness.premium, []);
        }
    });

    test("rejects unknown, padded, multiple, and mixed legacy line-item SKUs", async () => {
        const payloads = [
            legacyPayment({ sku: "wrong_sku" }),
            legacyPayment({ sku: "constructor" }),
            legacyPayment({ sku: "toString" }),
            legacyPayment({ sku: " seabyss_diamond_pack_1" }),
            legacyPayment({ lineitems: [
                { sku: packs[0][0], quantity: 1 },
                { sku: packs[1][0], quantity: 1 }
            ] }),
            legacyPayment({ lineitems: [
                { sku: packs[0][0], quantity: 1 },
                { sku: "unrelated_item", quantity: 1 }
            ] })
        ];
        for (const payload of payloads) {
            const harness = createHarness();
            assert.equal(await process(harness, payload), "ignored_unrecognized_product");
            assert.deepEqual(harness.validated, []);
            assert.deepEqual(harness.diamonds, []);
        }
    });

    test("accepts official combined order items but rejects ambiguity and foreign content", async () => {
        const accepted = createHarness();
        const payload = combinedOrder();
        assert.equal(await process(accepted, payload), "diamond_pack_granted");
        assert.deepEqual(accepted.diamonds, [{
            playFabId,
            transactionId: "2116000002",
            productId: "diamond_pack_2",
            xsollaSku: "seabyss_diamond_pack_2",
            productType: "diamond_pack",
            source: "xsolla_production"
        }]);
        assert.equal(Object.hasOwn(accepted.diamonds[0], "quantity"), false);

        const rejectedItems = [
            [{ sku: "wrong_sku", type: "bundle" }],
            [
                { sku: packs[0][0], type: "bundle" },
                { sku: packs[2][0], type: "bundle" }
            ],
            [
                { sku: packs[0][0], type: "bundle" },
                { sku: "other_currency", type: "virtual_currency" }
            ],
            [{ sku: packs[0][0], type: "virtual_currency" }]
        ];
        for (const items of rejectedItems) {
            const harness = createHarness();
            assert.equal(
                await process(harness, combinedOrder({ items })),
                "ignored_unrecognized_product"
            );
            assert.deepEqual(harness.validated, []);
            assert.deepEqual(harness.diamonds, []);
        }
    });

    test("allows sandbox receipts only for an explicitly allowlisted Master PlayFabId", async () => {
        for (const payload of [
            legacyPayment({ dryRun: 1, transactionId: "2116000201" }),
            combinedOrder({
                mode: "sandbox",
                billingDryRun: 1,
                transactionId: "2116000202"
            })
        ]) {
            const accepted = createHarness({
                allowSandboxGrants: true,
                sandboxTestPlayFabIds: [playFabId]
            });
            assert.equal(
                await process(accepted, payload),
                "diamond_pack_sandbox_granted"
            );
            assert.equal(accepted.diamonds[0].source, "xsolla_sandbox");

            const denied = createHarness({
                allowSandboxGrants: true,
                sandboxTestPlayFabIds: ["OTHER_PLAYER"]
            });
            assert.equal(await process(denied, payload), "ignored_dry_run");
            assert.deepEqual(denied.validated, []);
            assert.deepEqual(denied.diamonds, []);
        }
    });

    test("rejects malformed modes, transactions, and users before persistence", async () => {
        const badModes = [
            legacyPayment({ dryRun: 0 }),
            legacyPayment({ dryRun: "1" }),
            combinedOrder({ mode: "preview" }),
            combinedOrder({ mode: "sandbox" }),
            combinedOrder({ mode: "default", billingDryRun: 1 })
        ];
        for (const payload of badModes) {
            const harness = createHarness({
                allowSandboxGrants: true,
                sandboxTestPlayFabIds: [playFabId]
            });
            assert.equal(await process(harness, payload), "ignored_dry_run");
            assert.deepEqual(harness.diamonds, []);
        }

        for (const transactionId of ["0", "001", " 1", "9223372036854775808"]) {
            const harness = createHarness();
            await assert.rejects(process(harness, legacyPayment({ transactionId })));
            assert.deepEqual(harness.diamonds, []);
        }

        const invalid = createHarness({ userExists: false });
        await assert.rejects(process(invalid, legacyPayment()), XsollaInvalidUserError);
        assert.deepEqual(invalid.diamonds, []);
    });

    test("keeps the existing Premium payment contract unchanged", async () => {
        const harness = createHarness();
        assert.equal(await process(harness, premiumPayment()), "premium_granted");
        assert.deepEqual(harness.diamonds, []);
        assert.deepEqual(harness.premium, [{
            playFabId,
            transactionId: "2116000003",
            activatedAtUtcIso8601: "2026-08-10T12:00:00.000Z",
            expiresAtUtcIso8601: "2026-09-10T12:00:00.000Z"
        }]);
    });

    test("leaves unrelated order_paid lifecycle payloads as no-ops", async () => {
        const harness = createHarness();
        const payload = premiumPayment();
        payload.notification_type = "order_paid";
        assert.equal(await process(harness, payload), "validated_no_grant");
        assert.deepEqual(harness.diamonds, []);
        assert.deepEqual(harness.premium, []);
    });
});
