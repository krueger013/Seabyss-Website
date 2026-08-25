import { createHash } from "node:crypto";
import { financialSessionTicketDigest } from "./playfab-session-ticket-authenticator.js";
import { assertFinancialShadowPlayerAllowed } from "./financial-shadow-policy.js";

function publicError(code, message, statusCode) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    error.publicStatus = statusCode;
    return error;
}

function exactObject(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw publicError("FINANCIAL_SHADOW_HTTP_SCHEMA", `${name} has unknown or missing members.`, 400);
    }
    return value;
}

function containsClientIdentity(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
        if (["playfabid", "titleplayeraccountid", "entityid"].includes(String(key).toLowerCase())) return true;
        if (containsClientIdentity(child, seen)) return true;
    }
    return false;
}

function rejectClientIdentity(req) {
    if (containsClientIdentity(req?.body) || containsClientIdentity(req?.query)) {
        throw publicError(
            "FINANCIAL_SHADOW_CLIENT_IDENTITY_FORBIDDEN",
            "Financial Shadow identity must never be supplied by a client.",
            400
        );
    }
}

function header(req, name) {
    if (typeof req?.get === "function") return req.get(name);
    return req?.headers?.[name.toLowerCase()];
}

function noStore(res) {
    res.set?.("Cache-Control", "no-store, max-age=0");
    res.set?.("Pragma", "no-cache");
}

function sessionEpoch(value) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw publicError("FINANCIAL_SHADOW_HTTP_SCHEMA", "sessionEpoch is invalid.", 400);
    }
    return parsed;
}

export function financialShadowRateLimitKey(req) {
    const ticket = header(req, "X-PlayFab-SessionTicket");
    const ticketDigest = financialSessionTicketDigest(ticket);
    if (ticketDigest) return `shadow_ticket_${ticketDigest}`;
    const networkIdentity = String(req?.ip || req?.socket?.remoteAddress || "missing");
    return `shadow_missing_${createHash("sha256").update(networkIdentity, "utf8").digest("hex")}`;
}

