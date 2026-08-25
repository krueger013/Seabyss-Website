import { createHash } from "node:crypto";

export const FINANCIAL_DOMAINS = Object.freeze(["Diamonds", "Elite", "Premium"]);
export const FINANCIAL_DOMAIN_MODES = Object.freeze(["Legacy", "Shadow", "Canary", "Cutover"]);
export const CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET = "SeabyssEconomyStateV1";
export const PROGRESSIVE_FINANCIAL_READINESS_CERTIFICATE_KIND =
    "ProgressiveFinancialDomainReadinessV1";
export const DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID = "1D0C16";
export const DIAMONDS_PROGRESSIVE_MIGRATION_VERSION = "diamonds-domain-v1";
export const DIAMONDS_TARGET_ADAPTER_VERSION = "diamonds-target-poc-v1";
export const MAX_FINANCIAL_READINESS_CERTIFICATE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const FINANCIAL_DOMAIN_ENVIRONMENT_KEYS = Object.freeze({
    Diamonds: Object.freeze({
        mode: "FINANCIAL_DIAMONDS_MODE",
        canaryEnabled: "FINANCIAL_DIAMONDS_CANARY_ENABLED",
        cutoverEnabled: "FINANCIAL_DIAMONDS_CUTOVER_ENABLED",
        migrationEnabled: "FINANCIAL_DIAMONDS_MIGRATION_ENABLED",
        canaryUsers: "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS"
    }),
    Elite: Object.freeze({
        mode: "FINANCIAL_ELITE_MODE",
        canaryEnabled: "FINANCIAL_ELITE_CANARY_ENABLED",
        cutoverEnabled: "FINANCIAL_ELITE_CUTOVER_ENABLED",
        migrationEnabled: "FINANCIAL_ELITE_MIGRATION_ENABLED",
        canaryUsers: "FINANCIAL_ELITE_CANARY_PLAYFAB_IDS"
    }),
    Premium: Object.freeze({
        mode: "FINANCIAL_PREMIUM_MODE",
        canaryEnabled: "FINANCIAL_PREMIUM_CANARY_ENABLED",
        cutoverEnabled: "FINANCIAL_PREMIUM_CUTOVER_ENABLED",
        migrationEnabled: "FINANCIAL_PREMIUM_MIGRATION_ENABLED",
        canaryUsers: "FINANCIAL_PREMIUM_CANARY_PLAYFAB_IDS"
    })
});

export const FINANCIAL_DOMAIN_METRIC_NAMES = Object.freeze([
    "domain_mode",
    "migration_dry_run",
    "migration_conflict",
    "canary_operation",
    "legacy_direct_access",
    "rollback_available"
]);

const DOMAIN_SET = new Set(FINANCIAL_DOMAINS);
const MODE_SET = new Set(FINANCIAL_DOMAIN_MODES);
const METRIC_SET = new Set(FINANCIAL_DOMAIN_METRIC_NAMES);
const ACCESS_CLASSIFICATIONS = new Set([
    "intentional_legacy_adapter",
    "migration_only",
    "forbidden_direct_access"
]);

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function domainName(value) {
    canonical(value, "domain", 32);
    if (!DOMAIN_SET.has(value)) throw new TypeError("Financial domain is unsupported.");
    return value;
}

function modeName(value) {
    canonical(value, "mode", 32);
    if (!MODE_SET.has(value)) throw new TypeError("Financial domain mode is unsupported.");
    return value;
}

function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return value;
}

function booleanEnvironment(value, name) {
    if (value === undefined || value === null || value === "") return false;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new TypeError(`${name} must be exactly true or false.`);
}

