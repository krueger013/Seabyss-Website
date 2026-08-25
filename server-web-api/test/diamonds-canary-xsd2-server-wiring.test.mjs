import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("real server wires Canary xsd2 through the canonical Target and preserves Shadow fallback", async () => {
    const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
    assert.match(source, /diamondsDomainTarget\.mode === "Canary"/u);
    assert.match(source, /createDiamondsCanaryXsd2Composition\(\{/u);
    assert.match(source, /canonicalRuntime: diamondsDomainTarget\.canonicalRuntime/u);
    assert.match(source, /verifyCanaryReadiness: diamondsDomainTarget\.verifyPaymentCanaryReadiness/u);
    assert.match(source, /shadowProducer: financialShadowPaymentProducer/u);
    assert.match(source, /trustedXsollaV2ProjectionProducer = diamondsCanaryXsd2Composition\?\.producer \|\|\s*financialShadowPaymentProducer/u);
    assert.match(source, /producer: trustedXsollaV2ProjectionProducer/u);
});
