import { readConfiguredDiamondsCanaryPlayFabId } from "./diamonds-canary-identity.js";
import {
    createTrustedXsollaV2PaymentResolver
} from "./financial-shadow-payment-producer.js";
import { serverEconomyPocDigest } from "./server-economy-poc-model.js";

const REQUIRED_TARGET_CAPABILITIES = Object.freeze([
    "authoritative",
    "cas",
    "durableCompletion",
    "exactlyOnce",
    "fencing",
    "migrationProofRequired"
]);

export const DIAMONDS_CANARY_SANDBOX_TITLE_ID = "1D0C16";
export const DIAMONDS_CANARY_PLAYFAB_ID = readConfiguredDiamondsCanaryPlayFabId();
export const DIAMONDS_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID = "142853";

function coded(code, message, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function canonical(value, name, maximumLength = 200) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function providerTransactionId(value) {
    const normalized = canonical(value, "providerTransactionId", 19);
    if (!/^[1-9][0-9]*$/u.test(normalized)) {
        throw new TypeError("providerTransactionId must be a canonical positive int64 string.");
    }
    try {
        if (BigInt(normalized) > 9223372036854775807n) throw new RangeError();
    } catch {
        throw new TypeError("providerTransactionId must be a canonical positive int64 string.");
    }
    return normalized;
}

function strictInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "providerTransactionId") {
        throw coded(
            "DIAMONDS_CANARY_PAYMENT_INPUT_REJECTED",
            "Diamonds canary payment accepts only providerTransactionId.",
            400
        );
    }
    return providerTransactionId(value.providerTransactionId);
}

function exactCanaryPolicy(policy) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
        typeof policy.enabled !== "boolean") {
        throw new TypeError("Diamonds canary xsd2 policy is invalid.");
    }
    if (policy.enabled !== true) {
        if (Array.isArray(policy.canaryPlayFabIds) && policy.canaryPlayFabIds.length !== 0) {
            throw coded(
                "DIAMONDS_CANARY_PAYMENT_ALLOWLIST_MUST_BE_EMPTY",
                "Disabled Diamonds canary cannot retain an allowlist.",
                400
            );
        }
        return Object.freeze({ enabled: false, canaryPlayFabIds: Object.freeze([]) });
    }
    if (policy.environment !== "sandbox" || !Array.isArray(policy.canaryPlayFabIds) ||
        policy.canaryPlayFabIds.length !== 1 || !Array.isArray(policy.forbiddenTitleIds)) {
        throw coded(
            "DIAMONDS_CANARY_PAYMENT_POLICY_INVALID",
            "Diamonds canary payment requires one explicit player in the Sandbox environment.",
            400
        );
    }
    const titleId = canonical(policy.titleId, "Sandbox Title ID", 32);
    const canaryPlayFabId = canonical(policy.canaryPlayFabIds[0], "canary PlayFabId", 160);
    const forbiddenTitleIds = policy.forbiddenTitleIds.map((value) =>
        canonical(value, "forbidden Title ID", 32));
    if (titleId !== DIAMONDS_CANARY_SANDBOX_TITLE_ID ||
        canaryPlayFabId !== DIAMONDS_CANARY_PLAYFAB_ID ||
        !forbiddenTitleIds.includes(DIAMONDS_CANARY_FORBIDDEN_PRODUCTION_TITLE_ID) ||
        forbiddenTitleIds.includes(titleId)) {
        throw coded(
            "DIAMONDS_CANARY_PAYMENT_TITLE_FORBIDDEN",
            "Diamonds canary payment is restricted to the certified Sandbox Title and player; Production must be forbidden.",
            400
        );
    }
    return Object.freeze({
        enabled: true,
        titleId,
        environment: "sandbox",
        canaryPlayFabId,
        canaryPlayFabIds: Object.freeze([canaryPlayFabId]),
        forbiddenTitleIds: Object.freeze(forbiddenTitleIds)
    });
}

