import { getXsollaDiamondReceiptV2Key, serializeXsollaDiamondReceiptV2 } from "./playfab-xsolla-diamond-receipt-v2-store.js";
import { getXsollaStarterReceiptV2Key, serializeXsollaStarterReceiptV2 } from "./playfab-xsolla-starter-receipt-v2-store.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";
import {
    applyFinancialEntitlementGrant,
    verifyFinancialEntitlementGrant
} from "./financial-authority-v2.js";

const DIAMOND_PACK_REWARDS = Object.freeze({
    seabyss_diamond_pack_1: 500,
    seabyss_diamond_pack_2: 1200,
    seabyss_diamond_pack_3: 3000
});

export class FinancialAuthorityGrantError extends Error {
    constructor(code, message, { permanent = false, retryable = false, details = null } = {}) {
        super(message);
        this.name = "FinancialAuthorityGrantError";
        this.code = code;
        this.permanent = permanent;
        this.retryable = retryable;
        this.details = details;
    }
}

function fail(code, message, options) {
    throw new FinancialAuthorityGrantError(code, message, options);
}

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        fail("INVALID_GRANT_CONTEXT", `${name} is invalid.`, { permanent: true });
    }
    return value;
}

function parseReceipt(value, maximumReceiptBytes) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized, "utf8") > maximumReceiptBytes) {
            fail("INVALID_RECEIPT", "Immutable receipt is too large.", { permanent: true });
        }
        return structuredClone(value);
    }
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumReceiptBytes) {
        fail("INVALID_RECEIPT", "Immutable receipt is invalid.", { permanent: true });
    }
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        return parsed;
    } catch {
        fail("INVALID_RECEIPT", "Immutable receipt is not strict JSON.", { permanent: true });
    }
}

function requireReceiptCheckpoint(transaction) {
    if (transaction?.checkpoints?.receipt_persisted?.result?.receiptId !== transaction?.receiptId) {
        fail("RECEIPT_NOT_PERSISTED", "receipt_persisted checkpoint is absent or inconsistent.", { permanent: true });
    }
}

function validateReceipt(transaction, raw, maximumReceiptBytes) {
    canonical(transaction?.providerTransactionId, "providerTransactionId");
    canonical(transaction?.playFabId, "playFabId", 160);
    canonical(transaction?.sku, "sku", 255);
    canonical(transaction?.receiptId, "receiptId");
    requireReceiptCheckpoint(transaction);
    if (transaction.provider !== "xsolla" ||
        (!transaction.receiptId.startsWith("xss2_") && !transaction.receiptId.startsWith("xsd2_"))) {
        fail("UNSUPPORTED_RECEIPT", "Only xss2/xsd2 receipts may reach FinancialAuthorityV2.", { permanent: true });
    }
    const receipt = parseReceipt(raw, maximumReceiptBytes);
    const starter = transaction.receiptId.startsWith("xss2_");
    if (receipt.schemaVersion !== 2 || receipt.productType !== (starter ? "starter_pack" : "diamond_pack")) {
        fail("INVALID_RECEIPT", "Immutable receipt schema/type is invalid.", { permanent: true });
    }
    let product;
    try { product = getXsollaProductPlan(receipt.xsollaSku, receipt.productPlanVersion); }
    catch { fail("PLAN_MISMATCH", "Product plan version is unavailable.", { permanent: true }); }
    const expectedReceiptId = starter
        ? getXsollaStarterReceiptV2Key(receipt.transactionId)
        : getXsollaDiamondReceiptV2Key(receipt.transactionId);
    let expectedPlanHash = product.planHash;
    if (starter) {
        let rewards;
        try { rewards = getStarterRewardPlan(receipt.xsollaSku, receipt.rewardPlanVersion); }
        catch { fail("PLAN_MISMATCH", "Starter reward plan is unavailable.", { permanent: true }); }
        if (receipt.rewardPlanHash !== rewards.rewardPlanHash ||
            JSON.stringify(receipt.rewards) !== JSON.stringify(rewards.rewards)) {
            fail("PLAN_MISMATCH", "Starter reward snapshot differs from the signed plan.", { permanent: true });
        }
        expectedPlanHash = rewards.rewardPlanHash;
    }
    try {
        const input = { ...receipt, playFabId: receipt.userId };
        if (starter) serializeXsollaStarterReceiptV2(input);
        else serializeXsollaDiamondReceiptV2(input);
    } catch (error) {
        fail("INVALID_RECEIPT", "Immutable receipt validation failed.", {
            permanent: true,
            details: { cause: error?.message }
        });
    }
    if (expectedReceiptId !== transaction.receiptId ||
        receipt.transactionId !== transaction.providerTransactionId ||
        receipt.providerTransactionId !== transaction.providerTransactionId ||
        receipt.userId !== transaction.playFabId || receipt.xsollaSku !== transaction.sku ||
        receipt.productPlanVersion !== transaction.planVersion ||
        expectedPlanHash !== transaction.planHash || receipt.currency !== transaction.currency ||
        receipt.totalAmountMinor !== transaction.amountMinor || receipt.unitAmountMinor !== transaction.amountMinor ||
        receipt.quantity !== 1 || receipt.environment !== transaction.environment ||
        product.currency !== transaction.currency || product.unitAmountMinor !== transaction.amountMinor) {
        fail("ECONOMIC_MISMATCH", "Receipt, ledger and product economics differ.", { permanent: true });
    }
    return Object.freeze({ receipt: Object.freeze(receipt), product, starter });
}

