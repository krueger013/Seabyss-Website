import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SANDBOX_TITLE_ID = "1D0C16";
export const PRODUCTION_TITLE_ID = "142853";
export const CANARY_PLAYFAB_ID = "61AD15CDA4137EA9";
export const CANARY_TITLE_PLAYER_ACCOUNT_ID = "714E7F12EDBEA385";

export const CERTIFICATION_GATES = Object.freeze([
    "ShopPurchasesEnabled",
    "SHOP_PURCHASES_ENABLED",
    "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED",
    "PURCHASES_STARTER_ENABLED",
    "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED",
    "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED",
    "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS",
    "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "XSOLLA_ENABLE_STANDALONE_PREMIUM_PRODUCTS",
    "PAYMENT_WORKER_ENABLED",
    "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_REVISION_CAS_ENABLED",
    "PLAYFAB_FINANCIAL_SERVER_OWNED_FIELDS_ENABLED",
    "PLAYFAB_FINANCIAL_REFRESH_ENABLED",
    "PLAYFAB_FINANCIAL_PROFILE_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED"
]);

const ENVIRONMENT = Object.freeze({
    titleId: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID",
    secretKey: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY",
    canaryPlayFabId: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_PLAYFAB_ID",
    redisUrl: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_URL",
    redisPrefix: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_PREFIX",
    isolatedRedis: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_REDIS_ISOLATED",
    mutationEnabled: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_MUTATION_ENABLED",
    runId: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_RUN_ID",
    providerTimeoutMs: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_PROVIDER_TIMEOUT_MS",
    workerTimeoutMs: "PLAYFAB_FINANCIAL_CAS_CERTIFICATION_WORKER_TIMEOUT_MS"
});

const FALSE_SWITCHES = new Set(["", "0", "false", "off", "no", "disabled"]);
const TRUE_SWITCHES = new Set(["1", "true", "on", "yes", "enabled"]);
const REDACTED = "[REDACTED]";
const FINANCIAL_STATE_OBJECT = "SeabyssEconomyStateV1";
const FINANCIAL_FENCE_OBJECT = "SeabyssEconomyFenceV1";
const FINANCIAL_PROOF_OBJECT = "SeabyssEconomyProofV1";
const FINANCIAL_AMMO_PROOF_OBJECT = "SeabyssEconomyAmmoProofV1";
const SAFE_PREFIX_ROOT = "seabyss:cert:financial:1d0c16:";
const WORKER_SCENARIOS = new Set(["raw-cas", "runtime-consume"]);
const WORKER_LEASE_TOKEN_ENV = "PLAYFAB_FINANCIAL_CAS_WORKER_LEASE_TOKEN";
const JOB_TTL_PADDING_MILLISECONDS = 10_000;
const VERSION_CONFLICT_NAMES = new Set(["EntityProfileVersionMismatch", "ConcurrentEditError"]);
const VERSION_CONFLICT_NUMBERS = new Set([1352, 1133]);
const RETRYABLE_PROVIDER_CODES = new Set([
    "APIRequestLimitExceeded",
    "DownstreamServiceUnavailable",
    "ServiceUnavailable"
]);
const PROVIDER_STATE_MAX_ATTEMPTS = 5;
const PROVIDER_RETRY_BASE_MILLISECONDS = 100;
const PROVIDER_RETRY_MAX_MILLISECONDS = 2_000;

function certificationError(code, message, details = undefined) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
}

function requiredString(value, name, maximum = 2048) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
        throw certificationError("CERT_INVALID_CONFIGURATION", `${name} is required.`);
    }
    return value.trim();
}

function boundedInteger(value, name, minimum, maximum, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    if (!/^\d+$/u.test(String(value))) {
        throw certificationError("CERT_INVALID_CONFIGURATION", `${name} must be an integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw certificationError("CERT_INVALID_CONFIGURATION", `${name} is outside its safe range.`);
    }
    return parsed;
}

function switchValue(value, name, { absent = false } = {}) {
    if (value === undefined || value === null) return absent;
    const normalized = String(value).trim().toLowerCase();
    if (TRUE_SWITCHES.has(normalized)) return true;
    if (FALSE_SWITCHES.has(normalized)) return false;
    throw certificationError("CERT_INVALID_SWITCH", `${name} must be an explicit boolean switch.`);
}

function safeIdentifier(value, name, maximum = 160) {
    const normalized = requiredString(value, name, maximum);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(normalized)) {
        throw certificationError("CERT_INVALID_IDENTIFIER", `${name} contains unsafe characters.`);
    }
    return normalized;
}

export function assertSandboxCertificationEnvironment(environment = process.env) {
    if (String(environment.NODE_ENV || "").trim().toLowerCase() === "production") {
        throw certificationError("CERT_PRODUCTION_ENVIRONMENT_REFUSED", "NODE_ENV=production is forbidden.");
    }
    const titleId = requiredString(environment[ENVIRONMENT.titleId], ENVIRONMENT.titleId, 64);
    if (titleId === PRODUCTION_TITLE_ID) {
        throw certificationError("CERT_PRODUCTION_TITLE_REFUSED", "Production Title 142853 is forbidden.");
    }
    if (titleId !== SANDBOX_TITLE_ID) {
        throw certificationError(
            "CERT_SANDBOX_TITLE_MISMATCH",
            `Only the dedicated Sandbox Title ${SANDBOX_TITLE_ID} is allowed.`
        );
    }
    const canary = requiredString(
        environment[ENVIRONMENT.canaryPlayFabId] || CANARY_PLAYFAB_ID,
        ENVIRONMENT.canaryPlayFabId,
        160
    );
    if (canary !== CANARY_PLAYFAB_ID) {
        throw certificationError("CERT_CANARY_MISMATCH", "Only the dedicated financial canary is allowed.");
    }
    for (const gate of CERTIFICATION_GATES) {
        if (switchValue(environment[gate], gate)) {
            throw certificationError("CERT_ACTIVE_GATE_REFUSED", `${gate} must remain false.`);
        }
    }
    const checkoutMode = String(environment.XSOLLA_CHECKOUT_MODE || "sandbox").trim().toLowerCase();
    if (checkoutMode !== "sandbox") {
        throw certificationError("CERT_PRODUCTION_CHECKOUT_MODE_REFUSED", "XSOLLA_CHECKOUT_MODE must remain sandbox.");
    }
    if (!switchValue(environment[ENVIRONMENT.isolatedRedis], ENVIRONMENT.isolatedRedis)) {
        throw certificationError("CERT_ISOLATED_REDIS_REQUIRED", "An explicitly isolated Redis is required.");
    }
    if (!switchValue(environment[ENVIRONMENT.mutationEnabled], ENVIRONMENT.mutationEnabled)) {
        throw certificationError(
            "CERT_MUTATION_OPT_IN_REQUIRED",
            "The dedicated Sandbox certification mutation opt-in is required."
        );
    }
    return Object.freeze({ titleId, canaryPlayFabId: canary });
}

function validateRedisUrl(value) {
    const raw = requiredString(value, ENVIRONMENT.redisUrl, 4096);
    let parsed;
    try { parsed = new URL(raw); } catch {
        throw certificationError("CERT_INVALID_REDIS_URL", "The certification Redis URL is invalid.");
    }
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) ||
        !new Set(["127.0.0.1", "localhost"]).has(parsed.hostname.toLowerCase())) {
        throw certificationError(
            "CERT_NON_LOOPBACK_REDIS_REFUSED",
            "Certification Redis must be isolated on 127.0.0.1 or localhost."
        );
    }
    return raw;
}

function defaultRunId() {
    return `run-${Date.now()}-${randomUUID().slice(0, 12)}`;
}

export function loadCertificationConfiguration(environment = process.env, { runId = null } = {}) {
    const identity = assertSandboxCertificationEnvironment(environment);
    const selectedRunId = safeIdentifier(
        runId || environment[ENVIRONMENT.runId] || defaultRunId(),
        ENVIRONMENT.runId,
        120
    );
    const prefix = requiredString(
        environment[ENVIRONMENT.redisPrefix] || `${SAFE_PREFIX_ROOT}${selectedRunId}:`,
        ENVIRONMENT.redisPrefix,
        200
    );
    if (!prefix.startsWith(SAFE_PREFIX_ROOT) || !prefix.endsWith(":")) {
        throw certificationError(
            "CERT_UNSAFE_REDIS_PREFIX",
            `Redis prefix must be isolated below ${SAFE_PREFIX_ROOT}.`
        );
    }
    if (!prefix.includes(`${selectedRunId}:`)) {
        throw certificationError("CERT_RUN_PREFIX_MISMATCH", "Redis prefix must contain the exact run id.");
    }
    return Object.freeze({
        ...identity,
        secretKey: requiredString(environment[ENVIRONMENT.secretKey], ENVIRONMENT.secretKey, 4096),
        redisUrl: validateRedisUrl(environment[ENVIRONMENT.redisUrl]),
        redisPrefix: prefix,
        runId: selectedRunId,
        providerTimeoutMs: boundedInteger(
            environment[ENVIRONMENT.providerTimeoutMs], ENVIRONMENT.providerTimeoutMs, 1_000, 30_000, 8_000
        ),
        workerTimeoutMs: boundedInteger(
            environment[ENVIRONMENT.workerTimeoutMs], ENVIRONMENT.workerTimeoutMs, 5_000, 120_000, 45_000
        ),
        leaseTtlMilliseconds: Math.min(300_000, Math.max(
            30_000,
            boundedInteger(environment[ENVIRONMENT.providerTimeoutMs], ENVIRONMENT.providerTimeoutMs, 1_000, 30_000, 8_000) * 8 + 10_000,
            boundedInteger(environment[ENVIRONMENT.workerTimeoutMs], ENVIRONMENT.workerTimeoutMs, 5_000, 120_000, 45_000) + 10_000
        )),
        claimTtlMilliseconds: Math.min(300_000, Math.max(
            30_000,
            boundedInteger(environment[ENVIRONMENT.providerTimeoutMs], ENVIRONMENT.providerTimeoutMs, 1_000, 30_000, 8_000) * 8 + 10_000,
            boundedInteger(environment[ENVIRONMENT.workerTimeoutMs], ENVIRONMENT.workerTimeoutMs, 5_000, 120_000, 45_000) + 10_000
        )),
        crashLeaseTtlMilliseconds: Math.min(300_000, Math.max(
            30_000,
            boundedInteger(environment[ENVIRONMENT.providerTimeoutMs], ENVIRONMENT.providerTimeoutMs, 1_000, 30_000, 8_000) * 4 + 5_000
        )),
        crashClaimTtlMilliseconds: Math.min(300_000, Math.max(
            30_000,
            boundedInteger(environment[ENVIRONMENT.providerTimeoutMs], ENVIRONMENT.providerTimeoutMs, 1_000, 30_000, 8_000) * 4 + 5_000
        )),
        shortLeaseTtlMilliseconds: 2_000,
        shortClaimTtlMilliseconds: 2_000
    });
}

export function summarizeCertificationConfiguration(configuration) {
    return Object.freeze({
        titleId: configuration.titleId,
        canaryPlayFabId: configuration.canaryPlayFabId,
        runId: configuration.runId,
        redisPrefix: configuration.redisPrefix,
        redisEndpoint: sanitizedRedisEndpoint(configuration.redisUrl),
        providerTimeoutMs: configuration.providerTimeoutMs,
        workerTimeoutMs: configuration.workerTimeoutMs,
        leaseTtlMilliseconds: configuration.leaseTtlMilliseconds,
        claimTtlMilliseconds: configuration.claimTtlMilliseconds,
        crashLeaseTtlMilliseconds: configuration.crashLeaseTtlMilliseconds,
        crashClaimTtlMilliseconds: configuration.crashClaimTtlMilliseconds,
        shortLeaseTtlMilliseconds: configuration.shortLeaseTtlMilliseconds,
        shortClaimTtlMilliseconds: configuration.shortClaimTtlMilliseconds,
        gates: Object.freeze(Object.fromEntries(CERTIFICATION_GATES.map((gate) => [gate, false]))),
        secretsLogged: false
    });
}

function sanitizedRedisEndpoint(redisUrl) {
    try {
        const parsed = new URL(redisUrl);
        const port = parsed.port ? `:${parsed.port}` : "";
        return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname || ""}`;
    } catch {
        return "invalid";
    }
}

function shouldRedactKey(key) {
    return /secret|token|ticket|authorization|password|credential|api[_-]?key|redisurl/iu.test(key);
}

export function redactCertificationValue(value, explicitSecrets = []) {
    const secrets = explicitSecrets.filter((entry) => typeof entry === "string" && entry.length > 0);
    const seen = new WeakSet();
    function redact(current, key = "") {
        if (shouldRedactKey(key)) return REDACTED;
        if (typeof current === "string") {
            let result = current;
            for (const secret of secrets) result = result.split(secret).join(REDACTED);
            return result;
        }
        if (current === null || typeof current !== "object") return current;
        if (seen.has(current)) return "[CIRCULAR]";
        seen.add(current);
        if (Array.isArray(current)) return current.map((entry) => redact(entry));
        return Object.fromEntries(Object.entries(current).map(([childKey, child]) => [
            childKey,
            redact(child, childKey)
        ]));
    }
    return redact(value);
}

function safeCodeValue(value, fallback = "CERT_UNEXPECTED_FAILURE") {
    if (Number.isSafeInteger(value)) return `PROVIDER_ERROR_${value}`;
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value) ? value : fallback;
}

