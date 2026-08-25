import { createHash } from "node:crypto";
import {
    getXsollaDiamondReceiptV2Key,
    serializeXsollaDiamondReceiptV2
} from "./playfab-xsolla-diamond-receipt-v2-store.js";
import {
    getXsollaStarterReceiptV2Key,
    serializeXsollaStarterReceiptV2
} from "./playfab-xsolla-starter-receipt-v2-store.js";
import { assertFinancialShadowPlayerAllowed } from "./financial-shadow-policy.js";
import { createServerEconomyPocHighValueOperation } from "./server-economy-poc-domain-model.js";
import {
    mapValidatedXsollaReceiptToFinalServerEconomyPocOperation
} from "./server-economy-poc-receipt-mapper-final.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

const SAFE_TRANSACTION_STATES = Object.freeze(new Set(["Pending", "Processing", "Completed"]));

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

function digest(value) {
    return createHash("sha256")
        .update(JSON.stringify(stableValue(value)), "utf8")
        .digest("hex");
}

function transactionId(value) {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
        throw new TypeError("providerTransactionId must be a canonical positive int64 string.");
    }
    try {
        if (BigInt(value) > 9223372036854775807n) throw new RangeError();
    } catch {
        throw new TypeError("providerTransactionId must be a canonical positive int64 string.");
    }
    return value;
}

function strictInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "providerTransactionId") {
        fail(
            "FINANCIAL_SHADOW_PAYMENT_INPUT_REJECTED",
            "Payment Shadow producer accepts only providerTransactionId."
        );
    }
    return transactionId(value.providerTransactionId);
}

function validateReceiptCheckpoint(transaction) {
    const checkpoint = transaction.checkpoints?.receipt_persisted;
    const journal = transaction.stepJournal?.receipt_persisted;
    const identityHash = createHash("sha256")
        .update("xsolla", "utf8")
        .update("\0", "utf8")
        .update(transaction.providerTransactionId, "utf8")
        .digest("base64url");
    const expectedOperationId = `payment:${identityHash}:receipt_persisted:v1`;
    if (!checkpoint || !journal || journal.status !== "StepApplied" ||
        checkpoint.operationId !== expectedOperationId || journal.operationId !== expectedOperationId ||
        checkpoint.resultHash !== journal.resultHash ||
        checkpoint.resultHash !== digest(checkpoint.result) ||
        journal.resultHash !== digest(journal.result) ||
        checkpoint.result?.receiptId !== transaction.receiptId ||
        journal.result?.receiptId !== transaction.receiptId ||
        typeof checkpoint.completedAtUnixMs !== "number" ||
        typeof journal.updatedAtUnixMs !== "number") {
        fail(
            "FINANCIAL_SHADOW_PAYMENT_RECEIPT_PROOF_INVALID",
            "Immutable receipt checkpoint proof is absent or inconsistent."
        );
    }
}

function validateLedgerEnvelope(transaction, providerTransactionId, allowedTransactionStates) {
    if (!allowedTransactionStates.has(transaction.state) ||
        transaction.provider !== "xsolla" ||
        transaction.providerTransactionId !== providerTransactionId ||
        typeof transaction.receiptId !== "string" ||
        (!transaction.receiptId.startsWith("xss2_") && !transaction.receiptId.startsWith("xsd2_"))) {
        fail("FINANCIAL_SHADOW_PAYMENT_LEDGER_UNTRUSTED", "Payment ledger transaction is not projection-safe.");
    }
    const expectedReceiptId = transaction.receiptId.startsWith("xss2_")
        ? getXsollaStarterReceiptV2Key(providerTransactionId)
        : getXsollaDiamondReceiptV2Key(providerTransactionId);
    if (transaction.receiptId !== expectedReceiptId) {
        fail("FINANCIAL_SHADOW_PAYMENT_RECEIPT_KEY_MISMATCH", "Payment receipt key is not canonical.");
    }
    if (transaction.reversalStatus !== "None" ||
        !Array.isArray(transaction.reversalIds) || transaction.reversalIds.length !== 0 ||
        transaction.reversedAmountMinor !== 0) {
        fail(
            "FINANCIAL_SHADOW_PAYMENT_REVERSAL_PRESENT",
            "Reversed payment cannot enter Financial Shadow."
        );
    }
    validateReceiptCheckpoint(transaction);
}

