#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SANDBOX_TITLE_ID = "1D0C16";
export const PRODUCTION_TITLE_ID = "142853";
export const CANARY_PLAYFAB_ID = "61AD15CDA4137EA9";
export const CANARY_ENTITY = Object.freeze({
    Id: "714E7F12EDBEA385",
    Type: "title_player_account"
});

export const PROTECTED_OBJECT_NAMES = Object.freeze([
    "SeabyssEconomyStateV1",
    "SeabyssEconomyFenceV1",
    "SeabyssEconomyProofV1",
    "SeabyssEconomyAmmoProofV1",
    "SeabyssFinancialAuthorityV2",
    "SeabyssFinancialProfileV1"
]);

export const REQUIRED_CLIENT_MUTATION_DENIES = Object.freeze([
    "pfrn:api--/Client/AddUserVirtualCurrency",
    "pfrn:api--/Client/SubtractUserVirtualCurrency",
    "pfrn:api--/Client/UpdatePlayerCustomProperties",
    "pfrn:api--/Object/SetObjects",
    "pfrn:api--/Inventory/AddInventoryItems",
    "pfrn:api--/Inventory/DeleteInventoryCollection",
    "pfrn:api--/Inventory/DeleteInventoryItems",
    "pfrn:api--/Inventory/ExecuteInventoryOperations",
    "pfrn:api--/Inventory/ExecuteTransferOperations",
    "pfrn:api--/Inventory/PurchaseInventoryItems",
    "pfrn:api--/Inventory/SubtractInventoryItems",
    "pfrn:api--/Inventory/TransferInventoryItems",
    "pfrn:api--/Inventory/UpdateInventoryItems"
]);

const ENV = Object.freeze({
    titleId: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID",
    secretKey: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY",
    sessionTicket: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_SESSION_TICKET"
});
const CERTIFICATION_COMMENT_PREFIX = "Seabyss financial sandbox certification";
const POLICY_DENIAL_CODES = new Set([
    "NotAuthorized",
    "NotAuthorizedByTitle",
    "EntityPermissionDenied",
    "Forbidden"
]);
const POLICY_DENIAL_NUMERIC_CODES = new Set([1089, 1191]);
const TOKEN_FAILURE_CODES = new Set([
    "EntityTokenMissing",
    "EntityTokenInvalid",
    "EntityTokenExpired",
    "EntityTokenRevoked"
]);
const ACTIVE_GATE_NAMES = Object.freeze([
    "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED",
    "PURCHASES_STARTER_ENABLED",
    "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED",
    "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED",
    "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED"
]);

class SafeCertificationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "SafeCertificationError";
        this.code = code;
        this.details = details;
    }
}

function fail(code, message, details) {
    throw new SafeCertificationError(code, message, details);
}

function requiredEnvironment(name, maximumLength = 8192) {
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value !== value.trim()) {
        fail("CERTIFICATION_ENV_MISSING", `${name} is missing or invalid.`);
    }
    return value;
}

export function assertSafeTitle(titleId) {
    if (typeof titleId !== "string" || titleId.length === 0) {
        fail("SANDBOX_TITLE_REQUIRED", "Sandbox Title ID is required.");
    }
    if (titleId === PRODUCTION_TITLE_ID) {
        fail("PRODUCTION_TITLE_REFUSED", "Production Title 142853 is forbidden.");
    }
    if (titleId !== SANDBOX_TITLE_ID) {
        fail("SANDBOX_TITLE_MISMATCH", `Only Sandbox Title ${SANDBOX_TITLE_ID} is allowed.`);
    }
    return titleId;
}

