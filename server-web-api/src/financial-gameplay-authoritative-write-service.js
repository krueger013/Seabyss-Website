import {
    createFinancialGameplayWriteService,
    FinancialGameplayWriteError
} from "./financial-gameplay-write-service.js";

function retryableReadError(error) {
    if (typeof error?.code === "string") return error;
    return new FinancialGameplayWriteError(
        "FINANCIAL_READ_UNAVAILABLE",
        "Canonical Economy v2 read is temporarily unavailable.",
        { statusCode: 503, retryable: true, ambiguous: true }
    );
}

function wrapReader(reader) {
    if (typeof reader?.readFinancialV2 !== "function") return reader;
    return Object.freeze({
        async readFinancialV2(playFabId) {
            try {
                return await reader.readFinancialV2(playFabId);
            } catch (error) {
                throw retryableReadError(error);
            }
        }
    });
}

function wrapLeases(leases) {
    if (!leases) return leases;
    return Object.freeze({
        acquireResourceLease: leases.acquireResourceLease.bind(leases),
        releaseResourceLease: leases.releaseResourceLease.bind(leases),
        async renewResourceLease(input) {
            try {
                return await leases.renewResourceLease(input);
            } catch (error) {
                if (error?.code === "LEASE_LOST") {
                    throw new FinancialGameplayWriteError(
                        "PLAYER_LEASE_LOST",
                        "Gameplay financial player lease was lost.",
                        { statusCode: 409, retryable: true }
                    );
                }
                throw error;
            }
        }
    });
}

/**
 * Final fail-closed composition. It deliberately remains unreferenced by server.js.
 * The wrappers normalize the shared payment-ledger lease contract and make an
 * unknown canonical-read transport failure retryable, including reconciliation
 * reads made after an ambiguous provider commit.
 */
export function createFinancialGameplayAuthoritativeWriteService(options = {}) {
    return createFinancialGameplayWriteService({
        ...options,
        reader: wrapReader(options.reader),
        leases: wrapLeases(options.leases)
    });
}
