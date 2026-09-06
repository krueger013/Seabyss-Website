import "./fixtures/diamonds-canary-legacy.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
    DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
    readDiamondsSandboxDryRunEnvironment,
    runDiamondsSandboxReadOnlyDryRun
} from "../diamonds-sandbox-readiness-dry-run.mjs";

const SECRET = "test-only-secret-never-log";
const ENTITY_ID = "714E7F12EDBEA385";

function environment(overrides = {}) {
    return {
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "1D0C16",
        PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY: SECRET,
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID:
            DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
        ...overrides
    };
}

function response(data) {
    return {
        ok: true,
        status: 200,
        async json() { return { code: 200, data }; }
    };
}

function fixtureFetch({ mutateSecondObjectRead = false } = {}) {
    const calls = [];
    let objectReads = 0;
    const fetchImpl = async (url, options) => {
        const path = new URL(url).pathname;
        calls.push({ path, options });
        if (path === "/Server/GetUserAccountInfo") {
            return response({ UserInfo: {
                PlayFabId: DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
                TitleInfo: { TitlePlayerAccount: { Id: ENTITY_ID } }
            }});
        }
        if (path === "/Server/GetUserInventory") {
            return response({ VirtualCurrency: { DM: 500 }, Inventory: [] });
        }
        if (path === "/Authentication/GetEntityToken") {
            return response({
                EntityToken: "temporary-entity-token-not-returned",
                Entity: { Id: "1D0C16", Type: "title" }
            });
        }
        if (path === "/Object/GetObjects") {
            objectReads += 1;
            return response({
                ProfileVersion: mutateSecondObjectRead && objectReads === 2 ? 18 : 17,
                Objects: {
                    SeabyssEconomyStateV1: {
                        DataObject: {
                            schemaVersion: 1,
                            playFabId: DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
                            revision: 8,
                            diamonds: mutateSecondObjectRead && objectReads === 2 ? 501 : 500
                        }
                    }
                }
            });
        }
        throw new Error(`Unexpected endpoint ${path}`);
    };
    return { fetchImpl, calls };
}

test("Sandbox dry-run uses only four provider read APIs twice and changes nothing", async () => {
    const fixture = fixtureFetch();
    const result = await runDiamondsSandboxReadOnlyDryRun({
        environment: environment(),
        fetchImpl: fixture.fetchImpl
    });
    assert.equal(result.readOnly, true);
    assert.equal(result.sandboxTitleId, "1D0C16");
    assert.equal(result.productionTitleUntouched, true);
    assert.equal(result.playFabId, DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID);
    assert.equal(result.entityId, ENTITY_ID);
    assert.equal(result.legacyValue, 500);
    assert.equal(result.targetValue, 500);
    assert.equal(result.targetRevision, 8);
    assert.equal(result.providerProfileVersion, 17);
    assert.equal(result.migrationProofExists, false);
    assert.equal(result.proposedTargetValue, 500);
    assert.equal(result.conflictState, "ready");
    assert.equal(result.providerUnchanged, true);
    assert.equal(result.providerWriteCount, 0);
    assert.equal(result.providerBeforeDigest, result.providerAfterDigest);
    assert.equal(fixture.calls.length, 8);
    assert.deepEqual([...new Set(fixture.calls.map((entry) => entry.path))].sort(), [
        "/Authentication/GetEntityToken",
        "/Object/GetObjects",
        "/Server/GetUserAccountInfo",
        "/Server/GetUserInventory"
    ]);
    assert.ok(fixture.calls.every((entry) => entry.options.method === "POST"));
    assert.ok(fixture.calls.every((entry) => !/SetObjects|AddUser|SubtractUser/u.test(entry.path)));
    assert.doesNotMatch(JSON.stringify(result), /test-only-secret|entity-token/u);
});

test("Sandbox dry-run refuses Production before issuing any provider call", async () => {
    let calls = 0;
    await assert.rejects(runDiamondsSandboxReadOnlyDryRun({
        environment: environment({
            PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: "142853"
        }),
        fetchImpl: async () => { calls += 1; throw new Error("must not run"); }
    }), { code: "DIAMONDS_SANDBOX_TITLE_MISMATCH" });
    assert.equal(calls, 0);
});

test("Sandbox dry-run refuses conflicting configured identities before any provider call", () => {
    assert.throws(() => readDiamondsSandboxDryRunEnvironment(environment({
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "0000000000000001"
    })), { code: "DIAMONDS_CANARY_ID_CONFLICT" });
});

test("Sandbox dry-run refuses certificate evidence if provider state changes between reads", async () => {
    const fixture = fixtureFetch({ mutateSecondObjectRead: true });
    await assert.rejects(runDiamondsSandboxReadOnlyDryRun({
        environment: environment(),
        fetchImpl: fixture.fetchImpl
    }), { code: "DIAMONDS_DRY_RUN_PROVIDER_CHANGED" });
    assert.equal(fixture.calls.length, 8);
});
