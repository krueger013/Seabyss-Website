import assert from "node:assert/strict";
import { test } from "node:test";
import { createXsollaPremiumEventProcessor } from "../src/xsolla-premium-processor.js";

test("processor direct calls reject padded PlayFabIds without trim or allowlist normalization", async () => {
    let validations = 0;
    let receipts = 0;
    const processor = createXsollaPremiumEventProcessor({
        premiumPlanId: "321178",
        premiumPlanExternalId: "NZSorpSt",
        allowStarterProductionGrants: true,
        allowStarterSandboxGrants: true,
        starterSandboxTestPlayFabIds: [" 4DF88C225D91FE06"],
        async validateUser() { validations += 1; return true; },
        async persistStarterPackReceipt() { receipts += 1; }
    });
    const productionPayload = {
        transaction: { id: "2118200001" },
        purchase: {
            order: { lineitems: [{ sku: "seabyss_starter_pack_1", quantity: 1 }] }
        }
    };
    await assert.rejects(processor({
        payload: productionPayload,
        notificationType: "payment",
        userId: " 4DF88C225D91FE06"
    }));
    assert.equal(validations, 0);
    assert.equal(receipts, 0);

    const sandboxPayload = structuredClone(productionPayload);
    sandboxPayload.transaction.id = "2118200002";
    sandboxPayload.transaction.dry_run = 1;
    assert.equal(await processor({
        payload: sandboxPayload,
        notificationType: "payment",
        userId: "4DF88C225D91FE06"
    }), "ignored_dry_run");
    assert.equal(validations, 0);
    assert.equal(receipts, 0);
});
