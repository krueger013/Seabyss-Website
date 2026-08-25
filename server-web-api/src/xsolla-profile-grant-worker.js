import { createPaymentWorker } from "./payment-worker.js";

export const XSOLLA_PROFILE_GRANTED_CHECKPOINT = "profile_granted";

export function createXsollaProfileGrantWorker({
    ledger,
    grantAdapter,
    workerId = `xsolla-profile-grant-${process.pid}`,
    workerOptions = {},
    metrics = null,
    logger = { info() {}, warn() {}, error() {} }
} = {}) {
    if (!ledger || !grantAdapter || typeof grantAdapter.grant !== "function" ||
        !workerOptions || typeof workerOptions !== "object" || Array.isArray(workerOptions)) {
        throw new TypeError("Xsolla profile grant worker is not configured.");
    }
    const worker = createPaymentWorker({
        ...workerOptions,
        ledger,
        workerId,
        metrics,
        logger,
        completeAfterCheckpoints: true,
        steps: [{
            name: XSOLLA_PROFILE_GRANTED_CHECKPOINT,
            async run(context) {
                const receiptId = context?.transaction?.receiptId;
                if (typeof receiptId !== "string" ||
                    (!receiptId.startsWith("xss2_") && !receiptId.startsWith("xsd2_"))) {
                    const error = new Error("Only validated immutable xss2_/xsd2_ receipts may grant profiles.");
                    error.code = "UNSUPPORTED_RECEIPT";
                    error.permanent = true;
                    throw error;
                }
                return grantAdapter.grant(context);
            }
        }]
    });
    return Object.freeze({
        processTransaction: worker.processTransaction,
        processPending: worker.processPending,
        health() {
            return Object.freeze({ ...worker.health(), grantAdapter: grantAdapter.health?.() ?? null,
                checkpoint: XSOLLA_PROFILE_GRANTED_CHECKPOINT });
        }
    });
}
