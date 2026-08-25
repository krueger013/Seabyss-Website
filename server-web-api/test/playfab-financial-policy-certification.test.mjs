import assert from "node:assert/strict";
import test from "node:test";

import {
    PRODUCTION_TITLE_ID,
    PROTECTED_OBJECT_NAMES,
    REQUIRED_CLIENT_MUTATION_DENIES,
    SANDBOX_TITLE_ID,
    assertSafeTitle,
    evaluatePolicyCoverage,
    mergeApiStatements,
    mergeGlobalPermissions
} from "../playfab-financial-policy-certification.mjs";

test("title guard allows only the dedicated financial Sandbox", () => {
    assert.equal(assertSafeTitle(SANDBOX_TITLE_ID), SANDBOX_TITLE_ID);
    assert.throws(() => assertSafeTitle(""), /required/u);
    assert.throws(() => assertSafeTitle(PRODUCTION_TITLE_ID), /Production Title 142853/u);
    assert.throws(() => assertSafeTitle("OTHER"), /Only Sandbox Title/u);
});

test("global merge adds six exact object-scoped write denies and is idempotent", () => {
    const baseline = [{ Resource: "pfrn:data--*!*/Profile/*", Action: "Read", Effect: "Allow", Principal: "[SELF]" }];
    const once = mergeGlobalPermissions(baseline);
    const twice = mergeGlobalPermissions(once);
    assert.equal(once.length, baseline.length + PROTECTED_OBJECT_NAMES.length);
    assert.deepEqual(twice, once);
    for (const name of PROTECTED_OBJECT_NAMES) {
        assert.ok(once.some((entry) => entry.Resource === `pfrn:data--*!*/Profile/${name}` &&
            entry.Action === "Write" && entry.Effect === "Deny"));
    }
    assert.equal(once.some((entry) => entry.Resource === "pfrn:data--*!*/Profile/*" && entry.Action === "Write"), false);
});

test("API merge adds only exact title-player financial mutator denies and is idempotent", () => {
    const baseline = [{ Resource: "pfrn:api--/Client/*", Action: "*", Effect: "Allow", Principal: "*" }];
    const once = mergeApiStatements(baseline);
    const twice = mergeApiStatements(once);
    assert.equal(once.length, baseline.length + REQUIRED_CLIENT_MUTATION_DENIES.length);
    assert.deepEqual(twice, once);
    assert.equal(once.some((entry) => entry.Resource === "pfrn:api--/Client/UpdateUserData" && entry.Effect === "Deny"), false);
});

test("coverage is complete only when both object and API policy layers are present", () => {
    const globalPolicy = { Permissions: mergeGlobalPermissions([]) };
    const apiPolicy = { Statements: mergeApiStatements([]) };
    assert.deepEqual(evaluatePolicyCoverage(globalPolicy, apiPolicy), {
        complete: true,
        missingObjects: [],
        missingApis: []
    });
    const incomplete = evaluatePolicyCoverage({ Permissions: [] }, apiPolicy);
    assert.equal(incomplete.complete, false);
    assert.deepEqual(incomplete.missingObjects, PROTECTED_OBJECT_NAMES);
});
