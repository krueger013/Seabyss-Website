import { createHash } from "node:crypto";
import {
    PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
    validateFinancialAuthority
} from "./financial-authority-v2.js";
import {
    createPlayFabFinancialCanonicalReadClient,
    PLAYFAB_FINANCIAL_PROFILE_V1_OBJECT_NAME,
    PLAYFAB_LEGACY_PROFILE_KEY
} from "./playfab-financial-canonical-reader.js";

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

function coded(code, message, retryable = false) {
    const error = new Error(message);
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

function validateRegistry(registry) {
    if (!registry || !Array.isArray(registry.quantityIds) || !plain(registry.byId) ||
        typeof registry.projectLegacy !== "function" || typeof registry.projectV2 !== "function") {
        throw new TypeError("Exhaustive gameplay financial registry is required.");
    }
    const targets = new Set();
    for (const resourceId of registry.quantityIds) {
        const descriptor = registry.byId[resourceId];
        if (descriptor?.semantic !== "quantity" || !plain(descriptor.economy)) {
            throw new TypeError(`Gameplay Economy mapping is absent:${resourceId}`);
        }
        const target = JSON.stringify([descriptor.economy.itemId, descriptor.economy.stackId]);
        if (targets.has(target)) throw new TypeError("Gameplay Economy targets are not unique.");
        targets.add(target);
    }
}

function validateClient(client) {
    for (const method of [
        "getUserAccountInfo", "getUserInternalData", "getUserInventory", "getEntityToken",
        "getObjects", "getInventoryItems"
    ]) {
        if (typeof client?.[method] !== "function") {
            throw new TypeError(`PlayFab gameplay financial reader client.${method} is required.`);
        }
    }
}

function entityFromAccount(account, playFabId) {
    if (account?.UserInfo?.PlayFabId !== playFabId) {
        throw coded("PLAYFAB_IDENTITY_MISMATCH", "PlayFab returned another legacy account.");
    }
    return Object.freeze({
        Id: canonical(account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id, "TitlePlayerAccount.Id", 128),
        Type: "title_player_account"
    });
}

function parseProfile(data, playFabId, maximumProfileBytes) {
    const raw = data?.Data?.[PLAYFAB_LEGACY_PROFILE_KEY]?.Value;
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

function objectData(objects, objectName) {
    const value = objects?.Objects?.[objectName]?.DataObject;
    return value === undefined ? null : value;
}

function financialV1(value, playFabId) {
    if (value === null) return null;
    const profile = plain(value?.playerProfile) ? value.playerProfile : value;
    if (!plain(profile) || profile.playerAccountId !== playFabId) {
        throw coded("FINANCIAL_PROFILE_V1_INVALID", "SeabyssFinancialProfileV1 identity is invalid.");
    }
    return value;
}

function authorityV2(value, playFabId, objectVersion) {
    if (value === null) {
        return deepFreeze({ migrated: false, objectVersion, financialRevision: 0, authority: null });
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

function confirmedSkus(values, registry) {
    if (!Array.isArray(values)) throw new TypeError("confirmed Starter ownership must be an array.");
    const allowed = new Set(registry.starterSkus);
    const result = new Set();
    for (const value of values) {
        canonical(value, "confirmed Starter SKU", 255);
        if (!allowed.has(value)) throw new TypeError("confirmed Starter ownership contains an unknown SKU.");
        result.add(value);
    }
    return [...result].sort((left, right) => left.localeCompare(right));
}

function currencyBalances(inventory, registry) {
    if (!plain(inventory?.VirtualCurrency)) {
        throw coded("LEGACY_CURRENCY_RESPONSE_INVALID", "Legacy virtual currency response is invalid.");
    }
    const requiredCodes = new Set(registry.quantityIds
        .map((resourceId) => registry.byId[resourceId].legacy)
        .filter((legacy) => legacy.kind === "virtual_currency")
        .map((legacy) => legacy.currencyCode));
    const balances = {};
    for (const code of requiredCodes) {
        balances[code] = nonNegative(inventory.VirtualCurrency[code], `${code} legacy balance`);
    }
    return balances;
}

export function createPlayFabFinancialGameplayReader({
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
        throw new TypeError("Gameplay financial reader dependencies are invalid.");
    }
    const descriptorByItemId = new Map(registry.quantityIds.map((resourceId) => [
        registry.byId[resourceId].economy.itemId,
        registry.byId[resourceId]
    ]));

    async function context(playFabId) {
        canonical(playFabId, "playFabId", 128);
        const [account, tokenResult] = await Promise.all([
            playFab.getUserAccountInfo(playFabId),
            playFab.getEntityToken()
        ]);
        return {
            entity: entityFromAccount(account, playFabId),
            entityToken: canonical(tokenResult?.EntityToken, "EntityToken", 8192)
        };
    }

    async function economySnapshot(entity, entityToken) {
        const quantities = Object.fromEntries(registry.quantityIds.map((resourceId) => [resourceId, 0]));
        const seenStacks = new Set();
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
                const resourceId = descriptor.resourceId;
                const stackId = item.StackId ?? "default";
                if (stackId !== descriptor.economy.stackId || item.Type !== descriptor.economy.inventoryType) {
                    throw coded("ECONOMY_V2_MAPPING_MISMATCH", `Economy v2 mapping mismatch:${resourceId}`);
                }
                const target = JSON.stringify([item.Id, stackId]);
                if (seenStacks.has(target)) {
                    throw coded("ECONOMY_V2_DUPLICATE_STACK", `Economy v2 duplicate stack:${resourceId}`);
                }
                seenStacks.add(target);
                quantities[resourceId] = nonNegative(item.Amount, `${resourceId} amount`);
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
        const entity = entityFromAccount(account, playFabId);
        const profileV1 = parseProfile(data, playFabId, maximumProfileBytes);
        const legacyCurrencyBalances = currencyBalances(inventory, registry);
        const confirmedStarterSkus = confirmedSkus(confirmed, registry);
        const projection = registry.projectLegacy({
            playFabId,
            profile: profileV1,
            legacyCurrencyBalances,
            confirmedStarterSkus
        });
        return deepFreeze({
            schemaVersion: 1,
            playFabId,
            titlePlayerAccountId: entity.Id,
            profileV1,
            legacyCurrencyBalances,
            legacyDmBalance: legacyCurrencyBalances.DM,
            legacyGoldBalance: legacyCurrencyBalances.GD,
            confirmedStarterSkus,
            projection,
            evidence: {
                profileV1Digest: digest(profileV1),
                legacyCurrenciesDigest: digest(legacyCurrencyBalances),
                confirmedStarterOwnershipDigest: digest(confirmedStarterSkus)
            }
        });
    }

    async function readFinancialV2(playFabId) {
        const ctx = await context(playFabId);
        const [objects, economy] = await Promise.all([
            playFab.getObjects(ctx.entity, ctx.entityToken),
            economySnapshot(ctx.entity, ctx.entityToken)
        ]);
        const objectVersion = nonNegative(objects?.ProfileVersion ?? 0, "ProfileVersion");
        const profileV1Object = financialV1(
            objectData(objects, PLAYFAB_FINANCIAL_PROFILE_V1_OBJECT_NAME),
            playFabId
        );
        const authority = authorityV2(
            objectData(objects, PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME),
            playFabId,
            objectVersion
        );
        const projection = authority.migrated
            ? registry.projectV2({
                playFabId,
                economyV2Quantities: economy.quantities,
                authority: authority.authority
            })
            : null;
        return deepFreeze({
            schemaVersion: 1,
            playFabId,
            titlePlayerAccountId: ctx.entity.Id,
            financialProfileV1: profileV1Object,
            economyV2Quantities: economy.quantities,
            economyV2Etag: economy.etag,
            economyV2Pages: economy.pages,
            economyV2CollectionId: economy.collectionId,
            authorityV2: authority,
            projection,
            evidence: {
                financialProfileV1Digest: digest(profileV1Object),
                economyV2Digest: digest({
                    collectionId: economy.collectionId,
                    etag: economy.etag,
                    quantities: economy.quantities
                }),
                authorityV2Digest: digest(authority.authority)
            }
        });
    }

    async function readMigrationSources(playFabId) {
        const observedAtUnixMs = nonNegative(nowMilliseconds(), "observedAtUnixMs");
        const [legacy, financialV2] = await Promise.all([readLegacy(playFabId), readFinancialV2(playFabId)]);
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
            legacyCurrencyBalances: structuredClone(legacy.legacyCurrencyBalances),
            legacyDmBalance: legacy.legacyDmBalance,
            legacyGoldBalance: legacy.legacyGoldBalance,
            confirmedStarterSkus: [...legacy.confirmedStarterSkus],
            economyV2Quantities: structuredClone(financialV2.economyV2Quantities),
            economyV2Etag: financialV2.economyV2Etag,
            authorityV2: structuredClone(financialV2.authorityV2),
            legacyProjection: structuredClone(legacy.projection),
            financialV2Projection: structuredClone(financialV2.projection),
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
