import test from "node:test";
import assert from "node:assert/strict";
import {
    createServerEconomyPocInitialSnapshot,
    validateServerEconomyPocSnapshot
} from "../src/server-economy-poc-model.js";

test("snapshot validator rejects unknown root and Premium members", () => {
    const initial = createServerEconomyPocInitialSnapshot("STRICT_SCHEMA_PLAYER", 1000);
    assert.throws(
        () => validateServerEconomyPocSnapshot({ ...structuredClone(initial), injected: true }),
        { code: "POC_SNAPSHOT_CORRUPT" }
    );
    assert.throws(
        () => validateServerEconomyPocSnapshot({
            ...structuredClone(initial),
            premium: { ...structuredClone(initial.premium), injected: true }
        }),
        { code: "POC_SNAPSHOT_CORRUPT" }
    );
    assert.equal(validateServerEconomyPocSnapshot(initial), initial);
});
