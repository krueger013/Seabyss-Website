import { XsollaInvalidUserError } from "./xsolla-webhook.js";
import {
    hasXsollaDiamondItemContainer,
    resolveXsollaDiamondPack
} from "./xsolla-diamond-packs.js";
import { resolveXsollaStarterPack } from "./xsolla-starter-packs.js";
import {
    resolveXsollaPremiumProduct,
    resolveXsollaStandalonePremiumPeriod
} from "./xsolla-premium-products.js";

const maximumInt64 = 9223372036854775807n;

function asNormalizedIdentifier(value) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= 160 &&
        value === value.trim() &&
        !/\s/.test(value)
        ? value
        : null;
}

function asLosslessTransactionId(value) {
    let normalized;
    if (typeof value === "string") {
        if (value !== value.trim()) {
            return null;
        }
        normalized = value;
    } else if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            return null;
        }
        normalized = String(value);
    } else if (typeof value === "bigint") {
        normalized = String(value);
    } else {
        return null;
    }
    if (!/^[1-9][0-9]*$/.test(normalized)) {
        return null;
    }
    try {
        const numeric = BigInt(normalized);
        if (numeric > maximumInt64) {
            return null;
        }
    } catch {
        return null;
    }
    return normalized;
}

function resolvePaymentMode(payload, notificationType) {
    const hasRootDryRun = Object.prototype.hasOwnProperty.call(payload || {}, "dry_run");
    if (hasRootDryRun) {
        return "invalid";
    }

    if (notificationType === "payment") {
        const hasTransactionDryRun = Object.prototype.hasOwnProperty.call(
            payload?.transaction || {},
            "dry_run"
        );
        if (!hasTransactionDryRun) {
            return "production";
        }
        return payload.transaction.dry_run === 1 ? "sandbox" : "invalid";
    }

    if (notificationType === "order_paid") {
        const mode = payload?.order?.mode;
        const hasBillingDryRun = Object.prototype.hasOwnProperty.call(
            payload?.billing?.transaction || {},
            "dry_run"
        );
        if (mode === "sandbox") {
            return hasBillingDryRun && payload.billing.transaction.dry_run === 1
                ? "sandbox"
                : "invalid";
        }
        if (mode === "default") {
            return hasBillingDryRun ? "invalid" : "production";
        }
    }

    return "invalid";
}

function asDate(value) {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function serverNow(now) {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error("Premium processor server clock is unavailable.");
    }
    return new Date(value.getTime());
}

export function addOneUtcCalendarMonth(value) {
    const source = value instanceof Date ? new Date(value.getTime()) : null;
    if (!source || !Number.isFinite(source.getTime())) {
        throw new TypeError("A valid date is required.");
    }
    const targetYear = source.getUTCMonth() === 11
        ? source.getUTCFullYear() + 1
        : source.getUTCFullYear();
    const targetMonth = (source.getUTCMonth() + 1) % 12;
    const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    source.setUTCFullYear(targetYear, targetMonth, Math.min(source.getUTCDate(), lastTargetDay));
    return source;
}

export function resolveXsollaPremiumPeriod(payload, now = () => new Date()) {
    const transaction = payload?.transaction;
    const subscription = payload?.purchase?.subscription;
    const hasPaymentDate = Object.prototype.hasOwnProperty.call(transaction || {}, "payment_date");
    const hasNextChargeDate = Object.prototype.hasOwnProperty.call(subscription || {}, "date_next_charge");
    const paymentDate = hasPaymentDate ? asDate(transaction.payment_date) : null;
    const nextChargeDate = hasNextChargeDate ? asDate(subscription.date_next_charge) : null;
    if (hasPaymentDate && !paymentDate) {
        throw new Error("Xsolla Premium payment_date is invalid.");
    }
    if (hasNextChargeDate && !nextChargeDate) {
        throw new Error("Xsolla Premium date_next_charge is invalid.");
    }
    if (!nextChargeDate && !paymentDate) {
        throw new Error("Xsolla Premium payment has no reliable billing period.");
    }
    const activatedAt = paymentDate || serverNow(now);
    const expiresAt = nextChargeDate || addOneUtcCalendarMonth(paymentDate);
    if (expiresAt.getTime() <= activatedAt.getTime()) {
        throw new Error("Xsolla Premium expiration is not after activation.");
    }
    return Object.freeze({
        activatedAtUtcIso8601: activatedAt.toISOString(),
        expiresAtUtcIso8601: expiresAt.toISOString()
    });
}

