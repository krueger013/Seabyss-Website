import { createFinancialGameplayAuthoritativeWriteService } from "./financial-gameplay-authoritative-write-service.js";

const SHARED_PLAYER_LEASE_TYPE = "playfab-profile";

function positive(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function sharedPlayerLeases(leases) {
    if (!leases || typeof leases.acquireResourceLease !== "function" ||
        typeof leases.renewResourceLease !== "function" ||
        typeof leases.releaseResourceLease !== "function") {
        return leases;
    }
    const translate = (input) => ({ ...input, resourceType: SHARED_PLAYER_LEASE_TYPE });
    return Object.freeze({
        acquireResourceLease(input) {
            return leases.acquireResourceLease(translate(input));
        },
        renewResourceLease(input) {
            return leases.renewResourceLease(translate(input));
        },
        releaseResourceLease(input) {
            return leases.releaseResourceLease(translate(input));
        }
    });
}

function reconciliationPair({
    reader,
    economy,
    attempts,
    backoffMilliseconds,
    wait
}) {
    if (typeof reader?.readFinancialV2 !== "function" || typeof economy?.mutate !== "function") {
        return { reader, economy };
    }
    const expectedByPlayer = new Map();
    const wrappedEconomy = Object.freeze({
        async mutate(request) {
            const evidence = await economy.mutate(request);
            if (typeof evidence?.etag === "string" && evidence.etag.length > 0) {
                expectedByPlayer.set(request.playFabId, evidence.etag);
            }
            return evidence;
        }
    });
    const wrappedReader = Object.freeze({
        async readFinancialV2(playFabId) {
            const expectedEtag = expectedByPlayer.get(playFabId);
            if (!expectedEtag) return reader.readFinancialV2(playFabId);
            let lastSnapshot;
            let lastError;
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                try {
                    lastSnapshot = await reader.readFinancialV2(playFabId);
                    lastError = undefined;
                    if (lastSnapshot?.economyV2Etag === expectedEtag) {
                        expectedByPlayer.delete(playFabId);
                        return lastSnapshot;
                    }
                } catch (error) {
                    lastError = error;
                }
                if (attempt < attempts) {
                    await wait(backoffMilliseconds * attempt);
                }
            }
            if (lastError && !lastSnapshot) throw lastError;
            return lastSnapshot;
        }
    });
    return { reader: wrappedReader, economy: wrappedEconomy };
}

/**
 * Production-cutover composition for gameplay quantities. This module is
 * intentionally not wired into server.js. Payment and gameplay serialize on
 * the same `playfab-profile` lease, while Economy eventual-consistency reads
 * receive a bounded, injectable reconciliation window.
 */
export function createFinancialGameplayCutoverWriteService({
    reconciliationAttempts = 4,
    reconciliationBackoffMilliseconds = 50,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...options
} = {}) {
    positive(reconciliationAttempts, "reconciliationAttempts", { maximum: 10 });
    positive(reconciliationBackoffMilliseconds, "reconciliationBackoffMilliseconds", {
        minimum: 10,
        maximum: 2000
    });
    if (typeof wait !== "function") throw new TypeError("Reconciliation wait function is required.");
    const reconciled = reconciliationPair({
        reader: options.reader,
        economy: options.economy,
        attempts: reconciliationAttempts,
        backoffMilliseconds: reconciliationBackoffMilliseconds,
        wait
    });
    return createFinancialGameplayAuthoritativeWriteService({
        ...options,
        reader: reconciled.reader,
        economy: reconciled.economy,
        leases: sharedPlayerLeases(options.leases)
    });
}

export const FINANCIAL_GAMEPLAY_SHARED_PLAYER_LEASE_TYPE = SHARED_PLAYER_LEASE_TYPE;
