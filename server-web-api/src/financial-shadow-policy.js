function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 503;
    throw error;
}

function identifier(value, name, maximumLength = 160) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

export function parseFinancialShadowAllowlist(value) {
    const values = Array.isArray(value)
        ? value
        : String(value || "").split(",");
    const result = new Set();
    for (const raw of values) {
        const entry = String(raw || "").trim();
        if (!entry) continue;
        if (entry === "*" || entry.includes("*")) {
            fail("FINANCIAL_SHADOW_WILDCARD_FORBIDDEN", "Financial Shadow allowlist cannot contain a wildcard.");
        }
        identifier(entry, "Financial Shadow PlayFabId", 160);
        result.add(entry);
    }
    return Object.freeze([...result].sort());
}

export function evaluateFinancialShadowPolicy({
    enabled = false,
    nodeEnv = "development",
    shadowEnvironment = "sandbox",
    allowlistedPlayFabIds = [],
    serverId = "",
    redisConfigured = false,
    playFabConfigured = false,
    purchasesGlobalEnabled = false,
    purchasesDiamondEnabled = false,
    purchasesStarterEnabled = false,
    purchasesPremiumEnabled = false,
    purchasesDoublerEnabled = false,
    checkoutSandboxEnabled = false,
    checkoutProductionEnabled = false,
    hardenedCatalogEnabled = false,
    financialAuthorityCutoverEnabled = false
} = {}) {
    const allowlist = parseFinancialShadowAllowlist(allowlistedPlayFabIds);
    const normalizedNodeEnv = identifier(String(nodeEnv), "NODE_ENV", 32);
    const normalizedEnvironment = identifier(String(shadowEnvironment), "FINANCIAL_SHADOW_ENVIRONMENT", 32);
    const anyPurchases = Boolean(
        purchasesGlobalEnabled || purchasesDiamondEnabled || purchasesStarterEnabled ||
        purchasesPremiumEnabled || purchasesDoublerEnabled || checkoutSandboxEnabled ||
        checkoutProductionEnabled || hardenedCatalogEnabled
    );

    if (!enabled) {
        return Object.freeze({
            enabled: false,
            nodeEnv: normalizedNodeEnv,
            shadowEnvironment: normalizedEnvironment,
            allowlistedPlayFabIds: allowlist,
            serverId: serverId ? identifier(serverId, "FINANCIAL_SHADOW_SERVER_ID", 160) : null,
            authoritative: false,
            targetPlayFabWritesAllowed: false
        });
    }
    if (normalizedNodeEnv === "production") {
        fail("FINANCIAL_SHADOW_PRODUCTION_FORBIDDEN", "Financial Shadow mode cannot run with NODE_ENV=production.");
    }
    if (!["sandbox", "development", "test"].includes(normalizedEnvironment)) {
        fail("FINANCIAL_SHADOW_ENVIRONMENT_FORBIDDEN", "Financial Shadow mode is restricted to Sandbox/development/test.");
    }
    if (financialAuthorityCutoverEnabled) {
        fail("FINANCIAL_SHADOW_CUTOVER_CONFLICT", "Financial Shadow mode cannot run during financial authority cutover.");
    }
    if (anyPurchases) {
        fail("FINANCIAL_SHADOW_PURCHASE_GATE_CONFLICT", "Financial Shadow mode requires every purchase and checkout gate to remain disabled.");
    }
    if (!redisConfigured) {
        fail("FINANCIAL_SHADOW_REDIS_REQUIRED", "Financial Shadow mode requires Redis durability.");
    }
    if (!playFabConfigured) {
        fail("FINANCIAL_SHADOW_PLAYFAB_AUTH_REQUIRED", "Financial Shadow mode requires PlayFab server authentication credentials.");
    }
    if (allowlist.length === 0) {
        fail("FINANCIAL_SHADOW_ALLOWLIST_REQUIRED", "Financial Shadow mode requires an explicit non-empty PlayFabId allowlist.");
    }
    const normalizedServerId = identifier(serverId, "FINANCIAL_SHADOW_SERVER_ID", 160);
    return Object.freeze({
        enabled: true,
        nodeEnv: normalizedNodeEnv,
        shadowEnvironment: normalizedEnvironment,
        allowlistedPlayFabIds: allowlist,
        allowlist: new Set(allowlist),
        serverId: normalizedServerId,
        authoritative: false,
        targetPlayFabWritesAllowed: false,
        redisRequired: true,
        sessionTicketAuthRequired: true
    });
}

export function assertFinancialShadowPlayerAllowed(policy, playFabId) {
    if (policy?.enabled !== true || !(policy.allowlist instanceof Set)) {
        fail("FINANCIAL_SHADOW_DISABLED", "Financial Shadow mode is disabled.");
    }
    const player = identifier(playFabId, "authenticated PlayFabId", 160);
    if (!policy.allowlist.has(player)) {
        const error = new Error("Authenticated player is not allowlisted for Financial Shadow mode.");
        error.code = "FINANCIAL_SHADOW_PLAYER_FORBIDDEN";
        error.statusCode = 403;
        throw error;
    }
    return player;
}
