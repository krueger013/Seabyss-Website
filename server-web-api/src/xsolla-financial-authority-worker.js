import { createPaymentWorker } from "./payment-worker.js";

export const XSOLLA_ECONOMY_V2_GRANTED_CHECKPOINT = "economy_v2_granted";
export const XSOLLA_ENTITLEMENTS_GRANTED_CHECKPOINT = "entitlements_granted";
export const XSOLLA_PROFILE_GRANTED_CHECKPOINT_V2 = "profile_granted";

export function createXsollaFinancialAuthorityWorker({
    ledger,
    grantAdapter,
    workerId = `xsolla-financial-authority-${process.pid}`,
    workerOptions = {},
    metrics = null,
    logger = { info() {}, warn() {}, error() {} }
} = {}) {
    if (!ledger || !grantAdapter ||
        typeof grantAdapter.grantQuantitative !== "function" ||
        typeof grantAdapter.grantEntitlements !== "function" ||
        typeof grantAdapter.verifyFinal !== "function" ||
        !workerOptions || typeof workerOptions !== "object" || Array.isArray(workerOptions)) {
        throw new TypeError("Xsolla FinancialAuthorityV2 worker is not configured.");
    }
    const worker = createPaymentWorker({
        ...workerOptions,
        ledger,
        workerId,
        metrics,
        logger,
        completeAfterCheckpoints: true,
        steps: [
            {
                name: XSOLLA_ECONOMY_V2_GRANTED_CHECKPOINT,
                run: (context) => grantAdapter.grantQuantitative(context)
            },
            {
                name: XSOLLA_ENTITLEMENTS_GRANTED_CHECKPOINT,
                run: (context) => grantAdapter.grantEntitlements(context)
            },
            {
                name: XSOLLA_PROFILE_GRANTED_CHECKPOINT_V2,
                run: (context) => grantAdapter.verifyFinal(context)
            }
        ]
    });
    return Object.freeze({
        processTransaction: worker.processTransaction,
        processPending: worker.processPending,
        health() {
            return Object.freeze({
                ...worker.health(),
                grantAdapter: grantAdapter.health?.() ?? null,
                authorityVersion: "financial_v2",
                checkpoints: [
                    XSOLLA_ECONOMY_V2_GRANTED_CHECKPOINT,
                    XSOLLA_ENTITLEMENTS_GRANTED_CHECKPOINT,
                    XSOLLA_PROFILE_GRANTED_CHECKPOINT_V2
                ]
            });
        }
    });
}
