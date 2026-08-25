import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "redis";

import {
    createDiamondsSandboxReadOnlyClient
} from "./diamonds-sandbox-readiness-dry-run.mjs";
import {
    createDiamondsMigrationProofAwarePlayFabClient
} from "./src/diamonds-migration-proof-companion.js";
import {
    createCanary02V2BootstrapImportPlan,
    createFinancialCanary02V2Bootstrapper,
    extractCertifiedCanary02V2BootstrapEvidence,
    FINANCIAL_CANARY02_V2_BOOTSTRAP
} from "./src/financial-canary-redis-v2-bootstrap.js";
import {
    createFinancialCanaryRedisRuntimeContract,
    verifyFinancialCanaryRedisRuntime
} from "./src/financial-canary-redis-durability-contract.js";
import { createTrustedXsollaV2PaymentResolver } from "./src/financial-shadow-payment-producer.js";
import { createPlayFabXsollaV2ReceiptReader } from "./src/playfab-xsolla-v2-receipt-reader.js";
import { serverEconomyPocDigest } from "./src/server-economy-poc-model.js";
import {
    validateHistoricalXsd2SequenceRebaseEvidence
} from "./src/server-economy-poc-historical-sequence-rebase.js";

const C = FINANCIAL_CANARY02_V2_BOOTSTRAP;
const LEGACY_AOF_NAME = "financial-canary.aof.1.incr.aof";
const OFF_GATES = Object.freeze([
    "ShopPurchasesEnabled", "SHOP_PURCHASES_ENABLED", "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED", "PURCHASES_STARTER_ENABLED", "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED", "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED", "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS", "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS", "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "PAYMENT_WORKER_ENABLED", "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED", "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED", "FINANCIAL_DIAMONDS_CUTOVER_ENABLED",
    "FINANCIAL_DIAMONDS_MIGRATION_ENABLED", "FINANCIAL_ELITE_CUTOVER_ENABLED",
    "FINANCIAL_PREMIUM_CUTOVER_ENABLED", "FINANCIAL_ELITE_CANARY_ENABLED",
    "FINANCIAL_PREMIUM_CANARY_ENABLED", "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED",
    "SEABYSS_DIAMONDS_SANDBOX_CANARY_APPLY_ENABLED",
    "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED"
]);

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requireCondition(condition, code, message) {
    if (!condition) throw coded(code, message);
}

function text(value, name, maximum = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw coded("FINANCIAL_CANARY_V2_ENV_INVALID", `${name} is absent or invalid.`);
    }
    return value;
}

function off(environment, name) {
    const value = environment[name];
    if (value === undefined || value === null || value === "" || value === "false") return;
    throw coded("FINANCIAL_CANARY_V2_UNSAFE_GATE", `${name} must remain false.`);
}

function parseJson(value, label) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
        return parsed;
    } catch {
        throw coded("FINANCIAL_CANARY_V2_STATE_INVALID", `${label} is malformed.`);
    }
}

function loopbackRedisUrl(value) {
    const selected = text(value, "FINANCIAL_REDIS_URL", 8192);
    const parsed = new URL(selected);
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) ||
        !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) ||
        Number(parsed.port) !== 6398 || !parsed.password) {
        throw coded("FINANCIAL_CANARY_V2_REDIS_NOT_ISOLATED",
            "V2 bootstrap requires authenticated loopback Redis port 6398.");
    }
    return selected;
}

