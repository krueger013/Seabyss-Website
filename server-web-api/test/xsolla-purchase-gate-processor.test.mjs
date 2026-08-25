import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createXsollaPurchaseGateProcessor,
    XsollaPurchaseGateError
} from "../src/xsolla-purchase-gate-processor.js";

const starterEvent = {
    notificationType: "payment",
    payload: {
        purchase: { order: { lineitems: [{ sku: "seabyss_starter_pack_1", quantity: 1 }] } }
    }
};

function code(expected) {
    return (error) => error instanceof XsollaPurchaseGateError && error.code === expected;
}

describe("Xsolla backend purchase gates", () => {
    test("global gate is fail-closed before every paid processor", async () => {
        let calls = 0;
        const process = createXsollaPurchaseGateProcessor({
            legacyProcessor: async () => { calls += 1; }
        });
        await assert.rejects(process(starterEvent), code("PURCHASES_GLOBAL_DISABLED"));
        assert.equal(calls, 0);
    });

    test("requires family, SKU and catalog gates in addition to global", async () => {
        const base = {
            globalEnabled: true,
            legacyProcessor: async () => "granted"
        };
        await assert.rejects(
            createXsollaPurchaseGateProcessor({
                ...base,
                allowedSkus: ["seabyss_starter_pack_1"]
            })(starterEvent),
            code("PRODUCT_FAMILY_DISABLED")
        );
        await assert.rejects(
            createXsollaPurchaseGateProcessor({
                ...base,
                familyGates: { starter_pack: true }
            })(starterEvent),
            code("PRODUCT_DISABLED")
        );
    });

    test("routes an enabled SKU only to the selected hardened processor", async () => {
        let hardenedCalls = 0;
        let legacyCalls = 0;
        const process = createXsollaPurchaseGateProcessor({
            globalEnabled: true,
            familyGates: { starter_pack: true },
            allowedSkus: ["seabyss_starter_pack_1"],
            hardenedEnabled: true,
            hardenedProcessor: async () => { hardenedCalls += 1; return "hardened"; },
            legacyProcessor: async () => { legacyCalls += 1; return "legacy"; }
        });
        assert.equal(await process(starterEvent), "hardened");
        assert.equal(hardenedCalls, 1);
        assert.equal(legacyCalls, 0);
    });

    test("allows reversal processing while the purchase kill switch is off", async () => {
        let reversalEvent;
        const process = createXsollaPurchaseGateProcessor({
            reversalProcessor: async (event) => { reversalEvent = event; return "reversal_recorded"; }
        });
        const event = { notificationType: "refund", payload: {} };
        assert.equal(await process(event), "reversal_recorded");
        assert.equal(reversalEvent, event);
    });

    test("production hardened mode rejects unknown paid products", async () => {
        const process = createXsollaPurchaseGateProcessor({
            globalEnabled: true,
            hardenedEnabled: true,
            hardenedProcessor: async () => "impossible"
        });
        await assert.rejects(process({
            notificationType: "payment",
            payload: { purchase: { order: { lineitems: [{ sku: "attacker_sku" }] } } }
        }), code("UNRECOGNIZED_PAID_PRODUCT"));
    });

    test("non-financial subscription events preserve the legacy handler", async () => {
        const process = createXsollaPurchaseGateProcessor({
            legacyProcessor: async () => "validated_no_grant"
        });
        assert.equal(await process({ notificationType: "cancel_subscription" }), "validated_no_grant");
    });
});