function assertSafeRuntime(mode) {
    if ((process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
        fail("PRODUCTION_RUNTIME_REFUSED", "The certification harness cannot run with NODE_ENV=production.");
    }
    for (const name of ACTIVE_GATE_NAMES) {
        if ((process.env[name] || "").trim().toLowerCase() === "true") {
            fail("ACTIVE_GATE_REFUSED", `${name} must remain false.`);
        }
    }
    const titleId = assertSafeTitle(requiredEnvironment(ENV.titleId, 64));
    const secretKey = requiredEnvironment(ENV.secretKey, 4096);
    const sessionTicket = mode === "certify"
        ? requiredEnvironment(ENV.sessionTicket, 8192)
        : process.env[ENV.sessionTicket] || "";
    return Object.freeze({ titleId, secretKey, sessionTicket });
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function digest(value) {
    return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function clone(value) {
    return structuredClone(value);
}

function globalDenyStatement(objectName) {
    return {
        Resource: `pfrn:data--*!*/Profile/${objectName}`,
        Action: "Write",
        Effect: "Deny",
        Principal: "*",
        Comment: `${CERTIFICATION_COMMENT_PREFIX}: ${objectName} is server-owned`,
        Condition: { CallingEntityType: "title_player_account" }
    };
}

function apiDenyStatement(resource) {
    return {
        Resource: resource,
        Action: "*",
        Effect: "Deny",
        Principal: "{\"title_player_account\":\"*\"}",
        Comment: `${CERTIFICATION_COMMENT_PREFIX}: client mutation is server-owned`
    };
}

function isTitlePlayerPrincipal(value) {
    if (value && typeof value === "object" && value.title_player_account === "*") return true;
    if (typeof value !== "string") return false;
    try {
        const parsed = JSON.parse(value);
        return parsed?.title_player_account === "*";
    } catch {
        return false;
    }
}

function isGlobalDenyFor(statement, objectName) {
    return statement?.Resource === `pfrn:data--*!*/Profile/${objectName}` &&
        (statement.Action === "Write" || statement.Action === "*") &&
        statement.Effect === "Deny" && statement.Principal === "*" &&
        statement.Condition?.CallingEntityType === "title_player_account";
}

function isApiDenyFor(statement, resource) {
    return statement?.Resource === resource && statement.Action === "*" &&
        statement.Effect === "Deny" && isTitlePlayerPrincipal(statement.Principal);
}

export function mergeGlobalPermissions(permissions) {
    if (!Array.isArray(permissions)) fail("GLOBAL_POLICY_INVALID", "Global policy permissions are invalid.");
    const merged = clone(permissions);
    for (const objectName of PROTECTED_OBJECT_NAMES) {
        if (!merged.some((statement) => isGlobalDenyFor(statement, objectName))) {
            merged.push(globalDenyStatement(objectName));
        }
    }
    return merged;
}

export function mergeApiStatements(statements) {
    if (!Array.isArray(statements)) fail("API_POLICY_INVALID", "API policy statements are invalid.");
    const merged = clone(statements);
    for (const resource of REQUIRED_CLIENT_MUTATION_DENIES) {
        if (!merged.some((statement) => isApiDenyFor(statement, resource))) {
            merged.push(apiDenyStatement(resource));
        }
    }
    return merged;
}

export function evaluatePolicyCoverage(globalPolicy, apiPolicy) {
    const globalPermissions = globalPolicy?.Permissions;
    const apiStatements = apiPolicy?.Statements;
    const missingObjects = PROTECTED_OBJECT_NAMES.filter(
        (name) => !Array.isArray(globalPermissions) || !globalPermissions.some((entry) => isGlobalDenyFor(entry, name))
    );
    const missingApis = REQUIRED_CLIENT_MUTATION_DENIES.filter(
        (resource) => !Array.isArray(apiStatements) || !apiStatements.some((entry) => isApiDenyFor(entry, resource))
    );
    return Object.freeze({
        complete: missingObjects.length === 0 && missingApis.length === 0,
        missingObjects: Object.freeze(missingObjects),
        missingApis: Object.freeze(missingApis)
    });
}

function providerError(payload) {
    return Object.freeze({
        providerCode: typeof payload?.error === "string" ? payload.error.slice(0, 160) : null,
        providerErrorCode: Number.isSafeInteger(payload?.errorCode) ? payload.errorCode : null
    });
}

function isPolicyDenial(result) {
    return result?.ok === false &&
        (POLICY_DENIAL_CODES.has(result.providerCode) || POLICY_DENIAL_NUMERIC_CODES.has(result.providerErrorCode));
}

function assertNotTokenFailure(result, label) {
    if (TOKEN_FAILURE_CODES.has(result?.providerCode) ||
        (Number.isSafeInteger(result?.providerErrorCode) && result.providerErrorCode >= 1334 && result.providerErrorCode <= 1337)) {
        fail("CLIENT_CREDENTIAL_INVALID", `${label} failed because the canary credential is invalid or expired.`);
    }
}

function createClient({ titleId, secretKey, sessionTicket }) {
    const baseUrl = `https://${titleId}.playfabapi.com`;

    async function post(path, body, headerName, credential, { allowProviderError = false } = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        let response;
        try {
            response = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                redirect: "error",
                signal: controller.signal,
                headers: { "Content-Type": "application/json", [headerName]: credential },
                body: JSON.stringify(body)
            });
        } catch {
            fail("PLAYFAB_NETWORK_FAILURE", `PlayFab request failed for ${path}.`);
        } finally {
            clearTimeout(timeout);
        }
        const payload = await response.json().catch(() => null);
        const ok = response.ok && payload?.code === 200 && payload?.data !== undefined;
        const error = providerError(payload);
        const result = Object.freeze({
            ok,
            status: response.status,
            providerCode: error.providerCode,
            providerErrorCode: error.providerErrorCode,
            data: ok ? payload.data : null
        });
        if (!ok && !allowProviderError) {
            fail("PLAYFAB_REQUEST_REJECTED", `PlayFab rejected ${path}.`, {
                status: result.status,
                providerCode: result.providerCode,
                providerErrorCode: result.providerErrorCode
            });
        }
        return result;
    }

    return Object.freeze({
        titleEntityToken: () => post("/Authentication/GetEntityToken", {}, "X-SecretKey", secretKey),
        clientEntityToken: () => post("/Authentication/GetEntityToken", {}, "X-Authorization", sessionTicket),
        serverAccountInfo: () => post(
            "/Server/GetUserAccountInfo",
            { PlayFabId: CANARY_PLAYFAB_ID },
            "X-SecretKey",
            secretKey
        ),
        getGlobalPolicy: (titleToken) => post(
            "/Profile/GetGlobalPolicy",
            { Entity: { Id: titleId, Type: "title" } },
            "X-EntityToken",
            titleToken
        ),
        setGlobalPolicy: (titleToken, permissions) => post(
            "/Profile/SetGlobalPolicy",
            { Permissions: permissions },
            "X-EntityToken",
            titleToken
        ),
        getApiPolicy: () => post(
            "/Admin/GetPolicy",
            { PolicyName: "ApiPolicy" },
            "X-SecretKey",
            secretKey
        ),
        updateApiPolicy: (policyVersion, statements, overwritePolicy) => post(
            "/Admin/UpdatePolicy",
            {
                PolicyName: "ApiPolicy",
                PolicyVersion: policyVersion,
                OverwritePolicy: overwritePolicy,
                Statements: statements
            },
            "X-SecretKey",
            secretKey
        ),
        getObjects: (entityToken, entity, allowProviderError = false) => post(
            "/Object/GetObjects",
            { Entity: entity },
            "X-EntityToken",
            entityToken,
            { allowProviderError }
        ),
        setObjects: (entityToken, entity, objects, expectedProfileVersion, allowProviderError = false) => {
            const body = { Entity: entity, Objects: objects };
            if (Number.isSafeInteger(expectedProfileVersion)) body.ExpectedProfileVersion = expectedProfileVersion;
            return post("/Object/SetObjects", body, "X-EntityToken", entityToken, { allowProviderError });
        },
        clientApi: (path, body) => post(path, body, "X-Authorization", sessionTicket, { allowProviderError: true }),
        entityApi: (path, body, entityToken) => post(path, body, "X-EntityToken", entityToken, { allowProviderError: true })
    });
}

function assertTitleIdentity(tokenResult) {
    const entity = tokenResult?.data?.Entity;
    if (!tokenResult?.ok || entity?.Id !== SANDBOX_TITLE_ID || entity?.Type !== "title") {
        fail("TITLE_ENTITY_IDENTITY_MISMATCH", "The server credential did not resolve to the expected Sandbox Title.");
    }
    return tokenResult.data.EntityToken;
}

function assertClientIdentity(tokenResult) {
    const entity = tokenResult?.data?.Entity;
    if (!tokenResult?.ok || entity?.Id !== CANARY_ENTITY.Id || entity?.Type !== CANARY_ENTITY.Type) {
        fail("CANARY_ENTITY_IDENTITY_MISMATCH", "The client credential did not resolve to the expected Sandbox canary.");
    }
    return tokenResult.data.EntityToken;
}

function initialEconomyState() {
    return {
        schemaVersion: 1,
        playFabId: CANARY_PLAYFAB_ID,
        revision: 0,
        fencingEpoch: 0,
        diamonds: 0,
        eliteBall: 0,
        premium: { tier: 0, activatedAtUnixMs: null, expiresAtUnixMs: null },
        highValueAppliedThroughSequence: 0,
        ammoAppliedThroughSequence: 0,
        updatedAtUnixMs: 0
    };
}

function objectData(getObjectsData, objectName) {
    return getObjectsData?.Objects?.[objectName]?.DataObject ?? null;
}

function backupDirectory() {
    const root = process.env.LOCALAPPDATA || process.env.TEMP || homedir();
    return join(root, "Seabyss", "PlayFabFinancialPolicyCertification", SANDBOX_TITLE_ID);
}

async function writeBackup(globalPolicy, apiPolicy) {
    const capturedAtUtc = new Date().toISOString();
    const policies = { globalPolicy: clone(globalPolicy), apiPolicy: clone(apiPolicy) };
    const evidence = {
        schemaVersion: 1,
        titleId: SANDBOX_TITLE_ID,
        productionTitleId: PRODUCTION_TITLE_ID,
        capturedAtUtc,
        globalPolicySha256: digest(globalPolicy),
        apiPolicySha256: digest(apiPolicy),
        combinedPolicySha256: digest(policies),
        ...policies
    };
    const fileName = `policy-before-${capturedAtUtc.replace(/[:.]/gu, "-")}.json`;
    const path = join(backupDirectory(), fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return Object.freeze({
        path,
        globalPolicySha256: evidence.globalPolicySha256,
        apiPolicySha256: evidence.apiPolicySha256,
        combinedPolicySha256: evidence.combinedPolicySha256
    });
}

async function loadBackup(path) {
    const raw = await readFile(resolve(path), "utf8");
    const backup = JSON.parse(raw);
    if (backup?.titleId !== SANDBOX_TITLE_ID || backup?.productionTitleId !== PRODUCTION_TITLE_ID ||
        digest(backup.globalPolicy) !== backup.globalPolicySha256 ||
        digest(backup.apiPolicy) !== backup.apiPolicySha256 ||
        digest({ globalPolicy: backup.globalPolicy, apiPolicy: backup.apiPolicy }) !== backup.combinedPolicySha256) {
        fail("POLICY_BACKUP_INVALID", "Policy backup identity or hash is invalid.");
    }
    return backup;
}

async function currentPolicies(client, titleToken) {
    const [globalResult, apiResult] = await Promise.all([
        client.getGlobalPolicy(titleToken),
        client.getApiPolicy()
    ]);
    return Object.freeze({ globalPolicy: globalResult.data, apiPolicy: apiResult.data });
}

async function backupMode(client, titleToken) {
    const before = await currentPolicies(client, titleToken);
    const backup = await writeBackup(before.globalPolicy, before.apiPolicy);
    return {
        verdict: "BACKUP_CREATED",
        titleId: SANDBOX_TITLE_ID,
        globalRuleCount: before.globalPolicy.Permissions.length,
        apiRuleCount: before.apiPolicy.Statements.length,
        apiPolicyVersion: before.apiPolicy.PolicyVersion,
        backup
    };
}

async function restorePolicies(client, titleToken, before) {
    await client.setGlobalPolicy(titleToken, before.globalPolicy.Permissions);
    const currentApi = (await client.getApiPolicy()).data;
    await client.updateApiPolicy(currentApi.PolicyVersion, before.apiPolicy.Statements, true);
}

async function applyMode(client, titleToken) {
    const before = await currentPolicies(client, titleToken);
    const backup = await writeBackup(before.globalPolicy, before.apiPolicy);
    const globalPermissions = mergeGlobalPermissions(before.globalPolicy.Permissions);
    const apiStatements = mergeApiStatements(before.apiPolicy.Statements);
    let globalChanged = false;
    let apiChanged = false;
    try {
        if (canonicalJson(globalPermissions) !== canonicalJson(before.globalPolicy.Permissions)) {
            await client.setGlobalPolicy(titleToken, globalPermissions);
            globalChanged = true;
        }
        const additions = apiStatements.filter(
            (candidate) => !before.apiPolicy.Statements.some((entry) => canonicalJson(entry) === canonicalJson(candidate))
        );
        if (additions.length > 0) {
            await client.updateApiPolicy(before.apiPolicy.PolicyVersion, additions, false);
            apiChanged = true;
        }
        const after = await currentPolicies(client, titleToken);
        const coverage = evaluatePolicyCoverage(after.globalPolicy, after.apiPolicy);
        if (!coverage.complete) {
            fail("POLICY_APPLY_INCOMPLETE", "The published Sandbox policies do not cover every required object and client mutation API.", coverage);
        }
        return {
            verdict: "POLICY_APPLIED",
            titleId: SANDBOX_TITLE_ID,
            backup,
            globalRuleCountBefore: before.globalPolicy.Permissions.length,
            globalRuleCountAfter: after.globalPolicy.Permissions.length,
            apiRuleCountBefore: before.apiPolicy.Statements.length,
            apiRuleCountAfter: after.apiPolicy.Statements.length,
            apiPolicyVersionBefore: before.apiPolicy.PolicyVersion,
            apiPolicyVersionAfter: after.apiPolicy.PolicyVersion,
            globalChanged,
            apiChanged,
            protectedObjects: PROTECTED_OBJECT_NAMES,
            protectedMutationApis: REQUIRED_CLIENT_MUTATION_DENIES
        };
    } catch (error) {
        try {
            await restorePolicies(client, titleToken, before);
        } catch {
            fail("POLICY_APPLY_AND_ROLLBACK_FAILED", "Policy apply failed and automatic Sandbox rollback could not be verified.");
        }
        throw error;
    }
}

async function restoreMode(client, titleToken, backupPath) {
    if (!backupPath) fail("POLICY_BACKUP_REQUIRED", "Restore requires a policy backup path.");
    const backup = await loadBackup(backupPath);
    await restorePolicies(client, titleToken, backup);
    const restored = await currentPolicies(client, titleToken);
    if (digest(restored.globalPolicy) !== backup.globalPolicySha256 ||
        canonicalJson(restored.apiPolicy.Statements) !== canonicalJson(backup.apiPolicy.Statements)) {
        fail("POLICY_RESTORE_VERIFY_FAILED", "Sandbox policy restore did not match the backup.");
    }
    return { verdict: "POLICY_RESTORED", titleId: SANDBOX_TITLE_ID, backupPath: resolve(backupPath) };
}

async function expectDenied(label, operation) {
    const result = await operation();
    assertNotTokenFailure(result, label);
    if (!isPolicyDenial(result)) {
        fail("CLIENT_MUTATION_NOT_DENIED", `${label} was not denied by PlayFab policy.`, {
            label,
            status: result.status,
            providerCode: result.providerCode,
            providerErrorCode: result.providerErrorCode
        });
    }
    return Object.freeze({
        result: "DENIED",
        httpStatus: result.status,
        providerCode: result.providerCode,
        providerErrorCode: result.providerErrorCode
    });
}

async function waitForPolicyPropagation(client, clientToken, zeroState, maximumWaitMs = 10 * 60_000) {
    const started = Date.now();
    let attempts = 0;
    let consecutiveDenials = 0;
    const requiredConsecutiveDenials = 12;
    while (Date.now() - started <= maximumWaitMs) {
        attempts += 1;
        const current = await client.getObjects(clientToken, CANARY_ENTITY);
        const result = await client.setObjects(
            clientToken,
            CANARY_ENTITY,
            [{ ObjectName: "SeabyssEconomyStateV1", DataObject: zeroState }],
            current.data.ProfileVersion,
            true
        );
        assertNotTokenFailure(result, "Policy propagation probe");
        if (isPolicyDenial(result)) {
            consecutiveDenials += 1;
            if (consecutiveDenials >= requiredConsecutiveDenials) {
                return Object.freeze({ attempts, consecutiveDenials, waitMs: Date.now() - started, providerCode: result.providerCode });
            }
        } else if (result.ok) {
            consecutiveDenials = 0;
        }
        if (!result.ok && !isPolicyDenial(result)) {
            fail("POLICY_PROPAGATION_UNEXPECTED_ERROR", "Policy propagation probe returned an unexpected provider error.", {
                status: result.status,
                providerCode: result.providerCode,
                providerErrorCode: result.providerErrorCode
            });
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
    fail("POLICY_PROPAGATION_TIMEOUT", "PlayFab did not enforce twelve consecutive Sandbox write denials within ten minutes.");
}

function maliciousObjectTests() {
    const highRevision = 999_999;
    return Object.freeze([
        {
            label: "Economy State write",
            objectName: "SeabyssEconomyStateV1",
            data: { ...initialEconomyState(), diamonds: 999_999, revision: highRevision }
        },
        {
            label: "Fence write",
            objectName: "SeabyssEconomyFenceV1",
            data: {
                schemaVersion: 1,
                playFabId: CANARY_PLAYFAB_ID,
                fencingEpoch: highRevision,
                leaseTokenDigest: "f".repeat(64),
                activatedAtUnixMs: 1
            }
        },
        {
            label: "Proof write",
            objectName: "SeabyssEconomyProofV1",
            data: {
                schemaVersion: 1,
                playFabId: CANARY_PLAYFAB_ID,
                sequence: 1,
                operationId: "malicious-policy-certification",
                eventId: "malicious-policy-certification",
                immutableHash: "f".repeat(64)
            }
        },
        {
            label: "Ammo Proof write",
            objectName: "SeabyssEconomyAmmoProofV1",
            data: {
                schemaVersion: 1,
                playFabId: CANARY_PLAYFAB_ID,
                firstSequence: 1,
                throughSequence: 1,
                eventCount: 1,
                batchDigest: "f".repeat(64)
            }
        },
        {
            label: "Premium write",
            objectName: "SeabyssFinancialAuthorityV2",
            data: { schemaVersion: 2, financialRevision: highRevision, premium: { tier: "gold" } }
        },
        {
            label: "Unlock write",
            objectName: "SeabyssFinancialAuthorityV2",
            data: { schemaVersion: 2, financialRevision: highRevision, paidDestinationMarkerIds: ["destination_red_point"] }
        },
        {
            label: "Revision write",
            objectName: "SeabyssFinancialAuthorityV2",
            data: { schemaVersion: 2, financialRevision: highRevision }
        },
        {
            label: "Ownership write",
            objectName: "SeabyssFinancialAuthorityV2",
            data: { schemaVersion: 2, financialRevision: highRevision, ownedStarterSkus: ["seabyss_starter_pack_1"] }
        },
        {
            label: "Financial Profile write",
            objectName: "SeabyssFinancialProfileV1",
            data: { schemaVersion: 1, lastFencingToken: highRevision }
        }
    ]);
}

async function restoreCanaryObjectBaseline(client, titleToken, zeroState) {
    const current = await client.getObjects(titleToken, CANARY_ENTITY);
    const objects = [{ ObjectName: "SeabyssEconomyStateV1", DataObject: zeroState }];
    for (const name of PROTECTED_OBJECT_NAMES) {
        if (name !== "SeabyssEconomyStateV1") objects.push({ ObjectName: name, DeleteObject: true });
    }
    await client.setObjects(titleToken, CANARY_ENTITY, objects, current.data.ProfileVersion);
    const verified = await client.getObjects(titleToken, CANARY_ENTITY);
    if (canonicalJson(objectData(verified.data, "SeabyssEconomyStateV1")) !== canonicalJson(zeroState) ||
        PROTECTED_OBJECT_NAMES.some((name) => name !== "SeabyssEconomyStateV1" && objectData(verified.data, name) !== null)) {
        fail("CANARY_BASELINE_RESTORE_FAILED", "Accepted client mutation could not be removed from the Sandbox canary.");
    }
    return verified.data.ProfileVersion;
}

async function removeObjectFromEntity(client, titleToken, entity, objectName) {
    const current = await client.getObjects(titleToken, entity);
    await client.setObjects(
        titleToken,
        entity,
        [{ ObjectName: objectName, DeleteObject: true }],
        current.data.ProfileVersion
    );
    const verified = await client.getObjects(titleToken, entity);
    if (objectData(verified.data, objectName) !== null) {
        fail("CROSS_ENTITY_CLEANUP_FAILED", "Accepted cross-entity test object could not be removed from Sandbox.");
    }
}

async function certifyMode(client, titleToken, clientToken) {
    const account = await client.serverAccountInfo();
    const accountEntityId = account.data?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id;
    if (account.data?.UserInfo?.PlayFabId !== CANARY_PLAYFAB_ID || accountEntityId !== CANARY_ENTITY.Id) {
        fail("CANARY_ACCOUNT_MISMATCH", "Server account lookup did not resolve the expected Sandbox canary.");
    }

    const policies = await currentPolicies(client, titleToken);
    const coverage = evaluatePolicyCoverage(policies.globalPolicy, policies.apiPolicy);
    if (!coverage.complete) {
        fail("POLICY_COVERAGE_INCOMPLETE", "Required Sandbox policy rules are missing.", coverage);
    }

    const zeroState = initialEconomyState();
    let current = await client.getObjects(titleToken, CANARY_ENTITY);
    const existingState = objectData(current.data, "SeabyssEconomyStateV1");
    let serverWriteResult = "ALREADY_PRESENT";
    let serverWriteProfileVersion = current.data.ProfileVersion;
    if (existingState === null) {
        const write = await client.setObjects(
            titleToken,
            CANARY_ENTITY,
            [{ ObjectName: "SeabyssEconomyStateV1", DataObject: zeroState }],
            current.data.ProfileVersion
        );
        serverWriteResult = "PASS";
        serverWriteProfileVersion = write.data.ProfileVersion;
    } else if (canonicalJson(existingState) !== canonicalJson(zeroState)) {
        fail("CANARY_STATE_NOT_ZERO", "Existing Sandbox economy state is not the approved zero-value certification structure.");
    } else {
        const write = await client.setObjects(
            titleToken,
            CANARY_ENTITY,
            [{ ObjectName: "SeabyssEconomyStateV1", DataObject: zeroState }],
            current.data.ProfileVersion
        );
        serverWriteResult = "PASS_NOOP_ZERO";
        serverWriteProfileVersion = write.data.ProfileVersion;
    }

    const serverReadback = await client.getObjects(titleToken, CANARY_ENTITY);
    if (canonicalJson(objectData(serverReadback.data, "SeabyssEconomyStateV1")) !== canonicalJson(zeroState)) {
        fail("SERVER_READBACK_MISMATCH", "Server zero-value object readback did not match.");
    }
    const unexpectedObjects = PROTECTED_OBJECT_NAMES.filter(
        (name) => name !== "SeabyssEconomyStateV1" && objectData(serverReadback.data, name) !== null
    );
    if (unexpectedObjects.length > 0) {
        fail("CANARY_CONTAINS_UNEXPECTED_FINANCIAL_OBJECTS", "Sandbox canary contains unexpected financial objects before certification.", {
            objectNames: unexpectedObjects
        });
    }
    const baselineHash = digest(serverReadback.data.Objects);
    const propagation = await waitForPolicyPropagation(client, clientToken, zeroState);

    const negativeTests = {};
    for (const test of maliciousObjectTests()) {
        current = await client.getObjects(titleToken, CANARY_ENTITY);
        const result = await client.setObjects(
            clientToken,
            CANARY_ENTITY,
            [{ ObjectName: test.objectName, DataObject: test.data }],
            current.data.ProfileVersion,
            true
        );
        assertNotTokenFailure(result, test.label);
        if (!isPolicyDenial(result)) {
            const cleanup = result.ok
                ? `RESTORED_AT_PROFILE_VERSION_${await restoreCanaryObjectBaseline(client, titleToken, zeroState)}`
                : "NOT_REQUIRED";
            fail("CLIENT_MUTATION_NOT_DENIED", `${test.label} was not denied by PlayFab policy.`, {
                label: test.label,
                status: result.status,
                providerCode: result.providerCode,
                providerErrorCode: result.providerErrorCode,
                cleanup
            });
        }
        negativeTests[test.label] = Object.freeze({
            result: "DENIED",
            httpStatus: result.status,
            providerCode: result.providerCode,
            providerErrorCode: result.providerErrorCode
        });
    }

    const crossEntity = { Id: SANDBOX_TITLE_ID, Type: "title" };
    const crossResult = await client.setObjects(
        clientToken,
        crossEntity,
        [{ ObjectName: "SeabyssEconomyStateV1", DataObject: { probe: "forbidden" } }],
        undefined,
        true
    );
    assertNotTokenFailure(crossResult, "Cross-player write");
    if (!isPolicyDenial(crossResult)) {
        if (crossResult.ok) await removeObjectFromEntity(client, titleToken, crossEntity, "SeabyssEconomyStateV1");
        fail("CLIENT_MUTATION_NOT_DENIED", "Cross-player write was not denied by PlayFab policy.", {
            status: crossResult.status,
            providerCode: crossResult.providerCode,
            providerErrorCode: crossResult.providerErrorCode,
            cleanup: crossResult.ok ? "REMOVED" : "NOT_REQUIRED"
        });
    }
    negativeTests["Cross-player write"] = Object.freeze({
        result: "DENIED",
        httpStatus: crossResult.status,
        providerCode: crossResult.providerCode,
        providerErrorCode: crossResult.providerErrorCode
    });

    const clientRead = await client.getObjects(clientToken, CANARY_ENTITY);
    if (canonicalJson(objectData(clientRead.data, "SeabyssEconomyStateV1")) !== canonicalJson(zeroState)) {
        fail("CLIENT_READBACK_MISMATCH", "Approved client read did not return the server-owned zero snapshot.");
    }

    const bypassTests = {};
    bypassTests["Legacy VC add"] = await expectDenied("Legacy VC add", () => client.clientApi(
        "/Client/AddUserVirtualCurrency",
        { VirtualCurrency: "DM", Amount: 1 }
    ));
    bypassTests["Legacy VC subtract"] = await expectDenied("Legacy VC subtract", () => client.clientApi(
        "/Client/SubtractUserVirtualCurrency",
        { VirtualCurrency: "DM", Amount: 1 }
    ));
    bypassTests["Economy ExecuteInventoryOperations"] = await expectDenied(
        "Economy ExecuteInventoryOperations",
        () => client.entityApi("/Inventory/ExecuteInventoryOperations", {
            Entity: CANARY_ENTITY,
            CollectionId: "default",
            IdempotencyId: randomUUID(),
            Operations: [{ Add: { Item: { Id: "policy-certification-nonexistent-item" }, Amount: 1 } }]
        }, clientToken)
    );
    bypassTests["Economy SubtractInventoryItems"] = await expectDenied(
        "Economy SubtractInventoryItems",
        () => client.entityApi("/Inventory/SubtractInventoryItems", {
            Entity: CANARY_ENTITY,
            CollectionId: "default",
            IdempotencyId: randomUUID(),
            Item: { Id: "policy-certification-nonexistent-item" },
            Amount: 1
        }, clientToken)
    );
    bypassTests["Player custom financial marker"] = await expectDenied(
        "Player custom financial marker",
        () => client.clientApi("/Client/UpdatePlayerCustomProperties", {
            Properties: [{ Name: "seabyssStarterProfileV1", Value: 999_999 }]
        })
    );

    const finalReadback = await client.getObjects(titleToken, CANARY_ENTITY);
    if (digest(finalReadback.data.Objects) !== baselineHash ||
        canonicalJson(objectData(finalReadback.data, "SeabyssEconomyStateV1")) !== canonicalJson(zeroState)) {
        fail("NEGATIVE_TEST_MUTATED_STATE", "A negative client test changed the Sandbox financial object state.");
    }

    const inventoryRead = await client.entityApi("/Inventory/GetInventoryItems", {
        Entity: CANARY_ENTITY,
        CollectionId: "default",
        Count: 50
    }, clientToken);
    let inventoryReadPolicy;
    if (inventoryRead.ok) {
        inventoryReadPolicy = "ALLOWED_READ_ONLY";
    } else {
        assertNotTokenFailure(inventoryRead, "Economy inventory read");
        if (!isPolicyDenial(inventoryRead)) {
            fail("CLIENT_INVENTORY_READ_FAILED", "Economy inventory read returned an unexpected provider error.", {
                status: inventoryRead.status,
                providerCode: inventoryRead.providerCode,
                providerErrorCode: inventoryRead.providerErrorCode
            });
        }
        inventoryReadPolicy = "DENIED_SERVER_MEDIATED";
    }

    return {
        verdict: "PLAYFAB FINANCIAL POLICY CERTIFICATION: PASS",
        sandboxTitleId: SANDBOX_TITLE_ID,
        productionTitleId: PRODUCTION_TITLE_ID,
        globalRuleCount: policies.globalPolicy.Permissions.length,
        apiRuleCount: policies.apiPolicy.Statements.length,
        policyPropagation: propagation,
        negativeTests,
        bypassTests,
        serverPositive: {
            setObjects: serverWriteResult,
            readback: "PASS",
            profileVersion: finalReadback.data.ProfileVersion,
            initialWriteProfileVersion: serverWriteProfileVersion
        },
        clientRead: {
            entityObjects: "ALLOWED_READ_ONLY",
            economyInventory: inventoryReadPolicy
        },
        objectsRetained: ["SeabyssEconomyStateV1"],
        secretsLogged: false,
        productionTouched: false
    };
}

async function main() {
    const mode = process.argv[2];
    if (!["backup", "apply", "certify", "restore"].includes(mode) || process.argv.length > (mode === "restore" ? 4 : 3)) {
        fail("USAGE", "Usage: node playfab-financial-policy-certification.mjs backup|apply|certify|restore [backup-path]");
    }
    const environment = assertSafeRuntime(mode);
    const client = createClient(environment);
    const titleToken = assertTitleIdentity(await client.titleEntityToken());
    let result;
    if (mode === "backup") result = await backupMode(client, titleToken);
    else if (mode === "apply") result = await applyMode(client, titleToken);
    else if (mode === "restore") result = await restoreMode(client, titleToken, process.argv[3]);
    else {
        const clientToken = assertClientIdentity(await client.clientEntityToken());
        result = await certifyMode(client, titleToken, clientToken);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
    main().catch((error) => {
        const safe = error instanceof SafeCertificationError
            ? { verdict: "FAIL", code: error.code, message: error.message, details: error.details }
            : { verdict: "FAIL", code: "UNEXPECTED_FAILURE", message: "Certification failed unexpectedly." };
        process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
        process.exitCode = 1;
    });
}
