const CLASSIFICATIONS = Object.freeze({
    APPLIED: "APPLIED",
    NOT_APPLIED: "NOT_APPLIED",
    PROOF_MISMATCH: "PROOF_MISMATCH",
    STALE_WRITER: "STALE_WRITER",
    UNKNOWN: "UNKNOWN"
});

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive safe integer.`);
    }
    return value;
}

function errorChain(error) {
    const values = [];
    const seen = new Set();
    let current = error;
    while (current && typeof current === "object" && !seen.has(current) && values.length < 8) {
        values.push(current);
        seen.add(current);
        current = current.cause;
    }
    return values;
}

function hasCode(chain, values) {
    return chain.some((entry) => values.has(entry.code) || values.has(entry.providerError));
}

function hasClassification(chain, value) {
    return chain.some((entry) => entry.classification === value ||
        entry.providerReconciliationClassification === value);
}

function retryAfterMilliseconds(chain) {
    return chain.reduce((maximum, entry) => Number.isSafeInteger(entry.retryAfterMilliseconds) &&
        entry.retryAfterMilliseconds > 0 ? Math.max(maximum, entry.retryAfterMilliseconds) : maximum, 0);
}

export function classifyServerEconomyPocProviderFailure(error) {
    const chain = errorChain(error);
    const retryAfter = retryAfterMilliseconds(chain);
    if (hasClassification(chain, CLASSIFICATIONS.PROOF_MISMATCH) || hasCode(chain, new Set([
        "POC_PROVIDER_PROOF_MISMATCH",
        "DIAMONDS_MIGRATION_PROOF_MISMATCH"
    ]))) {
        return Object.freeze({
            classification: CLASSIFICATIONS.PROOF_MISMATCH,
            retryable: false,
            manualReview: true,
            requiresNewLease: false,
            retryAfterMilliseconds: 0
        });
    }
    if (hasClassification(chain, CLASSIFICATIONS.UNKNOWN) ||
        hasCode(chain, new Set(["POC_PLAYFAB_AMBIGUOUS_RESULT"]))) {
        return Object.freeze({
            classification: CLASSIFICATIONS.UNKNOWN,
            retryable: false,
            manualReview: true,
            requiresNewLease: false,
            retryAfterMilliseconds: 0
        });
    }
    if (hasClassification(chain, CLASSIFICATIONS.NOT_APPLIED) ||
        hasCode(chain, new Set(["POC_PLAYFAB_NOT_APPLIED"]))) {
        const overLimit = chain.some((entry) => entry.providerErrorCode === 1214 ||
            entry.code === "OverLimit" || entry.providerError === "OverLimit");
        return Object.freeze({
            classification: CLASSIFICATIONS.NOT_APPLIED,
            providerCondition: overLimit ? "OVERLIMIT" : "UNCHANGED_READBACK",
            retryable: true,
            manualReview: false,
            requiresNewLease: true,
            retryAfterMilliseconds: retryAfter
        });
    }
    if (hasCode(chain, new Set(["POC_STALE_WRITER"]))) {
        return Object.freeze({
            classification: CLASSIFICATIONS.STALE_WRITER,
            retryable: true,
            manualReview: false,
            requiresNewLease: true,
            retryAfterMilliseconds: retryAfter
        });
    }
    if (hasClassification(chain, CLASSIFICATIONS.APPLIED)) {
        return Object.freeze({
            classification: CLASSIFICATIONS.APPLIED,
            retryable: false,
            manualReview: false,
            requiresNewLease: false,
            retryAfterMilliseconds: 0
        });
    }
    return Object.freeze({
        classification: CLASSIFICATIONS.UNKNOWN,
        retryable: false,
        manualReview: true,
        requiresNewLease: false,
        retryAfterMilliseconds: 0
    });
}

export function computeServerEconomyPocProviderRetryBackoff({
    attempt,
    baseMilliseconds,
    maximumMilliseconds,
    jitterRatio = 0.2,
    randomValue = 0.5,
    retryAfterMilliseconds: providerDelay = 0
} = {}) {
    positiveInteger(attempt, "retry attempt");
    positiveInteger(baseMilliseconds, "retry backoff base");
    positiveInteger(maximumMilliseconds, "retry backoff maximum");
    if (baseMilliseconds > maximumMilliseconds || typeof jitterRatio !== "number" ||
        !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1 ||
        typeof randomValue !== "number" || !Number.isFinite(randomValue) ||
        randomValue < 0 || randomValue > 1 || !Number.isSafeInteger(providerDelay) || providerDelay < 0) {
        throw new TypeError("Provider retry backoff is invalid.");
    }
    const exponent = Math.min(attempt - 1, 52);
    const exponential = Math.min(maximumMilliseconds, baseMilliseconds * (2 ** exponent));
    const factor = 1 - jitterRatio + (2 * jitterRatio * randomValue);
    const jittered = Math.max(1, Math.min(maximumMilliseconds, Math.round(exponential * factor)));
    return Math.max(jittered, Math.min(maximumMilliseconds, providerDelay));
}

export const SERVER_ECONOMY_POC_PROVIDER_RETRY_CLASSIFICATIONS = CLASSIFICATIONS;
