import { getXsollaDiamondReceiptV2Key, serializeXsollaDiamondReceiptV2 } from "./playfab-xsolla-diamond-receipt-v2-store.js";
import { getXsollaStarterReceiptV2Key, serializeXsollaStarterReceiptV2 } from "./playfab-xsolla-starter-receipt-v2-store.js";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";
import { getStarterRewardPlan } from "./xsolla-starter-reward-plan-registry.js";
import { applyXsollaFinancialProfileGrant } from "./xsolla-financial-profile-mutator.js";

const RECEIPT_PREFIXES = Object.freeze(["xss2_", "xsd2_"]);

export class PaymentGrantPermanentError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = "PaymentGrantPermanentError";
        this.code = code;
        this.permanent = true;
        this.details = details;
    }
}

function permanent(code, message, details) {
    throw new PaymentGrantPermanentError(code, message, details);
}
function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        permanent("INVALID_GRANT_CONTEXT", `${name} is invalid.`);
    }
    return value;
}
function receiptPrefix(value) {
    return RECEIPT_PREFIXES.find((prefix) => value.startsWith(prefix)) || null;
}
function parseReceipt(value, maximumReceiptBytes) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        let serialized;
        try { serialized = JSON.stringify(value); }
        catch { permanent("INVALID_RECEIPT", "Immutable receipt payload is not JSON serializable."); }
        if (Buffer.byteLength(serialized, "utf8") > maximumReceiptBytes) {
            permanent("INVALID_RECEIPT", "Immutable receipt payload is too large.");
        }
        return structuredClone(value);
    }
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumReceiptBytes) {
        permanent("INVALID_RECEIPT", "Immutable receipt payload is invalid or too large.");
    }
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        return parsed;
    } catch {
        permanent("INVALID_RECEIPT", "Immutable receipt payload is not strict JSON.");
    }
}
function receiptCheckpoint(transaction) {
    const checkpoint = transaction?.checkpoints?.receipt_persisted;
    if (!checkpoint || checkpoint?.result?.receiptId !== transaction.receiptId) {
        permanent("RECEIPT_NOT_PERSISTED", "The durable receipt_persisted checkpoint is absent or inconsistent.");
    }
    return checkpoint;
}
function validateReceipt(transaction, rawReceipt, resolveProductPlan, resolveStarterRewardPlan, maximumReceiptBytes) {
    canonical(transaction?.providerTransactionId, "providerTransactionId");
    canonical(transaction?.playFabId, "playFabId", 160);
    canonical(transaction?.sku, "sku", 255);
    canonical(transaction?.receiptId, "receiptId");
    if (transaction.provider !== "xsolla" || !receiptPrefix(transaction.receiptId)) {
        permanent("UNSUPPORTED_RECEIPT", "Only immutable xss2_/xsd2_ Xsolla receipts may grant a profile.");
    }
    receiptCheckpoint(transaction);
    const receipt = parseReceipt(rawReceipt, maximumReceiptBytes);
    if (receipt.schemaVersion !== 2) permanent("INVALID_RECEIPT", "Immutable receipt schema version is invalid.");
    const starter = transaction.receiptId.startsWith("xss2_");
    const expectedType = starter ? "starter_pack" : "diamond_pack";
    if (receipt.productType !== expectedType) permanent("INVALID_RECEIPT", "Receipt type and key prefix disagree.");
    let plan;
    try { plan = resolveProductPlan(receipt.xsollaSku, receipt.productPlanVersion); }
    catch { permanent("PLAN_MISMATCH", "Product plan version is unavailable."); }
    const expectedReceiptId = starter
        ? getXsollaStarterReceiptV2Key(receipt.transactionId)
        : getXsollaDiamondReceiptV2Key(receipt.transactionId);
    let expectedPlanHash = plan.planHash;
    if (starter) {
        let rewardPlan;
        try { rewardPlan = resolveStarterRewardPlan(receipt.xsollaSku, receipt.rewardPlanVersion); }
        catch { permanent("PLAN_MISMATCH", "Starter reward plan version is unavailable."); }
        if (receipt.rewardPlanHash !== rewardPlan.rewardPlanHash ||
            JSON.stringify(receipt.rewards) !== JSON.stringify(rewardPlan.rewards)) {
            permanent("PLAN_MISMATCH", "Starter reward plan hash or snapshot differs.");
        }
        expectedPlanHash = rewardPlan.rewardPlanHash;
    }
    try {
        const canonicalInput = { ...receipt, playFabId: receipt.userId };
        if (starter) serializeXsollaStarterReceiptV2(canonicalInput);
        else serializeXsollaDiamondReceiptV2(canonicalInput);
    } catch (error) {
        permanent("INVALID_RECEIPT", "Immutable receipt validation failed.", { cause: error?.message });
    }
    const mismatched = expectedReceiptId !== transaction.receiptId ||
        receipt.transactionId !== transaction.providerTransactionId ||
        receipt.providerTransactionId !== transaction.providerTransactionId ||
        receipt.userId !== transaction.playFabId || receipt.xsollaSku !== transaction.sku ||
        receipt.productPlanVersion !== transaction.planVersion ||
        expectedPlanHash !== transaction.planHash || receipt.currency !== transaction.currency ||
        receipt.totalAmountMinor !== transaction.amountMinor || receipt.unitAmountMinor !== transaction.amountMinor ||
        receipt.quantity !== 1 || receipt.environment !== transaction.environment ||
        plan.currency !== transaction.currency || plan.unitAmountMinor !== transaction.amountMinor;
    if (mismatched) permanent("ECONOMIC_MISMATCH", "Receipt, ledger, plan, or paid economics differ.");
    return Object.freeze({ receipt: Object.freeze(receipt), plan, starter });
}
function verifyProfile(profile, receipt) {
    const transactionId = receipt.transactionId;
    if (!profile?.shopReceiptLedger?.appliedTransactionIds?.includes(transactionId)) return false;
    const operation = receipt.productType === "starter_pack" ? "XsollaStarterPack" : "XsollaDiamondPack";
    return Array.isArray(profile.durableEconomyTransactions) &&
        profile.durableEconomyTransactions.some((proof) => proof?.state === "Completed" &&
            proof.operation === operation && proof.operationKey === receipt.productId &&
            proof.requestId === transactionId && proof.accountId === receipt.userId);
}
async function assertLease(context) {
    if (typeof context?.assertLeaseOwnership !== "function") {
        permanent("INVALID_GRANT_CONTEXT", "Lease ownership assertion is required.");
    }
    const lease = await context.assertLeaseOwnership();
    if (!lease || lease.playerLeaseEpoch !== context.playerLeaseEpoch ||
        lease.transactionLeaseEpoch !== context.transactionLeaseEpoch) {
        permanent("STALE_FENCING", "Payment lease epoch changed during the profile grant.");
    }
}

