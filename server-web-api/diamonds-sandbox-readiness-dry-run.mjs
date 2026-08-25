import { readDiamondsCanaryIdentity, readConfiguredDiamondsCanaryPlayFabId } from "./src/diamonds-canary-identity.js";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    planProgressiveFinancialDomainMigration
} from "./src/progressive-financial-domain-migration.js";

export const DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID = readConfiguredDiamondsCanaryPlayFabId();
export const DIAMONDS_TARGET_OBJECT_NAME = "SeabyssEconomyStateV1";
export const DIAMONDS_MIGRATION_PROOF_OBJECT_NAME = "SeabyssDiamondsMigrationProofV1";

const PRODUCTION_TITLE_ID = "142853";
const READ_ONLY_ENDPOINTS = new Set([
    "/Server/GetUserAccountInfo",
    "/Server/GetUserInventory",
    "/Authentication/GetEntityToken",
    "/Object/GetObjects"
]);

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!plain(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
    return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function canonical(value, name, maximumLength = 8192) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function nonNegative(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid.`);
    return value;
}

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function readDiamondsSandboxDryRunEnvironment(environment = process.env) {
    if (!plain(environment)) throw new TypeError("environment is invalid.");
    const titleId = canonical(
        environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID",
        64);
    if (titleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID || titleId === PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_SANDBOX_TITLE_MISMATCH",
            `Read-only dry-run requires isolated Sandbox ${DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID}.`);
    }
    const secretKey = canonical(
        environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY");
    const identity = readDiamondsCanaryIdentity(environment);
    return Object.freeze({ titleId, secretKey, playFabId: identity.playFabId });
}

export function createDiamondsSandboxReadOnlyClient({
    titleId,
    secretKey,
    fetchImpl = globalThis.fetch,
    timeoutMilliseconds = 10_000
} = {}) {
    const sandboxTitle = canonical(titleId, "titleId", 64);
    if (sandboxTitle !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID || sandboxTitle === PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_SANDBOX_TITLE_MISMATCH", "Read-only client refused the configured title.");
    }
    const secret = canonical(secretKey, "secretKey");
    if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMilliseconds) ||
        timeoutMilliseconds <= 0 || timeoutMilliseconds > 30_000) {
        throw new TypeError("Read-only PlayFab client is invalid.");
    }
    const baseUrl = `https://${sandboxTitle}.playfabapi.com`;
    const calls = [];

    async function post(path, body, headerName, credential) {
        if (!READ_ONLY_ENDPOINTS.has(path)) {
            throw coded("DIAMONDS_DRY_RUN_MUTATION_ENDPOINT_REFUSED",
                "Only the certified read-only PlayFab endpoint allowlist is accepted.");
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
        let response;
        try {
            calls.push(path);
            response = await fetchImpl(`${baseUrl}${path}`, {
                method: "POST",
                redirect: "error",
                signal: controller.signal,
                headers: { "Content-Type": "application/json", [headerName]: credential },
                body: JSON.stringify(body)
            });
        } finally {
            clearTimeout(timeout);
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.code !== 200 || !plain(payload.data)) {
            throw coded("DIAMONDS_DRY_RUN_PROVIDER_READ_FAILED", "PlayFab rejected a read-only dry-run request.");
        }
        return payload.data;
    }

    return Object.freeze({
        getUserAccountInfo(playFabId) {
            return post("/Server/GetUserAccountInfo", { PlayFabId: playFabId }, "X-SecretKey", secret);
        },
        getUserInventory(playFabId) {
            return post("/Server/GetUserInventory", { PlayFabId: playFabId }, "X-SecretKey", secret);
        },
        getEntityToken() {
            return post("/Authentication/GetEntityToken", {
                Entity: { Id: sandboxTitle, Type: "title" }
            }, "X-SecretKey", secret);
        },
        getObjects(entity, entityToken) {
            return post("/Object/GetObjects", { Entity: entity }, "X-EntityToken",
                canonical(entityToken, "EntityToken"));
        },
        calls() { return Object.freeze([...calls]); }
    });
}

function objectEntry(result, name) {
    return result?.Objects?.[name] || null;
}

async function readProviderObservation({ client, titleId, playFabId }) {
    const [account, inventory, tokenResult] = await Promise.all([
        client.getUserAccountInfo(playFabId),
        client.getUserInventory(playFabId),
        client.getEntityToken()
    ]);
    if (account?.UserInfo?.PlayFabId !== playFabId) {
        throw coded("DIAMONDS_DRY_RUN_IDENTITY_MISMATCH", "PlayFab returned another legacy account.");
    }
    const entityId = canonical(
        account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
        "TitlePlayerAccount.Id",
        160);
    if (tokenResult?.Entity &&
        (tokenResult.Entity.Id !== titleId || tokenResult.Entity.Type !== "title")) {
        throw coded("DIAMONDS_DRY_RUN_TITLE_TOKEN_MISMATCH", "PlayFab returned another title token.");
    }
    const objects = await client.getObjects(
        { Id: entityId, Type: "title_player_account" },
        canonical(tokenResult?.EntityToken, "EntityToken"));
    const legacyValue = nonNegative(inventory?.VirtualCurrency?.DM ?? 0, "Legacy DM");
    const targetEntry = objectEntry(objects, DIAMONDS_TARGET_OBJECT_NAME);
    const targetObject = targetEntry?.DataObject ?? null;
    if (targetObject !== null && (!plain(targetObject) || targetObject.playFabId !== playFabId)) {
        throw coded("DIAMONDS_DRY_RUN_TARGET_INVALID", "Target snapshot is invalid or belongs to another player.");
    }
    const targetValue = nonNegative(targetObject?.diamonds ?? 0, "Target Diamonds");
    const targetRevision = nonNegative(targetObject?.revision ?? 0, "Target revision");
    const providerProfileVersion = nonNegative(objects?.ProfileVersion ?? 0, "ProfileVersion");
    const migrationProof = objectEntry(objects, DIAMONDS_MIGRATION_PROOF_OBJECT_NAME)?.DataObject ?? null;
    const providerState = {
        titleId,
        playFabId,
        entityId,
        legacyValue,
        targetValue,
        targetRevision,
        providerProfileVersion,
        targetObject,
        migrationProof
    };
    return Object.freeze({ ...providerState, providerStateDigest: digest(providerState) });
}

export async function runDiamondsSandboxReadOnlyDryRun({
    environment = process.env,
    fetchImpl = globalThis.fetch
} = {}) {
    const configuration = readDiamondsSandboxDryRunEnvironment(environment);
    const client = createDiamondsSandboxReadOnlyClient({ ...configuration, fetchImpl });
    const before = await readProviderObservation({ client, ...configuration });
    const after = await readProviderObservation({ client, ...configuration });
    if (before.providerStateDigest !== after.providerStateDigest) {
        throw coded("DIAMONDS_DRY_RUN_PROVIDER_CHANGED",
            "Provider state changed during the read-only dry-run; no certificate may be issued.");
    }
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds",
        playFabId: configuration.playFabId,
        titleId: configuration.titleId,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        legacyValue: before.legacyValue,
        targetValue: before.targetValue,
        legacyRevision: 0,
        targetRevision: before.targetRevision,
        providerProfileVersion: before.providerProfileVersion,
        providerStateDigest: before.providerStateDigest,
        migrationProof: before.migrationProof
    });
    const calls = client.calls();
    if (calls.length !== 8 || calls.some((path) => !READ_ONLY_ENDPOINTS.has(path))) {
        throw coded("DIAMONDS_DRY_RUN_CALL_BUDGET_INVALID", "Unexpected PlayFab request in dry-run.");
    }
    return Object.freeze({
        kind: "seabyss_diamonds_sandbox_readiness_dry_run_v1",
        readOnly: true,
        sandboxTitleId: configuration.titleId,
        productionTitleUntouched: true,
        playFabId: configuration.playFabId,
        entityId: before.entityId,
        legacyValue: before.legacyValue,
        targetValue: before.targetValue,
        targetRevision: before.targetRevision,
        providerProfileVersion: before.providerProfileVersion,
        migrationProofExists: before.migrationProof !== null,
        proposedTargetValue: plan.proposedTarget,
        conflictState: plan.status,
        conflicts: plan.conflicts,
        planHash: plan.planHash,
        providerBeforeDigest: before.providerStateDigest,
        providerAfterDigest: after.providerStateDigest,
        providerUnchanged: true,
        providerWriteCount: 0,
        apiCalls: Object.freeze([...calls])
    });
}

async function main() {
    const result = await runDiamondsSandboxReadOnlyDryRun();
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPoint === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            code: error?.code || "DIAMONDS_DRY_RUN_FAILED",
            message: error?.message || "Diamonds Sandbox read-only dry-run failed."
        })}\n`);
        process.exitCode = 1;
    });
}