function safeFailureCode(error) {
    return safeCodeValue(error?.code ?? error?.providerError ?? error?.providerErrorCode);
}

export function createCertificationFailureAggregate(entries) {
    if (!Array.isArray(entries) || entries.length < 2) {
        throw certificationError("CERT_FAILURE_AGGREGATE_INVALID", "At least two certification failures are required.");
    }
    const normalized = entries.map((entry) => {
        const stage = safeIdentifier(entry?.stage, "failure stage", 64);
        if (!entry?.error || typeof entry.error !== "object") {
            throw certificationError("CERT_FAILURE_AGGREGATE_INVALID", "A certification failure is missing.");
        }
        return Object.freeze({ stage, code: safeFailureCode(entry.error), error: entry.error });
    });
    const aggregate = certificationError(
        "CERT_PRIMARY_AND_CLEANUP_FAILURE",
        "Certification failed and one or more cleanup operations also failed."
    );
    aggregate.failures = Object.freeze(normalized.map(({ stage, code }) => Object.freeze({ stage, code })));
    aggregate.cause = normalized[0].error;
    return aggregate;
}

export function throwCertificationFailures(entries) {
    const failures = Array.isArray(entries) ? entries.filter((entry) => entry?.error) : [];
    if (failures.length === 0) return;
    if (failures.length === 1) throw failures[0].error;
    throw createCertificationFailureAggregate(failures);
}

export function safeCertificationError(error, explicitSecrets = []) {
    const failures = Array.isArray(error?.failures)
        ? error.failures.map((entry) => ({
            stage: safeIdentifier(entry?.stage, "failure stage", 64),
            code: safeCodeValue(entry?.code)
        }))
        : undefined;
    return redactCertificationValue({
        code: safeFailureCode(error),
        message: typeof error?.message === "string" ? error.message : "Certification failed.",
        status: Number.isSafeInteger(error?.status) ? error.status : undefined,
        providerCode: typeof error?.providerCode === "string" ? error.providerCode : undefined,
        providerErrorCode: Number.isSafeInteger(error?.providerErrorCode) ? error.providerErrorCode : undefined,
        providerFailureCode: typeof error?.providerFailureCode === "string"
            ? safeCodeValue(error.providerFailureCode) : undefined,
        failures
    }, explicitSecrets);
}

export function parsePlayFabProviderError({ status, payload } = {}) {
    const providerCode = typeof payload?.error === "string" ? payload.error : null;
    const providerErrorCode = Number.isSafeInteger(payload?.errorCode) ? payload.errorCode : null;
    const normalizedStatus = Number.isSafeInteger(status) ? status : null;
    const versionConflict = VERSION_CONFLICT_NAMES.has(providerCode) ||
        VERSION_CONFLICT_NUMBERS.has(providerErrorCode) ||
        VERSION_CONFLICT_NUMBERS.has(typeof payload?.error === "number" ? payload.error : null);
    return Object.freeze({
        status: normalizedStatus,
        providerCode,
        providerErrorCode,
        versionConflict,
        retryable: normalizedStatus === 429 || normalizedStatus >= 500 ||
            RETRYABLE_PROVIDER_CODES.has(providerCode),
        retryAfterSeconds: /^\d+$/u.test(String(payload?.retryAfterSeconds ?? ""))
            ? Number(payload.retryAfterSeconds) : null
    });
}

function injectedTimeout(phase) {
    const error = certificationError(
        phase === "before" ? "CERT_TIMEOUT_BEFORE_PROVIDER" : "CERT_TIMEOUT_AFTER_PROVIDER",
        `Injected certification timeout ${phase} PlayFab SetObjects.`
    );
    error.name = "AbortError";
    error.retryable = true;
    return error;
}

function setObjectNames(input, init) {
    const url = String(input?.url || input || "");
    if (!/\/Object\/SetObjects(?:\?|$)/u.test(url) || typeof init?.body !== "string") return [];
    try {
        const body = JSON.parse(init.body);
        return Array.isArray(body?.Objects)
            ? body.Objects.map((entry) => entry?.ObjectName).filter((entry) => typeof entry === "string")
            : [];
    } catch {
        return [];
    }
}

function financialStateWrite(input, init) {
    return setObjectNames(input, init).includes(FINANCIAL_STATE_OBJECT);
}

function financialStateMutation(input, init) {
    const names = setObjectNames(input, init);
    return names.includes(FINANCIAL_STATE_OBJECT) &&
        (names.includes(FINANCIAL_PROOF_OBJECT) || names.includes(FINANCIAL_AMMO_PROOF_OBJECT));
}

export function createPlayFabSetObjectsFaultController({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required.");
    let armed = null;
    let matchingCalls = 0;
    let injectedCalls = 0;

    function arm({ phase, occurrence = 1 } = {}) {
        if (!new Set(["before", "after"]).has(phase) ||
            !Number.isSafeInteger(occurrence) || occurrence <= 0) {
            throw certificationError("CERT_INVALID_FAULT_PLAN", "Fault phase/occurrence is invalid.");
        }
        armed = { phase, occurrence };
        matchingCalls = 0;
    }

    function disarm() { armed = null; }

    async function fetchWithFault(input, init) {
        const matches = financialStateMutation(input, init);
        if (matches) matchingCalls += 1;
        const inject = matches && armed !== null && matchingCalls === armed.occurrence;
        const phase = inject ? armed.phase : null;
        if (phase === "before") {
            injectedCalls += 1;
            armed = null;
            throw injectedTimeout("before");
        }
        const response = await fetchImpl(input, init);
        if (phase === "after") {
            injectedCalls += 1;
            armed = null;
            throw injectedTimeout("after");
        }
        return response;
    }

    return Object.freeze({
        fetch: fetchWithFault,
        arm,
        disarm,
        snapshot: () => Object.freeze({ matchingCalls, injectedCalls, armed: armed !== null })
    });
}

export function createPlayFabSetObjectsBarrierFetch({ fetchImpl = globalThis.fetch, arriveAndWait } = {}) {
    if (typeof fetchImpl !== "function" || typeof arriveAndWait !== "function") {
        throw new TypeError("Barrier fetch dependencies are required.");
    }
    return async function barrierFetch(input, init) {
        if (financialStateWrite(input, init)) await arriveAndWait();
        return fetchImpl(input, init);
    };
}

export function parseCertificationArguments(argv = process.argv.slice(2)) {
    if (!Array.isArray(argv) || argv.length === 0) {
        throw certificationError("CERT_USAGE", "Usage: orchestrator | worker <scenario> <job-key> <worker-id>.");
    }
    const [mode, scenario, jobKey, workerId, ...extra] = argv;
    if (mode === "orchestrator" && argv.length === 1) return Object.freeze({ mode });
    if (mode !== "worker" || extra.length > 0 || !WORKER_SCENARIOS.has(scenario)) {
        throw certificationError("CERT_USAGE", "Usage: orchestrator | worker <scenario> <job-key> <worker-id>.");
    }
    return Object.freeze({
        mode,
        scenario,
        jobKey: requiredString(jobKey, "job-key", 300),
        workerId: safeIdentifier(workerId, "worker-id", 120)
    });
}

export function parseWorkerOutput(output) {
    if (typeof output !== "string" || output.length === 0 || output.length > 128 * 1024) {
        throw certificationError("CERT_WORKER_PROTOCOL", "Worker output is missing or too large.");
    }
    const lines = output.trim().split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1) {
        throw certificationError("CERT_WORKER_PROTOCOL", "Worker must emit exactly one JSON result.");
    }
    let parsed;
    try { parsed = JSON.parse(lines[0]); } catch {
        throw certificationError("CERT_WORKER_PROTOCOL", "Worker result is invalid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        typeof parsed.workerId !== "string" || typeof parsed.status !== "string") {
        throw certificationError("CERT_WORKER_PROTOCOL", "Worker result schema is invalid.");
    }
    return Object.freeze(parsed);
}

function safeProviderDiagnosticCode(value) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647) {
        return `PROVIDER_ERROR_${value}`;
    }
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value) ? value : null;
}

function sanitizeProviderDiagnosticEntries(entries) {
    if (!Array.isArray(entries)) return Object.freeze([]);
    return Object.freeze(entries.slice(0, 5).map((entry, depth) => {
        const diagnostic = {
            depth,
            code: safeProviderDiagnosticCode(entry?.code),
            providerError: typeof entry?.providerError === "string" &&
                /^[A-Za-z0-9_.:-]{1,160}$/u.test(entry.providerError) ? entry.providerError : null,
            providerErrorCode: Number.isSafeInteger(entry?.providerErrorCode) &&
                entry.providerErrorCode >= 0 && entry.providerErrorCode <= 2_147_483_647
                ? entry.providerErrorCode : null,
            status: Number.isSafeInteger(entry?.status) && entry.status >= 100 && entry.status <= 599
                ? entry.status : null,
            retryAfterMilliseconds: Number.isSafeInteger(entry?.retryAfterMilliseconds) &&
                entry.retryAfterMilliseconds >= 0 && entry.retryAfterMilliseconds <= 300_000
                ? entry.retryAfterMilliseconds : null
        };
        if (entry?.rateLimitRetryExhausted === true) diagnostic.rateLimitRetryExhausted = true;
        if (entry?.rateLimitRetryRefused === true) diagnostic.rateLimitRetryRefused = true;
        if (Number.isSafeInteger(entry?.attempts) && entry.attempts >= 1 && entry.attempts <= 5) {
            diagnostic.attempts = entry.attempts;
        }
        return Object.freeze(diagnostic);
    }));
}

