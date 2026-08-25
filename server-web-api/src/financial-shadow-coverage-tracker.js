function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function exactObject(value, name, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", `${name} must be an object.`);
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", `${name} has unexpected members.`);
    }
    return value;
}

function positiveInteger(value, name, { allowZero = false } = {}) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`);
    }
    return value;
}

function sortedUniqueStrings(value, name, { allowEmpty = false } = {}) {
    if (!Array.isArray(value) || !allowEmpty && value.length === 0 ||
        value.some(item => typeof item !== "string" || item.length === 0)) {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", `${name} must contain sorted unique strings.`);
    }
    const normalized = [...new Set(value)].sort();
    if (normalized.length !== value.length || normalized.some((entry, index) => entry !== value[index])) {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", `${name} must be sorted and unique.`);
    }
    return normalized;
}

export function aggregateLegacyFinancialBaseline(baseline) {
    if (!baseline || !Array.isArray(baseline.entries)) {
        fail("FINANCIAL_SHADOW_BASELINE_INVALID", "Legacy financial baseline entries are missing.");
    }
    const grouped = new Map();
    for (const entry of baseline.entries) {
        if (!entry || typeof entry.path !== "string" || typeof entry.category !== "string") {
            fail("FINANCIAL_SHADOW_BASELINE_INVALID", "Legacy financial baseline entry is invalid.");
        }
        const count = positiveInteger(entry.count, `baseline count for ${entry.path}`);
        const current = grouped.get(entry.path) || {
            path: entry.path,
            occurrenceCount: 0,
            domains: new Set(),
            fingerprintCount: 0
        };
        current.occurrenceCount += count;
        current.domains.add(entry.category);
        current.fingerprintCount += 1;
        grouped.set(entry.path, current);
    }
    return [...grouped.values()]
        .map(entry => Object.freeze({
            path: entry.path,
            occurrenceCount: entry.occurrenceCount,
            domains: Object.freeze([...entry.domains].sort()),
            fingerprintCount: entry.fingerprintCount
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
}

function validateCoverage(entry) {
    if (!["none", "partial", "full"].includes(entry.coverageStatus)) {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", `Coverage status for ${entry.path} is invalid.`);
    }
    sortedUniqueStrings(entry.coveredDomains, `coveredDomains for ${entry.path}`, { allowEmpty: true });
    sortedUniqueStrings(entry.exclusions, `exclusions for ${entry.path}`, { allowEmpty: true });
    const hasEvidence = entry.evidence.shadowCoverage.length > 0;
    if (entry.coverageStatus === "none" &&
        (entry.coveredDomains.length > 0 || entry.exclusions.length > 0 || hasEvidence)) {
        fail("FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS", `No-coverage path ${entry.path} contains coverage claims.`);
    }
    if (entry.coverageStatus === "partial" &&
        (entry.coveredDomains.length === 0 || entry.exclusions.length === 0 || !hasEvidence)) {
        fail("FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS", `Partial path ${entry.path} lacks domains, exclusions, or evidence.`);
    }
    if (entry.coverageStatus === "full" &&
        (entry.coveredDomains.length === 0 || entry.exclusions.length > 0 || !hasEvidence)) {
        fail("FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS", `Full path ${entry.path} is incomplete or still excluded.`);
    }
    if (entry.shadowCovered !== (entry.coverageStatus === "full")) {
        fail("FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS", `shadowCovered for ${entry.path} must mean full coverage only.`);
    }
}

export function validateFinancialShadowCutoverTracker({ baseline, tracker }) {
    exactObject(tracker, "tracker", ["schemaVersion", "kind", "baseline", "cutoverReady", "summary", "paths"]);
    if (tracker.schemaVersion !== 1 || tracker.kind !== "seabyss_financial_shadow_cutover_tracker") {
        fail("FINANCIAL_SHADOW_TRACKER_INVALID", "Financial Shadow tracker identity is invalid.");
    }
    exactObject(tracker.baseline, "tracker.baseline", ["baselineVersion", "digest", "pathCount", "occurrenceCount"]);
    if (tracker.baseline.baselineVersion !== baseline.baselineVersion || tracker.baseline.digest !== baseline.digest) {
        fail("FINANCIAL_SHADOW_TRACKER_BASELINE_MISMATCH", "Financial Shadow tracker does not reference the exact audited baseline.");
    }

    const aggregated = aggregateLegacyFinancialBaseline(baseline);
    const baselineOccurrenceCount = aggregated.reduce((sum, entry) => sum + entry.occurrenceCount, 0);
    if (tracker.baseline.pathCount !== aggregated.length ||
        tracker.baseline.occurrenceCount !== baselineOccurrenceCount ||
        baseline.generationEvidence?.findingCount !== baselineOccurrenceCount) {
        fail("FINANCIAL_SHADOW_TRACKER_BASELINE_MISMATCH", "Financial Shadow tracker baseline totals do not match.");
    }
    if (!Array.isArray(tracker.paths) || tracker.paths.length !== aggregated.length) {
        fail("FINANCIAL_SHADOW_TRACKER_PATH_SET_MISMATCH", "Financial Shadow tracker path set is incomplete.");
    }

    const trackerByPath = new Map();
    for (const entry of tracker.paths) {
        exactObject(entry, "tracker path", [
            "path", "occurrenceCount", "domains", "audited", "coverageStatus", "coveredDomains",
            "exclusions", "shadowCovered", "migrated", "cutoverReady", "evidence"
        ]);
        if (typeof entry.path !== "string" || trackerByPath.has(entry.path)) {
            fail("FINANCIAL_SHADOW_TRACKER_PATH_SET_MISMATCH", "Financial Shadow tracker contains an invalid or duplicate path.");
        }
        exactObject(entry.evidence, `evidence for ${entry.path}`, ["baselineFingerprintCount", "baselineOccurrenceCount", "shadowCoverage", "migration"]);
        if (![entry.audited, entry.shadowCovered, entry.migrated, entry.cutoverReady].every(value => typeof value === "boolean")) {
            fail("FINANCIAL_SHADOW_TRACKER_INVALID", `Statuses for ${entry.path} must be booleans.`);
        }
        sortedUniqueStrings(entry.domains, `domains for ${entry.path}`);
        sortedUniqueStrings(entry.evidence.shadowCoverage, `shadow evidence for ${entry.path}`, { allowEmpty: true });
        sortedUniqueStrings(entry.evidence.migration, `migration evidence for ${entry.path}`, { allowEmpty: true });
        validateCoverage(entry);
        if (entry.migrated !== (entry.evidence.migration.length > 0)) {
            fail("FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS", `Migration status for ${entry.path} lacks evidence or contradicts it.`);
        }
        if (entry.cutoverReady !== Boolean(entry.audited && entry.shadowCovered && entry.migrated)) {
            fail("FINANCIAL_SHADOW_TRACKER_UNSUPPORTED_STATUS", `Cutover status for ${entry.path} is not derived from its gates.`);
        }
        trackerByPath.set(entry.path, entry);
    }

    for (const expected of aggregated) {
        const actual = trackerByPath.get(expected.path);
        if (!actual || actual.occurrenceCount !== expected.occurrenceCount ||
            actual.evidence.baselineOccurrenceCount !== expected.occurrenceCount ||
            actual.evidence.baselineFingerprintCount !== expected.fingerprintCount ||
            JSON.stringify(actual.domains) !== JSON.stringify(expected.domains)) {
            fail("FINANCIAL_SHADOW_TRACKER_PATH_SET_MISMATCH", `Financial Shadow tracker differs from baseline for ${expected.path}.`);
        }
    }

    const computed = {
        pathCount: tracker.paths.length,
        occurrenceCount: tracker.paths.reduce((sum, entry) => sum + entry.occurrenceCount, 0),
        auditedPathCount: tracker.paths.filter(entry => entry.audited).length,
        partialShadowPathCount: tracker.paths.filter(entry => entry.coverageStatus === "partial").length,
        fullShadowPathCount: tracker.paths.filter(entry => entry.coverageStatus === "full").length,
        shadowCoveredPathCount: tracker.paths.filter(entry => entry.shadowCovered).length,
        migratedPathCount: tracker.paths.filter(entry => entry.migrated).length,
        cutoverReadyPathCount: tracker.paths.filter(entry => entry.cutoverReady).length
    };
    exactObject(tracker.summary, "tracker.summary", Object.keys(computed));
    for (const [key, value] of Object.entries(computed)) {
        positiveInteger(tracker.summary[key], `tracker.summary.${key}`, { allowZero: true });
        if (tracker.summary[key] !== value) {
            fail("FINANCIAL_SHADOW_TRACKER_SUMMARY_MISMATCH", `Financial Shadow tracker summary ${key} is stale.`);
        }
    }
    const allReady = computed.cutoverReadyPathCount === computed.pathCount;
    if (tracker.cutoverReady !== allReady) {
        fail("FINANCIAL_SHADOW_TRACKER_SUMMARY_MISMATCH", "Financial Shadow tracker root cutover status is stale.");
    }
    return Object.freeze({ ...computed, cutoverReady: allReady, baselineDigest: baseline.digest });
}
