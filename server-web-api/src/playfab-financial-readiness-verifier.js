import {
    evaluateFinancialAuthorityReadiness,
    parseEconomyV2CatalogMappings,
    requiredEconomyV2RewardIds
} from "./financial-authority-readiness.js";
import { PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME } from "./financial-authority-v2.js";

const DEFAULT_STACK_ID = "default";
const GENERATED_STACK_ID = "{guid}";

function coded(code, message, retryable = false) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
}

function canonical(value, name, maximumLength = 512) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function providerCode(payload) {
    return typeof payload?.error === "string" && payload.error.length <= 160
        ? payload.error : null;
}

export function createPlayFabFinancialReadinessClient({
    titleId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 8000
} = {}) {
    const normalizedTitleId = canonical(titleId, "titleId", 64);
    const normalizedSecretKey = canonical(secretKey, "secretKey", 4096);
    if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0 || timeoutMilliseconds > 30_000) {
        throw new TypeError("PlayFab financial readiness client is not configured.");
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
        } catch {
            throw coded("PLAYFAB_READINESS_UNAVAILABLE", "PlayFab readiness evidence is unavailable.", true);
        } finally {
            clearTimeout(timeout);
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200 || !payload.data) {
            const error = coded(
                "PLAYFAB_READINESS_REJECTED",
                "PlayFab rejected a read-only readiness request.",
                response.status === 408 || response.status === 429 || response.status >= 500
            );
            error.providerCode = providerCode(payload);
            throw error;
        }
        return payload.data;
    }

    return Object.freeze({
        getEntityToken() {
            return post("/Authentication/GetEntityToken", {
                Entity: { Id: normalizedTitleId, Type: "title" }
            }, "X-SecretKey", normalizedSecretKey);
        },
        getPublishedCatalogItems(entityToken, itemIds) {
            canonical(entityToken, "EntityToken", 8192);
            if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 50) {
                throw new TypeError("Published catalog item IDs are invalid.");
            }
            const ids = itemIds.map((itemId) => canonical(itemId, "catalog itemId", 255));
            return post("/Catalog/GetItems", {
                Entity: { Id: normalizedTitleId, Type: "title" },
                Ids: ids
            }, "X-EntityToken", entityToken);
        },
        getGlobalPolicy(entityToken) {
            canonical(entityToken, "EntityToken", 8192);
            return post("/Profile/GetGlobalPolicy", {
                Entity: { Id: normalizedTitleId, Type: "title" }
            }, "X-EntityToken", entityToken);
        }
    });
}

function resourceCoversObject(resource, objectName) {
    if (typeof resource !== "string") return false;
    return resource.endsWith(`/Profile/${objectName}`) || resource.endsWith("/Profile/*");
}

export function evaluatePlayFabClientWriteDenyPolicy({
    policy,
    protectedResource,
    objectName = PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME
} = {}) {
    let resource;
    let name;
    try {
        resource = canonical(protectedResource, "protectedResource", 1024);
        name = canonical(objectName, "objectName", 255);
    } catch {
        return Object.freeze({ proven: false, reason: "policy_expectation_invalid" });
    }
    if (!resourceCoversObject(resource, name)) {
        return Object.freeze({ proven: false, reason: "policy_resource_does_not_cover_authority_object" });
    }
    if (!policy || typeof policy !== "object" || !Array.isArray(policy.Permissions)) {
        return Object.freeze({ proven: false, reason: "global_policy_response_invalid" });
    }
    const match = policy.Permissions.find((statement) => {
        if (!statement || typeof statement !== "object" || statement.Effect !== "Deny" ||
            (statement.Action !== "Write" && statement.Action !== "*") ||
            statement.Resource !== resource || statement.Principal !== "*") {
            return false;
        }
        const condition = statement.Condition;
        return condition && typeof condition === "object" && !Array.isArray(condition) &&
            Object.keys(condition).length === 1 &&
            condition.CallingEntityType === "title_player_account";
    });
    return match
        ? Object.freeze({
            proven: true,
            reason: "explicit_title_player_write_deny",
            protectedResource: resource,
            objectName: name
        })
        : Object.freeze({ proven: false, reason: "explicit_title_player_write_deny_missing" });
}