function assertTargetCapabilities(targetExecutor) {
    if (typeof targetExecutor?.executeTrustedXsd2 !== "function") {
        throw new TypeError("Diamonds canary Target payment executor is absent.");
    }
    for (const capability of REQUIRED_TARGET_CAPABILITIES) {
        if (targetExecutor.capabilities?.[capability] !== true) {
            throw coded(
                "DIAMONDS_CANARY_PAYMENT_TARGET_UNSAFE",
                `Diamonds canary Target executor lacks ${capability}.`
            );
        }
    }
}

function assertReady(result, policy, playFabId) {
    if (!result || result.ready !== true || result.domain !== "Diamonds" ||
        result.titleId !== policy.titleId || result.playFabId !== playFabId ||
        result.certificateValid !== true || result.migrationProofValid !== true ||
        result.redisHealthy !== true || result.playFabHealthy !== true ||
        result.scannerForbiddenCount !== 0) {
        throw coded(
            "DIAMONDS_CANARY_PAYMENT_NOT_READY",
            "Diamonds canary certificate, migration proof, scanner or provider health is invalid."
        );
    }
}

// The certified stable operation inbox intentionally excludes provider time
// from idempotency identity. This must match server-economy-poc-stable-stores
// so the PlayFab companion proof attests the exact durable inbox operation.
function targetOperationHash(operation) {
    return serverEconomyPocDigest({
        schemaVersion: operation.schemaVersion,
        kind: operation.kind,
        playFabId: operation.playFabId,
        operationId: operation.operationId,
        eventId: operation.eventId,
        reason: operation.reason,
        diamonds: operation.diamonds,
        diamondsDelta: operation.diamondsDelta ?? null,
        contextHash: operation.contextHash ?? null,
        eliteBall: operation.eliteBall,
        premium: operation.premium
    });
}

function trustedTargetCommand(resolved, titleId) {
    const { operation, transaction, receipt, product } = resolved;
    if (!transaction.receiptId.startsWith("xsd2_") || product.productType !== "diamond_pack" ||
        operation.kind !== "xsolla_entitlement" || !Number.isSafeInteger(operation.diamonds) ||
        operation.diamonds <= 0 || operation.eliteBall !== 0 || operation.premium !== null) {
        throw coded(
            "DIAMONDS_CANARY_PAYMENT_NOT_DIAMOND_XSD2",
            "Only a trusted immutable xsd2 Diamond operation can enter Target.",
            400
        );
    }
    return Object.freeze({
        schemaVersion: 1,
        domain: "Diamonds",
        titleId,
        playFabId: transaction.playFabId,
        provider: "xsolla",
        providerTransactionId: transaction.providerTransactionId,
        receiptId: transaction.receiptId,
        sku: transaction.sku,
        quantity: receipt.quantity,
        currency: transaction.currency,
        amountMinor: transaction.amountMinor,
        productPlanVersion: transaction.planVersion,
        productPlanHash: product.planHash,
        operationId: operation.operationId,
        eventId: operation.eventId,
        operationHash: targetOperationHash(operation),
        delta: operation.diamonds,
        reason: operation.reason,
        effectiveAtUnixMs: operation.createdAtUnixMs
    });
}

function validateTargetResult(result, command) {
    const terminal = result?.status === "Applied" || result?.status === "AlreadyApplied";
    if (!terminal || result.authoritative !== true || result.providerConfirmed !== true ||
        result.transactionState !== "Completed" || result.playFabId !== command.playFabId ||
        result.operationId !== command.operationId || result.delta !== command.delta ||
        !Number.isSafeInteger(result.balance) || result.balance < 0 ||
        !Number.isSafeInteger(result.revision) || result.revision < 0 ||
        !Number.isSafeInteger(result.fencingEpoch) || result.fencingEpoch <= 0) {
        throw coded(
            "DIAMONDS_CANARY_PAYMENT_TARGET_RESULT_INVALID",
            "Diamonds canary Target did not return a durable authoritative terminal result."
        );
    }
    return result;
}

