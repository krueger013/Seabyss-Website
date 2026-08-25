import { createHash } from "node:crypto";
import {
    PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
    validateFinancialAuthority
} from "./financial-authority-v2.js";

export const PLAYFAB_FINANCIAL_PROFILE_V1_OBJECT_NAME = "SeabyssFinancialProfileV1";
export const PLAYFAB_LEGACY_PROFILE_KEY = "profile_v1";
export const PLAYFAB_LEGACY_DIAMOND_CURRENCY = "DM";

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, name, maximumLength = 512) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegative(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
    return value;
}

function coded(code, message, retryable = false, cause = undefined) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.code = code;
    error.retryable = retryable;
    return error;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!plain(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

function providerCode(payload) {
    return typeof payload?.error === "string" && payload.error.length <= 160
        ? payload.error
        : null;
}

export function createPlayFabFinancialCanonicalReadClient({
    titleId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 8000
} = {}) {
    const normalizedTitleId = canonical(titleId, "titleId", 64);
    const normalizedSecret = canonical(secretKey, "secretKey", 4096);
    if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0 || timeoutMilliseconds > 30_000) {
        throw new TypeError("PlayFab canonical financial read client is not configured.");
    }
    const baseUrl = `https://${normalizedTitleId}.playfabapi.com`;

    async function post(path, body, headerName, credential) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
        let response;
        try {
            response = await fetchImpl(`${baseUrl}${path}`, {
                method: "POST",
                redirect: "error",
                signal: controller.signal,
                headers: { "Content-Type": "application/json", [headerName]: credential },
                body: JSON.stringify(body)
            });
        } catch (error) {
            throw coded("PLAYFAB_FINANCIAL_READ_UNAVAILABLE", "PlayFab financial read is unavailable.", true, error);
        } finally {
            clearTimeout(timeout);
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200 || !plain(payload.data)) {
            const error = coded(
                "PLAYFAB_FINANCIAL_READ_REJECTED",
                "PlayFab rejected a canonical financial read.",
                response.status === 408 || response.status === 429 || response.status >= 500
            );
            error.providerCode = providerCode(payload);
            const retryAfter = response.headers?.get?.("retry-after");
            if (response.status === 429 && typeof retryAfter === "string" && /^\d+$/u.test(retryAfter)) {
                error.retryAfterMilliseconds = Math.min(300_000, Number(retryAfter) * 1000);
            }
            throw error;
        }
        return payload.data;
    }

    return Object.freeze({
        getUserAccountInfo(playFabId) {
            return post("/Server/GetUserAccountInfo", { PlayFabId: playFabId }, "X-SecretKey", normalizedSecret);
        },
        getUserInternalData(playFabId) {
            return post("/Server/GetUserInternalData", {
                PlayFabId: playFabId,
                Keys: [PLAYFAB_LEGACY_PROFILE_KEY]
            }, "X-SecretKey", normalizedSecret);
        },
        getUserInventory(playFabId) {
            return post("/Server/GetUserInventory", { PlayFabId: playFabId }, "X-SecretKey", normalizedSecret);
        },
        getEntityToken() {
            return post("/Authentication/GetEntityToken", {
                Entity: { Id: normalizedTitleId, Type: "title" }
            }, "X-SecretKey", normalizedSecret);
        },
        getObjects(entity, entityToken) {
            canonical(entityToken, "EntityToken", 8192);
            return post("/Object/GetObjects", { Entity: entity }, "X-EntityToken", entityToken);
        },
        getInventoryItems(entity, entityToken, { collectionId, continuationToken, count }) {
            canonical(entityToken, "EntityToken", 8192);
            const request = { Entity: entity, CollectionId: collectionId, Count: count };
            if (continuationToken !== null) request.ContinuationToken = continuationToken;
            return post("/Inventory/GetInventoryItems", request, "X-EntityToken", entityToken);
        }
    });
}

function validateClient(client) {
    for (const method of [
        "getUserAccountInfo",
        "getUserInternalData",
        "getUserInventory",
        "getEntityToken",
        "getObjects",
        "getInventoryItems"
    ]) {
        if (typeof client?.[method] !== "function") {
            throw new TypeError(`PlayFab canonical financial reader client.${method} is required.`);
        }
    }
}