function localExpectations(catalogMappings, protectedResource, objectName) {
    const staticReadiness = evaluateFinancialAuthorityReadiness({
        cutoverEnabled: true,
        economyV2Enabled: true,
        authorityV2Enabled: true,
        unityAuthorityVersion: "financial_v2",
        migrationVersion: "financial_v2",
        revisionCasEnabled: true,
        serverOwnedFieldsEnabled: true,
        financialRefreshEnabled: true,
        catalogMappings
    });
    const errors = [...staticReadiness.errors];
    let resource = null;
    try {
        resource = canonical(protectedResource, "protectedResource", 1024);
        if (!resourceCoversObject(resource, objectName)) {
            errors.push("policy resource must cover FinancialAuthorityV2");
        }
    } catch {
        errors.push("PLAYFAB_FINANCIAL_AUTHORITY_POLICY_RESOURCE");
    }
    let mappings = {};
    try {
        mappings = parseEconomyV2CatalogMappings(catalogMappings);
    } catch {
        errors.push("PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON");
    }
    const expectations = [];
    for (const rewardId of requiredEconomyV2RewardIds()) {
        const mapping = mappings[rewardId];
        if (!mapping || typeof mapping !== "object") continue;
        const stackId = mapping.stackId ?? DEFAULT_STACK_ID;
        if (stackId === GENERATED_STACK_ID) {
            errors.push(`deterministic Economy v2 stack:${rewardId}`);
            continue;
        }
        expectations.push(Object.freeze({
            rewardId,
            itemId: mapping.itemId,
            stackId,
            expectedType: rewardId === "diamonds" ? "currency" : "catalogItem"
        }));
    }
    return Object.freeze({
        errors: Object.freeze([...new Set(errors)]),
        expectations: Object.freeze(expectations),
        protectedResource: resource
    });
}

function validatePublishedItems(response, expectations) {
    const errors = [];
    if (!response || typeof response !== "object" || !Array.isArray(response.Items)) {
        return Object.freeze({ errors: Object.freeze(["published_catalog_response_invalid"]), itemCount: 0 });
    }
    const requestedIds = new Set(expectations.map((entry) => entry.itemId));
    const publishedById = new Map();
    for (const item of response.Items) {
        if (!item || typeof item !== "object" || typeof item.Id !== "string" ||
            !requestedIds.has(item.Id) || publishedById.has(item.Id)) {
            errors.push("published_catalog_response_invalid");
            continue;
        }
        publishedById.set(item.Id, item);
    }
    for (const expected of expectations) {
        const item = publishedById.get(expected.itemId);
        if (!item) {
            errors.push(`published_catalog_item_missing:${expected.rewardId}`);
            continue;
        }
        if (item.Type !== expected.expectedType) {
            errors.push(`published_catalog_type_mismatch:${expected.rewardId}`);
        }
        const publishedStackId = item.DefaultStackId ?? DEFAULT_STACK_ID;
        if (publishedStackId === GENERATED_STACK_ID || publishedStackId !== expected.stackId) {
            errors.push(`published_catalog_stack_mismatch:${expected.rewardId}`);
        }
    }
    return Object.freeze({
        errors: Object.freeze([...new Set(errors)]),
        itemCount: publishedById.size
    });
}

function frozenResult({ ready, errors, catalog, policy, objectName, checkedAtUnixMs }) {
    return Object.freeze({
        ready,
        healthy: ready,
        component: "playfab_financial_readiness_evidence",
        errors: Object.freeze([...errors]),
        catalog: Object.freeze({ ...catalog }),
        policy: Object.freeze({ ...policy }),
        objectName,
        checkedAtUnixMs
    });
}