function asStrictPlanIdentifier(value) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
        return null;
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        return null;
    }
    const normalized = String(value);
    if (!normalized || normalized !== normalized.trim() || normalized.length > 160) {
        return null;
    }
    return normalized;
}

function providedPlanValues(containers, fieldNames) {
    const values = [];
    for (const container of containers) {
        for (const fieldName of fieldNames) {
            if (Object.prototype.hasOwnProperty.call(container || {}, fieldName)) {
                values.push(asStrictPlanIdentifier(container[fieldName]));
            }
        }
    }
    return values;
}

export function isSeabyssPremiumPlan(payload, premiumPlanId, premiumPlanExternalId) {
    const officialNumericId = asStrictPlanIdentifier(premiumPlanId);
    const officialExternalId = asStrictPlanIdentifier(premiumPlanExternalId);
    if (!officialNumericId || !officialExternalId) {
        return false;
    }

    const purchaseSubscription = payload?.purchase?.subscription;
    const planIds = providedPlanValues(
        [purchaseSubscription],
        ["plan_id"]
    );
    const externalIds = providedPlanValues(
        [purchaseSubscription],
        ["external_id", "plan_external_id"]
    );
    if (planIds.length === 0 && externalIds.length === 0) {
        return false;
    }

    if (planIds.some((value) =>
        value !== officialNumericId && value !== officialExternalId
    )) {
        return false;
    }
    if (externalIds.some((value) => value !== officialExternalId)) {
        return false;
    }
    return true;
}

