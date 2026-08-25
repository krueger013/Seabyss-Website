import { createHash } from "node:crypto";
import { createPaymentWorker } from "./payment-worker.js";
import { getXsollaDiamondReceiptV2Key } from "./playfab-xsolla-diamond-receipt-v2-store.js";
import { getXsollaStarterReceiptV2Key } from "./playfab-xsolla-starter-receipt-v2-store.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
        );
    }
    return value;
}

function digest(value) {
    return createHash("sha256")
        .update(JSON.stringify(stableValue(value)), "utf8")
        .digest("hex");
}

function canonicalReceipt(receipt, resolveProductPlan) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
        receipt.provider !== "xsolla" ||
        receipt.providerTransactionId !== receipt.transactionId ||
        receipt.userId !== receipt.playFabId ||
        (receipt.productType !== "starter_pack" && receipt.productType !== "diamond_pack")) {
        throw new TypeError("Ledgered Xsolla receipt identity is invalid.");
    }
    const createdAtUnixMs = Date.parse(receipt.createdAtUtc);
    if (!Number.isSafeInteger(createdAtUnixMs) || createdAtUnixMs < 0) {
        throw new TypeError("Ledgered Xsolla receipt timestamp is invalid.");
    }
    const plan = resolveProductPlan(receipt.xsollaSku, receipt.productPlanVersion);
    if (plan.productId !== receipt.productId || plan.productType !== receipt.productType ||
        plan.currency !== receipt.currency ||
        plan.unitAmountMinor !== receipt.totalAmountMinor || receipt.quantity !== 1) {
        throw new TypeError("Ledgered Xsolla receipt product plan is invalid.");
    }
    const planHash = receipt.productType === "starter_pack"
        ? receipt.rewardPlanHash
        : (plan.planHash || digest(plan));
    if (typeof planHash !== "string" || !/^[a-f0-9]{64}$/u.test(planHash)) {
        throw new TypeError("Ledgered Xsolla receipt plan hash is invalid.");
    }
    const receiptId = receipt.productType === "starter_pack"
        ? getXsollaStarterReceiptV2Key(receipt.transactionId)
        : getXsollaDiamondReceiptV2Key(receipt.transactionId);
    return Object.freeze({
        receipt,
        receiptId,
        planHash,
        createdAtUnixMs,
        ledgerInput: Object.freeze({
            provider: "xsolla",
            providerTransactionId: receipt.transactionId,
            // A stable canonical value prevents payment/order_paid dual notifications
            // from conflicting when only the later envelope knows the Xsolla order ID.
            orderId: receipt.transactionId,
            receiptId,
            playFabId: receipt.playFabId,
            sku: receipt.xsollaSku,
            planVersion: receipt.productPlanVersion,
            planHash,
            amountMinor: receipt.totalAmountMinor,
            currency: receipt.currency,
            environment: receipt.environment,
            createdAtUnixMs,
            createdBy: "xsolla_webhook",
            creationReason: "validated_immutable_receipt"
        })
    });
}

export function createXsollaLedgeredReceiptProcessor({
    ledger,
    persistStarterPackReceiptV2,
    persistDiamondPackReceiptV2,
    resolveProductPlan = getXsollaProductPlan,
    workerId = `xsolla-receipt-${process.pid}`,
    workerOptions = {},
    metrics = null,
    logger = { info() {}, warn() {}, error() {} }
} = {}) {
    if (!ledger || typeof ledger.createTransaction !== "function" ||
        typeof ledger.requireTransaction !== "function" ||
        typeof persistStarterPackReceiptV2 !== "function" ||
        typeof persistDiamondPackReceiptV2 !== "function" ||
        typeof resolveProductPlan !== "function") {
        throw new TypeError("Ledgered Xsolla receipt processor is not configured.");
    }

    return async function processLedgeredXsollaReceipt(receipt) {
        const normalized = canonicalReceipt(receipt, resolveProductPlan);
        const created = await ledger.createTransaction(normalized.ledgerInput);
        const transaction = created.record;
        if (created.status === "existing" && transaction.state === "Completed") {
            return Object.freeze({
                status: "already_completed",
                receiptId: normalized.receiptId,
                transaction
            });
        }
        if (created.status === "existing" && transaction.state === "Pending" &&
            transaction.checkpoints.receipt_persisted) {
            return Object.freeze({
                status: "checkpoints_pending",
                receiptId: normalized.receiptId,
                transaction
            });
        }
        if (["Quarantined", "DuplicatePaid", "RefundRequired", "ManualReview"].includes(
            transaction.state
        )) {
            throw new Error(`Payment ledger is in unsafe state ${transaction.state}.`);
        }

        const persistReceipt = receipt.productType === "starter_pack"
            ? persistStarterPackReceiptV2
            : persistDiamondPackReceiptV2;
        const worker = createPaymentWorker({
            ledger,
            workerId,
            metrics,
            logger,
            ...workerOptions,
            completeAfterCheckpoints: false,
            steps: [{
                name: "receipt_persisted",
                async run() {
                    const persisted = await persistReceipt(receipt);
                    if (!persisted || typeof persisted.key !== "string" ||
                        persisted.key !== normalized.receiptId) {
                        throw new Error("Immutable receipt persistence returned an invalid result.");
                    }
                    return {
                        receiptId: normalized.receiptId,
                        existing: persisted.existing === true
                    };
                }
            }]
        });
        const result = await worker.processTransaction({
            provider: "xsolla",
            providerTransactionId: receipt.transactionId
        });
        if (result.status !== "checkpoints_pending" && result.status !== "already_completed") {
            throw new Error(
                `Payment worker did not reach a receipt-safe state: ${result.status}.`);
        }
        return Object.freeze({
            status: result.status,
            receiptId: normalized.receiptId,
            transaction: result.transaction
        });
    };
}