function readEnvironment(mode, environment = process.env) {
    if (!new Set(["preflight", "import", "verify"]).has(mode)) {
        throw coded("FINANCIAL_CANARY_V2_MODE_INVALID", "Mode must be preflight, import or verify.");
    }
    const titleId = text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID", 64);
    const singular = text(environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID,
        "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID", 160);
    const plural = text(environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS,
        "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS", 160);
    requireCondition(titleId === C.titleId && titleId !== C.productionTitleId,
        "FINANCIAL_CANARY_V2_TITLE_FORBIDDEN", "Only Sandbox 1D0C16 is accepted.");
    requireCondition(singular === C.playFabId && plural === C.playFabId &&
        !singular.includes("*") && !singular.includes(","),
        "FINANCIAL_CANARY_V2_CANARY_INVALID", "One exact Canary_02 ID is required.");
    requireCondition(environment.NODE_ENV !== "production" &&
        environment.FINANCIAL_DIAMONDS_MODE === "Canary" &&
        environment.FINANCIAL_DIAMONDS_CANARY_ENABLED === "true" &&
        environment.FINANCIAL_ELITE_MODE === "Legacy" &&
        environment.FINANCIAL_PREMIUM_MODE === "Legacy",
        "FINANCIAL_CANARY_V2_DOMAIN_MODE_INVALID",
        "Diamonds Canary and Elite/Premium Legacy modes are required.");
    for (const gate of OFF_GATES) off(environment, gate);
    if (mode === "import") {
        requireCondition(environment.SEABYSS_FINANCIAL_CANARY_V2_BOOTSTRAP_ENABLED === "true",
            "FINANCIAL_CANARY_V2_BOOTSTRAP_ENABLE_REQUIRED", "Explicit V2 bootstrap enable is required.");
    } else {
        off(environment, "SEABYSS_FINANCIAL_CANARY_V2_BOOTSTRAP_ENABLED");
    }
    const localAppData = resolve(text(environment.LOCALAPPDATA, "LOCALAPPDATA", 1024));
    const runtime = createFinancialCanaryRedisRuntimeContract({
        localAppData,
        runtimeRoot: environment.SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT || null
    });
    const statePath = resolve(runtime.runtimeDirectory, "state.json");
    const state = parseJson(readFileSync(statePath, "utf8"), "V2 Redis state file");
    const legacyAofPath = resolve(localAppData, "SeabyssCodex", "financial-canary-memurai",
        "canary02", "runtime", "data", "appendonlydir", LEGACY_AOF_NAME);
    return Object.freeze({
        mode,
        titleId,
        playFabId: singular,
        secretKey: text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
            "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY", 4096),
        redisUrl: loopbackRedisUrl(environment.FINANCIAL_REDIS_URL || environment.TEST_REDIS_URL),
        runtime,
        state,
        legacyAofPath
    });
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