export function safeProviderCauseDiagnostics(error) {
    const entries = [];
    const seen = new Set();
    let current = error;
    while (current && typeof current === "object" && entries.length < 5 && !seen.has(current)) {
        seen.add(current);
        entries.push({
            code: current.code,
            providerError: current.providerError,
            providerErrorCode: current.providerErrorCode,
            status: current.status,
            retryAfterMilliseconds: current.retryAfterMilliseconds,
            rateLimitRetryExhausted: current.rateLimitRetryExhausted,
            rateLimitRetryRefused: current.rateLimitRetryRefused,
            attempts: current.attempts
        });
        current = current.cause;
    }
    return sanitizeProviderDiagnosticEntries(entries);
}

export function sanitizeWorkerDiagnostics(entries) {
    if (!Array.isArray(entries) || entries.length > 10) {
        throw certificationError("CERT_WORKER_DIAGNOSTIC_INVALID", "Worker diagnostics are invalid.");
    }
    const statuses = new Set([
        "applied", "already_acked", "recovered_after_snapshot", "rejected", "updated", "version_conflict"
    ]);
    return Object.freeze(entries.map((entry, index) => {
        const providerDiagnostics = sanitizeProviderDiagnosticEntries(entry?.providerDiagnostics);
        const diagnostic = {
            worker: index + 1,
            status: statuses.has(entry?.status) ? entry.status : "invalid",
            revision: Number.isSafeInteger(entry?.revision) && entry.revision >= 0 ? entry.revision : null,
            code: typeof entry?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(entry.code)
                ? entry.code : null
        };
        if (providerDiagnostics.length > 0) diagnostic.providerDiagnostics = providerDiagnostics;
        return Object.freeze(diagnostic);
    }));
}

const PREMIUM_TRANSIENT_REJECT_CODES = new Set([
    "POC_PLAYER_BUSY",
    "POC_OPERATION_BUSY",
    "POC_OPERATION_ORDER_BLOCKED",
    "POC_STALE_WRITER",
    "POC_STALE_INBOX_CLAIM",
    "POC_PLAYFAB_AMBIGUOUS_RESULT",
    "POC_PLAYFAB_FENCE_ACTIVATION_CONFLICT",
    "POC_SNAPSHOT_CAS_EXHAUSTED",
    "POC_INBOX_ACK_FAILED",
    "POC_REDIS_LEASE_UNAVAILABLE"
]);
const PREMIUM_SUCCESS_STATUSES = new Set(["applied", "already_acked", "recovered_after_snapshot"]);

function ambiguousProviderTransient(result) {
    const diagnostics = sanitizeProviderDiagnosticEntries(result?.providerDiagnostics);
    if (diagnostics.some((entry) =>
        entry.rateLimitRetryExhausted === true || entry.rateLimitRetryRefused === true)) {
        return false;
    }
    const statuses = diagnostics.map((entry) => entry.status).filter((status) => status !== null);
    return statuses.length === 0 || statuses.every((status) =>
        status === 408 || status === 429 || status >= 500);
}

function premiumTransientResult(result) {
    if (result?.status !== "rejected" || !PREMIUM_TRANSIENT_REJECT_CODES.has(result?.code)) return false;
    return result.code !== "POC_PLAYFAB_AMBIGUOUS_RESULT" || ambiguousProviderTransient(result);
}

function workerRetryDelayMilliseconds(result, attemptNumber, maximumDelayMilliseconds) {
    const hints = sanitizeProviderDiagnosticEntries(result?.providerDiagnostics)
        .map((entry) => entry.retryAfterMilliseconds)
        .filter((milliseconds) => milliseconds !== null);
    const providerDelay = hints.length > 0 ? Math.max(...hints) : 0;
    const backoff = Math.min(500, 100 * attemptNumber);
    return Math.min(maximumDelayMilliseconds, Math.max(backoff, providerDelay));
}

export async function convergePremiumWorkerRetries({
    name,
    attempt,
    maximumAttempts = 5,
    maximumDelayMilliseconds = 30_000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
    const safeName = safeIdentifier(name, "Premium retry name", 40);
    if (typeof attempt !== "function" || typeof sleep !== "function" ||
        !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 5 ||
        !Number.isSafeInteger(maximumDelayMilliseconds) ||
        maximumDelayMilliseconds < 100 || maximumDelayMilliseconds > 30_000) {
        throw certificationError("CERT_PREMIUM_RETRY_CONFIGURATION_INVALID", "Premium retry configuration is invalid.");
    }
    const attempts = [];
    for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
        const result = await attempt(attemptNumber);
        attempts.push(result);
        if (PREMIUM_SUCCESS_STATUSES.has(result?.status)) {
            return Object.freeze({
                name: safeName,
                converged: true,
                terminal: "success",
                attemptCount: attemptNumber,
                diagnostics: sanitizeWorkerDiagnostics(attempts)
            });
        }
        if (!premiumTransientResult(result)) {
            return Object.freeze({
                name: safeName,
                converged: false,
                terminal: "nontransient",
                attemptCount: attemptNumber,
                diagnostics: sanitizeWorkerDiagnostics(attempts)
            });
        }
        if (attemptNumber < maximumAttempts) {
            await sleep(workerRetryDelayMilliseconds(result, attemptNumber, maximumDelayMilliseconds));
        }
    }
    return Object.freeze({
        name: safeName,
        converged: false,
        terminal: "exhausted",
        attemptCount: maximumAttempts,
        diagnostics: sanitizeWorkerDiagnostics(attempts)
    });
}

function rawCasSnapshotPayloadHash(snapshot) {
    const payload = structuredClone(snapshot);
    delete payload.revision;
    delete payload.fencingEpoch;
    delete payload.updatedAtUnixMs;
    return providerStateHash(payload);
}

function rawCasRetryFailure(message, diagnostics) {
    const safeDiagnostics = Object.freeze(diagnostics.slice(0, 5));
    const error = certificationError(
        "CERT_RAW_CAS_RETRY_FAILED",
        `${message} ${JSON.stringify({ attempts: safeDiagnostics })}`
    );
    error.rawCasDiagnostics = safeDiagnostics;
    return error;
}

export async function convergeRawCasRetries({
    baseSnapshot,
    fencingEpoch,
    readSnapshot,
    renewLease,
    attempt,
    maximumAttempts = 5,
    maximumDelayMilliseconds = 30_000,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}) {
    if (!baseSnapshot || typeof baseSnapshot !== "object" ||
        baseSnapshot.playFabId !== CANARY_PLAYFAB_ID ||
        !Number.isSafeInteger(baseSnapshot.revision) || baseSnapshot.revision < 0 ||
        baseSnapshot.revision >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(baseSnapshot.updatedAtUnixMs) || baseSnapshot.updatedAtUnixMs < 0 ||
        baseSnapshot.updatedAtUnixMs >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(fencingEpoch) || fencingEpoch <= 0 ||
        baseSnapshot.fencingEpoch !== fencingEpoch ||
        typeof readSnapshot !== "function" || typeof renewLease !== "function" ||
        typeof attempt !== "function" || typeof sleep !== "function" ||
        !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 5 ||
        !Number.isSafeInteger(maximumDelayMilliseconds) ||
        maximumDelayMilliseconds < 100 || maximumDelayMilliseconds > 30_000) {
        throw certificationError("CERT_RAW_CAS_RETRY_CONFIGURATION_INVALID", "Raw CAS retry configuration is invalid.");
    }

    const base = Object.freeze(structuredClone(baseSnapshot));
    const baseHash = providerStateHash(base);
    const payloadHash = rawCasSnapshotPayloadHash(base);
    const target = Object.freeze({
        ...structuredClone(base),
        revision: base.revision + 1,
        fencingEpoch,
        updatedAtUnixMs: Math.max(Date.now(), base.updatedAtUnixMs + 1)
    });
    const targetHash = providerStateHash(target);
    const diagnostics = [];

    function appendFailureDiagnostic(error) {
        const diagnostic = sanitizeWorkerDiagnostics([{
            status: "rejected",
            revision: null,
            code: safeFailureCode(error),
            providerDiagnostics: safeProviderCauseDiagnostics(error)
        }])[0];
        diagnostics.push(diagnostic);
        return diagnostic;
    }

    function thrownProviderTransient(diagnostic) {
        if (diagnostic?.code === "CERT_WORKER_TIMEOUT" || diagnostic?.code === "CERT_WORKER_EXIT" ||
            /(?:PROTOCOL|CORRUPT|INTEGRITY|VERIFY|IDEMPOTENCY|NOT_FOUND|OVERFLOW|STALE)/u.test(diagnostic?.code || "")) {
            return false;
        }
        return Array.isArray(diagnostic?.providerDiagnostics) &&
            diagnostic.providerDiagnostics.length > 0 &&
            ambiguousProviderTransient({ providerDiagnostics: diagnostic.providerDiagnostics });
    }

    async function renewOrFail(attemptNumber, phase) {
        try {
            await renewLease({ attemptNumber, phase });
        } catch (error) {
            appendFailureDiagnostic(error);
            throw rawCasRetryFailure("Raw CAS retry could not renew the current lease.", diagnostics);
        }
    }

    async function waitForRetry(result, attemptNumber) {
        if (attemptNumber >= maximumAttempts) return;
        await renewOrFail(attemptNumber, "sleep");
        await sleep(workerRetryDelayMilliseconds(result, attemptNumber, maximumDelayMilliseconds));
    }

    for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
        await renewOrFail(attemptNumber, "read");

        let current;
        try {
            current = await readSnapshot();
        } catch (error) {
            const diagnostic = appendFailureDiagnostic(error);
            if (!thrownProviderTransient(diagnostic)) {
                throw rawCasRetryFailure("Raw CAS retry provider read failed nontransiently.", diagnostics);
            }
            await waitForRetry(diagnostic, attemptNumber);
            continue;
        }

        if (current?.playFabId !== CANARY_PLAYFAB_ID) {
            throw rawCasRetryFailure("Raw CAS retry observed a snapshot for another player.", diagnostics);
        }
        const currentHash = providerStateHash(current);
        if (currentHash === targetHash) {
            return Object.freeze({
                status: "recovered_after_ambiguous",
                attemptCount: attemptNumber - 1,
                diagnostics: Object.freeze(diagnostics),
                revisionAdvance: 1,
                economicDelta: 0,
                targetHash
            });
        }
        if (currentHash !== baseHash || rawCasSnapshotPayloadHash(current) !== payloadHash) {
            throw rawCasRetryFailure("Raw CAS retry observed a state outside its immutable intent.", diagnostics);
        }

        await renewOrFail(attemptNumber, "attempt");
        let result;
        try {
            result = await attempt({
                attemptNumber,
                currentSnapshot: current,
                nextSnapshot: target,
                targetHash
            });
        } catch (error) {
            const diagnostic = appendFailureDiagnostic(error);
            if (!thrownProviderTransient(diagnostic)) {
                throw rawCasRetryFailure("Raw CAS retry worker failed nontransiently.", diagnostics);
            }
            await waitForRetry(diagnostic, attemptNumber);
            continue;
        }
        diagnostics.push(sanitizeWorkerDiagnostics([result])[0]);

        let afterAttempt;
        try {
            afterAttempt = await readSnapshot();
        } catch (error) {
            const diagnostic = appendFailureDiagnostic(error);
            if (!thrownProviderTransient(diagnostic)) {
                throw rawCasRetryFailure("Raw CAS retry verification read failed nontransiently.", diagnostics);
            }
            await waitForRetry(diagnostic, attemptNumber);
            continue;
        }

        if (afterAttempt?.playFabId !== CANARY_PLAYFAB_ID) {
            throw rawCasRetryFailure("Raw CAS retry read another player after a write.", diagnostics);
        }
        const afterHash = providerStateHash(afterAttempt);
        if (afterHash === targetHash) {
            return Object.freeze({
                status: result.status === "updated" ? "updated" : "recovered_after_ambiguous",
                attemptCount: attemptNumber,
                diagnostics: Object.freeze(diagnostics),
                revisionAdvance: 1,
                economicDelta: 0,
                targetHash
            });
        }
        if (afterHash !== baseHash || rawCasSnapshotPayloadHash(afterAttempt) !== payloadHash) {
            throw rawCasRetryFailure("Raw CAS retry ended outside its immutable intent.", diagnostics);
        }

        const transient = result.status === "version_conflict" ||
            result.status === "rejected" &&
            result.code === "POC_PLAYFAB_AMBIGUOUS_RESULT" &&
            ambiguousProviderTransient(result);
        if (!transient || result.status === "updated") {
            throw rawCasRetryFailure("Raw CAS retry did not produce a safe transient outcome.", diagnostics);
        }
        await waitForRetry(result, attemptNumber);
    }
    throw rawCasRetryFailure("Raw CAS retry exhausted five bounded attempts.", diagnostics);
}

