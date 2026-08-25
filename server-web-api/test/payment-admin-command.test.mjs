import assert from "node:assert/strict";
import { test } from "node:test";
import { createPaymentAdminCommand } from "../src/payment-admin-command.js";

test("admin command exposes audited lookup and safe retry without accepting operator spoofing", async () => {
    const calls = [];
    const command = createPaymentAdminCommand({
        reconciliation: {
            async lookup(input) { calls.push({ method: "lookup", input }); return { items: [] }; },
            async safeRetry(input) { calls.push({ method: "retry", input }); return { status: "ok" }; }
        }
    });
    await command.execute([
        "lookup",
        "--provider", "xsolla",
        "--transaction", "2119400001"
    ], {
        operator: "authenticated-admin",
        reason: "support case 42"
    });
    await command.execute([
        "retry",
        "--provider", "xsolla",
        "--transaction", "2119400001"
    ], {
        operator: "authenticated-admin",
        reason: "resume failed checkpoints"
    });
    assert.deepEqual(calls, [{
        method: "lookup",
        input: {
            operator: "authenticated-admin",
            reason: "support case 42",
            query: { provider: "xsolla", providerTransactionId: "2119400001" },
            cursor: "0",
            limit: 50
        }
    }, {
        method: "retry",
        input: {
            operator: "authenticated-admin",
            reason: "resume failed checkpoints",
            provider: "xsolla",
            providerTransactionId: "2119400001"
        }
    }]);
    await assert.rejects(command.execute([
        "retry",
        "--provider", "xsolla",
        "--transaction", "2119400001",
        "--operator", "attacker"
    ], {
        operator: "authenticated-admin",
        reason: "must fail"
    }), /unsupported payment admin flag/i);
});