function rewardSets(receipt, product) {
    if (product.productType === "starter_pack") {
        const quantitative = receipt.rewards
            .filter((reward) => reward.grantMode === "additive")
            .map((reward) => Object.freeze({ rewardId: reward.rewardId, quantity: reward.quantity }));
        return Object.freeze({ quantitative: Object.freeze(quantitative), hasEntitlements: true });
    }
    if (product.productType === "diamond_pack") {
        const quantity = DIAMOND_PACK_REWARDS[receipt.xsollaSku];
        if (!quantity) fail("PLAN_MISMATCH", "Diamond quantity is unavailable.", { permanent: true });
        return Object.freeze({
            quantitative: Object.freeze([Object.freeze({ rewardId: "diamonds", quantity })]),
            hasEntitlements: true
        });
    }
    return Object.freeze({ quantitative: Object.freeze([]), hasEntitlements: true });
}

async function assertLease(context) {
    if (typeof context?.assertLeaseOwnership !== "function") {
        fail("INVALID_GRANT_CONTEXT", "Lease assertion is required.", { permanent: true });
    }
    const lease = await context.assertLeaseOwnership();
    if (lease?.playerLeaseEpoch !== context.playerLeaseEpoch ||
        lease?.transactionLeaseEpoch !== context.transactionLeaseEpoch) {
        fail("STALE_FENCING", "Worker lost its financial lease.", { permanent: true });
    }
}

function checkpointOperation(transaction, name) {
    const operationId = transaction?.checkpoints?.[name]?.operationId ||
        transaction?.stepJournal?.[name]?.operationId;
    return typeof operationId === "string" ? operationId : null;
}

function recordMetric(metrics, event, labels = {}, fields = {}, value = 1) {
    try { metrics?.record?.(event, { labels, fields, value }); } catch { /* financial semantics win */ }
}