function premiumRetryDiagnostics(initialResults, bronze = null, gold = null) {
    return Object.freeze({
        initial: Object.freeze({
            bronze: sanitizeWorkerDiagnostics(initialResults.slice(0, 1)),
            gold: sanitizeWorkerDiagnostics(initialResults.slice(1, 2))
        }),
        ordered: Object.freeze({
            bronze: bronze?.diagnostics || Object.freeze([]),
            gold: gold?.diagnostics || Object.freeze([])
        })
    });
}

function premiumRetryFailure(code, message, initialResults, bronze = null, gold = null) {
    const diagnostics = premiumRetryDiagnostics(initialResults, bronze, gold);
    const error = certificationError(code, `${message} ${JSON.stringify(diagnostics)}`);
    error.premiumDiagnostics = diagnostics;
    return error;
}

async function runtimeModules() {
    const [redisPackage, profile, snapshot, observed, engine, redisStores, redisLeases, domain, proof, crashes] =
        await Promise.all([
            import("redis"),
            import("./src/playfab-financial-profile-store.js"),
            import("./src/server-economy-poc-playfab-snapshot-store.js"),
            import("./src/server-economy-poc-playfab-snapshot-store-observed.js"),
            import("./src/server-economy-poc-runtime-engine.js"),
            import("./src/server-economy-poc-redis-stores.js"),
            import("./src/server-economy-poc-redis-player-leases.js"),
            import("./src/server-economy-poc-domain-model.js"),
            import("./src/server-economy-poc-provider-proof.js"),
            import("./src/server-economy-poc-engine.js")
        ]);
    return { redisPackage, profile, snapshot, observed, engine, redisStores, redisLeases, domain, proof, crashes };
}

async function connectRedis(configuration, modules) {
    const client = modules.redisPackage.createClient({ url: configuration.redisUrl });
    let connectionError = null;
    client.on("error", (error) => { connectionError = error; });
    await client.connect();
    if (connectionError) throw connectionError;
    return client;
}

function requireAsyncFence(candidateLeases) {
    if (typeof candidateLeases?.assertCurrent !== "function") {
        throw certificationError(
            "CERT_REDIS_LEASE_ADAPTER_INCOMPLETE",
            "Redis player lease adapter must expose async assertCurrent."
        );
    }
    return (input) => candidateLeases.assertCurrent(input);
}

async function createRuntimeHarness(configuration, modules, redis, {
    workerId,
    hooks = {},
    faultController = null,
    barrier = null,
    leaseTtlMilliseconds = configuration.leaseTtlMilliseconds,
    claimTtlMilliseconds = configuration.claimTtlMilliseconds
} = {}) {
    for (const [name, value] of Object.entries({ leaseTtlMilliseconds, claimTtlMilliseconds })) {
        if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
            throw certificationError("CERT_RUNTIME_TTL_INVALID", `${name} is outside the safe runtime range.`);
        }
    }
    const baseFault = faultController || createPlayFabSetObjectsFaultController();
    const providerFetch = barrier
        ? createPlayFabSetObjectsBarrierFetch({
            fetchImpl: baseFault.fetch,
            arriveAndWait: () => redisBarrier(redis, barrier, configuration.workerTimeoutMs)
        })
        : baseFault.fetch;
    const playFab = modules.profile.createPlayFabFinancialProfileClient({
        titleId: configuration.titleId,
        secretKey: configuration.secretKey,
        fetchImpl: providerFetch,
        timeoutMs: configuration.providerTimeoutMs
    });
    const candidateLeases = modules.redisLeases.createRedisServerEconomyPocPlayerLeases({
        redis,
        prefix: configuration.redisPrefix,
        nowMilliseconds: () => Date.now()
    });
    const assertPlayerFence = requireAsyncFence(candidateLeases);
    const snapshotStore = modules.observed.createObservedServerEconomyPocPlayFabSnapshotStore({
        client: playFab,
        assertPlayerFence,
        nowMilliseconds: () => Date.now()
    });
    const playerLeases = modules.snapshot.createServerEconomyPocPlayFabFencedPlayerLeases({
        candidateLeases,
        snapshotStore
    });
    const walStore = modules.redisStores.createRedisCompatibleServerEconomyPocWalStore({
        redis,
        prefix: configuration.redisPrefix
    });
    const operationInbox = modules.redisStores.createRedisCompatibleServerEconomyPocOperationInbox({
        redis,
        prefix: configuration.redisPrefix,
        nowMilliseconds: () => Date.now(),
        assertPlayerFence
    });
    const runtime = modules.engine.createServerEconomyPocRuntimeEngine({
        snapshotStore,
        operationInbox,
        walStore,
        playerLeases,
        workerId: workerId || `cert-${configuration.runId}`,
        tokenFactory: () => randomUUID(),
        nowMilliseconds: () => Date.now(),
        leaseTtlMilliseconds,
        claimTtlMilliseconds,
        ammoBatchSize: 100,
        maximumCasAttempts: 8,
        hooks
    });
    return Object.freeze({
        runtime,
        snapshotStore,
        playerLeases,
        candidateLeases,
        operationInbox,
        walStore,
        playFab,
        faultController: baseFault
    });
}

function providerState(metadata) {
    return Object.freeze({
        snapshot: metadata.exists ? structuredClone(metadata.snapshot) : null,
        fence: metadata.fence ? structuredClone(metadata.fence) : null,
        highValueProof: metadata.highValueProof ? structuredClone(metadata.highValueProof) : null,
        ammoProof: metadata.ammoProof ? structuredClone(metadata.ammoProof) : null
    });
}

function canonicalProviderValue(value) {
    if (Array.isArray(value)) return value.map((entry) => canonicalProviderValue(entry));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalProviderValue(value[key])]));
}

function providerStateHash(state) {
    return createHash("sha256").update(JSON.stringify(canonicalProviderValue(state)), "utf8").digest("hex");
}

function providerWrites(state) {
    return [
        [FINANCIAL_STATE_OBJECT, state.snapshot],
        [FINANCIAL_FENCE_OBJECT, state.fence],
        [FINANCIAL_PROOF_OBJECT, state.highValueProof],
        [FINANCIAL_AMMO_PROOF_OBJECT, state.ammoProof]
    ].map(([ObjectName, value]) => value === null
        ? { ObjectName, DeleteObject: true }
        : { ObjectName, DataObject: structuredClone(value) });
}

function providerVersionConflict(error) {
    return VERSION_CONFLICT_NAMES.has(error?.code) ||
        VERSION_CONFLICT_NAMES.has(error?.providerError) ||
        VERSION_CONFLICT_NUMBERS.has(error?.code) ||
        VERSION_CONFLICT_NUMBERS.has(error?.providerErrorCode) ||
        error?.status === 409;
}

function providerRateLimitRetryTerminal(error, depth = 0, seen = new Set()) {
    if (!error || typeof error !== "object" || depth > 4 || seen.has(error)) return false;
    seen.add(error);
    return error.rateLimitRetryExhausted === true || error.rateLimitRetryRefused === true ||
        providerRateLimitRetryTerminal(error.cause, depth + 1, seen);
}

function providerRetryable(error, depth = 0) {
    if (depth === 0 && providerRateLimitRetryTerminal(error)) return false;
    if (!error || depth > 4) return false;
    const status = Number.isSafeInteger(error.status) ? error.status : null;
    const code = typeof error.code === "string" ? error.code : null;
    const providerCode = typeof error.providerError === "string"
        ? error.providerError
        : typeof error.providerCode === "string" ? error.providerCode : null;
    return providerVersionConflict(error) || error.retryable === true || error.name === "AbortError" ||
        status === 408 || status === 429 || status >= 500 ||
        code === "PLAYFAB_TIMEOUT" || code === "CERT_TIMEOUT_BEFORE_PROVIDER" ||
        code === "CERT_TIMEOUT_AFTER_PROVIDER" || RETRYABLE_PROVIDER_CODES.has(code) ||
        RETRYABLE_PROVIDER_CODES.has(providerCode) || providerRetryable(error.cause, depth + 1);
}

function providerRetryAfterMilliseconds(error, attempt, depth = 0) {
    if (error && depth <= 4) {
        if (Number.isSafeInteger(error.retryAfterMilliseconds) && error.retryAfterMilliseconds >= 0) {
            return Math.min(PROVIDER_RETRY_MAX_MILLISECONDS, error.retryAfterMilliseconds);
        }
        if (Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
            return Math.min(PROVIDER_RETRY_MAX_MILLISECONDS, error.retryAfterSeconds * 1_000);
        }
        const nested = providerRetryAfterMilliseconds(error.cause, attempt, depth + 1);
        if (nested !== null) return nested;
    }
    if (depth > 0) return null;
    return Math.min(
        PROVIDER_RETRY_MAX_MILLISECONDS,
        PROVIDER_RETRY_BASE_MILLISECONDS * (2 ** Math.max(0, attempt - 1))
    );
}

function providerStateFailure(code, message, cause) {
    const error = certificationError(code, message);
    error.cause = cause;
    error.providerFailureCode = safeFailureCode(cause);
    return error;
}

export async function providerEntityContext(playFab, playFabId) {
    const account = await playFab.getUserAccountInfo(playFabId);
    if (account?.UserInfo?.PlayFabId !== playFabId) {
        throw certificationError("CERT_CANARY_IDENTITY_MISMATCH", "PlayFab returned another legacy account.");
    }
    const entityId = requiredString(
        account?.UserInfo?.TitleInfo?.TitlePlayerAccount?.Id,
        "TitlePlayerAccount.Id",
        160
    );
    if (entityId !== CANARY_TITLE_PLAYER_ACCOUNT_ID) {
        throw certificationError(
            "CERT_CANARY_ENTITY_MISMATCH",
            "PlayFab returned another Title Player Account entity."
        );
    }
    const token = await playFab.getEntityToken();
    return Object.freeze({
        entity: Object.freeze({ Id: entityId, Type: "title_player_account" }),
        entityToken: requiredString(token?.EntityToken, "EntityToken", 8192)
    });
}

