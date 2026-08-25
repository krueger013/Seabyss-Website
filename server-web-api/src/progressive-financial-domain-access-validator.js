import { readFile } from "node:fs/promises";

export const PROGRESSIVE_FINANCIAL_BASELINE_SCHEMA_VERSION = 1;
export const PROGRESSIVE_FINANCIAL_BASELINE_KIND = "seabyss_progressive_financial_domain_baseline";
export const CERTIFIED_FINANCIAL_TARGET_CONTRACT = "SeabyssEconomyStateV1";
export const DEPRECATED_FINANCIAL_TARGET_CONTRACT = "SeabyssFinancialAuthorityV2";
export const PROGRESSIVE_FINANCIAL_DOMAINS = Object.freeze(["Diamonds", "Elite", "Premium"]);
export const PROGRESSIVE_ACCESS_CLASSIFICATIONS = Object.freeze([
    "intentional_legacy_adapter",
    "migration_only",
    "forbidden_direct_access"
]);

const BASELINE_URL = new URL("../config/progressive-financial-domain-baseline.json", import.meta.url);
const DOMAIN_SET = new Set(PROGRESSIVE_FINANCIAL_DOMAINS);

function plain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
    const error = new TypeError(message);
    error.code = "PROGRESSIVE_FINANCIAL_BASELINE_INVALID";
    throw error;
}

function canonical(value, name, maximumLength = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        fail(`${name} is invalid.`);
    }
    return value;
}

function nonNegativeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative safe integer.`);
    return value;
}

function stringList(value, name) {
    if (!Array.isArray(value)) fail(`${name} must be an array.`);
    const seen = new Set();
    return Object.freeze(value.map((entry, index) => {
        const normalized = canonical(entry, `${name}[${index}]`);
        if (seen.has(normalized)) fail(`${name} contains a duplicate entry.`);
        seen.add(normalized);
        return normalized;
    }));
}

function countSnapshot(value, name) {
    if (!plain(value)) fail(`${name} is invalid.`);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        canonical(key, `${name} key`, 160);
        if (typeof entry === "boolean") {
            result[key] = entry;
        } else {
            result[key] = nonNegativeInteger(entry, `${name}.${key}`);
        }
    }
    return Object.freeze(result);
}

function classifiedEntries(domain, domainBaseline) {
    const mappings = [
        ["intentionalLegacyAdapters", "intentional_legacy_adapter"],
        ["migrationOnly", "migration_only"],
        ["forbiddenDirect", "forbidden_direct_access"]
    ];
    const entries = [];
    for (const [property, classification] of mappings) {
        for (const path of stringList(domainBaseline[property], `domains.${domain}.${property}`)) {
            entries.push(Object.freeze({ domain, path, classification }));
        }
    }
    return Object.freeze(entries);
}

function summarizeDomain(domain, value) {
    if (!plain(value)) fail(`domains.${domain} is invalid.`);
    const entries = classifiedEntries(domain, value);
    const counts = {
        intentional_legacy_adapter: 0,
        migration_only: 0,
        forbidden_direct_access: 0
    };
    for (const entry of entries) counts[entry.classification] += 1;

    const declaredReadyForCanary = value.readyForCanary === true;
    const forbiddenPathsRemain = counts.forbidden_direct_access > 0;
    const readinessConsistent = !declaredReadyForCanary || !forbiddenPathsRemain;
    const readyForCanary = declaredReadyForCanary && !forbiddenPathsRemain;
    const blockers = forbiddenPathsRemain ? Object.freeze(["forbidden_direct_access_remaining"]) : Object.freeze([]);

    return Object.freeze({
        domain,
        legacyStore: canonical(value.legacyStore, `domains.${domain}.legacyStore`),
        targetStore: canonical(value.targetStore, `domains.${domain}.targetStore`),
        before: countSnapshot(value.before, `domains.${domain}.before`),
        afterPreparation: countSnapshot(value.afterPreparation, `domains.${domain}.afterPreparation`),
        entries,
        counts: Object.freeze({ ...counts, total: entries.length }),
        declaredReadyForCanary,
        readyForCanary,
        forbiddenPathsRemain,
        readinessConsistent,
        blockers
    });
}

/**
 * Validates and normalizes the checked-in progressive migration baseline.
 * Readiness is deliberately fail-closed: a manifest cannot become Canary-ready
 * while any entry is classified as forbidden_direct_access.
 */
export function validateProgressiveFinancialDomainBaseline(value) {
    if (!plain(value)) fail("Progressive financial baseline is invalid.");
    if (value.schemaVersion !== PROGRESSIVE_FINANCIAL_BASELINE_SCHEMA_VERSION) {
        fail("Progressive financial baseline schemaVersion is unsupported.");
    }
    if (value.kind !== PROGRESSIVE_FINANCIAL_BASELINE_KIND) {
        fail("Progressive financial baseline kind is invalid.");
    }
    if (value.activeAuthority !== "Legacy") fail("Progressive financial baseline must remain Legacy-authoritative.");
    if (value.certifiedTargetContract !== CERTIFIED_FINANCIAL_TARGET_CONTRACT) {
        fail(`Certified target must be ${CERTIFIED_FINANCIAL_TARGET_CONTRACT}.`);
    }
    if (value.deprecatedMigrationOnlyTarget !== DEPRECATED_FINANCIAL_TARGET_CONTRACT) {
        fail(`Deprecated migration-only target must be ${DEPRECATED_FINANCIAL_TARGET_CONTRACT}.`);
    }
    if (!plain(value.domains)) fail("Progressive financial baseline domains are invalid.");

    const actualDomains = Object.keys(value.domains).sort();
    const expectedDomains = [...PROGRESSIVE_FINANCIAL_DOMAINS].sort();
    if (JSON.stringify(actualDomains) !== JSON.stringify(expectedDomains)) {
        fail("Progressive financial baseline must contain exactly Diamonds, Elite and Premium.");
    }

    const domains = {};
    const entries = [];
    let readyForCanary = true;
    for (const domain of PROGRESSIVE_FINANCIAL_DOMAINS) {
        if (!DOMAIN_SET.has(domain)) fail(`Unsupported financial domain ${domain}.`);
        const summary = summarizeDomain(domain, value.domains[domain]);
        domains[domain] = summary;
        entries.push(...summary.entries);
        readyForCanary = readyForCanary && summary.readyForCanary;
    }

    return Object.freeze({
        schemaVersion: value.schemaVersion,
        kind: value.kind,
        activeAuthority: value.activeAuthority,
        certifiedTargetContract: value.certifiedTargetContract,
        deprecatedMigrationOnlyTarget: value.deprecatedMigrationOnlyTarget,
        domains: Object.freeze(domains),
        entries: Object.freeze(entries),
        totalClassifiedAccesses: entries.length,
        readyForCanary
    });
}

export async function loadProgressiveFinancialDomainBaseline(file = BASELINE_URL) {
    let value;
    try {
        value = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
        const wrapped = new TypeError("Progressive financial baseline file is not valid JSON.");
        wrapped.code = "PROGRESSIVE_FINANCIAL_BASELINE_INVALID";
        wrapped.cause = error;
        throw wrapped;
    }
    return validateProgressiveFinancialDomainBaseline(value);
}