/**
 * Routes only an immutable xsd2 transaction for the single migrated Sandbox
 * canary to Target Diamonds. Every other user/product follows the existing
 * Shadow producer unchanged. The caller can supply only providerTransactionId;
 * identity and economics are rebuilt from ledger + receipt + plan.
 */
export function createDiamondsCanaryXsd2PaymentProducer({
    ledger,
    loadXsollaV2Receipt,
    shadowProducer,
    targetExecutor = null,
    verifyCanaryReadiness = null,
    policy
} = {}) {
    if (typeof ledger?.requireTransaction !== "function" ||
        typeof loadXsollaV2Receipt !== "function" ||
        (shadowProducer !== null && shadowProducer !== undefined &&
            (typeof shadowProducer?.projectTransaction !== "function" ||
                shadowProducer.authoritative !== false))) {
        throw new TypeError("Diamonds canary xsd2 router dependencies are incomplete.");
    }
    const normalizedPolicy = exactCanaryPolicy(policy);
    if (normalizedPolicy.enabled) {
        assertTargetCapabilities(targetExecutor);
        if (typeof verifyCanaryReadiness !== "function") {
            throw new TypeError("Diamonds canary readiness verifier is absent.");
        }
    }
    const resolver = normalizedPolicy.enabled
        ? createTrustedXsollaV2PaymentResolver({
            ledger,
            loadXsollaV2Receipt,
            expectedEnvironment: normalizedPolicy.environment,
            authorizeTransaction(transaction) {
                if (transaction.playFabId !== normalizedPolicy.canaryPlayFabId) {
                    throw coded(
                        "DIAMONDS_CANARY_PAYMENT_PLAYER_CHANGED",
                        "Trusted payment identity changed during canary routing.",
                        403
                    );
                }
            },
            allowedTransactionStates: new Set(["Pending", "Processing", "Completed", "Failed"])
        })
        : null;

    async function projectTransaction(input) {
        const id = strictInput(input);
        const routeEnvelope = await ledger.requireTransaction({
            provider: "xsolla",
            providerTransactionId: id
        });
        const targetSelected = normalizedPolicy.enabled &&
            routeEnvelope.playFabId === normalizedPolicy.canaryPlayFabId &&
            typeof routeEnvelope.receiptId === "string" && routeEnvelope.receiptId.startsWith("xsd2_");
        if (!targetSelected) {
            if (!shadowProducer) {
                return Object.freeze({
                    status: "not_projected",
                    route: "none",
                    authoritative: false,
                    requiresPlayerPresence: false
                });
            }
            const shadow = await shadowProducer.projectTransaction({ providerTransactionId: id });
            return Object.freeze({ ...shadow, route: "shadow", authoritative: false });
        }

        const resolved = await resolver.resolveTransaction({ providerTransactionId: id });
        const command = trustedTargetCommand(resolved, normalizedPolicy.titleId);
        const readiness = await verifyCanaryReadiness({
            domain: "Diamonds",
            titleId: normalizedPolicy.titleId,
            playFabId: command.playFabId,
            operationId: command.operationId,
            receiptId: command.receiptId,
            providerTransactionId: command.providerTransactionId
        });
        assertReady(readiness, normalizedPolicy, command.playFabId);
        const target = validateTargetResult(
            await targetExecutor.executeTrustedXsd2(command),
            command
        );
        await resolver.assertStillUnreversed(resolved);
        return Object.freeze({
            status: target.status === "AlreadyApplied" ? "already_applied" : "applied",
            route: "target_diamonds_canary",
            authoritative: true,
            requiresPlayerPresence: false,
            operation: resolved.operation,
            target
        });
    }

    return Object.freeze({
        projectTransaction,
        authoritative: normalizedPolicy.enabled ? "canary_only" : false,
        grantsLegacy: false,
        requiresPlayerPresence: false,
        policy: normalizedPolicy,
        source: "trusted_xsd2_target_or_existing_shadow"
    });
}