function parseImmutableReceipt(loaded, transaction) {
    if (!loaded || loaded.key !== transaction.receiptId || typeof loaded.value !== "string") {
        fail("FINANCIAL_SHADOW_PAYMENT_RECEIPT_MISSING", "Immutable payment receipt is missing.");
    }
    let document;
    try {
        document = JSON.parse(loaded.value);
    } catch {
        fail("FINANCIAL_SHADOW_PAYMENT_RECEIPT_INVALID", "Immutable payment receipt is malformed.");
    }
    if (!document || typeof document !== "object" || Array.isArray(document) ||
        document.schemaVersion !== 2) {
        fail("FINANCIAL_SHADOW_PAYMENT_RECEIPT_INVALID", "Immutable payment receipt schema is invalid.");
    }
    const receipt = { ...document, playFabId: document.userId };
    let canonical;
    try {
        canonical = transaction.receiptId.startsWith("xss2_")
            ? serializeXsollaStarterReceiptV2(receipt)
            : serializeXsollaDiamondReceiptV2(receipt);
    } catch {
        fail("FINANCIAL_SHADOW_PAYMENT_RECEIPT_INVALID", "Immutable payment receipt contract is invalid.");
    }
    if (canonical !== loaded.value) {
        fail("FINANCIAL_SHADOW_PAYMENT_RECEIPT_TAMPERED", "Immutable payment receipt is not canonical.");
    }
    return Object.freeze(receipt);
}

function validateTrustedChain(transaction, receipt, providerTransactionId) {
    let product;
    try {
        product = getXsollaProductPlan(receipt.xsollaSku, receipt.productPlanVersion);
    } catch {
        fail("FINANCIAL_SHADOW_PAYMENT_PLAN_INVALID", "Payment product plan is unavailable.");
    }
    const expectedPlanHash = product.productType === "starter_pack"
        ? receipt.rewardPlanHash
        : product.planHash;
    const createdAtUnixMs = Date.parse(receipt.createdAtUtc);
    if (receipt.provider !== "xsolla" || receipt.providerTransactionId !== providerTransactionId ||
        receipt.transactionId !== providerTransactionId || receipt.userId !== transaction.playFabId ||
        receipt.xsollaSku !== transaction.sku || receipt.productPlanVersion !== transaction.planVersion ||
        expectedPlanHash !== transaction.planHash || receipt.totalAmountMinor !== transaction.amountMinor ||
        receipt.currency !== transaction.currency || receipt.environment !== transaction.environment ||
        createdAtUnixMs !== transaction.createdAtUnixMs || product.productType !== receipt.productType) {
        fail("FINANCIAL_SHADOW_PAYMENT_CHAIN_MISMATCH", "Ledger, receipt, identity, or plan chain differs.");
    }
    return Object.freeze({ product, createdAtUnixMs });
}

async function assertNoReversal(ledger, transaction) {
    if (typeof ledger.lookupReversals !== "function") {
        fail("FINANCIAL_SHADOW_PAYMENT_REVERSAL_CHECK_UNAVAILABLE", "Payment reversal lookup is unavailable.");
    }
    const page = await ledger.lookupReversals({
        provider: transaction.provider,
        providerTransactionId: transaction.providerTransactionId
    }, { cursor: "0", limit: 1 });
    if (!page || !Array.isArray(page.items)) {
        fail("FINANCIAL_SHADOW_PAYMENT_REVERSAL_CHECK_UNAVAILABLE", "Payment reversal lookup is malformed.");
    }
    if (page.items.length > 0) {
        fail("FINANCIAL_SHADOW_PAYMENT_REVERSAL_PRESENT", "Reversed payment cannot enter Financial Shadow.");
    }
}

function projectionFromTrustedReceipt(transaction, receipt, product, effectiveAtUnixMs) {
    return Object.freeze({
        provider: "xsolla",
        source: "durable_immutable_receipt",
        receiptPersisted: true,
        economicValidationPassed: true,
        playFabId: transaction.playFabId,
        providerTransactionId: transaction.providerTransactionId,
        sku: transaction.sku,
        effectiveAtUnixMs,
        quantity: receipt.quantity,
        currency: transaction.currency,
        amountMinor: transaction.amountMinor,
        productPlanVersion: transaction.planVersion,
        productPlanHash: product.planHash,
        ...(product.productType === "starter_pack" ? {
            rewardPlanVersion: receipt.rewardPlanVersion,
            rewardPlanHash: receipt.rewardPlanHash
        } : {})
    });
}