function canonicalUsers(value, name) {
    const entries = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const users = [];
    const seen = new Set();
    for (const entry of entries) {
        canonical(entry, `${name} entry`, 128);
        if (entry === "*") throw new TypeError(`${name} cannot contain a wildcard.`);
        if (!seen.has(entry)) {
            seen.add(entry);
            users.push(entry);
        }
    }
    return Object.freeze(users.sort((left, right) => left.localeCompare(right)));
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

function coded(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function isoUtc(value, name, { nullable = false } = {}) {
    if (nullable && value === null) return null;
    canonical(value, name, 64);
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
        throw new TypeError(`${name} must be canonical UTC ISO-8601.`);
    }
    return date.toISOString();
}

function normalizePremium(value, name) {
    if (!plain(value)) throw new TypeError(`${name} is invalid.`);
    const tier = nonNegativeInteger(value.tier, `${name}.tier`);
    if (tier > 3) throw new TypeError(`${name}.tier is invalid.`);
    if (tier === 0) {
        if (value.effectiveAtUtc !== null || value.expiresAtUtc !== null) {
            throw new TypeError(`${name} inactive timestamps must be null.`);
        }
        return Object.freeze({ tier: 0, effectiveAtUtc: null, expiresAtUtc: null });
    }
    const effectiveAtUtc = isoUtc(value.effectiveAtUtc, `${name}.effectiveAtUtc`);
    const expiresAtUtc = isoUtc(value.expiresAtUtc, `${name}.expiresAtUtc`);
    if (Date.parse(expiresAtUtc) < Date.parse(effectiveAtUtc)) {
        throw new TypeError(`${name} expiration precedes effectiveAt.`);
    }
    return Object.freeze({ tier, effectiveAtUtc, expiresAtUtc });
}

export function normalizeFinancialDomainValue(domain, value, name = "value") {
    const selected = domainName(domain);
    if (selected === "Premium") return normalizePremium(value, name);
    return nonNegativeInteger(value, name);
}

function emptyValue(domain) {
    return domain === "Premium"
        ? Object.freeze({ tier: 0, effectiveAtUtc: null, expiresAtUtc: null })
        : 0;
}

function equal(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function validateDomainConfiguration(configuration) {
    if (!plain(configuration)) throw new TypeError("Financial domain configuration is invalid.");
    const domain = domainName(configuration.domain);
    const mode = modeName(configuration.mode);
    const canaryEnabled = configuration.canaryEnabled === true;
    const cutoverEnabled = configuration.cutoverEnabled === true;
    const migrationEnabled = configuration.migrationEnabled === true;
    const canaryPlayFabIds = canonicalUsers(configuration.canaryPlayFabIds || [], "canaryPlayFabIds");
    return deepFreeze({ domain, mode, canaryEnabled, cutoverEnabled, migrationEnabled, canaryPlayFabIds });
}

export function readFinancialDomainEnvironment(environment = process.env) {
    if (!plain(environment)) throw new TypeError("Financial domain environment is invalid.");
    const result = {};
    for (const domain of FINANCIAL_DOMAINS) {
        const keys = FINANCIAL_DOMAIN_ENVIRONMENT_KEYS[domain];
        const mode = environment[keys.mode] || "Legacy";
        result[domain] = validateDomainConfiguration({
            domain,
            mode,
            canaryEnabled: booleanEnvironment(environment[keys.canaryEnabled], keys.canaryEnabled),
            cutoverEnabled: booleanEnvironment(environment[keys.cutoverEnabled], keys.cutoverEnabled),
            migrationEnabled: booleanEnvironment(environment[keys.migrationEnabled], keys.migrationEnabled),
            canaryPlayFabIds: canonicalUsers(environment[keys.canaryUsers], keys.canaryUsers)
        });
    }
    return deepFreeze(result);
}

function staticConfigurationErrors(configuration) {
    const errors = [];
    const keys = FINANCIAL_DOMAIN_ENVIRONMENT_KEYS[configuration.domain];
    if (configuration.mode === "Legacy") {
        if (configuration.canaryEnabled) errors.push(`${keys.canaryEnabled}=false`);
        if (configuration.cutoverEnabled) errors.push(`${keys.cutoverEnabled}=false`);
        if (configuration.migrationEnabled) errors.push(`${keys.migrationEnabled}=false`);
        if (configuration.canaryPlayFabIds.length > 0) errors.push(`${keys.canaryUsers}=empty`);
    } else if (configuration.mode === "Shadow") {
        if (configuration.canaryEnabled) errors.push(`${keys.canaryEnabled}=false`);
        if (configuration.cutoverEnabled) errors.push(`${keys.cutoverEnabled}=false`);
        if (configuration.migrationEnabled) errors.push(`${keys.migrationEnabled}=false`);
    } else if (configuration.mode === "Canary") {
        if (!configuration.canaryEnabled) errors.push(`${keys.canaryEnabled}=true`);
        if (configuration.cutoverEnabled) errors.push(`${keys.cutoverEnabled}=false`);
        if (configuration.migrationEnabled) errors.push(`${keys.migrationEnabled}=false`);
        if (configuration.canaryPlayFabIds.length === 0) errors.push(`${keys.canaryUsers}=one_or_more_explicit_ids`);
    } else if (configuration.mode === "Cutover") {
        if (!configuration.cutoverEnabled) errors.push(`${keys.cutoverEnabled}=true`);
        if (configuration.canaryEnabled) errors.push(`${keys.canaryEnabled}=false`);
        if (configuration.migrationEnabled) errors.push(`${keys.migrationEnabled}=false`);
        if (configuration.canaryPlayFabIds.length > 0) errors.push(`${keys.canaryUsers}=empty`);
    }
    return errors;
}

export function evaluateFinancialDomainStartupSafety({
    environment = process.env,
    readinessByDomain = {},
    nowUtc = new Date().toISOString()
} = {}) {
    isoUtc(nowUtc, "nowUtc");
    const configurations = readFinancialDomainEnvironment(environment);
    const domains = {};
    let safe = true;
    for (const domain of FINANCIAL_DOMAINS) {
        const configuration = configurations[domain];
        const errors = staticConfigurationErrors(configuration);
        const readiness = validateReadinessCertificate(
            readinessByDomain[domain],
            configuration,
            nowUtc);
        if (configuration.mode !== "Legacy" && readiness.valid !== true) {
            errors.push(`${domain}:verified_readyForCanary=true`);
            errors.push(...readiness.errors.map((entry) => `${domain}:${entry}`));
        }
        if (configuration.mode === "Cutover" && readiness.readyForCutover !== true) {
            errors.push(`${domain}:verified_readyForCutover=true`);
        }
        if (errors.length > 0) safe = false;
        domains[domain] = deepFreeze({
            ...configuration,
            safe: errors.length === 0,
            activationRequested: configuration.mode !== "Legacy",
            errors
        });
    }

    const canaryDomains = FINANCIAL_DOMAINS.filter(
        (domain) => configurations[domain].mode === "Canary");
    if (canaryDomains.length > 1) {
        safe = false;
        for (const domain of canaryDomains) {
            domains[domain] = deepFreeze({
                ...domains[domain],
                safe: false,
                errors: [...domains[domain].errors, "only_one_domain_canary_allowed"]
            });
        }
    }
    const orderRequirements = {
        Elite: ["Diamonds"],
        Premium: ["Diamonds", "Elite"]
    };
    for (const [domain, prerequisites] of Object.entries(orderRequirements)) {
        if (configurations[domain].mode !== "Canary" && configurations[domain].mode !== "Cutover") {
            continue;
        }
        const missing = prerequisites.filter(
            (prerequisite) => configurations[prerequisite].mode !== "Cutover");
        if (missing.length > 0) {
            safe = false;
            domains[domain] = deepFreeze({
                ...domains[domain],
                safe: false,
                errors: [...domains[domain].errors,
                    `progressive_order_requires_${missing.join("_")}_Cutover`]
            });
        }
    }
    return deepFreeze({ safe, configurations, domains });
}

export function createFinancialDomainReadinessCertificate({
    healthInput,
    scannerBaselineDigest,
    sandboxTitleId,
    adapterVersion,
    migrationVersion,
    dryRunPlanHash,
    providerDigest,
    healthChecks,
    testDigest,
    issuedAtUtc,
    expiresAtUtc,
    targetContract = CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET
} = {}) {
    canonical(scannerBaselineDigest, "scannerBaselineDigest", 64);
    if (!/^[a-f0-9]{64}$/u.test(scannerBaselineDigest)) {
        throw new TypeError("scannerBaselineDigest must be a SHA-256 digest.");
    }
    if (targetContract !== CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET) {
        throw new TypeError("Readiness certificate target contract is not certified.");
    }
    canonical(sandboxTitleId, "sandboxTitleId", 64);
    if (sandboxTitleId === "142853") {
        throw new TypeError("A readiness certificate cannot target the Production title.");
    }
    canonical(adapterVersion, "adapterVersion", 128);
    canonical(migrationVersion, "migrationVersion", 128);
    for (const [name, value] of [
        ["dryRunPlanHash", dryRunPlanHash],
        ["providerDigest", providerDigest],
        ["testDigest", testDigest]
    ]) {
        canonical(value, name, 64);
        if (!/^[a-f0-9]{64}$/u.test(value)) {
            throw new TypeError(`${name} must be a SHA-256 digest.`);
        }
    }
    if (!plain(healthChecks) || Object.keys(healthChecks).length === 0 ||
        Object.values(healthChecks).some((value) => value !== true)) {
        throw new TypeError("Readiness certificate healthChecks must all be true.");
    }
    for (const key of Object.keys(healthChecks)) {
        canonical(key, "healthChecks key", 128);
        if (/(?:secret|token|ticket|password|authorization)/iu.test(key)) {
            throw new TypeError("Readiness certificate healthChecks cannot contain credentials.");
        }
    }
    const issued = isoUtc(issuedAtUtc, "issuedAtUtc");
    const expires = isoUtc(expiresAtUtc, "expiresAtUtc");
    const lifetimeMs = Date.parse(expires) - Date.parse(issued);
    if (lifetimeMs <= 0 || lifetimeMs > MAX_FINANCIAL_READINESS_CERTIFICATE_LIFETIME_MS) {
        throw new TypeError("Readiness certificate expiration is invalid.");
    }
    const health = evaluateFinancialDomainHealth(structuredClone(healthInput));
    if (health.readyForCanary !== true) {
        throw coded("FINANCIAL_DOMAIN_NOT_READY",
            "A readiness certificate cannot be created from blocked health evidence.",
            { blockers: health.blockers });
    }
    if (health.domain === "Diamonds" && sandboxTitleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID) {
        throw new TypeError(
            `Diamonds readiness certificate must target Sandbox ${DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID}.`);
    }
    const evidence = {
        kind: PROGRESSIVE_FINANCIAL_READINESS_CERTIFICATE_KIND,
        schemaVersion: 1,
        domain: health.domain,
        certifiedMode: health.mode,
        targetContract,
        scannerBaselineDigest,
        sandboxTitleId,
        adapterVersion,
        migrationVersion,
        dryRunPlanHash,
        providerDigest,
        healthChecks: stable(structuredClone(healthChecks)),
        testDigest,
        issuedAtUtc: issued,
        expiresAtUtc: expires,
        healthInput: structuredClone(healthInput),
        healthDigest: digest(health)
    };
    return deepFreeze({ ...evidence, certificateHash: digest(evidence) });
}

function validateReadinessCertificate(certificate, configuration, nowUtc) {
    const errors = [];
    if (!plain(certificate)) return { valid: false, readyForCutover: false,
        errors: ["readiness_certificate_missing"] };
    if (certificate.kind !== PROGRESSIVE_FINANCIAL_READINESS_CERTIFICATE_KIND ||
        certificate.schemaVersion !== 1) errors.push("readiness_certificate_schema_invalid");
    if (certificate.domain !== configuration.domain) errors.push("readiness_certificate_domain_mismatch");
    if (certificate.targetContract !== CERTIFIED_PROGRESSIVE_FINANCIAL_TARGET) {
        errors.push("readiness_certificate_target_not_certified");
    }
    if (!/^[a-f0-9]{64}$/u.test(certificate.scannerBaselineDigest || "")) {
        errors.push("readiness_certificate_scanner_digest_invalid");
    }
    if (typeof certificate.sandboxTitleId !== "string" ||
        certificate.sandboxTitleId === "142853") {
        errors.push("readiness_certificate_sandbox_title_invalid");
    }
    if (configuration.domain === "Diamonds" &&
        certificate.sandboxTitleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID) {
        errors.push("readiness_certificate_diamonds_sandbox_title_mismatch");
    }
    if (typeof certificate.adapterVersion !== "string" ||
        typeof certificate.migrationVersion !== "string") {
        errors.push("readiness_certificate_versions_invalid");
    }
    if (configuration.domain === "Diamonds" &&
        (certificate.adapterVersion !== DIAMONDS_TARGET_ADAPTER_VERSION ||
         certificate.migrationVersion !== DIAMONDS_PROGRESSIVE_MIGRATION_VERSION)) {
        errors.push("readiness_certificate_diamonds_version_mismatch");
    }
    for (const [name, value] of [
        ["dry_run_plan", certificate.dryRunPlanHash],
        ["provider", certificate.providerDigest],
        ["test", certificate.testDigest],
        ["certificate", certificate.certificateHash]
    ]) {
        if (!/^[a-f0-9]{64}$/u.test(value || "")) {
            errors.push(`readiness_certificate_${name}_digest_invalid`);
        }
    }
    if (!plain(certificate.healthChecks) || Object.keys(certificate.healthChecks).length === 0 ||
        Object.values(certificate.healthChecks).some((value) => value !== true)) {
        errors.push("readiness_certificate_health_checks_invalid");
    }
    let health = null;
    try {
        isoUtc(certificate.issuedAtUtc, "issuedAtUtc");
        isoUtc(certificate.expiresAtUtc, "expiresAtUtc");
        const lifetimeMs = Date.parse(certificate.expiresAtUtc) - Date.parse(certificate.issuedAtUtc);
        if (lifetimeMs <= 0 || lifetimeMs > MAX_FINANCIAL_READINESS_CERTIFICATE_LIFETIME_MS) {
            errors.push("readiness_certificate_lifetime_invalid");
        }
        if (Date.parse(certificate.issuedAtUtc) > Date.parse(nowUtc) ||
            Date.parse(certificate.expiresAtUtc) <= Date.parse(nowUtc)) {
            errors.push("readiness_certificate_expired_or_not_yet_valid");
        }
        health = evaluateFinancialDomainHealth(structuredClone(certificate.healthInput));
        if (health.domain !== configuration.domain || health.readyForCanary !== true) {
            errors.push("readiness_certificate_health_not_ready");
        }
        if (certificate.healthDigest !== digest(health)) {
            errors.push("readiness_certificate_health_digest_mismatch");
        }
        const { certificateHash, ...unsignedEvidence } = certificate;
        if (certificateHash !== digest(unsignedEvidence)) {
            errors.push("readiness_certificate_hash_mismatch");
        }
        if (configuration.mode === "Canary" && health.mode !== "Canary") {
            errors.push("readiness_certificate_mode_mismatch");
        }
        if (configuration.mode === "Cutover" && health.readyForCutover !== true) {
            errors.push("readiness_certificate_cutover_not_certified");
        }
    } catch {
        errors.push("readiness_certificate_evidence_invalid");
    }
    return {
        valid: errors.length === 0,
        readyForCutover: errors.length === 0 && health?.readyForCutover === true,
        errors
    };
}

export function validateFinancialDomainReadinessCertificate({
    certificate,
    configuration,
    nowUtc = new Date().toISOString()
} = {}) {
    const config = validateDomainConfiguration(configuration);
    isoUtc(nowUtc, "nowUtc");
    return deepFreeze(validateReadinessCertificate(certificate, config, nowUtc));
}

function requireAdapter(adapter, methods, name) {
    if (!adapter || methods.some((method) => typeof adapter[method] !== "function")) {
        throw new TypeError(`${name} adapter is not configured.`);
    }
}

function canarySelected(configuration, playFabId) {
    return configuration.mode === "Canary" && configuration.canaryPlayFabIds.includes(playFabId);
}

/**
 * Domain router prepared for later composition. It is deliberately not wired
 * into server.js: Legacy remains authoritative until a separately certified
 * composition injects the adapters and a non-Legacy readiness certificate.
 */
export function createProgressiveFinancialDomainService({
    configuration,
    legacyAdapter,
    shadowAdapter,
    targetAdapter,
    compare = equal,
    metrics = null
} = {}) {
    const config = validateDomainConfiguration(configuration);
    const configurationErrors = staticConfigurationErrors(config);
    if (configurationErrors.length > 0) {
        throw coded("FINANCIAL_DOMAIN_CONFIGURATION_UNSAFE",
            `Financial ${config.domain} ${config.mode} composition is unsafe: ${configurationErrors.join(", ")}`);
    }
    requireAdapter(legacyAdapter, ["read", "mutate"], "Legacy");
    if (config.mode === "Shadow") requireAdapter(shadowAdapter, ["observe", "read"], "Shadow");
    if (config.mode === "Canary" || config.mode === "Cutover") {
        requireAdapter(targetAdapter, ["read", "mutate"], "Target");
    }
    if (typeof compare !== "function") throw new TypeError("Domain comparator is required.");
    metrics?.setMode?.(config.domain, config.mode);

    async function read(playFabId) {
        canonical(playFabId, "playFabId", 128);
        if (config.mode === "Cutover" || canarySelected(config, playFabId)) {
            const value = normalizeFinancialDomainValue(config.domain,
                await targetAdapter.read(playFabId), "target value");
            const legacy = normalizeFinancialDomainValue(config.domain,
                await legacyAdapter.read(playFabId), "legacy compatibility value");
            const match = compare(legacy, value) === true;
            return deepFreeze({ domain: config.domain, mode: config.mode,
                authoritativeSource: "Target", value,
                comparison: { match, legacy, target: value } });
        }
        const legacy = normalizeFinancialDomainValue(config.domain,
            await legacyAdapter.read(playFabId), "legacy value");
        if (config.mode !== "Shadow") {
            return deepFreeze({ domain: config.domain, mode: config.mode,
                authoritativeSource: "Legacy", value: legacy, comparison: null });
        }
        const shadow = normalizeFinancialDomainValue(config.domain,
            await shadowAdapter.read(playFabId), "shadow value");
        const match = compare(legacy, shadow) === true;
        return deepFreeze({ domain: config.domain, mode: config.mode,
            authoritativeSource: "Legacy", value: legacy,
            comparison: { match, legacy, shadow } });
    }

    async function mutate({ playFabId, operationId, mutation, effectiveAtUtc = null } = {}) {
        canonical(playFabId, "playFabId", 128);
        canonical(operationId, "operationId", 255);
        if (!plain(mutation)) throw new TypeError("Domain mutation is invalid.");
        if (effectiveAtUtc !== null) isoUtc(effectiveAtUtc, "effectiveAtUtc");
        const request = deepFreeze({ domain: config.domain, playFabId, operationId,
            mutation: structuredClone(mutation), effectiveAtUtc });
        if (config.mode === "Cutover" || canarySelected(config, playFabId)) {
            metrics?.record?.("canary_operation", { domain: config.domain });
            return targetAdapter.mutate(request);
        }
        const result = await legacyAdapter.mutate(request);
        if (config.mode === "Shadow") {
            await shadowAdapter.observe({ ...request, legacyResult: structuredClone(result) });
        }
        return result;
    }

    return Object.freeze({ domain: config.domain, mode: config.mode, read, mutate });
}

function sha256(value, name) {
    canonical(value, name, 64);
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${name} must be a SHA-256 digest.`);
    return value;
}

function validateMigrationProof(proof, {
    domain,
    playFabId,
    titleId,
    migrationVersion,
    targetValue,
    targetRevision
}) {
    if (!plain(proof)) return { valid: false, reason: "missing" };
    if (proof.state !== "Completed" || proof.domain !== domain || proof.playFabId !== playFabId ||
        proof.titleId !== titleId || proof.migrationVersion !== migrationVersion ||
        !/^[a-f0-9]{64}$/u.test(proof.planHash || "") ||
        !/^[a-f0-9]{64}$/u.test(proof.targetDigest || "") ||
        proof.targetDigest !== digest(targetValue) ||
        !Number.isSafeInteger(proof.targetRevision) || proof.targetRevision < 0 ||
        proof.targetRevision !== targetRevision ||
        !Number.isSafeInteger(proof.targetOnlyOperationCount) || proof.targetOnlyOperationCount < 0) {
        return { valid: false, reason: "invalid" };
    }
    return { valid: true, reason: null };
}

function rollbackMetadata({ proof, targetClaimsPostCutover }) {
    const targetOnlyOperationCount = proof?.targetOnlyOperationCount ?? 0;
    const available = (proof === null || proof === undefined ||
        proof?.state === "Completed") &&
        targetOnlyOperationCount === 0 && targetClaimsPostCutover !== true;
    return deepFreeze({
        available,
        automatic: available,
        pointOfNoReturn: available ? "first_target_only_mutation_after_canary_enable" : "passed",
        reason: available
            ? "No target-only mutation is recorded; disable the domain gate before restoring Legacy."
            : "Target-only financial history exists; automatic rollback would lose or duplicate value."
    });
}

export function planProgressiveFinancialDomainMigration({
    domain,
    playFabId,
    titleId,
    migrationVersion,
    legacyValue,
    targetValue,
    legacyRevision = 0,
    targetRevision = 0,
    providerProfileVersion = 0,
    providerStateDigest,
    migrationProof = null,
    legacyClaimsPostCutover = false,
    targetClaimsPostCutover = false
} = {}) {
    const selected = domainName(domain);
    canonical(playFabId, "playFabId", 128);
    const selectedTitleId = canonical(titleId, "titleId", 64);
    const selectedMigrationVersion = canonical(migrationVersion, "migrationVersion", 128);
    if (selected === "Diamonds" && selectedTitleId !== DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID) {
        throw coded("DIAMONDS_SANDBOX_TITLE_MISMATCH",
            `Diamonds readiness plans must target isolated Sandbox ${DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID}.`);
    }
    const legacy = normalizeFinancialDomainValue(selected, legacyValue, "legacyValue");
    const target = normalizeFinancialDomainValue(selected, targetValue, "targetValue");
    nonNegativeInteger(legacyRevision, "legacyRevision");
    nonNegativeInteger(targetRevision, "targetRevision");
    nonNegativeInteger(providerProfileVersion, "providerProfileVersion");
    const selectedProviderDigest = sha256(providerStateDigest, "providerStateDigest");
    const proof = validateMigrationProof(migrationProof, {
        domain: selected,
        playFabId,
        titleId: selectedTitleId,
        migrationVersion: selectedMigrationVersion,
        targetValue: target,
        targetRevision
    });
    const rollback = rollbackMetadata({
        proof: migrationProof === null || proof.valid ? migrationProof : { state: "Invalid", targetOnlyOperationCount: 1 },
        targetClaimsPostCutover
    });
    const conflicts = [];

    if (migrationProof !== null && !proof.valid) {
        conflicts.push({ reason: "invalid_migration_proof", detail: proof.reason });
    }
    if (legacyClaimsPostCutover && targetClaimsPostCutover && !equal(legacy, target)) {
        conflicts.push({ reason: "divergent_post_cutover_authorities" });
    }
    if (proof.valid && !conflicts.length) {
        const basis = { schemaVersion: 2, domain: selected, playFabId,
            titleId: selectedTitleId, migrationVersion: selectedMigrationVersion,
            target, targetRevision, providerProfileVersion,
            providerStateDigest: selectedProviderDigest,
            proofPlanHash: migrationProof.planHash };
        return deepFreeze({
            status: "already_migrated",
            readOnly: true,
            providerWriteCount: 0,
            authorityWinner: "Target",
            domain: selected,
            playFabId,
            titleId: selectedTitleId,
            migrationVersion: selectedMigrationVersion,
            legacyValue: legacy,
            targetValue: target,
            proposedTarget: target,
            expectedTargetRevision: targetRevision,
            expectedProviderProfileVersion: providerProfileVersion,
            providerStateDigest: selectedProviderDigest,
            planHash: digest(basis),
            conflicts: [],
            rollback
        });
    }

    const targetIsEmpty = equal(target, emptyValue(selected));
    if (!targetIsEmpty && !equal(legacy, target)) {
        conflicts.push({
            reason: selected === "Premium"
                ? "premium_target_conflict_never_reduce_financial_proof"
                : "non_empty_target_conflict_never_add_or_merge",
            legacy,
            target
        });
    }
    if (conflicts.length > 0) {
        const conflictBasis = {
            schemaVersion: 2,
            kind: "progressive_financial_domain_migration",
            domain: selected,
            playFabId,
            titleId: selectedTitleId,
            migrationVersion: selectedMigrationVersion,
            legacyValue: legacy,
            legacyRevision,
            observedTarget: target,
            expectedTargetRevision: targetRevision,
            providerProfileVersion,
            providerStateDigest: selectedProviderDigest,
            proposedTarget: null,
            conflicts
        };
        return deepFreeze({
            status: "manual_review",
            readOnly: true,
            providerWriteCount: 0,
            authorityWinner: null,
            domain: selected,
            playFabId,
            titleId: selectedTitleId,
            migrationVersion: selectedMigrationVersion,
            legacyValue: legacy,
            targetValue: target,
            proposedTarget: null,
            expectedTargetRevision: targetRevision,
            expectedProviderProfileVersion: providerProfileVersion,
            providerStateDigest: selectedProviderDigest,
            planHash: digest(conflictBasis),
            conflicts,
            rollback
        });
    }

    const basis = {
        schemaVersion: 2,
        kind: "progressive_financial_domain_migration",
        domain: selected,
        playFabId,
        titleId: selectedTitleId,
        migrationVersion: selectedMigrationVersion,
        source: "Legacy",
        legacyValue: legacy,
        legacyRevision,
        observedTarget: target,
        expectedTargetRevision: targetRevision,
        providerProfileVersion,
        providerStateDigest: selectedProviderDigest,
        proposedTarget: legacy,
        conflictPolicy: "replace_exactly_never_add"
    };
    return deepFreeze({
        status: "ready",
        readOnly: true,
        providerWriteCount: 0,
        authorityWinner: "Legacy",
        domain: selected,
        playFabId,
        titleId: selectedTitleId,
        migrationVersion: selectedMigrationVersion,
        legacyValue: legacy,
        targetValue: target,
        proposedTarget: legacy,
        expectedTargetRevision: targetRevision,
        expectedProviderProfileVersion: providerProfileVersion,
        providerStateDigest: selectedProviderDigest,
        planHash: digest(basis),
        operationId: `domain-migration:${selected.toLowerCase()}:${digest(basis)}`,
        conflicts: [],
        rollback,
        conflictPolicy: selected === "Premium"
            ? "valid_newer_target_proof_wins_otherwise_manual_review"
            : "unmigrated_legacy_wins_valid_target_proof_wins_divergence_manual_review"
    });
}

export function assertProgressiveFinancialDomainMigrationPlanFresh({
    plan,
    currentObservation
} = {}) {
    if (!plain(plan) || !/^[a-f0-9]{64}$/u.test(plan.planHash || "")) {
        throw coded("DOMAIN_MIGRATION_PLAN_INVALID", "A hashed dry-run plan is required.");
    }
    if (!plain(currentObservation)) {
        throw coded("DOMAIN_MIGRATION_CURRENT_OBSERVATION_REQUIRED",
            "Fresh provider and Legacy observations are required.");
    }
    const current = planProgressiveFinancialDomainMigration({
        domain: plan.domain,
        playFabId: plan.playFabId,
        titleId: plan.titleId,
        migrationVersion: plan.migrationVersion,
        legacyValue: currentObservation.legacyValue,
        targetValue: currentObservation.targetValue,
        legacyRevision: currentObservation.legacyRevision ?? 0,
        targetRevision: currentObservation.targetRevision ?? 0,
        providerProfileVersion: currentObservation.providerProfileVersion ?? 0,
        providerStateDigest: currentObservation.providerStateDigest,
        migrationProof: currentObservation.migrationProof ?? null,
        legacyClaimsPostCutover: currentObservation.legacyClaimsPostCutover === true,
        targetClaimsPostCutover: currentObservation.targetClaimsPostCutover === true
    });
    if (current.planHash !== plan.planHash || current.status !== plan.status) {
        throw coded("DOMAIN_MIGRATION_PLAN_STALE",
            "Provider or Legacy state changed after the approved dry-run.",
            { approvedPlanHash: plan.planHash, currentPlanHash: current.planHash });
    }
    return deepFreeze({ fresh: true, planHash: plan.planHash });
}

export function createProgressiveFinancialDomainMigrationExecutor({
    enabled = false,
    providerWritesEnabled = false,
    markerStore,
    targetWriter,
    metrics = null
} = {}) {
    if (typeof enabled !== "boolean" || typeof providerWritesEnabled !== "boolean") {
        throw new TypeError("Domain migration executor gates are invalid.");
    }
    if (enabled || providerWritesEnabled) {
        requireAdapter(markerStore, ["get", "putIfAbsent"], "Migration marker store");
        requireAdapter(targetWriter, ["replaceIdempotent", "read"], "Migration target writer");
    }

    async function execute({ plan, approvedPlanHash, fencingEpoch, currentObservation } = {}) {
        if (!enabled || !providerWritesEnabled) {
            throw coded("DOMAIN_MIGRATION_DISABLED", "Progressive domain migration writes are disabled.");
        }
        if (!plain(plan) || plan.status !== "ready" || plan.readOnly !== true) {
            throw coded("DOMAIN_MIGRATION_PLAN_INVALID", "A ready dry-run plan is required.");
        }
        canonical(approvedPlanHash, "approvedPlanHash", 64);
        if (approvedPlanHash !== plan.planHash) {
            throw coded("DOMAIN_MIGRATION_PLAN_HASH_MISMATCH", "The approved dry-run plan hash differs.");
        }
        assertProgressiveFinancialDomainMigrationPlanFresh({ plan, currentObservation });
        positiveInteger(fencingEpoch, "fencingEpoch");
        const existing = await markerStore.get({ domain: plan.domain, playFabId: plan.playFabId });
        if (existing) {
            if (existing.planHash !== plan.planHash) {
                metrics?.record?.("migration_conflict", { domain: plan.domain });
                throw coded("DOMAIN_MIGRATION_MARKER_CONFLICT", "A different migration proof already exists.");
            }
            const readback = await targetWriter.read({
                domain: plan.domain,
                playFabId: plan.playFabId
            });
            const currentValue = normalizeFinancialDomainValue(
                plan.domain, readback?.value, "migration readback value");
            const currentRevision = nonNegativeInteger(
                readback?.targetRevision, "migration readback revision");
            if (digest(currentValue) !== existing.targetDigest ||
                currentRevision < existing.targetRevision) {
                metrics?.record?.("migration_conflict", { domain: plan.domain });
                throw coded("DOMAIN_MIGRATION_READBACK_CONFLICT",
                    "Migration marker does not match the current Target readback.");
            }
            return deepFreeze({ status: "already_migrated", providerWriteCount: 0,
                proof: structuredClone(existing), readback: structuredClone(readback) });
        }
        const evidence = await targetWriter.replaceIdempotent({
            domain: plan.domain,
            playFabId: plan.playFabId,
            operationId: plan.operationId,
            value: structuredClone(plan.proposedTarget),
            expectedRevision: plan.expectedTargetRevision,
            fencingEpoch
        });
        const readback = await targetWriter.read({
            domain: plan.domain,
            playFabId: plan.playFabId
        });
        const readbackValue = normalizeFinancialDomainValue(
            plan.domain, readback?.value, "migration readback value");
        const readbackRevision = nonNegativeInteger(
            readback?.targetRevision, "migration readback revision");
        if (!equal(readbackValue, plan.proposedTarget) ||
            readbackRevision !== nonNegativeInteger(evidence.targetRevision, "targetRevision")) {
            metrics?.record?.("migration_conflict", { domain: plan.domain });
            throw coded("DOMAIN_MIGRATION_READBACK_CONFLICT",
                "Target replacement was not confirmed by an exact provider readback.");
        }
        const proof = deepFreeze({
            state: "Completed",
            domain: plan.domain,
            playFabId: plan.playFabId,
            titleId: plan.titleId,
            migrationVersion: plan.migrationVersion,
            planHash: plan.planHash,
            targetDigest: digest(plan.proposedTarget),
            targetRevision: readbackRevision,
            targetOnlyOperationCount: 0,
            operationId: plan.operationId
        });
        const stored = await markerStore.putIfAbsent({
            domain: plan.domain,
            playFabId: plan.playFabId,
            proof
        });
        if (stored?.created !== true && stored?.proof?.planHash !== plan.planHash) {
            metrics?.record?.("migration_conflict", { domain: plan.domain });
            throw coded("DOMAIN_MIGRATION_MARKER_CONFLICT", "Migration proof CAS lost to another plan.");
        }
        return deepFreeze({ status: evidence.alreadyApplied === true ? "reconciled" : "completed",
            providerWriteCount: evidence.alreadyApplied === true ? 0 : 1,
            proof: structuredClone(stored?.proof || proof),
            readback: structuredClone(readback) });
    }

    return Object.freeze({
        enabled,
        providerWritesEnabled,
        execute,
        health() {
            return Object.freeze({ enabled, providerWritesEnabled,
                ready: enabled && providerWritesEnabled });
        }
    });
}

export function classifyLegacyFinancialAccess(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError("Legacy access entries must be an array.");
    const domains = Object.fromEntries(FINANCIAL_DOMAINS.map((domain) => [domain, {
        intentionalLegacyAdapter: 0,
        migrationOnly: 0,
        forbiddenDirectAccess: 0,
        entries: []
    }]));
    for (const raw of entries) {
        if (!plain(raw)) throw new TypeError("Legacy access entry is invalid.");
        const domain = domainName(raw.domain);
        const classification = canonical(raw.classification, "classification", 64);
        if (!ACCESS_CLASSIFICATIONS.has(classification)) {
            throw new TypeError("Legacy access classification is invalid.");
        }
        const path = canonical(raw.path, "path", 1024);
        const access = canonical(raw.access, "access", 128);
        const key = classification === "intentional_legacy_adapter"
            ? "intentionalLegacyAdapter"
            : classification === "migration_only" ? "migrationOnly" : "forbiddenDirectAccess";
        domains[domain][key] += 1;
        domains[domain].entries.push({ path, access, classification });
    }
    for (const domain of FINANCIAL_DOMAINS) {
        domains[domain].entries.sort((left, right) =>
            left.path.localeCompare(right.path) || left.access.localeCompare(right.access));
    }
    return deepFreeze({
        domains,
        totals: Object.fromEntries(FINANCIAL_DOMAINS.map((domain) => [domain,
            domains[domain].intentionalLegacyAdapter + domains[domain].migrationOnly +
            domains[domain].forbiddenDirectAccess]))
    });
}

export function evaluateFinancialDomainHealth({
    configuration,
    legacyAccess = {},
    shadowMismatchCount = 0,
    migrationConflicts = 0,
    pendingOperations = 0,
    scannerCertified = false,
    dryRunCertified = false,
    targetHealthy = false,
    redisHealthy = false,
    playFabHealthy = false,
    rollbackPlanValid = false,
    canaryCertified = false
} = {}) {
    const config = validateDomainConfiguration(configuration);
    const intentionalLegacyAdapter = nonNegativeInteger(
        legacyAccess.intentionalLegacyAdapter ?? 0, "intentionalLegacyAdapter");
    const migrationOnly = nonNegativeInteger(legacyAccess.migrationOnly ?? 0, "migrationOnly");
    const forbiddenDirectAccess = nonNegativeInteger(
        legacyAccess.forbiddenDirectAccess ?? 0, "forbiddenDirectAccess");
    nonNegativeInteger(shadowMismatchCount, "shadowMismatchCount");
    nonNegativeInteger(migrationConflicts, "migrationConflicts");
    nonNegativeInteger(pendingOperations, "pendingOperations");
    const blockers = [];
    if (!scannerCertified) blockers.push("legacy_scanner_not_certified");
    if (forbiddenDirectAccess > 0) blockers.push("forbidden_legacy_direct_access");
    if (!dryRunCertified) blockers.push("migration_dry_run_not_certified");
    if (shadowMismatchCount > 0) blockers.push("shadow_mismatch");
    if (migrationConflicts > 0) blockers.push("migration_conflict");
    if (pendingOperations > 0) blockers.push("pending_financial_operations");
    if (!targetHealthy) blockers.push("target_unhealthy");
    if (!redisHealthy) blockers.push("redis_unhealthy");
    if (!playFabHealthy) blockers.push("playfab_unhealthy");
    if (!rollbackPlanValid) blockers.push("rollback_plan_invalid");
    const readyForCanary = blockers.length === 0;
    const readyForCutover = readyForCanary && config.mode === "Canary" && canaryCertified === true;
    return deepFreeze({
        domain: config.domain,
        mode: config.mode,
        readyForCanary,
        readyForCutover,
        blockers,
        legacyAccessRemaining: {
            intentionalLegacyAdapter,
            migrationOnly,
            forbiddenDirectAccess
        },
        shadowMismatchCount,
        migrationConflicts,
        pendingOperations,
        rollbackAvailable: rollbackPlanValid === true,
        canaryCertified: canaryCertified === true
    });
}

export function createFinancialDomainMetrics() {
    const counters = new Map();
    const modes = new Map(FINANCIAL_DOMAINS.map((domain) => [domain, "Legacy"]));
    const rollback = new Map(FINANCIAL_DOMAINS.map((domain) => [domain, false]));

    function record(name, { domain, value = 1 } = {}) {
        canonical(name, "metric name", 64);
        if (!METRIC_SET.has(name) || name === "domain_mode" || name === "rollback_available") {
            throw new TypeError("Financial domain counter metric is invalid.");
        }
        const selected = domainName(domain);
        nonNegativeInteger(value, "metric value");
        const key = JSON.stringify([name, selected]);
        counters.set(key, (counters.get(key) || 0) + value);
    }

    function setMode(domain, mode) {
        modes.set(domainName(domain), modeName(mode));
    }

    function setRollbackAvailable(domain, available) {
        if (typeof available !== "boolean") throw new TypeError("rollback availability is invalid.");
        rollback.set(domainName(domain), available);
    }

    function snapshot() {
        return deepFreeze({
            domain_mode: Object.fromEntries(modes),
            rollback_available: Object.fromEntries(rollback),
            counters: [...counters.entries()].map(([key, value]) => {
                const [name, domain] = JSON.parse(key);
                return { name, domain, value };
            }).sort((left, right) => left.name.localeCompare(right.name) ||
                left.domain.localeCompare(right.domain))
        });
    }

    return Object.freeze({ record, setMode, setRollbackAvailable, snapshot });
}
