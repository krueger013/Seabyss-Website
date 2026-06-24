import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { createClient } from "redis";

const app = express();

const config = {
    nodeEnv: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT || 3000),
    publicOrigins: String(process.env.PUBLIC_SITE_ORIGIN || "http://localhost:8080")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    playFabTitleId: process.env.PLAYFAB_TITLE_ID,
    playFabSecretKey: process.env.PLAYFAB_SECRET_KEY,
    sessionSecret: process.env.SESSION_SECRET,
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    seabyssEnv: process.env.SEABYSS_ENV || "beta",
    redisUrl: process.env.REDIS_URL,
    sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 86400)
};

const isProduction = config.nodeEnv === "production";

if (!config.sessionSecret && isProduction) {
    throw new Error("SESSION_SECRET is required in production.");
}

if (isProduction && !config.playFabTitleId) {
    throw new Error("PLAYFAB_TITLE_ID is required in production.");
}

if (isProduction && !config.playFabSecretKey) {
    throw new Error("PLAYFAB_SECRET_KEY is required in production.");
}

if (isProduction && !config.redisUrl) {
    throw new Error("REDIS_URL is required in production.");
}

if (!Number.isFinite(config.sessionTtlSeconds) || config.sessionTtlSeconds < 300) {
    throw new Error("SESSION_TTL_SECONDS must be a number of at least 300 seconds.");
}

if (!config.playFabTitleId) {
    console.warn("PLAYFAB_TITLE_ID is not configured. Login will fail until the server .env is completed.");
}

app.set("trust proxy", isProduction ? 1 : 0);
app.disable("x-powered-by");

app.use(helmet());

app.use(cors({
    origin(origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }

        if (origin && config.publicOrigins.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error("CORS origin not allowed."));
    },
    credentials: true
}));

app.use(express.json({ limit: "16kb" }));

async function createSessionStore() {
    if (!config.redisUrl) {
        if (isProduction) {
            throw new Error("Redis session store is required in production.");
        }

        console.warn("REDIS_URL is not configured. Using MemoryStore for local development only.");
        return undefined;
    }

    const redisClient = createClient({
        url: config.redisUrl,
        socket: {
            reconnectStrategy(retries) {
                return Math.min(retries * 50, 1000);
            }
        }
    });

    redisClient.on("error", (error) => {
        console.error("Redis session store error", {
            message: error.message
        });
    });

    try {
        await redisClient.connect();
        await redisClient.ping();
    } catch (error) {
        if (isProduction) {
            throw new Error(`Redis session store unavailable: ${error.message}`);
        }

        console.warn("Redis unavailable. Using MemoryStore for local development only.");
        return undefined;
    }

    return new RedisStore({
        client: redisClient,
        prefix: "seabyss:web:sess:",
        ttl: config.sessionTtlSeconds
    });
}

const sessionStore = await createSessionStore();

app.use(session({
    name: "seabyss.sid",
    store: sessionStore,
    secret: config.sessionSecret || "development-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        domain: isProduction ? config.cookieDomain : undefined,
        maxAge: config.sessionTtlSeconds * 1000
    }
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many login attempts. Please try again later." }
});

function maskEmail(email) {
    if (!email || !email.includes("@")) {
        return undefined;
    }

    const [name, domain] = email.split("@");
    const visible = name.slice(0, 2);
    return `${visible}${"*".repeat(Math.max(2, name.length - 2))}@${domain}`;
}

function maskPlayFabId(playFabId) {
    if (!playFabId || playFabId.length < 8) {
        return undefined;
    }
    return `${playFabId.slice(0, 4)}...${playFabId.slice(-4)}`;
}

function publicSession(req) {
    if (!req.session.player) {
        return { loggedIn: false };
    }

    return {
        loggedIn: true,
        displayName: req.session.player.displayName || "Captain",
        environment: config.seabyssEnv
    };
}

function requireAuth(req, res, next) {
    if (!req.session.player) {
        res.status(401).json({ message: "Authentication required." });
        return;
    }
    next();
}