async function readTrustedProviderEvidence(configuration, historical) {
    const readOnly = createDiamondsSandboxReadOnlyClient({
        titleId: configuration.titleId,
        secretKey: configuration.secretKey
    });
    const mutationRefused = () => {
        throw coded("FINANCIAL_CANARY_V2_READ_ONLY_VIOLATION", "Provider mutation is forbidden during bootstrap.");
    };
    const proofAware = createDiamondsMigrationProofAwarePlayFabClient({
        client: {
            ...readOnly,
            getUserInternalData: mutationRefused,
            setObjects: mutationRefused
        },
        titleId: configuration.titleId,
        canaryPlayFabIds: [configuration.playFabId]
    });
    const [proof, spend, xsd2] = await Promise.all([
        proofAware.readDiamondsMigrationProof(configuration.playFabId),
        proofAware.verifyTrustedOperation({
            playFabId: configuration.playFabId,
            operationId: C.spend.operationId,
            operationHash: C.spend.operationImmutableHash,
            delta: C.spend.diamondsDelta
        }),
        proofAware.verifyTrustedOperation({
            playFabId: configuration.playFabId,
            operationId: C.xsd2.operationId,
            operationHash: C.xsd2.operationImmutableHash,
            delta: C.xsd2.diamondsDelta
        })
    ]);
    requireCondition(proof.snapshot.diamonds === 15 && proof.snapshot.revision === 3 &&
        proof.snapshot.highValueAppliedThroughSequence === 2 &&
        proof.proof.schemaVersion === 2 && proof.proof.state === "Completed" &&
        proof.proof.targetOnlyOperationCount === 2 && spend.verified === true &&
        spend.reason === "applied" && xsd2.verified === false && xsd2.reason === "missing",
        "FINANCIAL_CANARY_V2_PROVIDER_STATE_MISMATCH",
        "PlayFab no longer proves Target15/rev3/cursor2, spend applied and xsd2 missing.");

    let loadedReceipt = null;
    const loadReceipt = createPlayFabXsollaV2ReceiptReader({
        titleId: configuration.titleId,
        secretKey: configuration.secretKey
    });
    const ledgerRecord = historical.evidenceRedis.ledgerWrapper.record;
    const ledger = {
        async requireTransaction({ provider, providerTransactionId }) {
            requireCondition(provider === "xsolla" && providerTransactionId === C.xsd2.providerTransactionId,
                "FINANCIAL_CANARY_V2_TRUSTED_CHAIN_MISMATCH", "Unexpected trusted transaction lookup.");
            const record = structuredClone(ledgerRecord);
            // Redis cjson serializes an empty Lua array as `{}`. The production
            // Redis ledger store performs this same normalization on read.
            if (!Array.isArray(record.reversalIds) && record.reversalIds &&
                Object.keys(record.reversalIds).length === 0) record.reversalIds = [];
            return record;
        },
        async lookupReversals() { return Object.freeze({ items: [], nextCursor: null }); }
    };
    const resolver = createTrustedXsollaV2PaymentResolver({
        ledger,
        async loadXsollaV2Receipt(input) {
            loadedReceipt = await loadReceipt(input);
            return loadedReceipt;
        },
        expectedEnvironment: "sandbox",
        allowedTransactionStates: new Set(["Failed"]),
        authorizeTransaction(transaction) {
            requireCondition(transaction.playFabId === C.playFabId &&
                transaction.providerTransactionId === C.xsd2.providerTransactionId &&
                transaction.receiptId === C.xsd2.receiptId && transaction.sku === C.xsd2.sku,
                "FINANCIAL_CANARY_V2_TRUSTED_CHAIN_MISMATCH",
                "Ledger identity differs from certified xsd2.");
        }
    });
    const trusted = await resolver.resolveTransaction({
        providerTransactionId: C.xsd2.providerTransactionId
    });
    const provider = {
        titleId: C.titleId,
        playFabId: C.playFabId,
        snapshot: xsd2.snapshot,
        migrationProof: xsd2.proof,
        operationProof: { verified: xsd2.verified, reason: xsd2.reason },
        operationMarker: xsd2.highValueProof?.operationId === C.xsd2.operationId
            ? xsd2.highValueProof : null,
        operationResultHash: xsd2.proof?.latestTargetOperation?.h === C.xsd2.operationImmutableHash
            ? C.xsd2.operationImmutableHash : null
    };
    const evidence = {
        provider,
        redis: historical.evidenceRedis,
        trusted,
        provenance: historical.provenance
    };
    const verified = validateHistoricalXsd2SequenceRebaseEvidence({
        evidence,
        requireLedgerLease: false
    });
    requireCondition(verified.neverApplied === true && verified.allocatorBugProven === true,
        "FINANCIAL_CANARY_V2_TRUSTED_CHAIN_MISMATCH", "Historical xsd2 evidence is incomplete.");
    const providerState = {
        snapshot: proof.snapshot,
        migrationProof: proof.proof,
        highValueProof: proof.highValueProof,
        profileVersion: proof.profileVersion
    };
    return Object.freeze({
        provider,
        trusted,
        verified,
        attestation: Object.freeze({
            schemaVersion: 1,
            kind: "Canary02PlayFabProviderAttestation",
            titleId: C.titleId,
            playFabId: C.playFabId,
            targetDiamonds: proof.snapshot.diamonds,
            targetRevision: proof.snapshot.revision,
            providerCursor: proof.snapshot.highValueAppliedThroughSequence,
            migrationProofSchemaVersion: proof.proof.schemaVersion,
            targetOnlyOperationCount: proof.proof.targetOnlyOperationCount,
            spend10ProofVerified: spend.verified,
            xsd2ProofMissing: xsd2.verified === false && xsd2.reason === "missing",
            providerStateDigest: serverEconomyPocDigest(providerState),
            receiptDigest: sha256(Buffer.from(loadedReceipt.value, "utf8")),
            receiptId: loadedReceipt.key,
            trustedOperationHash: trusted.operation.immutableHash,
            // The provider state digest carries the evidence. A deterministic
            // timestamp keeps restart verification byte-for-byte stable.
            observedAtUnixMs: 0
        }),
        readOnlyCallCount: readOnly.calls().length
    });
}