function validateRegistry(registry) {
    if (!registry || !Array.isArray(registry.resources) || !Array.isArray(registry.quantityIds) ||
        typeof registry.projectLegacy !== "function" || typeof registry.projectV2 !== "function") {
        throw new TypeError("Canonical financial resource registry is required.");
    }
    const targets = new Set();
    for (const rewardId of registry.quantityIds) {
        const descriptor = registry.byId?.[rewardId];
        if (!descriptor?.economy) throw new TypeError(`Economy mapping is absent:${rewardId}`);
        const target = JSON.stringify([descriptor.economy.itemId, descriptor.economy.stackId]);
        if (targets.has(target)) throw new TypeError("Canonical Economy targets are not unique.");
        targets.add(target);
    }
}

function accountEntity(account, playFabId) {
    if (account?.UserInfo?.PlayFabId !== playFabId) {
        throw coded("PLAYFAB_IDENTITY_MISMATCH", "PlayFab returned another legacy account.");
    }
    return Object.freeze({
        Id: canonical(account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id, "TitlePlayerAccount.Id", 128),
        Type: "title_player_account"
    });
}

function parseLegacyProfile(result, playFabId, maximumProfileBytes) {
    const raw = result?.Data?.[PLAYFAB_LEGACY_PROFILE_KEY]?.Value;
    if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > maximumProfileBytes) {
        throw coded("LEGACY_PROFILE_MISSING", "profile_v1 is absent or exceeds its read limit.");
    }
    let profile;
    try { profile = JSON.parse(raw); } catch {
        throw coded("LEGACY_PROFILE_INVALID", "profile_v1 is not valid JSON.");
    }
    if (!plain(profile) || profile.playerAccountId !== playFabId) {
        throw coded("LEGACY_PROFILE_IDENTITY_MISMATCH", "profile_v1 identity is invalid.");
    }
    return profile;
}

function legacyDm(result) {
    return nonNegative(result?.VirtualCurrency?.[PLAYFAB_LEGACY_DIAMOND_CURRENCY], "legacy DM balance");
}

function objectData(objects, name) {
    const value = objects?.Objects?.[name]?.DataObject;
    return value === undefined ? null : value;
}

function validateFinancialV1(value, playFabId) {
    if (value === null) return null;
    const profile = plain(value?.playerProfile) ? value.playerProfile : value;
    if (!plain(profile) || profile.playerAccountId !== playFabId) {
        throw coded("FINANCIAL_PROFILE_V1_INVALID", "SeabyssFinancialProfileV1 identity is invalid.");
    }
    return value;
}

function normalizeAuthority(value, playFabId, objectVersion) {
    if (value === null) {
        return Object.freeze({ migrated: false, objectVersion, financialRevision: 0, authority: null });
    }
    const authority = structuredClone(value);
    validateFinancialAuthority(authority, playFabId);
    return deepFreeze({
        migrated: true,
        objectVersion,
        financialRevision: authority.financialRevision,
        authority
    });
}

function validateConfirmedStarterSkus(values, registry) {
    if (!Array.isArray(values)) throw new TypeError("confirmed Starter ownership must be an array.");
    const allowed = new Set(registry.starterSkus);
    const seen = new Set();
    for (const value of values) {
        canonical(value, "confirmed Starter SKU", 255);
        if (!allowed.has(value)) throw new TypeError("confirmed Starter ownership contains an unknown SKU.");
        seen.add(value);
    }
    return [...seen].sort((left, right) => left.localeCompare(right));
}

