import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID,
    resolveXsollaStarterPack
} from "../src/xsolla-starter-packs.js";
import { createXsollaPremiumEventProcessor } from "../src/xsolla-premium-processor.js";

const playFabId = "4DF88C225D91FE06";
const packs = Object.freeze([
    ["seabyss_starter_pack_1", "starter_pack_1"],
    ["seabyss_starter_pack_2", "starter_pack_2"],
    ["seabyss_starter_pack_3", "starter_pack_3"]
]);

function payment({
    sku = packs[0][0],
    transactionId = "2117000001",
    quantity = 1,
    includeQuantity = true,
    dryRun,
    lineitems,
    subscription
} = {}) {
    const item = { sku };
    if (includeQuantity) {
        item.quantity = quantity;
    }
    const transaction = { id: transactionId };
    if (dryRun !== undefined) {
        transaction.dry_run = dryRun;
    }
    const purchase = { order: { lineitems: lineitems || [item] } };
    if (subscription !== undefined) {
        purchase.subscription = subscription;
    }
    return { notification_type: "payment", transaction, purchase };
}

function orderPaid({
    sku = packs[0][0],
    transactionId = "2117000002",
    orderId = 700002,
    userId = playFabId,
    mode = "sandbox",
    status = "paid",
    currencyType = "real",
    projectId = 310966,
    billingNotificationType = "payment",
    billingDryRun = 1,
    includeBillingDryRun = true,
    type = "virtual_good",
    includeType = true,
    isPreOrder = false,
    includeIsPreOrder = true,
    quantity = 1,
    includeQuantity = true,
    items
} = {}) {
    const transaction = { id: transactionId };
    if (includeBillingDryRun) {
        transaction.dry_run = billingDryRun;
    }
    const item = { sku };
    if (includeType) {
        item.type = type;
    }
    if (includeIsPreOrder) {
        item.is_pre_order = isPreOrder;
    }
    if (includeQuantity) {
        item.quantity = quantity;
    }
    return {
        notification_type: "order_paid",
        user: { external_id: userId },
        order: { id: orderId, mode, status, currency_type: currencyType },
        billing: {
            notification_type: billingNotificationType,
            settings: { project_id: projectId },
            transaction
        },
        items: items === undefined ? [item] : items
    };
}

function createHarness(options = {}) {
    const starters = [];
    const validated = [];
    const processor = createXsollaPremiumEventProcessor({
        premiumPlanId: "321178",
        premiumPlanExternalId: "NZSorpSt",
        allowSandboxGrants: options.allowSandboxGrants === true,
        sandboxTestPlayFabIds: options.sandboxTestPlayFabIds || [],
        allowStarterSandboxGrants: options.allowStarterSandboxGrants === true,
        starterSandboxTestPlayFabIds: options.starterSandboxTestPlayFabIds || [],
        allowStarterProductionGrants: options.allowStarterProductionGrants === true,
        async validateUser(value) {
            validated.push(value);
            return options.userExists ?? true;
        },
        async persistStarterPackReceipt(receipt) {
            starters.push(receipt);
        },
        async persistDiamondPackReceipt() {
            throw new Error("unexpected Diamond persistence");
        },
        async persistPremiumProductReceipt() {
            throw new Error("unexpected standalone Premium persistence");
        },
        async persistPremiumEntitlement() {
            throw new Error("unexpected legacy Premium persistence");
        }
    });
    return { processor, starters, validated };
}

async function process(harness, payload, notificationType = payload.notification_type) {
    const userId = notificationType === "order_paid"
        ? payload.user?.external_id
        : playFabId;
    return harness.processor({ payload, notificationType, userId });
}