function recordMetric(metrics, event, labels = {}, fields = {}, value = 1) {
    try {
        metrics?.record?.(event, { value, labels, fields });
    } catch {
        // Observability must never alter payment grant semantics.
    }
}

export function createPlayFabPaymentGrantAdapter({
    profileStore,
    loadReceipt,
    resolveProductPlan = getXsollaProductPlan,
    resolveStarterRewardPlan = getStarterRewardPlan,
    mutateProfile = applyXsollaFinancialProfileGrant,
    maximumCasAttempts = 5,
    maximumReceiptBytes = 128 * 1024,
    nowUtc = () => new Date(),
    nowMilliseconds = () => Date.now(),
    metrics = null
} = {}) {
    if (!profileStore || typeof profileStore.read !== "function" ||
        typeof profileStore.compareAndSet !== "function" || typeof loadReceipt !== "function" ||
        typeof resolveProductPlan !== "function" || typeof resolveStarterRewardPlan !== "function" ||
        typeof mutateProfile !== "function" || typeof nowUtc !== "function" ||
        typeof nowMilliseconds !== "function" ||
        !Number.isSafeInteger(maximumCasAttempts) || maximumCasAttempts <= 0 ||
        !Number.isSafeInteger(maximumReceiptBytes) || maximumReceiptBytes <= 0) {
        throw new TypeError("PlayFab payment grant adapter is not configured.");
    }

    async function timedPlayFabCall(component, call) {
        const started = nowMilliseconds();
        try {
            return await call();
        } catch (error) {
            if (error?.retryable === true) {
                recordMetric(metrics, "playfab_retry", { component }, {
                    errorCode: error?.code || "PLAYFAB_ERROR"
                });
            }
            if (error?.code === "AMBIGUOUS_PROVIDER_RESULT") {
                recordMetric(metrics, "ambiguous_provider_result", { component });
            }
            throw error;
        } finally {
            const elapsed = Math.max(0, Math.round(nowMilliseconds() - started));
            recordMetric(metrics, "playfab_call_latency", { component }, {}, elapsed);
        }
    }

    async function grant(context) {
        const transaction = context?.transaction;
        if (!transaction || typeof transaction !== "object") permanent("INVALID_GRANT_CONTEXT", "Ledger transaction is absent.");
        receiptCheckpoint(transaction);
        await assertLease(context);
        const loaded = await timedPlayFabCall("receipt_read", () => loadReceipt({
            playFabId: transaction.playFabId,
            receiptId: transaction.receiptId,
            transaction: structuredClone(transaction)
        }));
        if (loaded === null || loaded === undefined) permanent("RECEIPT_NOT_FOUND", "Immutable receipt is missing.");
        const { receipt } = validateReceipt(
            transaction,
            loaded?.value ?? loaded,
            resolveProductPlan,
            resolveStarterRewardPlan,
            maximumReceiptBytes
        );
        canonical(context.operationId, "operationId");
        if (!Number.isSafeInteger(context.playerLeaseEpoch) || context.playerLeaseEpoch <= 0) {
            permanent("STALE_FENCING", "Player lease fencing token is invalid.");
        }
        for (let attempt = 1; attempt <= maximumCasAttempts; attempt += 1) {
            await assertLease(context);
            const snapshot = await timedPlayFabCall("profile_read", () =>
                profileStore.read(transaction.playFabId));
            if (!snapshot || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 || !snapshot.profile) {
                permanent("INVALID_PROFILE_SNAPSHOT", "PlayFab profile snapshot is invalid.");
            }
            let mutation;
            try {
                mutation = mutateProfile(snapshot.profile, {
                    sku: transaction.sku,
                    transactionId: transaction.providerTransactionId,
                    nowUtc: nowUtc(),
                    grantSource: "xsolla"
                });
            } catch (error) {
                permanent("PROFILE_MUTATION_INVALID", "Financial profile mutation failed validation.", { cause: error?.message });
            }
            if (!mutation || !["applied", "already_applied"].includes(mutation.status) || !mutation.profile) {
                permanent("PROFILE_MUTATION_INVALID", "Financial profile mutator returned an invalid result.");
            }
            if (mutation.status === "already_applied") {
                if (!verifyProfile(mutation.profile, receipt)) permanent("PROFILE_PROOF_MISSING", "Replay proof is incomplete.");
                return Object.freeze({ status: "already_applied", version: snapshot.version, attempts: attempt,
                    receiptId: transaction.receiptId });
            }
            await assertLease(context);
            const result = await timedPlayFabCall("profile_cas", () => profileStore.compareAndSet({
                playFabId: transaction.playFabId,
                expectedVersion: snapshot.version,
                profile: mutation.profile,
                operationId: context.operationId,
                fencingToken: context.playerLeaseEpoch
            }));
            if (result?.applied === true || result?.reason === "already_applied") {
                await assertLease(context);
                const final = await timedPlayFabCall("profile_verify", () =>
                    profileStore.read(transaction.playFabId));
                if (!final || !verifyProfile(final.profile, receipt)) {
                    permanent("PROFILE_GRANT_VERIFICATION_FAILED", "Final profile grant proof is missing.");
                }
                return Object.freeze({ status: result.applied ? "applied" : "already_applied",
                    version: final.version, attempts: attempt, receiptId: transaction.receiptId });
            }
            if (result?.reason === "stale_fencing") {
                recordMetric(metrics, "fencing_reject", { component: "playfab_profile" });
                permanent("STALE_FENCING", "PlayFab profile rejected stale fencing.");
            }
            if (result?.reason !== "version_conflict") {
                permanent("PROFILE_STORE_PROTOCOL", "PlayFab profile CAS returned an invalid result.");
            }
            recordMetric(metrics, "profile_cas_conflict", { component: "playfab_profile" });
            recordMetric(metrics, "playfab_retry", { component: "profile_cas" }, { attempt });
        }
        const error = new Error(`PlayFab profile CAS conflict exceeded ${maximumCasAttempts} attempts.`);
        error.code = "PROFILE_CAS_RETRY_EXHAUSTED";
        throw error;
    }

    function health() {
        return Object.freeze({ healthy: true, configured: true, receiptFormats: [...RECEIPT_PREFIXES],
            maximumCasAttempts, maximumReceiptBytes });
    }
    return Object.freeze({ grant, health });
}
