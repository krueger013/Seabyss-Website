import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createPlayFabSessionTicketAuthenticator,
    PlayFabSessionAuthenticationError
} from "../src/playfab-session-ticket-authenticator.js";

const ticket = "session-ticket-local-test-1234567890";
const playFabId = "46789223F9CB1BB9";

function jsonResponse(payload, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json", ...extraHeaders }
    });
}

describe("PlayFab session-ticket authenticator", () => {
    test("derives the legacy PlayFabId only from AuthenticateSessionTicket", async () => {
        const calls = [];
        const authenticate = createPlayFabSessionTicketAuthenticator({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            async fetchImpl(url, init) {
                calls.push({ url, init });
                return jsonResponse({
                    code: 200,
                    data: {
                        IsSessionTicketExpired: false,
                        UserInfo: { PlayFabId: playFabId }
                    }
                });
            }
        });

        assert.deepEqual(await authenticate(ticket), { playFabId });
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            "https://142853.playfabapi.com/Server/AuthenticateSessionTicket"
        );
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.redirect, "error");
        assert.equal(calls[0].init.headers["X-SecretKey"], "playfab-secret-local");
        assert.deepEqual(JSON.parse(calls[0].init.body), { SessionTicket: ticket });
    });

    test("never accepts caller-authored identity and skips the network for bad tickets", async () => {
        let calls = 0;
        const authenticate = createPlayFabSessionTicketAuthenticator({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            async fetchImpl() { calls += 1; }
        });
        for (const candidate of [
            null,
            "short",
            ` ${ticket}`,
            `${ticket}\n`,
            { sessionTicket: ticket, playFabId: "ATTACKER" },
            "x".repeat(4097)
        ]) {
            assert.equal(await authenticate(candidate), null);
        }
        assert.equal(calls, 0);
    });

    test("rejects expired and provider-declared invalid tickets", async () => {
        const expired = createPlayFabSessionTicketAuthenticator({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            async fetchImpl() {
                return jsonResponse({
                    code: 200,
                    data: {
                        IsSessionTicketExpired: true,
                        UserInfo: { PlayFabId: playFabId }
                    }
                });
            }
        });
        assert.equal(await expired(ticket), null);

        const invalid = createPlayFabSessionTicketAuthenticator({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            async fetchImpl() {
                return jsonResponse({ code: 400, error: "InvalidSessionTicket" }, 400);
            }
        });
        assert.equal(await invalid(ticket), null);
    });

    test("fails closed on missing expiry proof, fake identity, upstream errors and oversize", async () => {
        const cases = [
            () => jsonResponse({ code: 200, data: { UserInfo: { PlayFabId: playFabId } } }),
            () => jsonResponse({
                code: 200,
                data: { IsSessionTicketExpired: false, UserInfo: { PlayFabId: " BAD" } }
            }),
            () => jsonResponse({ code: 500, error: "InternalServerError" }, 500),
            () => new Response("x".repeat(2048), { status: 200 })
        ];
        for (const responseFactory of cases) {
            const authenticate = createPlayFabSessionTicketAuthenticator({
                titleId: "142853",
                secretKey: "playfab-secret-local",
                maximumResponseBytes: 1024,
                async fetchImpl() { return responseFactory(); }
            });
            await assert.rejects(
                authenticate(ticket),
                (error) => error instanceof PlayFabSessionAuthenticationError &&
                    error.code === "PLAYFAB_SESSION_AUTHENTICATION_UNAVAILABLE" &&
                    !error.message.includes(ticket)
            );
        }
    });

    test("fails closed when credentials or transport are unavailable", async () => {
        const unconfigured = createPlayFabSessionTicketAuthenticator();
        await assert.rejects(unconfigured(ticket), PlayFabSessionAuthenticationError);

        const transportFailure = createPlayFabSessionTicketAuthenticator({
            titleId: "142853",
            secretKey: "playfab-secret-local",
            async fetchImpl() { throw new Error(`must-not-leak-${ticket}`); }
        });
        await assert.rejects(
            transportFailure(ticket),
            (error) => error instanceof PlayFabSessionAuthenticationError &&
                !error.message.includes(ticket)
        );
    });
});