describe("Xsolla Starter Pack payment mapping", () => {
    test("uses only the exact three official SKU-to-product mappings", () => {
        assert.deepEqual({ ...XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID }, {
            seabyss_starter_pack_1: "starter_pack_1",
            seabyss_starter_pack_2: "starter_pack_2",
            seabyss_starter_pack_3: "starter_pack_3"
        });
        assert.equal(Object.isFrozen(XSOLLA_STARTER_PACK_SKU_TO_PRODUCT_ID), true);

        for (const [xsollaSku, productId] of packs) {
            assert.deepEqual(resolveXsollaStarterPack(payment({ sku: xsollaSku }), "payment"), {
                productId,
                xsollaSku,
                productType: "starter_pack"
            });
        }
    });

    test("accepts package quantity only as numeric one when it is present", () => {
        assert.ok(resolveXsollaStarterPack(payment({ quantity: 1 }), "payment"));
        assert.ok(resolveXsollaStarterPack(payment({ includeQuantity: false }), "payment"));
        for (const quantity of [0, 2, -1, "1", null, true, { value: 1 }]) {
            assert.equal(resolveXsollaStarterPack(payment({ quantity }), "payment"), null);
        }
    });

    test("rejects unknown, padded, multiple, mixed, and prototype-inherited SKUs", () => {
        const inherited = Object.create({ sku: packs[0][0] });
        inherited.quantity = 1;
        const invalid = [
            payment({ sku: "wrong_sku" }),
            payment({ sku: "constructor" }),
            payment({ sku: "toString" }),
            payment({ sku: " seabyss_starter_pack_1" }),
            payment({ sku: "seabyss_starter_pack_1 " }),
            payment({ lineitems: [
                { sku: packs[0][0], quantity: 1 },
                { sku: packs[1][0], quantity: 1 }
            ] }),
            payment({ lineitems: [
                { sku: packs[0][0], quantity: 1 },
                { sku: "unrelated_item", quantity: 1 }
            ] }),
            payment({ lineitems: [inherited] })
        ];
        for (const payload of invalid) {
            assert.equal(resolveXsollaStarterPack(payload, "payment"), null);
        }
    });

    test("maps only an exact Catalog virtual_good Starter Pack I order", () => {
        assert.deepEqual(resolveXsollaStarterPack(orderPaid(), "order_paid"), {
            productId: "starter_pack_1",
            xsollaSku: "seabyss_starter_pack_1",
            productType: "starter_pack"
        });
    });

    test("rejects malformed, bundle, mixed, and prototype-inherited Catalog items", () => {
        const inherited = Object.create({ sku: packs[0][0] });
        inherited.type = "virtual_good";
        inherited.is_pre_order = false;
        inherited.quantity = 1;
        const missingStatus = orderPaid();
        delete missingStatus.order.status;
        const missingCurrencyType = orderPaid();
        delete missingCurrencyType.order.currency_type;
        const missingBillingNotification = orderPaid();
        delete missingBillingNotification.billing.notification_type;
        const invalid = [
            orderPaid({ items: [] }),
            orderPaid({ status: "new" }),
            orderPaid({ currencyType: "virtual" }),
            orderPaid({ billingNotificationType: "refund" }),
            missingStatus,
            missingCurrencyType,
            missingBillingNotification,
            orderPaid({ quantity: 0 }),
            orderPaid({ quantity: 2 }),
            orderPaid({ quantity: "1" }),
            orderPaid({ includeQuantity: false }),
            orderPaid({ type: "bundle" }),
            orderPaid({ type: "virtual_currency" }),
            orderPaid({ includeType: false }),
            orderPaid({ isPreOrder: true }),
            orderPaid({ includeIsPreOrder: false }),
            orderPaid({ sku: "wrong_sku" }),
            orderPaid({ sku: "constructor" }),
            orderPaid({ sku: " seabyss_starter_pack_1" }),
            orderPaid({ sku: "seabyss_starter_pack_1 " }),
            orderPaid({ items: [
                {
                    sku: packs[0][0], type: "virtual_good",
                    is_pre_order: false, quantity: 1
                },
                {
                    sku: packs[1][0], type: "virtual_good",
                    is_pre_order: false, quantity: 1
                }
            ] }),
            orderPaid({ items: [
                {
                    sku: packs[0][0], type: "virtual_good",
                    is_pre_order: false, quantity: 1
                },
                {
                    sku: "seabyss_diamond_pack_1", type: "bundle",
                    is_pre_order: false, quantity: 1
                }
            ] }),
            orderPaid({ items: [inherited] }),
            orderPaid({ items: [[{
                sku: packs[0][0],
                type: "virtual_good",
                is_pre_order: false,
                quantity: 1
            }]] })
        ];
        for (const payload of invalid) {
            assert.equal(resolveXsollaStarterPack(payload, "order_paid"), null);
        }
    });
});