export function createPlayFabFinancialCanonicalReader({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMilliseconds,
    registry,
    collectionId = "default",
    pageSize = 50,
    maximumPages = 200,
    maximumProfileBytes = 1024 * 1024,
    readConfirmedStarterOwnership = async () => [],
    nowMilliseconds = () => Date.now()
} = {}) {
    const playFab = client || createPlayFabFinancialCanonicalReadClient({
        titleId,
        secretKey,
        fetchImpl,
        timeoutMilliseconds
    });
    validateClient(playFab);
    validateRegistry(registry);
    const normalizedCollectionId = canonical(collectionId, "collectionId", 255);
    for (const [name, value, maximum] of [
        ["pageSize", pageSize, 50],
        ["maximumPages", maximumPages, 10_000],
        ["maximumProfileBytes", maximumProfileBytes, 16 * 1024 * 1024]
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
            throw new TypeError(`${name} is invalid.`);
        }
    }
    if (typeof readConfirmedStarterOwnership !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Canonical financial reader dependencies are invalid.");
    }
    const descriptorByItemId = new Map();
    for (const rewardId of registry.quantityIds) {
        const descriptor = registry.byId[rewardId];
        descriptorByItemId.set(descriptor.economy.itemId, descriptor);
    }

    async function context(playFabId) {
        canonical(playFabId, "playFabId", 128);
        const [account, tokenResult] = await Promise.all([
            playFab.getUserAccountInfo(playFabId),
            playFab.getEntityToken()
        ]);
        const entity = accountEntity(account, playFabId);
        const entityToken = canonical(tokenResult?.EntityToken, "EntityToken", 8192);
        return { entity, entityToken };
    }

    async function readEconomy(entity, entityToken) {
        const quantities = Object.fromEntries(registry.quantityIds.map((rewardId) => [rewardId, 0]));
        const seenTargets = new Set();
        const seenTokens = new Set();
        let continuationToken = null;
        let etag = null;
        let pages = 0;
        do {
            if (pages >= maximumPages) {
                throw coded("ECONOMY_V2_PAGINATION_LIMIT", "Economy v2 inventory exceeded its pagination bound.");
            }
            const page = await playFab.getInventoryItems(entity, entityToken, {
                collectionId: normalizedCollectionId,
                continuationToken,
                count: pageSize
            });
            pages += 1;
            const pageEtag = canonical(page?.ETag, "Economy v2 ETag", 1024);
            if (etag !== null && etag !== pageEtag) {
                throw coded("ECONOMY_V2_SNAPSHOT_DRIFT", "Economy v2 ETag changed during pagination.", true);
            }
            etag = pageEtag;
            if (!Array.isArray(page?.Items)) {
                throw coded("ECONOMY_V2_RESPONSE_INVALID", "Economy v2 inventory response is invalid.");
            }
            for (const item of page.Items) {
                if (!plain(item) || typeof item.Id !== "string") {
                    throw coded("ECONOMY_V2_RESPONSE_INVALID", "Economy v2 inventory contains an invalid item.");
                }
                const descriptor = descriptorByItemId.get(item.Id);
                if (!descriptor) continue;
                const stackId = item.StackId ?? "default";
                if (stackId !== descriptor.economy.stackId || item.Type !== descriptor.economy.inventoryType) {
                    throw coded(
                        "ECONOMY_V2_MAPPING_MISMATCH",
                        `Economy v2 item does not match the canonical mapping:${descriptor.rewardId}`
                    );
                }
                const target = JSON.stringify([item.Id, stackId]);
                if (seenTargets.has(target)) {
                    throw coded("ECONOMY_V2_DUPLICATE_STACK", `Economy v2 returned a duplicate stack:${descriptor.rewardId}`);
                }
                seenTargets.add(target);
                quantities[descriptor.rewardId] = nonNegative(item.Amount, `${descriptor.rewardId} amount`);
            }
            const next = page.ContinuationToken ?? null;
            if (next !== null) {
                canonical(next, "ContinuationToken", 8192);
                if (seenTokens.has(next)) {
                    throw coded("ECONOMY_V2_PAGINATION_CYCLE", "Economy v2 returned a repeated continuation token.");
                }
                seenTokens.add(next);
            }
            continuationToken = next;
        } while (continuationToken !== null);
        return deepFreeze({ quantities, etag, pages, collectionId: normalizedCollectionId });
    }

    async function readLegacy(playFabId) {
        canonical(playFabId, "playFabId", 128);
        const [account, data, inventory, confirmed] = await Promise.all([
            playFab.getUserAccountInfo(playFabId),
            playFab.getUserInternalData(playFabId),
            playFab.getUserInventory(playFabId),
            readConfirmedStarterOwnership(playFabId)
        ]);
        const entity = accountEntity(account, playFabId);
        const profileV1 = parseLegacyProfile(data, playFabId, maximumProfileBytes);
        const legacyDmBalance = legacyDm(inventory);
        const confirmedStarterSkus = validateConfirmedStarterSkus(confirmed, registry);
        const projection = registry.projectLegacy({
            playFabId,
            profile: profileV1,
            legacyDmBalance,
            confirmedStarterSkus
        });
        const snapshot = {
            schemaVersion: 1,
            playFabId,
            titlePlayerAccountId: entity.Id,
            profileV1,
            legacyDmBalance,
            confirmedStarterSkus,
            projection,
            evidence: {
                profileV1Digest: digest(profileV1),
                legacyDmDigest: digest({ currencyCode: PLAYFAB_LEGACY_DIAMOND_CURRENCY, balance: legacyDmBalance }),
                confirmedStarterOwnershipDigest: digest(confirmedStarterSkus)
            }
        };
        return deepFreeze(snapshot);
    }

    async function readFinancialV2(playFabId) {
        const ctx = await context(playFabId);
        const [objects, economy] = await Promise.all([
            playFab.getObjects(ctx.entity, ctx.entityToken),
            readEconomy(ctx.entity, ctx.entityToken)
        ]);
        const objectVersion = nonNegative(objects?.ProfileVersion ?? 0, "ProfileVersion");
        const financialProfileV1 = validateFinancialV1(
            objectData(objects, PLAYFAB_FINANCIAL_PROFILE_V1_OBJECT_NAME),
            playFabId
        );
        const authorityV2 = normalizeAuthority(
            objectData(objects, PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME),
            playFabId,
            objectVersion
        );
        const snapshot = {
            schemaVersion: 1,
            playFabId,
            titlePlayerAccountId: ctx.entity.Id,
            financialProfileV1,
            economyV2Quantities: economy.quantities,
            economyV2Etag: economy.etag,
            economyV2Pages: economy.pages,
            economyV2CollectionId: economy.collectionId,
            authorityV2,
            evidence: {
                financialProfileV1Digest: digest(financialProfileV1),
                economyV2Digest: digest({
                    collectionId: economy.collectionId,
                    etag: economy.etag,
                    quantities: economy.quantities
                }),
                authorityV2Digest: digest(authorityV2.authority)
            }
        };
        return deepFreeze(snapshot);
    }

    async function readMigrationSources(playFabId) {
        const observedAtUnixMs = nonNegative(nowMilliseconds(), "observedAtUnixMs");
        const [legacy, financialV2] = await Promise.all([
            readLegacy(playFabId),
            readFinancialV2(playFabId)
        ]);
        if (legacy.titlePlayerAccountId !== financialV2.titlePlayerAccountId) {
            throw coded("PLAYFAB_ENTITY_IDENTITY_MISMATCH", "Legacy and Entity reads resolved different players.");
        }
        return deepFreeze({
            schemaVersion: 1,
            observedAtUnixMs,
            observedAtUtc: new Date(observedAtUnixMs).toISOString(),
            playFabId,
            titlePlayerAccountId: legacy.titlePlayerAccountId,
            profileV1: structuredClone(legacy.profileV1),
            financialProfileV1: structuredClone(financialV2.financialProfileV1),
            legacyDmBalance: legacy.legacyDmBalance,
            confirmedStarterSkus: [...legacy.confirmedStarterSkus],
            economyV2Quantities: structuredClone(financialV2.economyV2Quantities),
            economyV2Etag: financialV2.economyV2Etag,
            authorityV2: structuredClone(financialV2.authorityV2),
            legacyProjection: structuredClone(legacy.projection),
            evidence: deepFreeze({ ...legacy.evidence, ...financialV2.evidence })
        });
    }

    return Object.freeze({
        readLegacy,
        readFinancialV2,
        readMigrationSources,
        loadSources: readMigrationSources,
        collectionId: normalizedCollectionId,
        registryDigest: registry.digest
    });
}
