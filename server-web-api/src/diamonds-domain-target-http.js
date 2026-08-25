import { createHash } from "node:crypto";

const READ_KEYS = Object.freeze(["playFabId"]);
const MUTATION_KEYS = Object.freeze([
    "contextId", "delta", "eventId", "operationId", "playFabId",
    "reason", "sessionEpoch", "sessionId"
]);

function exactObject(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        const error = new Error(`${name} has unknown or missing fields.`);
        error.code = "DIAMONDS_TARGET_HTTP_SCHEMA";
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function noStore(response) {
    response.set?.("Cache-Control", "no-store, max-age=0");
    response.set?.("Pragma", "no-cache");
}

function publicStatus(error) {
    return Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode
        : error?.retryable === true ? 503 : 500;
}

function safeIdentity(playFabId) {
    return createHash("sha256").update(playFabId, "utf8").digest("hex").slice(0, 16);
}

function trustedPrincipal(value) {
    return value?.authenticated === true && value?.authenticationType === "GameServer" &&
        typeof value.serverId === "string" && value.serverId.length > 0;
}

/** Authenticated game-server-only handlers; no client session credential is accepted here. */
export function createDiamondsDomainTargetHttpHandlers({
    adapter,
    authenticateGameServer,
    authorizePlayer,
    logger = console
} = {}) {
    if (typeof adapter?.read !== "function" || typeof adapter?.mutate !== "function" ||
        typeof authenticateGameServer !== "function" || typeof authorizePlayer !== "function" ||
        typeof logger?.warn !== "function" || typeof logger?.error !== "function") {
        throw new TypeError("Diamonds Target HTTP dependencies are incomplete.");
    }

    async function principal(request) {
        let identity;
        try {
            identity = await authenticateGameServer(request);
        } catch {
            const error = new Error("Game-server authentication is unavailable.");
            error.code = "DIAMONDS_TARGET_AUTH_UNAVAILABLE";
            error.statusCode = 503;
            throw error;
        }
        if (!trustedPrincipal(identity)) {
            const error = new Error("Authenticated financial game-server identity is required.");
            error.code = "DIAMONDS_TARGET_AUTH_REQUIRED";
            error.statusCode = 401;
            throw error;
        }
        return Object.freeze({ ...identity });
    }

    async function authorized(request, body) {
        const identity = await principal(request);
        const decision = await authorizePlayer({
            principal: identity,
            playFabId: body.playFabId,
            sessionId: body.sessionId ?? null,
            sessionEpoch: body.sessionEpoch ?? null,
            operationId: body.operationId ?? null,
            eventId: body.eventId ?? null
        });
        if (decision?.authorized !== true || decision.playFabId !== body.playFabId) {
            const error = new Error("Game server is not authorized for this player operation.");
            error.code = "DIAMONDS_TARGET_PLAYER_UNAUTHORIZED";
            error.statusCode = 403;
            throw error;
        }
        return identity;
    }

    async function execute(request, response, kind) {
        const keys = kind === "read" ? READ_KEYS : MUTATION_KEYS;
        const body = exactObject(request?.body, keys, `Diamonds Target ${kind}`);
        const identity = await authorized(request, body);
        noStore(response);
        try {
            const result = kind === "read"
                ? await adapter.read(body)
                : await adapter.mutate(body);
            return response.status(200).json(result);
        } catch (error) {
            const status = publicStatus(error);
            const code = typeof error?.code === "string" ? error.code : "DIAMONDS_TARGET_FAILED";
            const log = status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
            log("diamonds_target_request_rejected", {
                code,
                status,
                serverId: identity.serverId,
                playerHash: safeIdentity(body.playFabId)
            });
            return response.status(status).json({
                error: status >= 500 ? "diamonds_target_unavailable" : "diamonds_target_rejected",
                code
            });
        }
    }

    return Object.freeze({
        read: (request, response) => execute(request, response, "read"),
        mutate: (request, response) => execute(request, response, "mutate"),
        authenticationType: "GameServer",
        clientSessionTicketsAccepted: false
    });
}

function route(handler) {
    return async (request, response, next) => {
        try {
            await handler(request, response);
        } catch (error) {
            next(error);
        }
    };
}

export function registerDiamondsDomainTargetRoutes(app, {
    handlers,
    preventSensitiveResponseCaching = (request, response, next) => next(),
    requireJsonObject = (request, response, next) => next(),
    limiter = (request, response, next) => next()
} = {}) {
    if (!app || typeof app.post !== "function" || !handlers) {
        const error = new Error("Diamonds Target routes are inactive or not configured.");
        error.code = "DIAMONDS_TARGET_ROUTES_INACTIVE";
        throw error;
    }
    const limits = Array.isArray(limiter) ? limiter : [limiter];
    app.post("/financial/domains/diamonds/v1/read", preventSensitiveResponseCaching,
        ...limits, requireJsonObject, route(handlers.read));
    app.post("/financial/domains/diamonds/v1/mutate", preventSensitiveResponseCaching,
        ...limits, requireJsonObject, route(handlers.mutate));
    return Object.freeze({
        registered: true,
        prefix: "/financial/domains/diamonds/v1",
        routeCount: 2,
        gameServerAuthenticated: true
    });
}