export async function writeProviderStateExact(harness, playFabId, intended, label, {
    maximumAttempts = PROVIDER_STATE_MAX_ATTEMPTS,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 10 ||
        typeof sleep !== "function") {
        throw certificationError("CERT_PROVIDER_RETRY_CONFIGURATION_INVALID", "Provider restore retry configuration is invalid.");
    }
    const intendedHash = providerStateHash(intended);
    let lastFailure = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        let current;
        try {
            current = await harness.snapshotStore.readWithMetadata(playFabId);
        } catch (error) {
            lastFailure = error;
            if (!providerRetryable(error)) {
                throw providerStateFailure(
                    "CERT_PROVIDER_STATE_READ_FAILED",
                    `${label} provider state could not be read safely.`,
                    error
                );
            }
            if (attempt < maximumAttempts) {
                await sleep(providerRetryAfterMilliseconds(error, attempt));
                continue;
            }
            break;
        }
        if (providerStateHash(providerState(current)) === intendedHash) {
            return Object.freeze({
                status: attempt === 1 ? `${label}_already_exact` : `${label}_recovered`,
                hash: intendedHash,
                attempts: attempt
            });
        }

        let mutationFailure = null;
        try {
            const context = await providerEntityContext(harness.playFab, playFabId);
            await harness.playFab.setObjects(
                context.entity,
                context.entityToken,
                current.objectVersion,
                providerWrites(intended)
            );
        } catch (error) {
            mutationFailure = error;
        }

        let verified = null;
        let verificationFailure = null;
        try {
            verified = await harness.snapshotStore.readWithMetadata(playFabId);
        } catch (error) {
            verificationFailure = error;
        }
        if (verified && providerStateHash(providerState(verified)) === intendedHash) {
            return Object.freeze({
                status: mutationFailure ? `${label}_recovered` : label,
                hash: intendedHash,
                attempts: attempt
            });
        }
        if (mutationFailure && !providerRetryable(mutationFailure)) {
            throw providerStateFailure(
                "CERT_PROVIDER_STATE_WRITE_REJECTED",
                `${label} provider write was rejected and did not reconcile.`,
                mutationFailure
            );
        }
        if (!mutationFailure && verificationFailure && !providerRetryable(verificationFailure)) {
            throw providerStateFailure(
                "CERT_PROVIDER_STATE_READ_FAILED",
                `${label} provider readback failed.`,
                verificationFailure
            );
        }
        lastFailure = mutationFailure || verificationFailure || certificationError(
            "CERT_PROVIDER_STATE_READBACK_MISMATCH",
            `${label} provider readback differs from the intended hash.`
        );
        if (attempt < maximumAttempts) {
            await sleep(providerRetryAfterMilliseconds(lastFailure, attempt));
        }
    }
    throw providerStateFailure(
        "CERT_PROVIDER_STATE_RETRY_EXHAUSTED",
        `${label} exhausted bounded provider reconciliation attempts.`,
        lastFailure
    );
}

export async function restoreProviderBaseline({ faultController, harness, playFabId, baselineState }) {
    if (typeof faultController?.disarm !== "function") {
        throw certificationError("CERT_FAULT_CONTROLLER_INVALID", "Provider fault controller cannot be disarmed.");
    }
    faultController.disarm();
    const evidence = await writeProviderStateExact(
        harness,
        playFabId,
        baselineState,
        "provider_baseline_restored"
    );
    return evidence;
}

export async function finalizeCertificationCleanup({ primaryFailure = null, restoreProvider, cleanupRedis }) {
    if (typeof restoreProvider !== "function" || typeof cleanupRedis !== "function") {
        throw certificationError("CERT_CLEANUP_CONFIGURATION_INVALID", "Certification cleanup callbacks are required.");
    }
    let restoreEvidence = null;
    let restoreFailure = null;
    let redisCleanupFailure = null;
    try { restoreEvidence = await restoreProvider(); } catch (error) { restoreFailure = error; }
    try { await cleanupRedis(); } catch (error) { redisCleanupFailure = error; }
    throwCertificationFailures([
        { stage: "primary", error: primaryFailure },
        { stage: "provider_restore", error: restoreFailure },
        { stage: "redis_cleanup", error: redisCleanupFailure }
    ]);
    return restoreEvidence;
}

async function cleanCertificationProviderState(harness, modules, playFabId) {
    const initial = modules.domain.createServerEconomyPocInitialSnapshot(playFabId, Date.now());
    const clean = Object.freeze({
        snapshot: initial,
        fence: null,
        highValueProof: null,
        ammoProof: null
    });
    return writeProviderStateExact(harness, playFabId, clean, "certification_baseline_installed");
}

async function cleanupRedisPrefix(redis, configuration) {
    if (!configuration.redisPrefix.startsWith(SAFE_PREFIX_ROOT) ||
        !configuration.redisPrefix.includes(`${configuration.runId}:`)) {
        throw certificationError("CERT_UNSAFE_REDIS_CLEANUP", "Redis cleanup prefix is not the exact certification run.");
    }
    let cursor = "0";
    let deleted = 0;
    do {
        const result = await redis.sendCommand([
            "SCAN", cursor, "MATCH", `${configuration.redisPrefix}*`, "COUNT", "100"
        ]);
        if (!Array.isArray(result) || !Array.isArray(result[1])) {
            throw certificationError("CERT_REDIS_CLEANUP_PROTOCOL", "Redis SCAN cleanup returned invalid data.");
        }
        cursor = String(result[0]);
        if (result[1].length > 0) {
            deleted += Number(await redis.sendCommand(["DEL", ...result[1]]) || 0);
        }
    } while (cursor !== "0");
    return deleted;
}
function highValueInput(configuration, suffix, {
    diamonds = 0,
    eliteBall = 0,
    premium = null,
    effectiveAtUnixMs = Date.now()
} = {}) {
    return Object.freeze({
        playFabId: configuration.canaryPlayFabId,
        operationId: `cert:${configuration.runId}:${suffix}`,
        eventId: `cert-event:${configuration.runId}:${suffix}`,
        diamonds,
        eliteBall,
        premium,
        reason: "sandbox_financial_cas_certification",
        effectiveAtUnixMs
    });
}

function expectedPremium(before, operation) {
    if (operation.premium === null) return before;
    const active = before.tier > 0 && before.expiresAtUnixMs > operation.effectiveAtUnixMs;
    return Object.freeze({
        tier: active ? Math.max(before.tier, Number(operation.premium.tier)) : Number(operation.premium.tier),
        activatedAtUnixMs: active ? before.activatedAtUnixMs : operation.effectiveAtUnixMs,
        expiresAtUnixMs: (active ? before.expiresAtUnixMs : operation.effectiveAtUnixMs) +
            operation.premium.durationSeconds * 1000
    });
}

async function expectCode(call, expectedCode) {
    try { await call(); } catch (error) {
        if (error?.code === expectedCode) return error;
        throw error;
    }
    throw certificationError("CERT_EXPECTED_FAILURE_ABSENT", `Expected ${expectedCode}.`);
}

async function redisBarrier(redis, barrier, timeoutMilliseconds) {
    await redis.sendCommand(["INCR", barrier.arrivedKey]);
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
        if (await redis.sendCommand(["GET", barrier.releaseKey]) === "go") return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw certificationError("CERT_BARRIER_TIMEOUT", "PlayFab CAS barrier timed out.");
}

async function waitForRedisCount(redis, key, expected, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
        if (Number(await redis.sendCommand(["GET", key]) || 0) >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw certificationError("CERT_BARRIER_TIMEOUT", "Workers did not reach the CAS barrier.");
}

function jobKey(configuration, suffix) {
    return `${configuration.redisPrefix}cert:job:${safeIdentifier(suffix, "job suffix", 120)}`;
}

function exactKeys(value, expected, code) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw certificationError(code, "Certification worker job schema is invalid.");
    }
}

function safeJobInteger(value, name, { positive = false } = {}) {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
        throw certificationError("CERT_JOB_BOUNDS_INVALID", `${name} is outside safe integer bounds.`);
    }
    return value;
}

function validateRawProof(proof, configuration, kind) {
    if (proof === null || proof === undefined) return null;
    if (proof.playFabId !== configuration.canaryPlayFabId) {
        throw certificationError("CERT_JOB_IDENTITY_MISMATCH", `${kind} proof belongs to another player.`);
    }
    if (kind === "high-value") {
        exactKeys(proof, ["schemaVersion", "playFabId", "sequence", "operationId", "eventId", "immutableHash"], "CERT_JOB_PROOF_INVALID");
        safeJobInteger(proof.sequence, "proof.sequence", { positive: true });
        if (!proof.operationId.startsWith(`cert:${configuration.runId}:`) ||
            !proof.eventId.startsWith(`cert-event:${configuration.runId}:`) ||
            !/^[a-f0-9]{64}$/u.test(proof.immutableHash)) {
            throw certificationError("CERT_JOB_PROOF_INVALID", "High-value proof identity is invalid.");
        }
    } else {
        exactKeys(proof, ["schemaVersion", "playFabId", "firstSequence", "throughSequence", "eventCount", "batchDigest"], "CERT_JOB_PROOF_INVALID");
        safeJobInteger(proof.firstSequence, "ammoProof.firstSequence", { positive: true });
        safeJobInteger(proof.throughSequence, "ammoProof.throughSequence", { positive: true });
        safeJobInteger(proof.eventCount, "ammoProof.eventCount", { positive: true });
        if (proof.throughSequence - proof.firstSequence + 1 !== proof.eventCount ||
            proof.eventCount > 500 || !/^[a-f0-9]{64}$/u.test(proof.batchDigest)) {
            throw certificationError("CERT_JOB_PROOF_INVALID", "Ammo proof range/digest is invalid.");
        }
    }
    return proof;
}

