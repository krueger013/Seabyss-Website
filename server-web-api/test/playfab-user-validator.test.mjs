import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPlayFabUserValidator } from "../src/playfab-user-validator.js";

const existingPlayFabId = "ABCDEF123456";

function playFabResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        }
    };
}

describe("PlayFab Xsolla user validator", () => {
    test("validates an existing account by exact PlayFabId without creating anything", async () => {
        const calls = [];
        const validateUser = createPlayFabUserValidator({
            titleId: "local-test-title",
            secretKey: "local-test-secret",
            timeoutMs: 1000,
            async fetchImpl(url, options) {
                calls.push({ url, options });
                return playFabResponse(200, {
                    code: 200,
                    data: { UserInfo: { PlayFabId: existingPlayFabId } }
                });
            }
        });

        assert.equal(await validateUser(existingPlayFabId), true);
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            "https://local-test-title.playfabapi.com/Server/GetUserAccountInfo"
        );
        assert.equal(calls[0].options.method, "POST");
        assert.equal(calls[0].options.redirect, "error");
        assert.equal(calls[0].options.headers["X-SecretKey"], "local-test-secret");
        assert.deepEqual(JSON.parse(calls[0].options.body), { PlayFabId: existingPlayFabId });
        assert.doesNotMatch(calls[0].url, /Register|Create|Grant|Purchase/i);
    });

    test("returns false for an unknown Master PlayFabId or an invalid PlayFabId", async () => {
        const cases = [
            {
                inputId: "C5CB2658CA7B9977",
                error: "AccountNotFound",
                errorCode: 1001
            },
            {
                inputId: "TESTUSER1",
                error: "InvalidParams",
                errorCode: 1000
            }
        ];
        for (const testCase of cases) {
            const validateUser = createPlayFabUserValidator({
                titleId: "local-test-title",
                secretKey: "local-test-secret",
                async fetchImpl() {
                    return playFabResponse(400, {
                        code: 400,
                        error: testCase.error,
                        errorCode: testCase.errorCode
                    });
                }
            });

            assert.equal(await validateUser(testCase.inputId), false, testCase.inputId);
        }
    });

    test("rejects malformed identifiers without contacting PlayFab", async () => {
        let calls = 0;
        const validateUser = createPlayFabUserValidator({
            titleId: "local-test-title",
            secretKey: "local-test-secret",
            async fetchImpl() {
                calls += 1;
                throw new Error("must not be called");
            }
        });

        assert.equal(await validateUser(""), false);
        assert.equal(await validateUser(" ABCDEF123456"), false);
        assert.equal(await validateUser(123456), false);
        assert.equal(calls, 0);
    });

    test("fails closed on upstream errors and inconsistent successful responses", async () => {
        for (const response of [
            playFabResponse(429, { code: 429, error: "TooManyRequests" }),
            playFabResponse(500, { code: 500, error: "InternalServerError" }),
            playFabResponse(200, {
                code: 200,
                data: { UserInfo: { PlayFabId: "DIFFERENT123" } }
            })
        ]) {
            const validateUser = createPlayFabUserValidator({
                titleId: "local-test-title",
                secretKey: "local-test-secret",
                async fetchImpl() {
                    return response;
                }
            });
            await assert.rejects(validateUser(existingPlayFabId));
        }
    });
});