function validateLoginInput(req, res, next) {
    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password || email.length > 254 || password.length > 256) {
        res.status(400).json({ message: "Invalid email or password." });
        return;
    }

    req.loginInput = { email, password };
    next();
}

async function loginWithPlayFab(email, password) {
    if (!config.playFabTitleId) {
        const error = new Error("PlayFab title is not configured.");
        error.publicStatus = 503;
        throw error;
    }

    const response = await fetch(`https://${config.playFabTitleId}.playfabapi.com/Client/LoginWithEmailAddress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            TitleId: config.playFabTitleId,
            Email: email,
            Password: password,
            InfoRequestParameters: {
                GetPlayerProfile: true,
                GetUserAccountInfo: true,
                GetUserData: false,
                GetUserInventory: false,
                GetUserVirtualCurrency: false
            }
        })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200) {
        const error = new Error("Invalid email or password.");
        error.publicStatus = 401;
        throw error;
    }

    return payload.data;
}

function buildProfile(sessionPlayer) {
    return {
        displayName: sessionPlayer.displayName || "Captain",
        playFabId: maskPlayFabId(sessionPlayer.playFabId),
        email: maskEmail(sessionPlayer.email),
        createdAt: sessionPlayer.createdAt,
        lastLoginAt: sessionPlayer.lastLoginAt,
        level: sessionPlayer.level,
        xp: sessionPlayer.xp,
        gold: sessionPlayer.gold,
        diamonds: sessionPlayer.diamonds,
        sirenTears: sessionPlayer.sirenTears,
        combatGrade: sessionPlayer.combatGrade,
        elitePoints: sessionPlayer.elitePoints,
        equippedShip: sessionPlayer.equippedShip,
        equippedCannons: sessionPlayer.equippedCannons,
        stats: sessionPlayer.stats,
        environment: config.seabyssEnv
    };
}

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        environment: config.seabyssEnv,
        version: "0.1.0"
    });
});

app.post("/auth/login", loginLimiter, validateLoginInput, async (req, res, next) => {
    try {
        const { email, password } = req.loginInput;
        const data = await loginWithPlayFab(email, password);

        req.session.regenerate((regenerateError) => {
            if (regenerateError) {
                next(regenerateError);
                return;
            }

            const accountInfo = data.InfoResultPayload && data.InfoResultPayload.AccountInfo;
            const playerProfile = data.InfoResultPayload && data.InfoResultPayload.PlayerProfile;

            req.session.player = {
                playFabId: data.PlayFabId,
                email,
                displayName: data.NewlyCreated ? undefined : (playerProfile && playerProfile.DisplayName),
                createdAt: accountInfo && accountInfo.Created,
                lastLoginAt: new Date().toISOString()
            };

            res.json(publicSession(req));
        });
    } catch (error) {
        if (error.publicStatus === 401) {
            res.status(401).json({ message: "Invalid email or password." });
            return;
        }
        next(error);
    }
});

app.post("/auth/logout", (req, res) => {
    req.session.destroy(() => {
        res.clearCookie("seabyss.sid", {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax",
            domain: isProduction ? config.cookieDomain : undefined
        });
        res.json({ success: true });
    });
});

app.get("/auth/session", (req, res) => {
    res.json(publicSession(req));
});

app.get("/me", requireAuth, (req, res) => {
    res.json(buildProfile(req.session.player));
});

app.use((req, res) => {
    res.status(404).json({ message: "Not found." });
});

app.use((error, req, res, next) => {
    const status = error.publicStatus || 500;
    if (status >= 500) {
        console.error("Request failed", {
            path: req.path,
            method: req.method,
            message: error.message
        });
    }

    res.status(status).json({
        message: status >= 500 ? "Server unavailable. Please try again later." : error.message
    });
});

app.listen(config.port, () => {
    console.log(`Seabyss web API listening on port ${config.port} (${config.seabyssEnv}).`);
});