export function validateWorkerJob(job, configuration, scenario, nowUnixMs = Date.now()) {
    if (!WORKER_SCENARIOS.has(scenario)) {
        throw certificationError("CERT_JOB_SCENARIO_INVALID", "Worker job scenario is invalid.");
    }
    exactKeys(job, scenario === "raw-cas"
        ? ["schemaVersion", "runId", "playFabId", "expiresAtUnixMs", "barrier", "casInput"]
        : ["schemaVersion", "runId", "playFabId", "expiresAtUnixMs", "operationId"],
    "CERT_JOB_SCHEMA_INVALID");
    if (job.schemaVersion !== 1 || job.runId !== configuration.runId ||
        job.playFabId !== configuration.canaryPlayFabId) {
        throw certificationError("CERT_JOB_IDENTITY_MISMATCH", "Worker job identity is invalid.");
    }
    const expiresAt = safeJobInteger(job.expiresAtUnixMs, "expiresAtUnixMs", { positive: true });
    if (expiresAt <= nowUnixMs || expiresAt > nowUnixMs + configuration.workerTimeoutMs + JOB_TTL_PADDING_MILLISECONDS) {
        throw certificationError("CERT_JOB_EXPIRED", "Worker job TTL is invalid or expired.");
    }
    if (scenario === "runtime-consume") {
        if (typeof job.operationId !== "string" ||
            !job.operationId.startsWith(`cert:${configuration.runId}:`) || job.operationId.length > 200) {
            throw certificationError("CERT_JOB_OPERATION_INVALID", "Runtime operation id is outside the certification run.");
        }
        return Object.freeze(structuredClone(job));
    }
    exactKeys(job.barrier, ["arrivedKey", "releaseKey"], "CERT_JOB_BARRIER_INVALID");
    for (const key of [job.barrier.arrivedKey, job.barrier.releaseKey]) {
        if (typeof key !== "string" || !key.startsWith(`${configuration.redisPrefix}cert:barrier:`)) {
            throw certificationError("CERT_JOB_BARRIER_INVALID", "Raw CAS barrier is outside the certification prefix.");
        }
    }
    const cas = job.casInput;
    const allowedCasKeys = ["playFabId", "expectedRevision", "fencingEpoch", "nextSnapshot"];
    if (cas?.operationProof !== undefined) allowedCasKeys.push("operationProof");
    if (cas?.ammoProof !== undefined) allowedCasKeys.push("ammoProof");
    exactKeys(cas, allowedCasKeys, "CERT_JOB_CAS_INVALID");
    if (Object.hasOwn(cas, "leaseToken") || cas.playFabId !== configuration.canaryPlayFabId ||
        cas.nextSnapshot?.playFabId !== configuration.canaryPlayFabId) {
        throw certificationError("CERT_JOB_IDENTITY_MISMATCH", "Raw CAS job contains a foreign identity or durable lease token.");
    }
    const expectedRevision = safeJobInteger(cas.expectedRevision, "expectedRevision");
    const epoch = safeJobInteger(cas.fencingEpoch, "fencingEpoch", { positive: true });
    safeJobInteger(cas.nextSnapshot.revision, "nextSnapshot.revision", { positive: true });
    safeJobInteger(cas.nextSnapshot.fencingEpoch, "nextSnapshot.fencingEpoch", { positive: true });
    if (cas.nextSnapshot.revision !== expectedRevision + 1 || cas.nextSnapshot.fencingEpoch !== epoch) {
        throw certificationError("CERT_JOB_CAS_INVALID", "Raw CAS revision/fence transition is invalid.");
    }
    validateRawProof(cas.operationProof, configuration, "high-value");
    validateRawProof(cas.ammoProof, configuration, "ammo");
    return Object.freeze(structuredClone(job));
}

async function storeJob(redis, configuration, key, job, scenario) {
    const expiresAtUnixMs = Date.now() + configuration.workerTimeoutMs;
    const validated = validateWorkerJob({ ...job, expiresAtUnixMs }, configuration, scenario);
    await redis.sendCommand([
        "SET", key, JSON.stringify(validated), "PX",
        String(configuration.workerTimeoutMs + JOB_TTL_PADDING_MILLISECONDS)
    ]);
    return validated;
}

async function deleteRedisKeys(redis, keys) {
    const exact = [...new Set(keys.filter((key) => typeof key === "string" && key.length > 0))];
    if (exact.length > 0) await redis.sendCommand(["DEL", ...exact]);
}

async function loadJob(redis, configuration, key, scenario) {
    if (!key.startsWith(`${configuration.redisPrefix}cert:job:`)) {
        throw certificationError("CERT_UNSAFE_JOB_KEY", "Worker job is outside the certification prefix.");
    }
    const raw = await redis.sendCommand(["GET", key]);
    if (typeof raw !== "string" || raw.length > 256 * 1024) {
        throw certificationError("CERT_JOB_MISSING", "Worker job is missing or too large.");
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
        throw certificationError("CERT_JOB_CORRUPT", "Worker job contains invalid JSON.");
    }
    return validateWorkerJob(parsed, configuration, scenario);
}

function launchWorker(configuration, scenario, key, workerId, secretEnvironment = {}) {
    const script = fileURLToPath(import.meta.url);
    const environment = {
        ...process.env,
        ...secretEnvironment,
        [ENVIRONMENT.runId]: configuration.runId,
        [ENVIRONMENT.redisPrefix]: configuration.redisPrefix
    };
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, "worker", scenario, key, workerId], {
            env: environment,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        const limit = 128 * 1024;
        const timer = setTimeout(() => {
            child.kill();
            reject(certificationError("CERT_WORKER_TIMEOUT", `${workerId} timed out.`));
        }, configuration.workerTimeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
            if (stdout.length > limit) child.kill();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            if (stderr.length > limit) child.kill();
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(certificationError(
                    "CERT_WORKER_EXIT",
                    `${workerId} exited with code ${code}.`,
                    { stderrPresent: stderr.trim().length > 0 }
                ));
                return;
            }
            try { resolve(parseWorkerOutput(stdout)); } catch (error) { reject(error); }
        });
    });
}

async function workerMode(argumentsValue, configuration) {
    const modules = await runtimeModules();
    const redis = await connectRedis(configuration, modules);
    try {
        const job = await loadJob(redis, configuration, argumentsValue.jobKey, argumentsValue.scenario);
        const barrier = argumentsValue.scenario === "raw-cas" ? job.barrier : null;
        const harness = await createRuntimeHarness(configuration, modules, redis, {
            workerId: argumentsValue.workerId,
            barrier
        });
        try {
            let result;
            if (argumentsValue.scenario === "raw-cas") {
                const leaseToken = requiredString(process.env[WORKER_LEASE_TOKEN_ENV], WORKER_LEASE_TOKEN_ENV, 255);
                result = await harness.snapshotStore.compareAndSet({ ...job.casInput, leaseToken });
            } else {
                result = await harness.runtime.processHighValueOperation({
                    playFabId: configuration.canaryPlayFabId,
                    operationId: job.operationId,
                    consumer: "certification_worker"
                });
            }
            return Object.freeze({
                workerId: argumentsValue.workerId,
                status: result.status,
                revision: result.snapshot?.revision ?? null,
                code: null
            });
        } catch (error) {
            return Object.freeze({
                workerId: argumentsValue.workerId,
                status: "rejected",
                revision: null,
                code: typeof error?.code === "string" ? error.code : "CERT_WORKER_FAILURE",
                providerDiagnostics: safeProviderCauseDiagnostics(error)
            });
        }
    } finally {
        await redis.quit().catch(() => redis.disconnect());
    }
}

async function runtimeWorkerAttempt({ configuration, redis, operationId, suffix, workerId }) {
    const key = jobKey(configuration, suffix);
    await storeJob(redis, configuration, key, {
        schemaVersion: 1,
        runId: configuration.runId,
        playFabId: configuration.canaryPlayFabId,
        operationId
    }, "runtime-consume");
    try {
        return await launchWorker(configuration, "runtime-consume", key, workerId);
    } finally {
        await deleteRedisKeys(redis, [key]);
    }
}

async function multiprocessRuntimeScenario({ configuration, redis, harness, count, suffix, diamonds }) {
    const operation = highValueInput(configuration, suffix, { diamonds, effectiveAtUnixMs: Date.now() });
    await harness.runtime.enqueueAuthoritativeHighValueOperation(operation);
    const key = jobKey(configuration, `runtime-${count}`);
    await storeJob(redis, configuration, key, {
        schemaVersion: 1,
        runId: configuration.runId,
        playFabId: configuration.canaryPlayFabId,
        operationId: operation.operationId
    }, "runtime-consume");
    const before = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
    let results;
    try {
        results = await Promise.all(Array.from({ length: count }, (_, index) =>
            launchWorker(configuration, "runtime-consume", key, `runtime-${count}-${index + 1}`)));
    } finally {
        await deleteRedisKeys(redis, [key]);
    }
    const after = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
    if (after.diamonds - before.diamonds !== diamonds) {
        throw certificationError("CERT_MULTIPROCESS_DOUBLE_GRANT", `${count}-process grant delta is not exact.`);
    }
    const mutationWinners = results.filter((entry) => entry.status === "applied").length;
    if (mutationWinners !== 1 || results.some((entry) =>
        !new Set(["applied", "already_acked", "recovered_after_snapshot", "rejected"]).has(entry.status))) {
        throw certificationError("CERT_MULTIPROCESS_RESULT_INVALID", `${count}-process result is not fenced.`);
    }
    const rejectedCodes = results.filter((entry) => entry.status === "rejected").map((entry) => entry.code);
    if (rejectedCodes.some((code) => !new Set(["POC_PLAYER_BUSY", "POC_OPERATION_BUSY"]).has(code))) {
        throw certificationError("CERT_MULTIPROCESS_UNEXPECTED_REJECT", `${count}-process worker failed unexpectedly.`);
    }
    return Object.freeze({ processCount: count, mutationWinners, results, exactDelta: diamonds });
}
async function rawCasScenario({ configuration, redis, harness }) {
    const leaseToken = randomUUID();
    const leaseTtlMilliseconds = Math.min(300_000, Math.max(
        configuration.leaseTtlMilliseconds,
        configuration.workerTimeoutMs * 2
    ));
    const acquired = await harness.playerLeases.acquire({
        playFabId: configuration.canaryPlayFabId,
        owner: `raw-cas-${configuration.runId}`,
        token: leaseToken,
        ttlMilliseconds: leaseTtlMilliseconds
    });
    if (acquired?.status !== "acquired") {
        throw certificationError("CERT_RAW_CAS_LEASE_FAILED", "Raw CAS could not acquire the canary.");
    }
    const epoch = acquired.lease.epoch;
    const cleanupKeys = [];
    try {
        const current = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const candidates = [1, 2].map((offset) => ({
            playFabId: configuration.canaryPlayFabId,
            expectedRevision: current.revision,
            fencingEpoch: epoch,
            nextSnapshot: Object.freeze({
                ...structuredClone(current),
                revision: current.revision + 1,
                fencingEpoch: epoch,
                updatedAtUnixMs: Math.max(Date.now() + offset, current.updatedAtUnixMs + offset)
            })
        }));
        const barrier = {
            arrivedKey: `${configuration.redisPrefix}cert:barrier:raw-cas:arrived`,
            releaseKey: `${configuration.redisPrefix}cert:barrier:raw-cas:release`
        };
        cleanupKeys.push(barrier.arrivedKey, barrier.releaseKey);
        await deleteRedisKeys(redis, cleanupKeys);
        const launches = [];
        for (let index = 0; index < candidates.length; index += 1) {
            const key = jobKey(configuration, `raw-cas-${index + 1}`);
            cleanupKeys.push(key);
            await storeJob(redis, configuration, key, {
                schemaVersion: 1,
                runId: configuration.runId,
                playFabId: configuration.canaryPlayFabId,
                barrier,
                casInput: candidates[index]
            }, "raw-cas");
            launches.push(launchWorker(
                configuration,
                "raw-cas",
                key,
                `raw-cas-${index + 1}`,
                { [WORKER_LEASE_TOKEN_ENV]: leaseToken }
            ));
        }
        await waitForRedisCount(redis, barrier.arrivedKey, 2, configuration.workerTimeoutMs);
        await redis.sendCommand(["SET", barrier.releaseKey, "go", "PX", String(configuration.workerTimeoutMs)]);
        const firstRound = await Promise.all(launches);
        const winner = firstRound.find((entry) => entry.status === "updated");
        const loser = firstRound.find((entry) => entry.status === "version_conflict");
        const afterWinner = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (!winner || !loser || afterWinner.revision !== current.revision + 1 ||
            afterWinner.diamonds !== current.diamonds || afterWinner.eliteBall !== current.eliteBall) {
            throw certificationError("CERT_RAW_CAS_NOT_LINEARIZED", "Real PlayFab CAS did not select exactly one writer at N+1.");
        }

        const retry = await convergeRawCasRetries({
            baseSnapshot: afterWinner,
            fencingEpoch: epoch,
            readSnapshot: () => harness.runtime.readSnapshot(configuration.canaryPlayFabId),
            renewLease: () => harness.playerLeases.renew({
                playFabId: configuration.canaryPlayFabId,
                token: leaseToken,
                epoch,
                ttlMilliseconds: leaseTtlMilliseconds
            }),
            maximumDelayMilliseconds: Math.min(30_000, configuration.workerTimeoutMs),
            attempt: async ({ attemptNumber, currentSnapshot, nextSnapshot }) => {
                const suffix = `raw-cas-loser-retry-${attemptNumber}`;
                const retryBarrier = {
                    arrivedKey: `${configuration.redisPrefix}cert:barrier:${suffix}:arrived`,
                    releaseKey: `${configuration.redisPrefix}cert:barrier:${suffix}:release`
                };
                const retryKey = jobKey(configuration, suffix);
                cleanupKeys.push(retryBarrier.arrivedKey, retryBarrier.releaseKey, retryKey);
                await deleteRedisKeys(redis, [retryBarrier.arrivedKey, retryBarrier.releaseKey, retryKey]);
                await storeJob(redis, configuration, retryKey, {
                    schemaVersion: 1,
                    runId: configuration.runId,
                    playFabId: configuration.canaryPlayFabId,
                    barrier: retryBarrier,
                    casInput: {
                        playFabId: configuration.canaryPlayFabId,
                        expectedRevision: currentSnapshot.revision,
                        fencingEpoch: epoch,
                        nextSnapshot
                    }
                }, "raw-cas");
                await redis.sendCommand([
                    "SET", retryBarrier.releaseKey, "go", "PX", String(configuration.workerTimeoutMs)
                ]);
                return launchWorker(
                    configuration,
                    "raw-cas",
                    retryKey,
                    `${loser.workerId}-retry-${attemptNumber}`,
                    { [WORKER_LEASE_TOKEN_ENV]: leaseToken }
                );
            }
        });
        const afterRetry = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (afterRetry.revision !== current.revision + 2 ||
            afterRetry.fencingEpoch !== epoch ||
            rawCasSnapshotPayloadHash(afterRetry) !== rawCasSnapshotPayloadHash(current)) {
            throw rawCasRetryFailure(
                "CAS loser did not converge on the immutable N+2 provider snapshot.",
                retry.diagnostics
            );
        }
        return Object.freeze({
            processCount: 2,
            firstRound: sanitizeWorkerDiagnostics(firstRound),
            winner: winner.workerId,
            loser: loser.workerId,
            loserRetry: retry,
            economicDelta: 0,
            revisionAdvance: 2
        });
    } finally {
        await deleteRedisKeys(redis, cleanupKeys).catch(() => {});
        await harness.playerLeases.release({
            playFabId: configuration.canaryPlayFabId,
            token: leaseToken,
            epoch
        }).catch(() => {});
    }
}