export function createPlayFabFinancialAuthorityGrantAdapter({
    economyAdapter,
    authorityStore,
    loadReceipt,
    maximumCasAttempts = 5,
    maximumReceiptBytes = 128 * 1024,
    nowUtc = () => new Date(),
    metrics = null
} = {}) {
    if (!economyAdapter || typeof economyAdapter.grant !== "function" || typeof economyAdapter.verify !== "function" ||
        !authorityStore || typeof authorityStore.read !== "function" ||
        typeof authorityStore.compareAndSet !== "function" || typeof loadReceipt !== "function" ||
        !Number.isSafeInteger(maximumCasAttempts) || maximumCasAttempts <= 0 ||
        !Number.isSafeInteger(maximumReceiptBytes) || maximumReceiptBytes <= 0 || typeof nowUtc !== "function") {
        throw new TypeError("FinancialAuthorityV2 grant adapter is not configured.");
    }

    async function requireMigratedAuthority(playFabId) {
        const snapshot = await authorityStore.read(playFabId);
        if (!snapshot?.migrated || !snapshot.authority) {
            fail(
                "FINANCIAL_AUTHORITY_NOT_MIGRATED",
                "Player is not migrated to FinancialAuthorityV2.",
                { permanent: true }
            );
        }
        return snapshot;
    }

    async function contract(context) {
        const transaction = context?.transaction;
        if (!transaction || typeof transaction !== "object") {
            fail("INVALID_GRANT_CONTEXT", "Ledger transaction is absent.", { permanent: true });
        }
        await assertLease(context);
        const loaded = await loadReceipt({
            playFabId: transaction.playFabId,
            receiptId: transaction.receiptId,
            transaction: structuredClone(transaction)
        });
        if (loaded === null || loaded === undefined) {
            fail("RECEIPT_NOT_FOUND", "Immutable receipt is missing.", { permanent: true });
        }
        const validated = validateReceipt(transaction, loaded?.value ?? loaded, maximumReceiptBytes);
        return Object.freeze({ ...validated, rewards: rewardSets(validated.receipt, validated.product) });
    }

    async function grantQuantitative(context) {
        canonical(context?.operationId, "operationId", 160);
        const { receipt, rewards } = await contract(context);
        if (rewards.quantitative.length === 0) return Object.freeze({ status: "not_applicable", operationCount: 0 });
        await requireMigratedAuthority(context.transaction.playFabId);
        await assertLease(context);
        try {
            const result = await economyAdapter.grant({
                playFabId: context.transaction.playFabId,
                operationId: context.operationId,
                idempotencyCreatedAtUtc: receipt.createdAtUtc,
                rewards: rewards.quantitative
            });
            recordMetric(metrics, "dm_grant", { authority: "economy_v2" }, {
                transactionId: context.transaction.providerTransactionId,
                quantity: rewards.quantitative.find((reward) => reward.rewardId === "diamonds")?.quantity ?? 0
            });
            return result;
        } catch (error) {
            if (error?.ambiguous === true) recordMetric(metrics, "dm_ambiguous", { authority: "economy_v2" });
            throw error;
        }
    }

    async function grantEntitlements(context) {
        canonical(context?.operationId, "operationId", 160);
        const { receipt } = await contract(context);
        for (let attempt = 1; attempt <= maximumCasAttempts; attempt += 1) {
            await assertLease(context);
            const snapshot = await requireMigratedAuthority(context.transaction.playFabId);
            const mutation = applyFinancialEntitlementGrant(snapshot.authority, {
                sku: context.transaction.sku,
                transactionId: receipt.transactionId,
                operationId: context.operationId,
                fencingToken: context.playerLeaseEpoch,
                productPlanVersion: receipt.productPlanVersion,
                rewardPlanVersion: receipt.rewardPlanVersion,
                nowUtc: nowUtc()
            });
            if (mutation.status === "already_applied") {
                if (!verifyFinancialEntitlementGrant(mutation.authority, {
                    sku: context.transaction.sku,
                    transactionId: receipt.transactionId,
                    operationId: context.operationId,
                    productPlanVersion: receipt.productPlanVersion,
                    rewardPlanVersion: receipt.rewardPlanVersion
                })) fail("FINANCIAL_AUTHORITY_PROOF_MISSING", "Entitlement replay proof is absent.", { permanent: true });
                return Object.freeze({ status: "already_applied", financialRevision: snapshot.financialRevision, attempts: attempt });
            }
            if (mutation.status === "stale_fencing") {
                fail("STALE_FENCING", "FinancialAuthorityV2 rejected stale fencing.", { permanent: true });
            }
            await assertLease(context);
            const result = await authorityStore.compareAndSet({
                playFabId: context.transaction.playFabId,
                expectedObjectVersion: snapshot.objectVersion,
                expectedFinancialRevision: snapshot.financialRevision,
                authority: mutation.authority,
                operationId: context.operationId,
                fencingToken: context.playerLeaseEpoch
            });
            if (result?.applied === true || result?.reason === "already_applied") {
                if (!verifyFinancialEntitlementGrant(result.authority, {
                    sku: context.transaction.sku,
                    transactionId: receipt.transactionId,
                    operationId: context.operationId,
                    productPlanVersion: receipt.productPlanVersion,
                    rewardPlanVersion: receipt.rewardPlanVersion
                })) fail("FINANCIAL_AUTHORITY_PROOF_MISSING", "Final entitlement proof is absent.", { permanent: true });
                return Object.freeze({
                    status: result.applied ? "applied" : "already_applied",
                    financialRevision: result.financialRevision,
                    attempts: attempt
                });
            }
            if (result?.reason === "stale_fencing") {
                fail("STALE_FENCING", "FinancialAuthorityV2 rejected stale fencing.", { permanent: true });
            }
            if (result?.reason !== "version_conflict") {
                fail("FINANCIAL_AUTHORITY_PROTOCOL", "Financial authority store returned an invalid result.", { permanent: true });
            }
            recordMetric(metrics, "financial_merge_conflict", { authority: "financial_v2" }, { attempt });
        }
        const error = new FinancialAuthorityGrantError(
            "FINANCIAL_CAS_RETRY_EXHAUSTED",
            "FinancialAuthorityV2 CAS retries were exhausted.",
            { retryable: true }
        );
        throw error;
    }

    async function verifyFinal(context) {
        const { receipt, rewards } = await contract(context);
        const quantitativeOperationId = checkpointOperation(context.transaction, "economy_v2_granted");
        const entitlementOperationId = checkpointOperation(context.transaction, "entitlements_granted");
        if (!entitlementOperationId) {
            fail("CHECKPOINT_PROOF_MISSING", "Entitlement checkpoint operation is absent.", { permanent: true });
        }
        let quantitative = null;
        if (rewards.quantitative.length > 0) {
            if (!quantitativeOperationId) {
                fail("CHECKPOINT_PROOF_MISSING", "Economy v2 checkpoint operation is absent.", { permanent: true });
            }
            quantitative = await economyAdapter.verify({
                playFabId: context.transaction.playFabId,
                operationId: quantitativeOperationId,
                idempotencyCreatedAtUtc: receipt.createdAtUtc,
                rewards: rewards.quantitative
            });
        }
        await assertLease(context);
        const snapshot = await authorityStore.read(context.transaction.playFabId);
        if (!snapshot?.migrated || !verifyFinancialEntitlementGrant(snapshot.authority, {
            sku: context.transaction.sku,
            transactionId: receipt.transactionId,
            operationId: entitlementOperationId,
            productPlanVersion: receipt.productPlanVersion,
            rewardPlanVersion: receipt.rewardPlanVersion
        })) {
            fail("FINANCIAL_AUTHORITY_VERIFY_FAILED", "Final FinancialAuthorityV2 proof is absent.", { permanent: true });
        }
        recordMetric(metrics, "authority_revision", { authority: "financial_v2" }, {
            financialRevision: snapshot.financialRevision
        }, snapshot.financialRevision);
        return Object.freeze({
            status: "verified",
            authorityVersion: "financial_v2",
            financialRevision: snapshot.financialRevision,
            quantitative: quantitative ? {
                idempotencyId: quantitative.idempotencyId,
                transactionIds: quantitative.transactionIds,
                etag: quantitative.etag
            } : null,
            entitlementOperationId
        });
    }

    function health() {
        const economy = economyAdapter.health?.() ?? null;
        return Object.freeze({
            healthy: economy?.healthy === true,
            configured: economy?.configured === true,
            authorityVersion: "financial_v2",
            economy,
            maximumCasAttempts
        });
    }

    async function probe() {
        await economyAdapter.probe?.();
        await authorityStore.probe?.();
        return Object.freeze({ ok: true, authorityVersion: "financial_v2" });
    }

    return Object.freeze({ grantQuantitative, grantEntitlements, verifyFinal, health, probe });
}