async function run(mode, environment = process.env) {
    const configuration = readEnvironment(mode, environment);
    const historical = extractCertifiedCanary02V2BootstrapEvidence(
        readFileSync(configuration.legacyAofPath));
    const provider = await readTrustedProviderEvidence(configuration, historical);
    const redis = createClient({ url: configuration.redisUrl });
    await redis.connect();
    try {
        const runtime = await verifyFinancialCanaryRedisRuntime({
            redis,
            contract: configuration.runtime,
            state: configuration.state
        });
        const bindingRaw = await redis.sendCommand(["GET", configuration.runtime.datasetBindingKey]);
        requireCondition(typeof bindingRaw === "string",
            "FINANCIAL_CANARY_V2_BINDING_MISSING", "V2 dataset binding is absent.");
        const binding = parseJson(bindingRaw, "V2 dataset binding");
        const plan = createCanary02V2BootstrapImportPlan({
            historical,
            providerAttestation: provider.attestation,
            datasetBinding: binding,
            importedAtUnixMs: Date.parse(binding.createdAt)
        });
        const bootstrapper = createFinancialCanary02V2Bootstrapper({
            redis,
            datasetBindingKey: configuration.runtime.datasetBindingKey,
            runtimeIdKey: configuration.runtime.runtimeIdKey,
            datasetBindingRaw: bindingRaw
        });
        let result = null;
        if (mode === "import") result = await bootstrapper.importCertified(plan);
        else if (mode === "verify") result = await bootstrapper.inspect(plan);
        const output = {
            result: mode === "preflight" ? "preflight_pass" :
                mode === "import" ? result.status : "verify_pass",
            schemaVersion: binding.schemaVersion,
            runtimeIdHash: runtime.runtimeIdHash,
            datasetIdHash: runtime.datasetIdHash,
            bindingHash: binding.bindingHash,
            historicalImport: mode === "preflight" ? "not_performed" : "verified",
            certifiedAofSha256: historical.certifiedPrefixSha256,
            target: provider.provider.snapshot.diamonds,
            revision: provider.provider.snapshot.revision,
            providerCursor: provider.provider.snapshot.highValueAppliedThroughSequence,
            spendProof: "applied",
            xsd2Proof: "missing",
            originalSequence: C.xsd2.originalSequence,
            orphanedSequence: C.xsd2.rebasedSequence,
            activeSequence: C.xsd2.originalSequence,
            ledgerState: historical.evidenceRedis.ledgerWrapper.record.state,
            providerWrites: 0,
            aofFsyncConfirmed: result?.aofLocalFsync ?? false,
            exactDataset: runtime.exactDataset,
            productionUntouched: true
        };
        return Object.freeze(output);
    } finally {
        await redis.quit().catch(() => redis.disconnect());
    }
}

async function main() {
    const mode = process.argv[2];
    try {
        process.stdout.write(`${JSON.stringify(await run(mode))}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify({
            code: error?.code || "FINANCIAL_CANARY_V2_BOOTSTRAP_FAILED",
            message: error?.message || "V2 bootstrap failed."
        })}\n`);
        process.exitCode = 1;
    }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) await main();

export { readEnvironment, readTrustedProviderEvidence, run };
