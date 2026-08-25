import { createHash } from "node:crypto";
import { createInitialFinancialAuthority } from "./financial-authority-v2.js";
import { compareCanonicalFinancialProjections } from "./financial-canonical-resource-registry.js";

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

function requireDependencies(sourceReader, registry) {
    if (!sourceReader || typeof sourceReader.readMigrationSources !== "function") {
        throw new TypeError("Canonical migration source reader is required.");
    }
    if (!registry || typeof registry.projectLegacy !== "function" ||
        typeof registry.projectV2 !== "function" || !Array.isArray(registry.quantityIds)) {
        throw new TypeError("Canonical gameplay financial registry is required.");
    }
}

function manualReview(playFabId, conflicts, sourceEvidence) {
    return deepFreeze({
        status: "manual_review",
        readOnly: true,
        providerWriteCount: 0,
        playFabId,
        conflicts,
        sourceEvidence
    });
}

export function createPlayFabCanonicalFinancialMigrationDryRun({
    sourceReader,
    registry,
    nowMilliseconds = () => Date.now()
} = {}) {
    requireDependencies(sourceReader, registry);
    if (typeof nowMilliseconds !== "function") throw new TypeError("Migration dry-run clock is invalid.");
    let runs = 0;
    let manualReviews = 0;
    let failures = 0;

    async function run(playFabId) {
        canonical(playFabId, "playFabId", 128);
        runs += 1;
        try {
            const snapshot = await sourceReader.readMigrationSources(playFabId);
            if (!snapshot || snapshot.playFabId !== playFabId || !plain(snapshot.profileV1) ||
                !plain(snapshot.legacyCurrencyBalances) || !plain(snapshot.economyV2Quantities) ||
                typeof snapshot.economyV2Etag !== "string") {
                throw new TypeError("Canonical migration source snapshot is invalid.");
            }
            const migratedAtUnixMs = nonNegative(nowMilliseconds(), "migratedAtUnixMs");
            const migratedAtUtc = new Date(migratedAtUnixMs).toISOString();
            const legacyProjection = registry.projectLegacy({
                playFabId,
                profile: snapshot.profileV1,
                legacyCurrencyBalances: snapshot.legacyCurrencyBalances,
                confirmedStarterSkus: snapshot.confirmedStarterSkus || []
            });
            const sourceEvidence = deepFreeze({
                profileV1: digest(snapshot.profileV1),
                financialProfileV1: digest(snapshot.financialProfileV1 ?? null),
                legacyCurrencies: digest(snapshot.legacyCurrencyBalances),
                confirmedStarterOwnership: digest(snapshot.confirmedStarterSkus || []),
                economyV2: digest({
                    etag: snapshot.economyV2Etag,
                    quantities: snapshot.economyV2Quantities
                }),
                authorityV2: digest(snapshot.authorityV2?.authority ?? null),
                registry: registry.digest
            });
            const conflicts = [];

            if (snapshot.financialProfileV1 !== null && snapshot.financialProfileV1 !== undefined) {
                const financialProfileProjection = registry.projectLegacy({
                    playFabId,
                    profile: snapshot.financialProfileV1,
                    legacyCurrencyBalances: snapshot.legacyCurrencyBalances,
                    confirmedStarterSkus: snapshot.confirmedStarterSkus || []
                });
                const comparison = compareCanonicalFinancialProjections(
                    legacyProjection,
                    financialProfileProjection
                );
                for (const difference of comparison.differences) {
                    conflicts.push({
                        resource: difference.resource,
                        reason: "profile_v1_financial_profile_v1_conflict",
                        profileV1: difference.legacy,
                        financialProfileV1: difference.financialV2
                    });
                }
            }

            for (const resourceId of registry.quantityIds) {
                const target = legacyProjection.quantities[resourceId];
                const current = nonNegative(snapshot.economyV2Quantities[resourceId], `${resourceId} Economy quantity`);
                if (current !== 0 && current !== target) {
                    conflicts.push({
                        resource: resourceId,
                        reason: "economy_v2_target_conflict",
                        target,
                        economyV2: current
                    });
                }
            }

            if (snapshot.authorityV2?.migrated) {
                const currentV2 = registry.projectV2({
                    playFabId,
                    economyV2Quantities: snapshot.economyV2Quantities,
                    authority: snapshot.authorityV2.authority
                });
                const comparison = compareCanonicalFinancialProjections(legacyProjection, currentV2);
                if (!comparison.match) {
                    for (const difference of comparison.differences) {
                        conflicts.push({
                            resource: difference.resource,
                            reason: "existing_financial_v2_conflict",
                            legacy: difference.legacy,
                            financialV2: difference.financialV2
                        });
                    }
                } else if (conflicts.length === 0) {
                    return deepFreeze({
                        status: "already_migrated",
                        readOnly: true,
                        providerWriteCount: 0,
                        playFabId,
                        planHash: digest({ playFabId, sourceEvidence, status: "already_migrated" }),
                        sourceEvidence,
                        projection: structuredClone(currentV2),
                        plannedEconomyRewards: [],
                        plannedAuthorityInitialization: null,
                        conflicts: []
                    });
                }
            }

            if (conflicts.length > 0) {
                manualReviews += 1;
                return manualReview(playFabId, conflicts, sourceEvidence);
            }

            const plannedEconomyRewards = registry.quantityIds
                .map((resourceId) => ({
                    rewardId: resourceId,
                    quantity: legacyProjection.quantities[resourceId] - snapshot.economyV2Quantities[resourceId]
                }))
                .filter((reward) => reward.quantity > 0)
                .sort((left, right) => left.rewardId.localeCompare(right.rewardId));
            const initialAuthority = createInitialFinancialAuthority({
                playFabId,
                migratedAtUtc,
                sourceDigests: {
                    profileV1: sourceEvidence.profileV1,
                    financialV1: sourceEvidence.financialProfileV1,
                    legacyDm: digest({ currency: "DM", balance: snapshot.legacyCurrencyBalances.DM }),
                    legacyGold: digest({ currency: "GD", balance: snapshot.legacyCurrencyBalances.GD }),
                    gameplayRegistry: registry.digest,
                    confirmedStarterOwnership: sourceEvidence.confirmedStarterOwnership
                },
                premium: structuredClone(legacyProjection.premium),
                paidDestinationMarkerIds: [...legacyProjection.paidDestinationMarkerIds],
                paidShipDesignIds: [...legacyProjection.paidShipDesignIds],
                ownedStarterSkus: [...legacyProjection.ownedStarterSkus],
                appliedTransactionIds: []
            });
            const basis = {
                schemaVersion: 1,
                authorityVersion: "financial_v2",
                playFabId,
                migratedAtUtc,
                sourceEvidence,
                targetQuantities: legacyProjection.quantities,
                observedEconomyV2Quantities: snapshot.economyV2Quantities,
                economyV2Etag: snapshot.economyV2Etag,
                plannedEconomyRewards,
                initialAuthority,
                goldPolicy: registry.goldPolicy
            };
            return deepFreeze({
                status: "ready",
                readOnly: true,
                providerWriteCount: 0,
                playFabId,
                planHash: digest(basis),
                sourceEvidence,
                projection: structuredClone(legacyProjection),
                targetQuantities: structuredClone(legacyProjection.quantities),
                observedEconomyV2Quantities: structuredClone(snapshot.economyV2Quantities),
                economyV2Etag: snapshot.economyV2Etag,
                plannedEconomyRewards,
                plannedAuthorityInitialization: initialAuthority,
                conflicts: [],
                migratedAtUtc,
                goldPolicy: registry.goldPolicy
            });
        } catch (error) {
            failures += 1;
            throw error;
        }
    }

    function health() {
        return Object.freeze({
            readOnly: true,
            providerWritesEnabled: false,
            runs,
            manualReviews,
            failures,
            registryDigest: registry.digest
        });
    }

    return Object.freeze({ run, health });
}