async function leaseTakeoverScenario({ configuration, harness }) {
    const tokenA = randomUUID();
    const acquiredA = await harness.playerLeases.acquire({
        playFabId: configuration.canaryPlayFabId,
        owner: `takeover-a-${configuration.runId}`,
        token: tokenA,
        ttlMilliseconds: configuration.shortLeaseTtlMilliseconds
    });
    if (acquiredA?.status !== "acquired") {
        throw certificationError("CERT_TAKEOVER_LEASE_FAILED", "Lease A was not acquired.");
    }
    const epochA = acquiredA.lease.epoch;
    const snapshotA = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
    await new Promise((resolve) => setTimeout(resolve, configuration.shortLeaseTtlMilliseconds + 250));

    const tokenB = randomUUID();
    const acquiredB = await harness.playerLeases.acquire({
        playFabId: configuration.canaryPlayFabId,
        owner: `takeover-b-${configuration.runId}`,
        token: tokenB,
        ttlMilliseconds: configuration.leaseTtlMilliseconds
    });
    if (acquiredB?.status !== "acquired" || acquiredB.lease.epoch !== epochA + 1) {
        throw certificationError("CERT_TAKEOVER_EPOCH_INVALID", "Lease B did not receive exactly epoch A+1.");
    }
    const epochB = acquiredB.lease.epoch;
    try {
        const beforeB = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const bResult = await harness.snapshotStore.compareAndSet({
            playFabId: configuration.canaryPlayFabId,
            expectedRevision: beforeB.revision,
            leaseToken: tokenB,
            fencingEpoch: epochB,
            nextSnapshot: {
                ...structuredClone(beforeB),
                revision: beforeB.revision + 1,
                fencingEpoch: epochB,
                updatedAtUnixMs: Math.max(Date.now(), beforeB.updatedAtUnixMs + 1)
            }
        });
        if (bResult.status !== "updated") {
            throw certificationError("CERT_TAKEOVER_B_WRITE_FAILED", "Lease B did not publish after takeover.");
        }
        await expectCode(() => harness.snapshotStore.compareAndSet({
            playFabId: configuration.canaryPlayFabId,
            expectedRevision: snapshotA.revision,
            leaseToken: tokenA,
            fencingEpoch: epochA,
            nextSnapshot: {
                ...structuredClone(snapshotA),
                revision: snapshotA.revision + 1,
                fencingEpoch: epochA,
                updatedAtUnixMs: Math.max(Date.now(), snapshotA.updatedAtUnixMs + 1)
            }
        }), "POC_STALE_WRITER");
        const final = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (final.revision !== beforeB.revision + 1 || final.fencingEpoch !== epochB) {
            throw certificationError("CERT_TAKEOVER_FINAL_STATE_INVALID", "Stale A affected B's provider state.");
        }
        return Object.freeze({ epochA, epochB, staleARejected: true, bRevisionAdvance: 1 });
    } finally {
        await harness.playerLeases.release({
            playFabId: configuration.canaryPlayFabId,
            token: tokenB,
            epoch: epochB
        }).catch(() => {});
    }
}
async function orchestratorMode(configuration) {
    const modules = await runtimeModules();
    const redis = await connectRedis(configuration, modules);
    const faultController = createPlayFabSetObjectsFaultController();
    try {
        const harness = await createRuntimeHarness(configuration, modules, redis, {
            workerId: `orchestrator-${configuration.runId}`,
            faultController
        });
        await cleanupRedisPrefix(redis, configuration);
        const baselineMetadata = await harness.snapshotStore.readWithMetadata(configuration.canaryPlayFabId);
        const baselineState = providerState(baselineMetadata);
        const baselineHash = providerStateHash(baselineState);
        let result = null;
        let restoreEvidence = null;
        let primaryFailure = null;
        try {
            await cleanCertificationProviderState(harness, modules, configuration.canaryPlayFabId);
            const before = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
            const scenarios = {};

        const starterEffectiveAt = Date.now() - 60_000;
        const starter = highValueInput(configuration, "starter", {
            diamonds: 1_000,
            eliteBall: 13_000,
            premium: { tier: 1, durationSeconds: 86_400 },
            effectiveAtUnixMs: starterEffectiveAt
        });
        const submitted = await harness.runtime.enqueueAuthoritativeHighValueOperation(starter);
        const replay = await harness.runtime.enqueueAuthoritativeHighValueOperation(starter);
        const starterBefore = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        await harness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: starter.operationId,
            consumer: "certification_orchestrator"
        });
        const starterAfter = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const expectedStarterPremium = expectedPremium(starterBefore.premium, starter);
        if (submitted.status !== "submitted" || replay.status !== "existing" ||
            starterAfter.diamonds - starterBefore.diamonds !== 1_000 ||
            starterAfter.eliteBall - starterBefore.eliteBall !== 13_000 ||
            JSON.stringify(starterAfter.premium) !== JSON.stringify(expectedStarterPremium)) {
            throw certificationError("CERT_STARTER_PROJECTION_MISMATCH", "Starter projection is not exact.");
        }
        scenarios.replayAndStarter = { exact: true };

        const diamond = highValueInput(configuration, "diamond-500", {
            diamonds: 500,
            effectiveAtUnixMs: Date.now()
        });
        await harness.runtime.enqueueAuthoritativeHighValueOperation(diamond);
        const diamondPayloadReplay = await harness.runtime.enqueueAuthoritativeHighValueOperation(diamond);
        await expectCode(() => harness.runtime.enqueueAuthoritativeHighValueOperation({
            ...diamond,
            diamonds: 1_200
        }), "POC_OPERATION_IDEMPOTENCY_CONFLICT");
        const diamondBefore = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        await harness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: diamond.operationId,
            consumer: "certification_orchestrator"
        });
        const diamondAfter = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const diamondReplay = await harness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: diamond.operationId,
            consumer: "certification_orchestrator"
        });
        if (diamondPayloadReplay.status !== "existing" ||
            diamondAfter.diamonds - diamondBefore.diamonds !== 500 || diamondReplay.status !== "already_acked") {
            throw certificationError("CERT_DIAMOND_REPLAY_MISMATCH", "Diamond +500 replay is not exactly once.");
        }
        scenarios.diamonds = {
            exactDelta: 500,
            replay: diamondReplay.status,
            sameOperationPayload1200Rejected: true
        };

        const ammoBefore = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        for (let index = 0; index < 20; index += 1) {
            await harness.runtime.appendEliteBallDelta({
                playFabId: configuration.canaryPlayFabId,
                eventId: `cert-ammo:${configuration.runId}:${index + 1}`,
                delta: -1,
                reason: "sandbox_certification_shot"
            });
        }
        const firstAmmoReplay = await harness.runtime.appendEliteBallDelta({
            playFabId: configuration.canaryPlayFabId,
            eventId: `cert-ammo:${configuration.runId}:1`,
            delta: -1,
            reason: "sandbox_certification_shot"
        });
        await expectCode(() => harness.runtime.appendEliteBallDelta({
            playFabId: configuration.canaryPlayFabId,
            eventId: `cert-ammo:${configuration.runId}:1`,
            delta: -2,
            reason: "sandbox_certification_shot"
        }), "POC_WAL_IDEMPOTENCY_CONFLICT");
        const ammoFlush = await harness.runtime.flushEliteBall(configuration.canaryPlayFabId, { batchSize: 20 });
        const ammoAfter = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const emptyFlush = await harness.runtime.flushEliteBall(configuration.canaryPlayFabId, { batchSize: 20 });
        if (ammoAfter.eliteBall - ammoBefore.eliteBall !== -20 || ammoFlush.status !== "flushed" ||
            emptyFlush.status !== "empty" || firstAmmoReplay.status !== "existing") {
            throw certificationError("CERT_AMMO_BATCH_MISMATCH", "Elite batch/replay result is not exact.");
        }
        scenarios.elite = { eventCount: 20, exactDelta: -20, replay: firstAmmoReplay.status };

        const bronze = highValueInput(configuration, "bronze-extension", {
            premium: { tier: 1, durationSeconds: 3_600 },
            effectiveAtUnixMs: starterEffectiveAt + 1_000
        });
        const gold = highValueInput(configuration, "gold-upgrade", {
            premium: { tier: 3, durationSeconds: 3_600 },
            effectiveAtUnixMs: starterEffectiveAt + 2_000
        });
        const premiumBefore = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        await harness.runtime.enqueueAuthoritativeHighValueOperation(bronze);
        await harness.runtime.enqueueAuthoritativeHighValueOperation(gold);
        const bronzeKey = jobKey(configuration, "premium-bronze-concurrent");
        const goldKey = jobKey(configuration, "premium-gold-concurrent");
        await storeJob(redis, configuration, bronzeKey, {
            schemaVersion: 1,
            runId: configuration.runId,
            playFabId: configuration.canaryPlayFabId,
            operationId: bronze.operationId
        }, "runtime-consume");
        await storeJob(redis, configuration, goldKey, {
            schemaVersion: 1,
            runId: configuration.runId,
            playFabId: configuration.canaryPlayFabId,
            operationId: gold.operationId
        }, "runtime-consume");
        let premiumConcurrent;
        try {
            premiumConcurrent = await Promise.all([
                launchWorker(configuration, "runtime-consume", bronzeKey, "premium-bronze-concurrent"),
                launchWorker(configuration, "runtime-consume", goldKey, "premium-gold-concurrent")
            ]);
        } finally {
            await deleteRedisKeys(redis, [bronzeKey, goldKey]);
        }
        if (premiumConcurrent.some((entry) => entry.status === "rejected" &&
            !premiumTransientResult(entry))) {
            throw premiumRetryFailure(
                "CERT_PREMIUM_CONCURRENT_FAILURE",
                "Concurrent Premium worker failed unexpectedly.",
                premiumConcurrent
            );
        }
        const bronzeRetry = await convergePremiumWorkerRetries({
            name: "bronze",
            maximumDelayMilliseconds: Math.min(30_000, configuration.workerTimeoutMs),
            attempt: (attemptNumber) => runtimeWorkerAttempt({
                configuration,
                redis,
                operationId: bronze.operationId,
                suffix: `premium-bronze-ordered-retry-${attemptNumber}`,
                workerId: `premium-bronze-ordered-retry-${attemptNumber}`
            })
        });
        if (!bronzeRetry.converged) {
            throw premiumRetryFailure(
                "CERT_PREMIUM_ORDERED_RETRY_FAILED",
                "Ordered Premium Bronze retries did not converge.",
                premiumConcurrent,
                bronzeRetry
            );
        }
        const goldRetry = await convergePremiumWorkerRetries({
            name: "gold",
            maximumDelayMilliseconds: Math.min(30_000, configuration.workerTimeoutMs),
            attempt: (attemptNumber) => runtimeWorkerAttempt({
                configuration,
                redis,
                operationId: gold.operationId,
                suffix: `premium-gold-ordered-retry-${attemptNumber}`,
                workerId: `premium-gold-ordered-retry-${attemptNumber}`
            })
        });
        if (!goldRetry.converged) {
            throw premiumRetryFailure(
                "CERT_PREMIUM_ORDERED_RETRY_FAILED",
                "Ordered Premium Gold retries did not converge.",
                premiumConcurrent,
                bronzeRetry,
                goldRetry
            );
        }
        const premiumAfter = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const expectedBronze = expectedPremium(premiumBefore.premium, bronze);
        const expectedGold = expectedPremium(expectedBronze, gold);
        if (JSON.stringify(premiumAfter.premium) !== JSON.stringify(expectedGold)) {
            throw certificationError("CERT_PREMIUM_MISMATCH", "Premium delayed extension/upgrade is not deterministic.");
        }
        scenarios.premium = {
            deterministic: true,
            tier: premiumAfter.premium.tier,
            expiresAtUnixMs: premiumAfter.premium.expiresAtUnixMs,
            concurrentProcesses: 2,
            concurrentResults: premiumRetryDiagnostics(premiumConcurrent).initial,
            orderedRetry: Object.freeze({
                bronze: bronzeRetry.diagnostics,
                gold: goldRetry.diagnostics
            })
        };

        const afterTimeoutOperation = highValueInput(configuration, "timeout-after", {
            diamonds: 7,
            effectiveAtUnixMs: Date.now()
        });
        await harness.runtime.enqueueAuthoritativeHighValueOperation(afterTimeoutOperation);
        const timeoutAfterBefore = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        faultController.arm({ phase: "after" });
        const timeoutAfterResult = await harness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: afterTimeoutOperation.operationId,
            consumer: "certification_timeout_after"
        });
        const timeoutAfterSnapshot = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (timeoutAfterSnapshot.diamonds - timeoutAfterBefore.diamonds !== 7) {
            throw certificationError("CERT_TIMEOUT_AFTER_DOUBLE_GRANT", "Timeout-after recovery delta is not exact.");
        }
        scenarios.timeoutAfterProvider = { status: timeoutAfterResult.status, exactDelta: 7 };

        const beforeTimeoutOperation = highValueInput(configuration, "timeout-before", {
            diamonds: 11,
            effectiveAtUnixMs: Date.now()
        });
        await harness.runtime.enqueueAuthoritativeHighValueOperation(beforeTimeoutOperation);
        const timeoutBeforeSnapshot = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        faultController.arm({ phase: "before" });
        await expectCode(() => harness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: beforeTimeoutOperation.operationId,
            consumer: "certification_timeout_before"
        }), "POC_PLAYFAB_AMBIGUOUS_RESULT");
        const afterFailedBefore = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (afterFailedBefore.diamonds !== timeoutBeforeSnapshot.diamonds) {
            throw certificationError("CERT_TIMEOUT_BEFORE_MUTATED", "Timeout-before unexpectedly changed provider state.");
        }
        await harness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: beforeTimeoutOperation.operationId,
            consumer: "certification_timeout_before_retry"
        });
        const timeoutBeforeRecovered = await harness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (timeoutBeforeRecovered.diamonds - timeoutBeforeSnapshot.diamonds !== 11) {
            throw certificationError("CERT_TIMEOUT_BEFORE_RETRY_MISMATCH", "Timeout-before retry is not exact.");
        }
        scenarios.timeoutBeforeProvider = { firstMutation: false, retryExactDelta: 11 };

        let crashArmed = true;
        const crashHarness = await createRuntimeHarness(configuration, modules, redis, {
            workerId: `crash-${configuration.runId}`,
            leaseTtlMilliseconds: configuration.crashLeaseTtlMilliseconds,
            claimTtlMilliseconds: configuration.crashClaimTtlMilliseconds,
            hooks: {
                afterSnapshotCas({ domain: crashDomain }) {
                    if (crashDomain === "high_value" && crashArmed) {
                        crashArmed = false;
                        throw new modules.crashes.ServerEconomyPocSimulatedCrash("certification_after_snapshot_before_ack");
                    }
                }
            }
        });
        const crashOperation = highValueInput(configuration, "crash-after-cas", {
            diamonds: 13,
            effectiveAtUnixMs: Date.now()
        });
        await crashHarness.runtime.enqueueAuthoritativeHighValueOperation(crashOperation);
        const crashBefore = await crashHarness.runtime.readSnapshot(configuration.canaryPlayFabId);
        await expectCode(() => crashHarness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: crashOperation.operationId,
            consumer: "certification_crash"
        }), "POC_SIMULATED_CRASH");
        await new Promise((resolve) => setTimeout(resolve, configuration.crashLeaseTtlMilliseconds + 250));
        const recoveryHarness = await createRuntimeHarness(configuration, modules, redis, {
            workerId: `recovery-${configuration.runId}`
        });
        const recovered = await recoveryHarness.runtime.processHighValueOperation({
            playFabId: configuration.canaryPlayFabId,
            operationId: crashOperation.operationId,
            consumer: "certification_crash_recovery"
        });
        const crashAfter = await recoveryHarness.runtime.readSnapshot(configuration.canaryPlayFabId);
        if (crashAfter.diamonds - crashBefore.diamonds !== 13 || recovered.status !== "recovered_after_snapshot") {
            throw certificationError("CERT_CRASH_RECOVERY_MISMATCH", "Crash recovery was not exactly once.");
        }
        scenarios.crashAfterCas = { recovered: true, exactDelta: 13 };

        scenarios.multiProcess2 = await multiprocessRuntimeScenario({
            configuration, redis, harness: recoveryHarness, count: 2, suffix: "multiprocess-2", diamonds: 17
        });
        scenarios.multiProcess10 = await multiprocessRuntimeScenario({
            configuration, redis, harness: recoveryHarness, count: 10, suffix: "multiprocess-10", diamonds: 19
        });
        scenarios.leaseTakeover = await leaseTakeoverScenario({
            configuration, harness: recoveryHarness
        });
        scenarios.rawProviderCas = await rawCasScenario({
            configuration, redis, harness: recoveryHarness
        });

        const after = await recoveryHarness.runtime.readSnapshot(configuration.canaryPlayFabId);
        const metadata = await recoveryHarness.snapshotStore.readWithMetadata(configuration.canaryPlayFabId);
            result = Object.freeze({
                verdict: "PLAYFAB_FINANCIAL_CAS_FENCING_CERTIFICATION_PASS",
            configuration: summarizeCertificationConfiguration(configuration),
            scenarios,
            before,
            after,
            providerProfileVersion: metadata.objectVersion,
            playFabHttpMetrics: recoveryHarness.snapshotStore.httpMetricsSnapshot(),
                redisEvidenceRetained: false,
                legacyMutated: false,
                purchasesEnabled: false
            });
        } catch (error) {
            primaryFailure = error;
        } finally {
            restoreEvidence = await finalizeCertificationCleanup({
                primaryFailure,
                restoreProvider: () => restoreProviderBaseline({
                    faultController,
                    harness,
                    playFabId: configuration.canaryPlayFabId,
                    baselineState
                }),
                cleanupRedis: () => cleanupRedisPrefix(redis, configuration)
            });
        }
        return Object.freeze({
            ...result,
            cleanup: Object.freeze({
                providerBaselineHashBefore: baselineHash,
                providerBaselineHashAfter: restoreEvidence.hash,
                providerObjectsRestored: true,
                fenceAndProofsDeletedWhenAbsentInBaseline: true,
                redisRunPrefixDeleted: true
            })
        });
    } finally {
        await redis.quit().catch(() => redis.disconnect());
    }
}

async function main() {
    let configuration = null;
    try {
        const argumentsValue = parseCertificationArguments();
        configuration = loadCertificationConfiguration(process.env);
        const result = argumentsValue.mode === "worker"
            ? await workerMode(argumentsValue, configuration)
            : await orchestratorMode(configuration);
        process.stdout.write(`${JSON.stringify(redactCertificationValue(result, [
            configuration.secretKey,
            configuration.redisUrl
        ]))}\n`);
    } catch (error) {
        const secrets = configuration ? [configuration.secretKey, configuration.redisUrl] : [];
        process.stdout.write(`${JSON.stringify({
            verdict: "PLAYFAB_FINANCIAL_CAS_FENCING_CERTIFICATION_FAIL",
            error: safeCertificationError(error, secrets)
        })}\n`);
        process.exitCode = 1;
    }
}

const isMain = process.argv[1] && pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href === import.meta.url;
if (isMain) await main();