export function createFinancialShadowPaymentProducer({
    ledger,
    loadXsollaV2Receipt,
    enqueueCanonicalProjection,
    policy
} = {}) {
    if (typeof ledger?.requireTransaction !== "function" ||
        typeof loadXsollaV2Receipt !== "function" ||
        typeof enqueueCanonicalProjection !== "function" || policy?.enabled !== true ||
        typeof policy.shadowEnvironment !== "string") {
        throw new TypeError("Financial Shadow payment producer is not configured.");
    }

    const resolver = createTrustedXsollaV2PaymentResolver({
        ledger,
        loadXsollaV2Receipt,
        expectedEnvironment: policy.shadowEnvironment,
        authorizeTransaction(transaction) {
            assertFinancialShadowPlayerAllowed(policy, transaction.playFabId);
        }
    });

    async function projectTransaction(input) {
        const resolved = await resolver.resolveTransaction(input);
        const canonical = resolved.operation;
        const submitted = await enqueueCanonicalProjection(canonical);
        await resolver.assertStillUnreversed(resolved);
        return Object.freeze({
            status: submitted?.status === "existing" ? "already_projected" : "projected",
            operation: canonical,
            submitted
        });
    }

    return Object.freeze({
        projectTransaction,
        authoritative: false,
        grantsLegacy: false,
        requiresPlayerPresence: false,
        source: "ledger_and_immutable_xsolla_v2_receipt"
    });
}

/**
 * Resolves an immutable xss2/xsd2 payment into the canonical financial
 * operation using only the durable ledger, immutable receipt and versioned
 * product plans. The caller can submit only the provider transaction ID.
 *
 * Keeping this verifier separate lets an isolated Diamonds canary route a
 * trusted xsd2 operation to the authoritative Target without accepting a
 * caller-authored player, amount, balance or reward projection.
 */
export function createTrustedXsollaV2PaymentResolver({
    ledger,
    loadXsollaV2Receipt,
    expectedEnvironment,
    authorizeTransaction = () => undefined,
    allowedTransactionStates = SAFE_TRANSACTION_STATES
} = {}) {
    if (typeof ledger?.requireTransaction !== "function" ||
        typeof loadXsollaV2Receipt !== "function" ||
        typeof expectedEnvironment !== "string" || expectedEnvironment.length === 0 ||
        typeof authorizeTransaction !== "function" ||
        !(allowedTransactionStates instanceof Set) || allowedTransactionStates.size === 0) {
        throw new TypeError("Trusted Xsolla v2 payment resolver is not configured.");
    }

    async function resolveTransaction(input) {
        const providerTransactionId = strictInput(input);
        const transaction = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId
        });
        await authorizeTransaction(transaction);
        validateLedgerEnvelope(transaction, providerTransactionId, allowedTransactionStates);
        if (transaction.environment !== expectedEnvironment) {
            fail(
                "FINANCIAL_SHADOW_PAYMENT_ENVIRONMENT_MISMATCH",
                "Payment environment differs from the isolated financial environment."
            );
        }
        const loaded = await loadXsollaV2Receipt({
            playFabId: transaction.playFabId,
            receiptId: transaction.receiptId
        });
        const receipt = parseImmutableReceipt(loaded, transaction);
        const trusted = validateTrustedChain(transaction, receipt, providerTransactionId);
        await assertNoReversal(ledger, transaction);
        const mapped = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(
            projectionFromTrustedReceipt(transaction, receipt, trusted.product, trusted.createdAtUnixMs)
        );
        const operation = createServerEconomyPocHighValueOperation({
            ...mapped,
            createdAtUnixMs: trusted.createdAtUnixMs
        });
        return Object.freeze({
            transaction,
            receipt,
            product: trusted.product,
            operation
        });
    }

    async function assertStillUnreversed(resolved) {
        if (!resolved?.transaction) {
            throw new TypeError("Resolved trusted payment is required.");
        }
        await assertNoReversal(ledger, resolved.transaction);
        return true;
    }

    return Object.freeze({
        resolveTransaction,
        assertStillUnreversed,
        acceptsCallerFields: Object.freeze(["providerTransactionId"]),
        source: "ledger_and_immutable_xsolla_v2_receipt"
    });
}
