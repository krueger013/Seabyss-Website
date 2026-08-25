import { createMemoryServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";
import { serverEconomyPocId, serverEconomyPocPositive, serverEconomyPocReadonly } from "./server-economy-poc-model.js";
import { createServerEconomyPocPlayFabSnapshotStore } from "./server-economy-poc-playfab-snapshot-store.js";

function requireClient(client) {
    for (const method of ["getUserAccountInfo", "getEntityToken", "getObjects", "setObjects"]) {
        if (typeof client?.[method] !== "function") {
            throw new TypeError(`Observed PlayFab client.${method} is required.`);
        }
    }
    return client;
}

function requireMetrics(metrics) {
    if (typeof metrics?.increment !== "function" || typeof metrics?.observe !== "function" ||
        typeof metrics?.snapshot !== "function") {
        throw new TypeError("Observed PlayFab HTTP metrics sink is incomplete.");
    }
    return metrics;
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export function createObservedServerEconomyPocPlayFabSnapshotStore({
    client,
    metrics = createMemoryServerEconomyPocMetrics(),
    nowMilliseconds = Date.now,
    monotonicMilliseconds = () => performance.now(),
    contextCacheTtlMilliseconds = 60_000,
    maximumCachedPlayers = 1_000,
    ...storeOptions
} = {}) {
    const upstream = requireClient(client);
    const sink = requireMetrics(metrics);
    const ttl = serverEconomyPocPositive(contextCacheTtlMilliseconds, "contextCacheTtlMilliseconds");
    const maximumPlayers = serverEconomyPocPositive(maximumCachedPlayers, "maximumCachedPlayers");
    if (typeof nowMilliseconds !== "function" || typeof monotonicMilliseconds !== "function") {
        throw new TypeError("Observed PlayFab clock functions are required.");
    }

    const accounts = new Map();
    let entityToken = null;

    function increment(name, value = 1, labels = {}) {
        try { sink.increment(name, value, labels); } catch {}
    }

    function observe(name, value, labels = {}) {
        try { sink.observe(name, value, labels); } catch {}
    }

    async function actualHttp(method, call) {
        const started = monotonicMilliseconds();
        increment("playfab_http_total");
        increment("playfab_http_method_total", 1, { method });
        if (method === "SetObjects") increment("playfab_set_objects_total");
        try {
            const result = await call();
            increment("playfab_http_success_total", 1, { method });
            return result;
        } catch (error) {
            increment("playfab_http_failure_total", 1, { method });
            throw error;
        } finally {
            observe("playfab_http_duration_ms", Math.max(0, monotonicMilliseconds() - started), { method });
        }
    }

    function cacheAccount(player, value) {
        if (accounts.size >= maximumPlayers && !accounts.has(player)) {
            accounts.delete(accounts.keys().next().value);
            increment("playfab_context_cache_eviction_total", 1, { kind: "account" });
        }
        accounts.set(player, {
            expiresAtUnixMs: nowMilliseconds() + ttl,
            value: clone(value)
        });
    }

    function tokenExpiry(value) {
        const providerExpiry = Date.parse(value?.TokenExpiration || "");
        const ttlExpiry = nowMilliseconds() + ttl;
        if (!Number.isFinite(providerExpiry)) return ttlExpiry;
        return Math.max(nowMilliseconds(), Math.min(ttlExpiry, providerExpiry - 5_000));
    }

    const observedClient = Object.freeze({
        async getUserAccountInfo(playFabId) {
            const player = serverEconomyPocId(playFabId, "playFabId", 160);
            const cached = accounts.get(player);
            if (cached && cached.expiresAtUnixMs > nowMilliseconds()) {
                increment("playfab_context_cache_hit_total", 1, { kind: "account" });
                return clone(cached.value);
            }
            if (cached) accounts.delete(player);
            increment("playfab_context_cache_miss_total", 1, { kind: "account" });
            const value = await actualHttp("GetUserAccountInfo", () => upstream.getUserAccountInfo(player));
            cacheAccount(player, value);
            return clone(value);
        },

        async getEntityToken() {
            if (entityToken && entityToken.expiresAtUnixMs > nowMilliseconds()) {
                increment("playfab_context_cache_hit_total", 1, { kind: "entity_token" });
                return clone(entityToken.value);
            }
            entityToken = null;
            increment("playfab_context_cache_miss_total", 1, { kind: "entity_token" });
            const value = await actualHttp("GetEntityToken", () => upstream.getEntityToken());
            entityToken = { expiresAtUnixMs: tokenExpiry(value), value: clone(value) };
            return clone(value);
        },

        getObjects(entity, token) {
            return actualHttp("GetObjects", () => upstream.getObjects(entity, token));
        },

        setObjects(entity, token, expectedProfileVersion, objects) {
            return actualHttp("SetObjects", () =>
                upstream.setObjects(entity, token, expectedProfileVersion, objects));
        }
    });

    const base = createServerEconomyPocPlayFabSnapshotStore({
        ...storeOptions,
        client: observedClient
    });

    function invalidateContext(playFabId = null) {
        if (playFabId === null || playFabId === undefined) {
            accounts.clear();
            entityToken = null;
            return;
        }
        accounts.delete(serverEconomyPocId(playFabId, "playFabId", 160));
    }

    async function probe() {
        entityToken = null;
        return base.probe();
    }

    return Object.freeze({
        ...base,
        probe,
        invalidateContext,
        httpMetricsSnapshot: () => serverEconomyPocReadonly(sink.snapshot()),
        contextCachePolicy: Object.freeze({
            ttlMilliseconds: ttl,
            maximumPlayers,
            bounded: true,
            readinessProbeBypassesTokenCache: true
        }),
        reportsActualPlayFabHttpCalls: true
    });
}
