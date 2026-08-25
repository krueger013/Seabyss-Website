import {
    compareCanonicalFinancialProjections,
    FINANCIAL_AUTHORITY_READ_MODES
} from "./financial-canonical-resource-registry.js";

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function coded(code, message, retryable = false, cause = undefined) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.code = code;
    error.retryable = retryable;
    return error;
}

function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

function requireReader(mode, reader) {
    const methods = mode === "Legacy"
        ? ["readLegacy"]
        : mode === "ShadowRead"
            ? ["readMigrationSources"]
            : ["readFinancialV2"];
    if (!reader || methods.some((method) => typeof reader[method] !== "function")) {
        throw new TypeError(`Financial ${mode} reader is not configured.`);
    }
}

export function createFinancialAuthorityModeReader({
    mode = "Legacy",
    sourceReader
} = {}) {
    if (!FINANCIAL_AUTHORITY_READ_MODES.includes(mode)) {
        throw new TypeError("Financial authority read mode must be Legacy, ShadowRead or Cutover.");
    }
    requireReader(mode, sourceReader);
    let reads = 0;
    let failures = 0;
    let lastReadStatus = "not_started";

    async function read(playFabId) {
        canonical(playFabId, "playFabId", 128);
        reads += 1;
        try {
            if (mode === "Legacy") {
                const legacy = await sourceReader.readLegacy(playFabId);
                if (!legacy?.projection || legacy.projection.playFabId !== playFabId) {
                    throw coded("FINANCIAL_LEGACY_PROJECTION_INVALID", "Legacy financial projection is invalid.");
                }
                lastReadStatus = "legacy";
                return deepFreeze({
                    mode,
                    status: "legacy",
                    authoritativeSource: "profile_v1_and_legacy_virtual_currency",
                    projection: structuredClone(legacy.projection),
                    shadow: null,
                    cutoverEligible: false
                });
            }

            if (mode === "ShadowRead") {
                const snapshot = await sourceReader.readMigrationSources(playFabId);
                if (!snapshot?.legacyProjection || snapshot.legacyProjection.playFabId !== playFabId) {
                    throw coded("FINANCIAL_SHADOW_LEGACY_INVALID", "ShadowRead legacy projection is invalid.");
                }
                let comparison;
                if (!snapshot.authorityV2?.migrated || !snapshot.financialV2Projection) {
                    comparison = {
                        match: false,
                        differences: [{
                            resource: "FinancialAuthorityV2",
                            legacy: "present",
                            financialV2: "not_migrated"
                        }]
                    };
                } else {
                    comparison = compareCanonicalFinancialProjections(
                        snapshot.legacyProjection,
                        snapshot.financialV2Projection
                    );
                }
                lastReadStatus = comparison.match ? "shadow_match" : "shadow_mismatch";
                return deepFreeze({
                    mode,
                    status: lastReadStatus,
                    authoritativeSource: "profile_v1_and_legacy_virtual_currency",
                    projection: structuredClone(snapshot.legacyProjection),
                    shadow: {
                        projection: snapshot.financialV2Projection
                            ? structuredClone(snapshot.financialV2Projection)
                            : null,
                        match: comparison.match,
                        differences: structuredClone(comparison.differences)
                    },
                    cutoverEligible: comparison.match === true
                });
            }

            const financialV2 = await sourceReader.readFinancialV2(playFabId);
            if (!financialV2?.authorityV2?.migrated || !financialV2.projection ||
                financialV2.projection.playFabId !== playFabId) {
                throw coded(
                    "FINANCIAL_AUTHORITY_NOT_MIGRATED",
                    "Cutover refuses a player without a verified FinancialAuthorityV2 projection."
                );
            }
            lastReadStatus = "cutover";
            return deepFreeze({
                mode,
                status: "cutover",
                authoritativeSource: "economy_v2_and_FinancialAuthorityV2",
                projection: structuredClone(financialV2.projection),
                shadow: null,
                cutoverEligible: true
            });
        } catch (error) {
            failures += 1;
            lastReadStatus = "failed";
            if (error?.code === "FINANCIAL_AUTHORITY_NOT_MIGRATED" ||
                error?.code === "FINANCIAL_LEGACY_PROJECTION_INVALID" ||
                error?.code === "FINANCIAL_SHADOW_LEGACY_INVALID") {
                throw error;
            }
            throw coded(
                mode === "Cutover" ? "FINANCIAL_CUTOVER_READ_FAILED" :
                    mode === "ShadowRead" ? "FINANCIAL_SHADOW_READ_FAILED" : "FINANCIAL_LEGACY_READ_FAILED",
                `${mode} financial read failed closed.`,
                error?.retryable === true,
                error
            );
        }
    }

    function health() {
        return Object.freeze({ mode, reads, failures, lastReadStatus });
    }

    return Object.freeze({ read, health, mode });
}