describe("Xsolla Starter Pack processor", () => {
    test("keeps production disabled by default and persists only when explicitly enabled", async () => {
        for (let index = 0; index < packs.length; index += 1) {
            const [xsollaSku, productId] = packs[index];
            const transactionId = String(2117000100 + index);
            const disabled = createHarness();
            assert.equal(
                await process(disabled, payment({ xsollaSku, sku: xsollaSku, transactionId })),
                "ignored_unrecognized_product"
            );
            assert.deepEqual(disabled.validated, []);
            assert.deepEqual(disabled.starters, []);

            const harness = createHarness({ allowStarterProductionGrants: true });
            assert.equal(
                await process(harness, payment({ xsollaSku, sku: xsollaSku, transactionId })),
                "starter_pack_granted"
            );
            assert.deepEqual(harness.validated, [playFabId]);
            assert.deepEqual(harness.starters, [{
                playFabId,
                transactionId,
                productId,
                xsollaSku,
                productType: "starter_pack",
                source: "xsolla_production"
            }]);
            assert.equal(Object.hasOwn(harness.starters[0], "quantity"), false);
            assert.equal(Object.hasOwn(harness.starters[0], "rewards"), false);
        }
    });

    test("allows sandbox grants only for the exact allowlisted PlayFabId", async () => {
        const accepted = createHarness({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId]
        });
        assert.equal(
            await process(accepted, payment({ dryRun: 1 })),
            "starter_pack_sandbox_granted"
        );
        assert.equal(accepted.starters[0].source, "xsolla_sandbox");

        const rejected = createHarness({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: ["OTHER_PLAYER"]
        });
        assert.equal(await process(rejected, payment({ dryRun: 1 })), "ignored_dry_run");
        assert.deepEqual(rejected.validated, []);
        assert.deepEqual(rejected.starters, []);

        const globalOnly = createHarness({
            allowSandboxGrants: true,
            sandboxTestPlayFabIds: [playFabId]
        });
        assert.equal(await process(globalOnly, payment({ dryRun: 1 })), "ignored_dry_run");
        assert.deepEqual(globalOnly.validated, []);
        assert.deepEqual(globalOnly.starters, []);
    });

    test("grants Catalog order_paid Sandbox only to its exact dedicated allowlist", async () => {
        const accepted = createHarness({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId]
        });
        assert.equal(
            await process(accepted, orderPaid({ transactionId: "2117000201" })),
            "starter_pack_sandbox_granted"
        );
        assert.deepEqual(accepted.validated, [playFabId]);
        assert.deepEqual(accepted.starters, [{
            playFabId,
            transactionId: "2117000201",
            productId: "starter_pack_1",
            xsollaSku: "seabyss_starter_pack_1",
            productType: "starter_pack",
            source: "xsolla_sandbox"
        }]);

        const denied = createHarness({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId]
        });
        assert.equal(
            await process(denied, orderPaid({
                transactionId: "2117000202",
                userId: "OTHER_PLAYER"
            })),
            "ignored_dry_run"
        );
        assert.deepEqual(denied.validated, []);
        assert.deepEqual(denied.starters, []);
    });

    test("keeps Catalog production Starter disabled and rejects malformed Sandbox modes", async () => {
        const production = createHarness();
        assert.equal(
            await process(production, orderPaid({
                transactionId: "2117000203",
                mode: "default",
                includeBillingDryRun: false
            })),
            "ignored_unrecognized_product"
        );
        assert.deepEqual(production.validated, []);
        assert.deepEqual(production.starters, []);

        for (const payload of [
            orderPaid({ transactionId: "2117000204", mode: "sandbox", includeBillingDryRun: false }),
            orderPaid({ transactionId: "2117000205", mode: "sandbox", billingDryRun: 0 }),
            orderPaid({ transactionId: "2117000206", mode: "sandbox", billingDryRun: "1" }),
            orderPaid({ transactionId: "2117000207", mode: "default", billingDryRun: 1 }),
            orderPaid({ transactionId: "2117000208", mode: "preview", billingDryRun: 1 })
        ]) {
            const harness = createHarness({
                allowStarterSandboxGrants: true,
                starterSandboxTestPlayFabIds: [playFabId]
            });
            assert.equal(await process(harness, payload), "ignored_dry_run");
            assert.deepEqual(harness.validated, []);
            assert.deepEqual(harness.starters, []);
        }
    });

    test("fails closed before validation for invalid products and ambiguity", async () => {
        const invalid = [
            payment({ quantity: "1" }),
            payment({ sku: "wrong_sku" }),
            payment({ lineitems: [
                { sku: packs[0][0], quantity: 1 },
                { sku: "seabyss_diamond_pack_1", quantity: 1 }
            ] }),
            payment({ subscription: {
                plan_id: "321178",
                external_id: "NZSorpSt",
                date_next_charge: "2026-09-18T00:00:00Z"
            } })
        ];
        for (const payload of invalid) {
            const harness = createHarness();
            const result = await process(harness, payload);
            assert.ok(["ignored_unrecognized_product", "ignored_ambiguous_product"].includes(result));
            assert.deepEqual(harness.validated, []);
            assert.deepEqual(harness.starters, []);
        }
    });

    test("rejects noncanonical transaction IDs and unknown PlayFab users", async () => {
        for (const transactionId of ["0", "001", " 1", "9223372036854775808"]) {
            const harness = createHarness({
                allowStarterProductionGrants: true
            });
            await assert.rejects(process(harness, payment({ transactionId })));
            assert.deepEqual(harness.starters, []);

            const catalogHarness = createHarness({
                allowStarterSandboxGrants: true,
                starterSandboxTestPlayFabIds: [playFabId]
            });
            await assert.rejects(process(catalogHarness, orderPaid({ transactionId })));
            assert.deepEqual(catalogHarness.starters, []);
        }
        const unknown = createHarness({
            allowStarterProductionGrants: true,
            userExists: false
        });
        await assert.rejects(process(unknown, payment()));
        assert.deepEqual(unknown.starters, []);

        const unknownCatalog = createHarness({
            allowStarterSandboxGrants: true,
            starterSandboxTestPlayFabIds: [playFabId],
            userExists: false
        });
        await assert.rejects(process(unknownCatalog, orderPaid()));
        assert.deepEqual(unknownCatalog.starters, []);
    });
});