export function createFinancialShadowHttpHandlers({
    policy,
    runtime,
    authenticateSessionTicket,
    authenticationDiagnostics = () => null
} = {}) {
    if (!policy || typeof authenticateSessionTicket !== "function" || typeof authenticationDiagnostics !== "function") {
        throw new TypeError("Financial Shadow HTTP requires policy and PlayFab session authentication.");
    }
    if (policy.enabled === true && (!runtime || typeof runtime.getSnapshot !== "function" ||
        typeof runtime.registerPresence !== "function" || typeof runtime.heartbeatPresence !== "function" ||
        typeof runtime.observe !== "function" || typeof runtime.claimInbox !== "function" ||
        typeof runtime.ackDelivery !== "function" || typeof runtime.diagnostics !== "function")) {
        throw new TypeError("Enabled Financial Shadow HTTP requires the complete runtime.");
    }

    async function authenticatedIdentity(req) {
        if (policy.enabled !== true) throw publicError("FINANCIAL_SHADOW_DISABLED", "Not found.", 404);
        rejectClientIdentity(req);
        const ticket = header(req, "X-PlayFab-SessionTicket");
        if (typeof ticket !== "string" || ticket.length < 16 || ticket.length > 4096 ||
            ticket !== ticket.trim() || /[\s\u0000-\u001f\u007f]/u.test(ticket)) {
            throw publicError("FINANCIAL_SHADOW_SESSION_REQUIRED", "A valid PlayFab session ticket is required.", 401);
        }
        let authenticated;
        try { authenticated = await authenticateSessionTicket(ticket); } catch {
            throw publicError("FINANCIAL_SHADOW_AUTH_UNAVAILABLE", "PlayFab session authentication is unavailable.", 503);
        }
        if (!authenticated?.playFabId) {
            throw publicError("FINANCIAL_SHADOW_SESSION_INVALID", "PlayFab session ticket is invalid or expired.", 401);
        }
        if (!authenticated.titlePlayerAccountId || authenticated.entity?.id !== authenticated.titlePlayerAccountId ||
            authenticated.entity?.type !== "title_player_account") {
            throw publicError("FINANCIAL_SHADOW_IDENTITY_INCOMPLETE", "PlayFab session identity is incomplete.", 503);
        }
        try {
            const playFabId = assertFinancialShadowPlayerAllowed(policy, authenticated.playFabId);
            return Object.freeze({
                playFabId,
                titlePlayerAccountId: authenticated.titlePlayerAccountId,
                entity: Object.freeze({ ...authenticated.entity })
            });
        } catch (error) {
            error.publicStatus = error.statusCode || 403;
            throw error;
        }
    }

    async function getSnapshot(req, res) {
        const identity = await authenticatedIdentity(req);
        noStore(res);
        res.json({ schemaVersion: 1, authoritative: false, snapshot: await runtime.getSnapshot(identity.playFabId) });
    }

    async function registerPresence(req, res) {
        const identity = await authenticatedIdentity(req);
        exactObject(req.body, ["sessionId"], "presence register body");
        noStore(res);
        res.status(201).json({
            schemaVersion: 1,
            authoritative: false,
            presence: await runtime.registerPresence({ playFabId: identity.playFabId, sessionId: req.body.sessionId })
        });
    }

    async function heartbeatPresence(req, res) {
        const identity = await authenticatedIdentity(req);
        exactObject(req.body, ["sessionEpoch", "sessionId"], "presence heartbeat body");
        noStore(res);
        res.json({
            schemaVersion: 1,
            authoritative: false,
            presence: await runtime.heartbeatPresence({
                playFabId: identity.playFabId,
                sessionId: req.body.sessionId,
                sessionEpoch: sessionEpoch(req.body.sessionEpoch)
            })
        });
    }

    async function observe(req, res) {
        const identity = await authenticatedIdentity(req);
        noStore(res);
        res.status(202).json(await runtime.observe(identity.playFabId, req.body, identity));
    }

    async function getInbox(req, res) {
        const identity = await authenticatedIdentity(req);
        const sessionId = header(req, "X-Shadow-Session-Id");
        const epoch = sessionEpoch(header(req, "X-Shadow-Session-Epoch"));
        const limit = req?.query?.limit === undefined ? 20 : Number(req.query.limit);
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
            throw publicError("FINANCIAL_SHADOW_HTTP_SCHEMA", "Inbox limit is invalid.", 400);
        }
        noStore(res);
        res.json({
            schemaVersion: 1,
            authoritative: false,
            inbox: await runtime.claimInbox({ playFabId: identity.playFabId, sessionId, sessionEpoch: epoch, limit })
        });
    }

    async function ackInbox(req, res) {
        const identity = await authenticatedIdentity(req);
        exactObject(req.body, ["deliveryEpoch", "deliveryId", "sessionEpoch", "sessionId"], "inbox ACK body");
        noStore(res);
        res.json({
            schemaVersion: 1,
            authoritative: false,
            ack: await runtime.ackDelivery({
                playFabId: identity.playFabId,
                sessionId: req.body.sessionId,
                sessionEpoch: sessionEpoch(req.body.sessionEpoch),
                deliveryId: req.body.deliveryId,
                deliveryEpoch: req.body.deliveryEpoch
            })
        });
    }

    async function getDiagnostics(req, res) {
        const identity = await authenticatedIdentity(req);
        noStore(res);
        res.json({
            schemaVersion: 1,
            authoritative: false,
            diagnostics: await runtime.diagnostics(identity.playFabId),
            authentication: authenticationDiagnostics()
        });
    }

    return Object.freeze({
        getSnapshot,
        registerPresence,
        heartbeatPresence,
        observe,
        getInbox,
        ackInbox,
        getDiagnostics,
        enabled: policy.enabled === true,
        identityDerivedOnlyFromSessionTicket: true
    });
}

function route(handler) {
    return async (req, res, next) => {
        try { await handler(req, res); } catch (error) { next(error); }
    };
}

export function registerFinancialShadowRoutes(app, {
    handlers,
    preventSensitiveResponseCaching = (req, res, next) => next(),
    requireJsonObject = (req, res, next) => next(),
    limiter = (req, res, next) => next()
} = {}) {
    if (!app || typeof app.get !== "function" || typeof app.post !== "function" || !handlers) {
        throw new TypeError("Financial Shadow route registration is invalid.");
    }
    const limits = Array.isArray(limiter) ? limiter : [limiter];
    app.get("/financial/shadow/v1/snapshot", preventSensitiveResponseCaching, ...limits, route(handlers.getSnapshot));
    app.post("/financial/shadow/v1/presence/register", preventSensitiveResponseCaching, ...limits,
        requireJsonObject, route(handlers.registerPresence));
    app.post("/financial/shadow/v1/presence/heartbeat", preventSensitiveResponseCaching, ...limits,
        requireJsonObject, route(handlers.heartbeatPresence));
    app.post("/financial/shadow/v1/observe", preventSensitiveResponseCaching, ...limits,
        requireJsonObject, route(handlers.observe));
    app.get("/financial/shadow/v1/inbox", preventSensitiveResponseCaching, ...limits, route(handlers.getInbox));
    app.post("/financial/shadow/v1/inbox/ack", preventSensitiveResponseCaching, ...limits,
        requireJsonObject, route(handlers.ackInbox));
    app.get("/financial/shadow/v1/diagnostics", preventSensitiveResponseCaching, ...limits,
        route(handlers.getDiagnostics));
    return Object.freeze({ registered: true, enabled: handlers.enabled === true,
        prefix: "/financial/shadow/v1", routeCount: 7 });
}
