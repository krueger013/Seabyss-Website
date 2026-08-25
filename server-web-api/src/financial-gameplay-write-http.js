import { createHash } from "node:crypto";

function headerValue(request, name) {
    const direct = request?.get?.(name);
    if (typeof direct === "string" && direct.length > 0) return direct;
    const raw = request?.headers?.[name.toLowerCase()];
    return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function safeIdentity(playFabId) {
    return createHash("sha256").update(playFabId, "utf8").digest("hex").slice(0, 16);
}

function statusFor(error) {
    if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
        return error.statusCode;
    }
    if (error?.retryable === true || error?.ambiguous === true) return 503;
    return 500;
}

function retryAfterSeconds(error) {
    const milliseconds = error?.retryAfterMilliseconds;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 86_400_000) {
        return null;
    }
    return Math.max(1, Math.ceil(milliseconds / 1000));
}

export function createFinancialGameplayWriteHttpHandler({
    authenticateSessionTicket,
    service,
    logger = console
} = {}) {
    if (typeof authenticateSessionTicket !== "function" || typeof service?.execute !== "function" ||
        typeof logger?.warn !== "function" || typeof logger?.error !== "function") {
        throw new TypeError("Gameplay write HTTP dependencies are incomplete.");
    }

    return async function financialGameplayWriteHttp(request, response) {
        if (request?.method && request.method !== "POST") {
            response.set?.("Allow", "POST");
            return response.status(405).json({ error: "method_not_allowed" });
        }
        const ticket = headerValue(request, "x-playfab-sessionticket");
        if (!ticket || ticket.length > 8192 || ticket !== ticket.trim()) {
            return response.status(401).json({ error: "authentication_required" });
        }
        let authenticated;
        try {
            authenticated = await authenticateSessionTicket(ticket);
        } catch (error) {
            logger.error("financial_gameplay_auth_unavailable", {
                code: typeof error?.code === "string" ? error.code : "AUTH_UNAVAILABLE"
            });
            return response.status(503).json({ error: "authentication_unavailable" });
        }
        if (!authenticated || typeof authenticated.playFabId !== "string") {
            return response.status(401).json({ error: "invalid_session_ticket" });
        }
        const identityHash = safeIdentity(authenticated.playFabId);
        try {
            const result = await service.execute({
                identity: {
                    authenticated: true,
                    authenticationType: "PlayFabSessionTicket",
                    playFabId: authenticated.playFabId
                },
                request: request.body
            });
            return response.status(result.status === "already_completed" ? 200 : 201).json(result);
        } catch (error) {
            const status = statusFor(error);
            const code = typeof error?.code === "string" ? error.code : "FINANCIAL_WRITE_FAILED";
            const retryAfter = retryAfterSeconds(error);
            if (retryAfter !== null) response.set?.("Retry-After", String(retryAfter));
            const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
            log("financial_gameplay_write_rejected", { identityHash, code, status });
            return response.status(status).json({
                error: status >= 500 ? "financial_write_unavailable" : "financial_write_rejected",
                code
            });
        }
    };
}
