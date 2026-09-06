import assert from "node:assert/strict";
import test from "node:test";

import { readDiamondsCanaryIdentity } from "../src/diamonds-canary-identity.js";

const SANDBOX = "1D0C16";
const PLAYER = "C5BD37AA141B3C4E";
const env = (overrides = {}) => ({
    PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: SANDBOX,
    ...overrides
});

test("accepts exactly one configured Sandbox PlayFabId", () => {
    assert.deepEqual(readDiamondsCanaryIdentity(env({
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID: PLAYER
    })), { titleId: SANDBOX, playFabId: PLAYER, configured: true });
});

for (const value of ["", "*", "anyPlayer", `${PLAYER},61AD15CDA4137EA9`, ` ${PLAYER}`]) {
    test(`rejects unsafe Canary identity ${JSON.stringify(value)}`, () => {
        assert.throws(() => readDiamondsCanaryIdentity(env({
            FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID: value
        })), /one exact uppercase legacy PlayFabId/u);
    });
}

test("rejects absent identity when Canary is required", () => {
    assert.throws(() => readDiamondsCanaryIdentity(env()), /one exact Diamonds Canary PlayFabId/iu);
});

test("allows disabled runtime to remain unconfigured", () => {
    assert.deepEqual(readDiamondsCanaryIdentity({}, { required: false }), {
        titleId: null,
        playFabId: null,
        configured: false
    });
});

test("rejects conflicting singular and compatibility settings", () => {
    assert.throws(() => readDiamondsCanaryIdentity(env({
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID: PLAYER,
        FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "61AD15CDA4137EA9"
    })), /settings disagree/u);
});

test("rejects Production and any wrong Title", () => {
    for (const titleId of ["142853", "ABCDEF"]) {
        assert.throws(() => readDiamondsCanaryIdentity({
            PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID: titleId,
            FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID: PLAYER
        }), /Sandbox Title 1D0C16/u);
    }
});

test("disabled runtime accepts explicitly empty identity settings but activation still refuses them", () => {
    for (const settings of [
        { FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "" },
        { FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID: "", FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS: "" }
    ]) {
        assert.deepEqual(readDiamondsCanaryIdentity(settings, { required: false }),
            { titleId: null, playFabId: null, configured: false });
        assert.throws(() => readDiamondsCanaryIdentity(settings), /one exact uppercase legacy PlayFabId/u);
    }
});
