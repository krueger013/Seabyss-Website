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

const combatGradeThresholds = [
    { min: 1000, grade: "Legende Abyssale" },
    { min: 750, grade: "Couronne Or" },
    { min: 500, grade: "Couronne Argent" },
    { min: 300, grade: "Couronne Bronze" },
    { min: 200, grade: "Crane Or" },
    { min: 150, grade: "Crane Argent" },
    { min: 100, grade: "Crane Bronze" },
    { min: 75, grade: "Bouclier Or" },
    { min: 50, grade: "Bouclier Argent" },
    { min: 30, grade: "Bouclier Bronze" },
    { min: 20, grade: "Or I" },
    { min: 10, grade: "Argent I" },
    { min: 1, grade: "Bronze I" }
];

const shipNameById = {
    elite_1: "Elite Ship 1"
};

const cannonNameById = {
    carronade: "Carronade",
    long_range_cannon: "Long Range Cannon",
    iron_cannon: "Iron Cannon"
};

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

function toReadableId(id) {
    if (typeof id !== "string" || !id.trim()) {
        return null;
    }

    return id
        .trim()
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatNumber(value) {
    const number = toPublicNumber(value);
    return number === null ? null : new Intl.NumberFormat("en-US").format(number);
}

function formatDateTime(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

function deriveCombatGrade(combatPoints) {
    const points = toPublicNumber(combatPoints);
    if (!points || points <= 0) {
        return "Unranked";
    }

    const match = combatGradeThresholds.find((grade) => points >= grade.min);
    return match ? match.grade : "Unranked";
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

function emptyGameplayProfile() {
    return {
        gold: null,
        diamonds: null,
        sirenTears: null,
        xp: null,
        level: null,
        elitePoints: null,
        combatPoints: null,
        combatGrade: null,
        equippedShip: null,
        equippedShipId: null,
        equippedCannons: [],
        npcKills: null,
        boardingCount: null,
        playerKills: null
    };
}

function toPublicNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
}

function calculateLevel(xp) {
    const safeXp = Math.max(0, Number(xp) || 0);
    return Math.max(1, Math.floor(Math.sqrt(safeXp / 100)) + 1);
}

function summarizeEquippedCannons(cannons) {
    if (!Array.isArray(cannons)) {
        return [];
    }

    return cannons
        .map((cannon) => ({
            id: typeof cannon.id === "string" ? cannon.id : null,
            name: cannonNameById[cannon.id] || toReadableId(cannon.id),
            equipped: toPublicNumber(cannon.equipped)
        }))
        .filter((cannon) => cannon.id && cannon.equipped && cannon.equipped > 0);
}

function buildGameplaySummary(rawProfile) {
    if (!rawProfile || typeof rawProfile !== "object") {
        return emptyGameplayProfile();
    }

    const xp = toPublicNumber(rawProfile.xp);
    const equippedShipId = typeof rawProfile.equippedEliteShipId === "string" && rawProfile.equippedEliteShipId
        ? rawProfile.equippedEliteShipId
        : null;
    const playerKills = toPublicNumber(rawProfile.playerKills);
    const storedCombatPoints = toPublicNumber(rawProfile.combatPoints);
    // PlayerProfileData.playerKills is currently the available persisted score for the web combat profile.
    const combatPoints = storedCombatPoints === null ? playerKills : storedCombatPoints;
    const storedCombatGrade = typeof rawProfile.combatGrade === "string" && rawProfile.combatGrade
        ? rawProfile.combatGrade
        : null;

    return {
        gold: toPublicNumber(rawProfile.gold),
        diamonds: toPublicNumber(rawProfile.diamonds),
        sirenTears: toPublicNumber(rawProfile.sirenTears),
        xp,
        level: xp === null ? null : calculateLevel(xp),
        elitePoints: toPublicNumber(rawProfile.elitePoints),
        combatPoints,
        combatGrade: storedCombatGrade || deriveCombatGrade(combatPoints),
        equippedShip: equippedShipId ? shipNameById[equippedShipId] || toReadableId(equippedShipId) : null,
        equippedShipId,
        equippedCannons: summarizeEquippedCannons(rawProfile.cannons),
        npcKills: toPublicNumber(rawProfile.npcKills),
        boardingCount: toPublicNumber(rawProfile.boardingCount),
        playerKills
    };
}

async function getGameplayProfile(playFabId) {
    if (!playFabId || !config.playFabTitleId || !config.playFabSecretKey) {
        return emptyGameplayProfile();
    }

    try {
        const response = await fetch(`https://${config.playFabTitleId}.playfabapi.com/Server/GetUserInternalData`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-SecretKey": config.playFabSecretKey
            },
            body: JSON.stringify({
                PlayFabId: playFabId,
                Keys: ["profile_v1"]
            })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.code !== 200) {
            console.error("PlayFab gameplay profile request failed", {
                playFabId: maskPlayFabId(playFabId),
                status: response.status,
                code: payload.error || "unknown"
            });
            return emptyGameplayProfile();
        }

        const rawValue = payload.data &&
            payload.data.Data &&
            payload.data.Data.profile_v1 &&
            payload.data.Data.profile_v1.Value;

        if (!rawValue) {
            return emptyGameplayProfile();
        }

        try {
            return buildGameplaySummary(JSON.parse(rawValue));
        } catch (error) {
            console.error("PlayFab gameplay profile JSON invalid", {
                playFabId: maskPlayFabId(playFabId),
                message: error.message
            });
            return emptyGameplayProfile();
        }
    } catch (error) {
        console.error("PlayFab gameplay profile unavailable", {
            playFabId: maskPlayFabId(playFabId),
            message: error.message
        });
        return emptyGameplayProfile();
    }
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

async function buildProfile(sessionPlayer) {
    const gameplay = await getGameplayProfile(sessionPlayer.playFabId);
    const equippedCannonsLabel = gameplay.equippedCannons.length
        ? gameplay.equippedCannons.map((cannon) => `${cannon.name || cannon.id} x${formatNumber(cannon.equipped)}`).join(", ")
        : null;

    return {
        displayName: sessionPlayer.displayName || "Captain",
        playFabId: maskPlayFabId(sessionPlayer.playFabId),
        email: maskEmail(sessionPlayer.email),
        createdAt: formatDateTime(sessionPlayer.createdAt),
        lastLoginAt: formatDateTime(sessionPlayer.lastLoginAt),
        level: formatNumber(gameplay.level),
        xp: formatNumber(gameplay.xp),
        gold: formatNumber(gameplay.gold),
        diamonds: formatNumber(gameplay.diamonds),
        sirenTears: formatNumber(gameplay.sirenTears),
        combatGrade: gameplay.combatGrade,
        elitePoints: formatNumber(gameplay.elitePoints),
        equippedShip: gameplay.equippedShip,
        equippedCannons: equippedCannonsLabel,
        stats: {
            "Combat points": formatNumber(gameplay.combatPoints),
            "Player kills": formatNumber(gameplay.playerKills),
            "NPC kills": formatNumber(gameplay.npcKills),
            "Boardings": formatNumber(gameplay.boardingCount)
        },
        gameplay,
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

app.get("/me", requireAuth, async (req, res, next) => {
    try {
        res.json(await buildProfile(req.session.player));
    } catch (error) {
        next(error);
    }
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