export function createPlayFabFinancialReadinessVerifier({
    client,
    titleId,
    secretKey,
    fetchImpl,
    timeoutMilliseconds,
    catalogMappings,
    protectedResource,
    objectName = PLAYFAB_FINANCIAL_AUTHORITY_OBJECT_NAME,
    policyEvaluator = evaluatePlayFabClientWriteDenyPolicy,
    nowMilliseconds = () => Date.now()
} = {}) {
    const normalizedObjectName = canonical(objectName, "objectName", 255);
    if (typeof policyEvaluator !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Financial readiness verifier dependencies are invalid.");
    }
    const local = localExpectations(catalogMappings, protectedResource, normalizedObjectName);
    const playFab = local.errors.length > 0
        ? client || null
        : client || createPlayFabFinancialReadinessClient({
            titleId,
            secretKey,
            fetchImpl,
            timeoutMilliseconds
        });
    if (local.errors.length === 0) {
        for (const method of ["getEntityToken", "getPublishedCatalogItems", "getGlobalPolicy"]) {
            if (typeof playFab?.[method] !== "function") {
                throw new TypeError(`PlayFab readiness client.${method} is required.`);
            }
        }
    }
    let latest = null;
    let inFlight = null;

    async function run() {
        const checkedAtUnixMs = nowMilliseconds();
        if (!Number.isSafeInteger(checkedAtUnixMs) || checkedAtUnixMs < 0) {
            throw new TypeError("Financial readiness verifier clock is invalid.");
        }
        if (local.errors.length > 0) {
            return frozenResult({
                ready: false,
                errors: local.errors,
                catalog: { proven: false, publishedItemCount: 0 },
                policy: { proven: false, reason: "local_expectation_invalid" },
                objectName: normalizedObjectName,
                checkedAtUnixMs
            });
        }
        try {
            const tokenResult = await playFab.getEntityToken();
            const entityToken = canonical(tokenResult?.EntityToken, "EntityToken", 8192);
            if (tokenResult?.Entity &&
                (tokenResult.Entity.Type !== "title" || tokenResult.Entity.Id !== titleId)) {
                throw coded("PLAYFAB_READINESS_IDENTITY_MISMATCH", "Readiness token is not the configured title.");
            }
            const itemIds = [...new Set(local.expectations.map((entry) => entry.itemId))];
            const [catalogResponse, policyResponse] = await Promise.all([
                playFab.getPublishedCatalogItems(entityToken, itemIds),
                playFab.getGlobalPolicy(entityToken)
            ]);
            const catalog = validatePublishedItems(catalogResponse, local.expectations);
            const policy = policyEvaluator({
                policy: policyResponse,
                protectedResource: local.protectedResource,
                objectName: normalizedObjectName
            });
            const errors = [...catalog.errors];
            if (policy?.proven !== true) {
                errors.push(`client_write_policy_unproven:${policy?.reason || "invalid_evaluator_result"}`);
            }
            return frozenResult({
                ready: errors.length === 0,
                errors,
                catalog: { proven: catalog.errors.length === 0, publishedItemCount: catalog.itemCount },
                policy: {
                    proven: policy?.proven === true,
                    reason: policy?.reason || "invalid_evaluator_result"
                },
                objectName: normalizedObjectName,
                checkedAtUnixMs
            });
        } catch (error) {
            return frozenResult({
                ready: false,
                errors: [error?.code || "PLAYFAB_READINESS_PROBE_FAILED"],
                catalog: { proven: false, publishedItemCount: 0 },
                policy: { proven: false, reason: "provider_probe_failed" },
                objectName: normalizedObjectName,
                checkedAtUnixMs
            });
        }
    }

    async function verify() {
        if (inFlight) return inFlight;
        inFlight = run().then((result) => {
            latest = result;
            return result;
        }).finally(() => { inFlight = null; });
        return inFlight;
    }

    function health() {
        return latest || Object.freeze({
            ready: false,
            healthy: false,
            component: "playfab_financial_readiness_evidence",
            errors: Object.freeze(["not_verified"]),
            objectName: normalizedObjectName
        });
    }

    return Object.freeze({ verify, probe: verify, health });
}