export function createXsollaPremiumEventProcessor({
    premiumPlanId,
    premiumPlanExternalId = null,
    allowSandboxGrants = false,
    sandboxTestPlayFabIds = [],
    allowStarterSandboxGrants = false,
    starterSandboxTestPlayFabIds = [],
    allowStarterProductionGrants = false,
    enableStandalonePremiumProducts = false,
    persistPremiumEntitlement,
    persistDiamondPackReceipt,
    persistStarterPackReceipt,
    persistPremiumProductReceipt,
    validateUser,
    now = () => new Date()
} = {}) {
    const configuredPlanId = asStrictPlanIdentifier(premiumPlanId);
    const configuredPlanExternalId = premiumPlanExternalId === null || premiumPlanExternalId === undefined
        ? null
        : asStrictPlanIdentifier(premiumPlanExternalId);
    const sandboxGrantEnabled = allowSandboxGrants === true;
    const sandboxAllowedUsers = new Set(
        Array.isArray(sandboxTestPlayFabIds)
            ? sandboxTestPlayFabIds.map(asNormalizedIdentifier).filter(Boolean)
            : []
    );
    const starterSandboxGrantEnabled = allowStarterSandboxGrants === true;
    const starterSandboxAllowedUsers = new Set(
        Array.isArray(starterSandboxTestPlayFabIds)
            ? starterSandboxTestPlayFabIds.map(asNormalizedIdentifier).filter(Boolean)
            : []
    );
    const starterProductionGrantEnabled = allowStarterProductionGrants === true;

    return async function processXsollaEvent({ payload, notificationType, userId }) {
        if (notificationType !== "payment" && notificationType !== "order_paid") {
            return "validated_no_grant";
        }

        if (notificationType === "order_paid" &&
            !hasXsollaDiamondItemContainer(payload, notificationType)) {
            return "validated_no_grant";
        }

        const paymentMode = resolvePaymentMode(payload, notificationType);
        const isSandboxPayment = paymentMode === "sandbox";
        const canonicalUserId = asNormalizedIdentifier(userId);
        const starterPack = resolveXsollaStarterPack(payload, notificationType);
        if (paymentMode === "invalid") {
            return "ignored_dry_run";
        }
        if (starterPack) {
            if (isSandboxPayment && (
                !starterSandboxGrantEnabled ||
                !canonicalUserId ||
                !starterSandboxAllowedUsers.has(canonicalUserId)
            )) {
                return "ignored_dry_run";
            }
            if (!isSandboxPayment && !starterProductionGrantEnabled) {
                return "ignored_unrecognized_product";
            }
        } else if (isSandboxPayment && (
            !sandboxGrantEnabled ||
            !canonicalUserId ||
            !sandboxAllowedUsers.has(canonicalUserId)
        )) {
            return "ignored_dry_run";
        }

        const diamondPack = resolveXsollaDiamondPack(payload, notificationType);
        const premiumProduct = enableStandalonePremiumProducts === true
            ? resolveXsollaPremiumProduct(payload, notificationType)
            : null;
        let isPremiumPayment = false;
        if (notificationType === "order_paid") {
            const recognizedProductCount = [diamondPack, starterPack].filter(Boolean).length;
            if (recognizedProductCount > 1) {
                return "ignored_ambiguous_product";
            }
            if (recognizedProductCount === 0) {
                return "ignored_unrecognized_product";
            }
        } else {
            if (!configuredPlanId || !configuredPlanExternalId) {
                throw new Error("Xsolla Premium processing is not configured.");
            }
            isPremiumPayment = isSeabyssPremiumPlan(
                payload,
                configuredPlanId,
                configuredPlanExternalId
            );
            const recognizedProductCount = [
                diamondPack,
                starterPack,
                premiumProduct,
                isPremiumPayment ? { legacyPremium: true } : null
            ].filter(Boolean).length;
            if (recognizedProductCount > 1) {
                return "ignored_ambiguous_product";
            }
            if (recognizedProductCount === 0) {
                return hasXsollaDiamondItemContainer(payload, notificationType)
                    ? "ignored_unrecognized_product"
                    : "ignored_non_premium_plan";
            }
        }

        const transactionId = asLosslessTransactionId(
            notificationType === "payment"
                ? payload?.transaction?.id
                : payload?.billing?.transaction?.id
        );
        if (!transactionId || !canonicalUserId) {
            throw new Error("Xsolla payment identifiers are invalid.");
        }
        if (typeof validateUser !== "function") {
            throw new Error("Xsolla user validation is not configured.");
        }

        const userExists = await validateUser(canonicalUserId);
        if (userExists === false) {
            throw new XsollaInvalidUserError();
        }
        if (userExists !== true) {
            throw new Error("Xsolla user validation returned an invalid result.");
        }

        if (diamondPack) {
            if (typeof persistDiamondPackReceipt !== "function") {
                throw new Error("Xsolla Diamond Pack processing is not configured.");
            }
            await persistDiamondPackReceipt({
                playFabId: canonicalUserId,
                transactionId,
                ...diamondPack,
                source: isSandboxPayment ? "xsolla_sandbox" : "xsolla_production"
            });
            return isSandboxPayment
                ? "diamond_pack_sandbox_granted"
                : "diamond_pack_granted";
        }

        if (starterPack) {
            if (typeof persistStarterPackReceipt !== "function") {
                throw new Error("Xsolla Starter Pack processing is not configured.");
            }
            await persistStarterPackReceipt({
                playFabId: canonicalUserId,
                transactionId,
                ...starterPack,
                source: isSandboxPayment ? "xsolla_sandbox" : "xsolla_production"
            });
            return isSandboxPayment
                ? "starter_pack_sandbox_granted"
                : "starter_pack_granted";
        }

        if (premiumProduct) {
            if (typeof persistPremiumProductReceipt !== "function") {
                throw new Error("Xsolla standalone Premium processing is not configured.");
            }
            const period = resolveXsollaStandalonePremiumPeriod(now);
            await persistPremiumProductReceipt({
                playFabId: canonicalUserId,
                transactionId,
                ...premiumProduct,
                ...period,
                source: isSandboxPayment ? "xsolla_sandbox" : "xsolla_production"
            });
            return isSandboxPayment
                ? "premium_product_sandbox_granted"
                : "premium_product_granted";
        }

        if (!isPremiumPayment || typeof persistPremiumEntitlement !== "function") {
            throw new Error("Xsolla Premium processing is not configured.");
        }

        const period = resolveXsollaPremiumPeriod(payload, now);
        await persistPremiumEntitlement({
            playFabId: canonicalUserId,
            transactionId,
            ...(isSandboxPayment ? { grantSource: "xsolla_sandbox" } : {}),
            ...period
        });
        return isSandboxPayment ? "premium_sandbox_granted" : "premium_granted";
    };
}
