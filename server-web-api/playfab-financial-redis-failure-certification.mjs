import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SANDBOX_TITLE_ID = "1D0C16";
export const PRODUCTION_TITLE_ID = "142853";
export const CANARY_PLAYFAB_ID = "61AD15CDA4137EA9";
export const CANARY_ENTITY_ID = "714E7F12EDBEA385";
export const REDIS_FAILURE_PORT = 63879;
export const REDIS_FAILURE_PREFIX = "seabyss:cert:financial:1d0c16:redis-failure:v1:";

export const REDIS_FAILURE_GATES = Object.freeze([
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
    "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED",
    "PAYMENT_WORKER_ENABLED",
    "PLAYFAB_FINANCIAL_PROFILE_ENABLED",
    "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS",
    "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "XSOLLA_ENABLE_STANDALONE_PREMIUM_PRODUCTS"
]);

const ENV = Object.freeze({
    titleId: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID",
    secretKey: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY",
    canaryPlayFabId: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_PLAYFAB_ID",
    canaryEntityId: "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_CANARY_ENTITY_ID",
    redisUrl: "PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_URL",
    redisPrefix: "PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_PREFIX",
    isolatedRedis: "PLAYFAB_FINANCIAL_REDIS_FAILURE_REDIS_ISOLATED",
    mutationEnabled: "PLAYFAB_FINANCIAL_REDIS_FAILURE_MUTATION_ENABLED",
    pauseMilliseconds: "PLAYFAB_FINANCIAL_REDIS_FAILURE_PAUSE_MS",
    jobTtlSeconds: "PLAYFAB_FINANCIAL_REDIS_FAILURE_JOB_TTL_SECONDS",
    providerTimeoutMilliseconds: "PLAYFAB_FINANCIAL_REDIS_FAILURE_PROVIDER_TIMEOUT_MS"
});

const TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE = new Set(["", "0", "false", "no", "off", "disabled"]);
const PAUSE_POINTS = new Set(["none", "after_claim", "after_provider"]);
const MINIMUM_RECOVERY_TTL_MILLISECONDS = 30_000;
const MAXIMUM_RECOVERY_TTL_MILLISECONDS = 300_000;
const RECOVERY_PROVIDER_CALL_BUDGET = 8;
const SCENARIOS = Object.freeze({
    "diamonds-500": Object.freeze({ diamonds: 500, eliteBall: 0, premium: null }),
    "elite-13000": Object.freeze({ diamonds: 0, eliteBall: 13_000, premium: null }),
    "premium-bronze": Object.freeze({
        diamonds: 0,
        eliteBall: 0,
        premium: Object.freeze({ tier: 1, durationSeconds: 3_600 })
    })
});
const SCENARIO_ALIASES = Object.freeze({
    diamonds: "diamonds-500",
    elite: "elite-13000",
    premium: "premium-bronze"
});

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function required(value, name, maximum = 4096) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
        throw failure("REDIS_FAILURE_INVALID_CONFIGURATION", `${name} is required.`);
    }
    return value.trim();
}

function identifier(value, name, maximum = 200) {
    const normalized = required(value, name, maximum);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(normalized)) {
        throw failure("REDIS_FAILURE_INVALID_IDENTIFIER", `${name} is invalid.`);
    }
    return normalized;
}

function integer(value, name, minimum, maximum, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    if (!/^\d+$/u.test(String(value))) {
        throw failure("REDIS_FAILURE_INVALID_CONFIGURATION", `${name} must be an integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw failure("REDIS_FAILURE_INVALID_CONFIGURATION", `${name} is outside its safe range.`);
    }
    return parsed;
}

function enabled(value, name, { missing = false } = {}) {
    if (value === undefined || value === null) return missing;
    const normalized = String(value).trim().toLowerCase();
    if (TRUE.has(normalized)) return true;
    if (FALSE.has(normalized)) return false;
    throw failure("REDIS_FAILURE_INVALID_SWITCH", `${name} must be an explicit boolean switch.`);
}

function exactKeys(value, keys, name) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
        throw failure("REDIS_FAILURE_JOB_CORRUPT", `${name} schema is invalid.`);
    }
    return value;
}

function digest(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshotDigest(snapshot) {
    return digest(JSON.stringify(snapshot));
}

export function hashEphemeralClaimToken(rawToken) {
    return digest(`seabyss-redis-failure-claim-v1:${required(rawToken, "claim token", 255)}`);
}

export function normalizeRedisFailureScenario(value) {
    const scenario = required(value, "scenario", 40).toLowerCase();
    const normalized = SCENARIO_ALIASES[scenario] || scenario;
    if (!Object.hasOwn(SCENARIOS, normalized)) {
        throw failure("REDIS_FAILURE_UNKNOWN_SCENARIO", "Scenario must be diamonds, elite, or premium.");
    }
    return normalized;
}

function validateRedisUrl(value) {
    const raw = required(value, ENV.redisUrl, 2048);
    let parsed;
    try { parsed = new URL(raw); } catch {
        throw failure("REDIS_FAILURE_UNSAFE_REDIS", "Redis URL is invalid.");
    }
    const pathName = parsed.pathname === "" ? "/" : parsed.pathname;
    if (parsed.protocol !== "redis:" || parsed.hostname !== "127.0.0.1" ||
        Number(parsed.port) !== REDIS_FAILURE_PORT || !new Set(["/", "/0"]).has(pathName) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw failure(
            "REDIS_FAILURE_UNSAFE_REDIS",
            `Only unauthenticated loopback Redis 127.0.0.1:${REDIS_FAILURE_PORT} database 0 is allowed.`
        );
    }
    return raw;
}

export function loadRedisFailureConfiguration(environment = process.env) {
    if (String(environment.NODE_ENV || "").trim().toLowerCase() === "production") {
        throw failure("REDIS_FAILURE_PRODUCTION_ENVIRONMENT_REFUSED", "NODE_ENV=production is forbidden.");
    }
    const titleId = required(environment[ENV.titleId], ENV.titleId, 64);
    if (titleId === PRODUCTION_TITLE_ID) {
        throw failure("REDIS_FAILURE_PRODUCTION_TITLE_REFUSED", "Production Title 142853 is forbidden.");
    }
    if (titleId !== SANDBOX_TITLE_ID) {
        throw failure("REDIS_FAILURE_SANDBOX_TITLE_MISMATCH", `Only Sandbox Title ${SANDBOX_TITLE_ID} is allowed.`);
    }
    const playFabId = required(environment[ENV.canaryPlayFabId] || CANARY_PLAYFAB_ID, ENV.canaryPlayFabId, 160);
    const entityId = required(environment[ENV.canaryEntityId] || CANARY_ENTITY_ID, ENV.canaryEntityId, 160);
    if (playFabId !== CANARY_PLAYFAB_ID || entityId !== CANARY_ENTITY_ID) {
        throw failure("REDIS_FAILURE_CANARY_MISMATCH", "Only the dedicated Sandbox canary is allowed.");
    }
    for (const gate of REDIS_FAILURE_GATES) {
        if (enabled(environment[gate], gate)) {
            throw failure("REDIS_FAILURE_ACTIVE_GATE_REFUSED", `${gate} must remain false.`);
        }
    }
    if (String(environment.XSOLLA_CHECKOUT_MODE || "").trim().toLowerCase() === "production") {
        throw failure(
            "REDIS_FAILURE_PRODUCTION_CHECKOUT_MODE_REFUSED",
            "XSOLLA_CHECKOUT_MODE=production is forbidden."
        );
    }
    if (!enabled(environment[ENV.isolatedRedis], ENV.isolatedRedis)) {
        throw failure("REDIS_FAILURE_ISOLATED_REDIS_REQUIRED", "The Redis instance must be explicitly isolated.");
    }
    if (!enabled(environment[ENV.mutationEnabled], ENV.mutationEnabled)) {
        throw failure("REDIS_FAILURE_MUTATION_OPT_IN_REQUIRED", "The Sandbox-only mutation opt-in is required.");
    }
    const redisPrefix = required(environment[ENV.redisPrefix] || REDIS_FAILURE_PREFIX, ENV.redisPrefix, 200);
    if (redisPrefix !== REDIS_FAILURE_PREFIX) {
        throw failure("REDIS_FAILURE_UNSAFE_PREFIX", `Redis prefix must exactly equal ${REDIS_FAILURE_PREFIX}`);
    }
    return Object.freeze({
        titleId,
        secretKey: required(environment[ENV.secretKey], ENV.secretKey, 4096),
        playFabId,
        entityId,
        redisUrl: validateRedisUrl(environment[ENV.redisUrl] || `redis://127.0.0.1:${REDIS_FAILURE_PORT}/0`),
        redisPrefix,
        pauseMilliseconds: integer(environment[ENV.pauseMilliseconds], ENV.pauseMilliseconds, 1_000, 120_000, 30_000),
        jobTtlMilliseconds: integer(environment[ENV.jobTtlSeconds], ENV.jobTtlSeconds, 300, 86_400, 3_600) * 1_000,
        providerTimeoutMilliseconds: integer(
            environment[ENV.providerTimeoutMilliseconds], ENV.providerTimeoutMilliseconds, 1_000, 30_000, 8_000
        ),
        leaseTtlMilliseconds: 2_000,
        claimTtlMilliseconds: 2_000
    });
}

export function selectRedisFailureRuntimeTtls(configuration, pausePoint = "none") {
    if (!PAUSE_POINTS.has(pausePoint)) {
        throw failure("REDIS_FAILURE_INVALID_PAUSE", "Runtime TTL selection received an invalid pause point.");
    }
    const controlledLeaseTtl = integer(
        configuration?.leaseTtlMilliseconds, "leaseTtlMilliseconds", 1_000, 300_000, null
    );
    const controlledClaimTtl = integer(
        configuration?.claimTtlMilliseconds, "claimTtlMilliseconds", 1_000, 300_000, null
    );
    if (pausePoint !== "none") {
        return Object.freeze({
            mode: "controlled_expiration",
            leaseTtlMilliseconds: controlledLeaseTtl,
            claimTtlMilliseconds: controlledClaimTtl
        });
    }
    const providerTimeout = integer(
        configuration?.providerTimeoutMilliseconds, "providerTimeoutMilliseconds", 1_000, 30_000, null
    );
    const recoveryTtl = Math.min(MAXIMUM_RECOVERY_TTL_MILLISECONDS, Math.max(
        MINIMUM_RECOVERY_TTL_MILLISECONDS, providerTimeout * RECOVERY_PROVIDER_CALL_BUDGET
    ));
    return Object.freeze({ mode: "normal_or_recovery", leaseTtlMilliseconds: recoveryTtl,
        claimTtlMilliseconds: recoveryTtl });
}

export function parseRedisFailureArguments(argv = process.argv.slice(2)) {
    if (!Array.isArray(argv) || argv.length < 2) {
        throw failure("REDIS_FAILURE_INVALID_ARGUMENTS", "Usage: prepare <scenario> | process <operationId> <pausePoint> | read <operationId>.");
    }
    const mode = String(argv[0] || "").toLowerCase();
    if (mode === "prepare" && argv.length === 2) {
        return Object.freeze({ mode, scenario: normalizeRedisFailureScenario(argv[1]) });
    }
    if (mode === "process" && argv.length === 3) {
        const operationId = identifier(argv[1], "operationId", 200);
        if (!operationId.startsWith("cert:redis-failure:")) {
            throw failure("REDIS_FAILURE_INVALID_OPERATION", "operationId is outside the certification namespace.");
        }
        const pausePoint = String(argv[2] || "").toLowerCase();
        if (!PAUSE_POINTS.has(pausePoint)) {
            throw failure("REDIS_FAILURE_INVALID_PAUSE", "pausePoint must be none, after_claim, or after_provider.");
        }
        return Object.freeze({ mode, operationId, pausePoint });
    }
    if (mode === "read" && argv.length === 2) {
        const operationId = identifier(argv[1], "operationId", 200);
        if (!operationId.startsWith("cert:redis-failure:")) {
            throw failure("REDIS_FAILURE_INVALID_OPERATION", "operationId is outside the certification namespace.");
        }
        return Object.freeze({ mode, operationId });
    }
    throw failure("REDIS_FAILURE_INVALID_ARGUMENTS", "Usage: prepare <scenario> | process <operationId> <pausePoint> | read <operationId>.");
}

export function createRedisFailurePauseMarker({
    pausePoint,
    operationId,
    scenario,
    ownerId,
    leaseEpoch,
    claimEpoch = null,
    revision = null,
    leaseExpiresAtUnixMs,
    boundedPauseMilliseconds
} = {}) {
    if (!new Set(["after_claim", "after_provider"]).has(pausePoint)) {
        throw failure("REDIS_FAILURE_INVALID_PAUSE", "A marker requires after_claim or after_provider.");
    }
    const optionalPositive = (value, name) => value === null
        ? null
        : integer(value, name, 1, Number.MAX_SAFE_INTEGER, null);
    return Object.freeze({
        schemaVersion: 1,
        type: "redis_failure_pause",
        pausePoint,
        titleId: SANDBOX_TITLE_ID,
        playFabId: CANARY_PLAYFAB_ID,
        operationId: identifier(operationId, "operationId", 200),
        scenario: normalizeRedisFailureScenario(scenario),
        ownerId: identifier(ownerId, "ownerId", 160),
        leaseEpoch: optionalPositive(leaseEpoch, "leaseEpoch"),
        claimEpoch: optionalPositive(claimEpoch, "claimEpoch"),
        revision: revision === null ? null : integer(revision, "revision", 0, Number.MAX_SAFE_INTEGER, null),
        leaseExpiresAtUnixMs: integer(
            leaseExpiresAtUnixMs, "leaseExpiresAtUnixMs", 0, Number.MAX_SAFE_INTEGER, null
        ),
        boundedPauseMilliseconds: integer(
            boundedPauseMilliseconds, "boundedPauseMilliseconds", 1_000, 120_000, null
        ),
        tokensLogged: false
    });
}

export async function emitRedisFailurePause(marker, {
    writeLine = (line) => process.stdout.write(`${line}\n`),
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
    if (typeof writeLine !== "function" || typeof wait !== "function") {
        throw new TypeError("Pause marker dependencies are invalid.");
    }
    const line = JSON.stringify(marker);
    writeLine(line);
    await wait(marker.boundedPauseMilliseconds);
    return marker;
}

function jobKey(configuration, operationId) {
    return `${configuration.redisPrefix}job:${digest(identifier(operationId, "operationId", 200))}`;
}

function createJob({ configuration, scenario, operation, before, nowUnixMs }) {
    return Object.freeze({
        schemaVersion: 1,
        identity: Object.freeze({
            titleId: configuration.titleId,
            playFabId: configuration.playFabId,
            entityId: configuration.entityId
        }),
        operation: Object.freeze({
            operationId: operation.operationId,
            eventId: operation.eventId,
            immutableHash: operation.immutableHash,
            scenario
        }),
        before: Object.freeze({
            profileVersion: before.objectVersion,
            revision: before.snapshot.revision,
            fencingEpoch: before.snapshot.fencingEpoch,
            payloadHash: snapshotDigest(before.snapshot)
        }),
        createdAtUnixMs: nowUnixMs,
        expiresAtUnixMs: nowUnixMs + configuration.jobTtlMilliseconds
    });
}

export function validateRedisFailureJob(value, { configuration, operationId, nowUnixMs = Date.now() } = {}) {
    const job = exactKeys(value, [
        "schemaVersion", "identity", "operation", "before", "createdAtUnixMs", "expiresAtUnixMs"
    ], "job");
    if (job.schemaVersion !== 1) throw failure("REDIS_FAILURE_JOB_CORRUPT", "Job version is invalid.");
    exactKeys(job.identity, ["titleId", "playFabId", "entityId"], "job.identity");
    exactKeys(job.operation, ["operationId", "eventId", "immutableHash", "scenario"], "job.operation");
    exactKeys(job.before, ["profileVersion", "revision", "fencingEpoch", "payloadHash"], "job.before");
    if (job.identity.titleId !== SANDBOX_TITLE_ID || job.identity.playFabId !== CANARY_PLAYFAB_ID ||
        job.identity.entityId !== CANARY_ENTITY_ID ||
        job.identity.titleId !== configuration.titleId || job.identity.playFabId !== configuration.playFabId ||
        job.identity.entityId !== configuration.entityId) {
        throw failure("REDIS_FAILURE_JOB_IDENTITY_MISMATCH", "Nested job identity is invalid.");
    }
    const scenario = normalizeRedisFailureScenario(job.operation.scenario);
    const expectedOperationPrefix = `cert:redis-failure:${scenario}:`;
    const expectedEventId = job.operation.operationId.replace(
        /^cert:redis-failure:/u,
        "cert-event:redis-failure:"
    );
    if (job.operation.operationId !== operationId ||
        !job.operation.operationId.startsWith(expectedOperationPrefix) ||
        identifier(job.operation.eventId, "job.operation.eventId", 200) !== expectedEventId ||
        !/^[a-f0-9]{64}$/u.test(job.operation.immutableHash) ||
        scenario !== job.operation.scenario) {
        throw failure("REDIS_FAILURE_JOB_IDENTITY_MISMATCH", "Nested operation identity is invalid.");
    }
    for (const [field, minimum] of [["profileVersion", 0], ["revision", 0], ["fencingEpoch", 0]]) {
        if (!Number.isSafeInteger(job.before[field]) || job.before[field] < minimum) {
            throw failure("REDIS_FAILURE_JOB_CORRUPT", `job.before.${field} is invalid.`);
        }
    }
    if (!/^[a-f0-9]{64}$/u.test(job.before.payloadHash) ||
        !Number.isSafeInteger(job.createdAtUnixMs) || job.createdAtUnixMs < 0 ||
        !Number.isSafeInteger(job.expiresAtUnixMs) || job.expiresAtUnixMs <= job.createdAtUnixMs ||
        job.expiresAtUnixMs - job.createdAtUnixMs > configuration.jobTtlMilliseconds ||
        nowUnixMs >= job.expiresAtUnixMs) {
        throw failure("REDIS_FAILURE_JOB_EXPIRED_OR_CORRUPT", "Job TTL or proof is invalid.");
    }
    return Object.freeze(structuredClone(job));
}

function secureOperationInbox(base) {
    return Object.freeze({
        submit: (input) => base.submit(input),
        get: (playFabId, operationId) => base.get(playFabId, operationId),
        scanAfter: (input) => base.scanAfter(input),
        listPlayersWithPending: (input) => base.listPlayersWithPending(input),
        claim: (input) => base.claim({ ...input, token: hashEphemeralClaimToken(input.token) }),
        ack: (input) => base.ack({ ...input, claimToken: hashEphemeralClaimToken(input.claimToken) }),
        releaseClaim: (input) => base.releaseClaim({
            ...input,
            claimToken: hashEphemeralClaimToken(input.claimToken)
        }),
        durable: true,
        redisCompatible: true,
        claimTokensHashedAtRest: true
    });
}

async function runtimeModules() {
    const [redisPackage, profile, snapshot, observed, engine, redisStores, redisLeases] = await Promise.all([
        import("redis"),
        import("./src/playfab-financial-profile-store.js"),
        import("./src/server-economy-poc-playfab-snapshot-store.js"),
        import("./src/server-economy-poc-playfab-snapshot-store-observed.js"),
        import("./src/server-economy-poc-runtime-engine.js"),
        import("./src/server-economy-poc-redis-stores.js"),
        import("./src/server-economy-poc-redis-player-leases.js")
    ]);
    return { redisPackage, profile, snapshot, observed, engine, redisStores, redisLeases };
}

async function connectRedis(configuration, modules) {
    const redis = modules.redisPackage.createClient({ url: configuration.redisUrl });
    let connectionError = null;
    redis.on("error", (error) => { connectionError = error; });
    await redis.connect();
    if (connectionError) throw connectionError;
    if (await redis.sendCommand(["PING"]) !== "PONG") {
        throw failure("REDIS_FAILURE_PING_FAILED", "Isolated Redis did not return PONG.");
    }
    return redis;
}

async function createRuntime(configuration, modules, redis, { pausePoint = "none", scenario, operationId } = {}) {
    const runtimeTtls = selectRedisFailureRuntimeTtls(configuration, pausePoint);
    const playFab = modules.profile.createPlayFabFinancialProfileClient({
        titleId: configuration.titleId,
        secretKey: configuration.secretKey,
        timeoutMs: configuration.providerTimeoutMilliseconds
    });
    const candidateLeases = modules.redisLeases.createRedisServerEconomyPocPlayerLeases({
        redis,
        prefix: configuration.redisPrefix,
        nowMilliseconds: () => Date.now()
    });
    const assertPlayerFence = (input) => candidateLeases.assertCurrent(input);
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
    const rawInbox = modules.redisStores.createRedisCompatibleServerEconomyPocOperationInbox({
        redis,
        prefix: configuration.redisPrefix,
        nowMilliseconds: () => Date.now(),
        assertPlayerFence
    });
    const operationInbox = secureOperationInbox(rawInbox);
    const ownerId = `redis-failure-${process.pid}`;
    let paused = false;
    async function pause(markerPoint, evidence) {
        if (paused || pausePoint !== markerPoint) return;
        paused = true;
        await emitRedisFailurePause(createRedisFailurePauseMarker({
            pausePoint: markerPoint,
            operationId,
            scenario,
            ownerId,
            leaseEpoch: evidence.leaseEpoch,
            claimEpoch: evidence.claimEpoch ?? null,
            revision: evidence.revision ?? null,
            leaseExpiresAtUnixMs: Date.now() + runtimeTtls.leaseTtlMilliseconds,
            boundedPauseMilliseconds: configuration.pauseMilliseconds
        }));
    }
    const runtime = modules.engine.createServerEconomyPocRuntimeEngine({
        snapshotStore,
        operationInbox,
        walStore,
        playerLeases,
        workerId: ownerId,
        tokenFactory: () => randomUUID(),
        nowMilliseconds: () => Date.now(),
        leaseTtlMilliseconds: runtimeTtls.leaseTtlMilliseconds,
        claimTtlMilliseconds: runtimeTtls.claimTtlMilliseconds,
        maximumCasAttempts: 8,
        hooks: {
            afterInboxClaim: ({ lease, claim }) => pause("after_claim", {
                leaseEpoch: lease.epoch,
                claimEpoch: claim.claimEpoch
            }),
            afterSnapshotCas: ({ domain, snapshot: next }) => {
                if (domain !== "high_value") return undefined;
                return pause("after_provider", {
                    leaseEpoch: next.fencingEpoch,
                    revision: next.revision
                });
            }
        }
    });
    return Object.freeze({ runtime, snapshotStore, playerLeases, operationInbox, walStore, rawInbox,
        runtimeTtls });
}

async function storeJob(redis, configuration, job) {
    const key = jobKey(configuration, job.operation.operationId);
    const result = await redis.sendCommand([
        "SET", key, JSON.stringify(job), "PX", String(configuration.jobTtlMilliseconds), "NX"
    ]);
    if (result !== "OK") throw failure("REDIS_FAILURE_JOB_CONFLICT", "Certification job already exists.");
    return key;
}

async function loadJob(redis, configuration, operationId) {
    const raw = await redis.sendCommand(["GET", jobKey(configuration, operationId)]);
    if (typeof raw !== "string" || raw.length > 64 * 1024) {
        throw failure("REDIS_FAILURE_JOB_MISSING", "Certification job is missing or expired.");
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
        throw failure("REDIS_FAILURE_JOB_CORRUPT", "Certification job contains invalid JSON.");
    }
    return validateRedisFailureJob(parsed, { configuration, operationId });
}

function scenarioInput(configuration, scenario) {
    const suffix = randomUUID();
    const values = SCENARIOS[scenario];
    const now = Date.now();
    return Object.freeze({
        playFabId: configuration.playFabId,
        operationId: `cert:redis-failure:${scenario}:${suffix}`,
        eventId: `cert-event:redis-failure:${scenario}:${suffix}`,
        diamonds: values.diamonds,
        eliteBall: values.eliteBall,
        premium: values.premium,
        reason: "sandbox_redis_failure_certification",
        effectiveAtUnixMs: now
    });
}

function safeSnapshot(metadata) {
    const snapshot = metadata.snapshot;
    return Object.freeze({
        profileVersion: metadata.objectVersion,
        revision: snapshot.revision,
        fencingEpoch: snapshot.fencingEpoch,
        diamonds: snapshot.diamonds,
        eliteBall: snapshot.eliteBall,
        premium: snapshot.premium,
        highValueAppliedThroughSequence: snapshot.highValueAppliedThroughSequence,
        ammoAppliedThroughSequence: snapshot.ammoAppliedThroughSequence,
        payloadHash: snapshotDigest(snapshot),
        providerFenceEpoch: metadata.fence?.fencingEpoch ?? null,
        proofOperationId: metadata.highValueProof?.operationId ?? null
    });
}

async function prepareMode(argumentsValue, configuration, modules, redis) {
    const harness = await createRuntime(configuration, modules, redis, {
        scenario: argumentsValue.scenario,
        operationId: "cert:redis-failure:prepare"
    });
    const before = await harness.snapshotStore.readWithMetadata(configuration.playFabId);
    if (!before.exists) throw failure("REDIS_FAILURE_SNAPSHOT_MISSING", "Sandbox canary snapshot is not initialized.");
    const input = scenarioInput(configuration, argumentsValue.scenario);
    const submitted = await harness.runtime.enqueueAuthoritativeHighValueOperation(input);
    const operation = submitted.record?.operation;
    if (!operation || operation.playFabId !== configuration.playFabId || operation.operationId !== input.operationId) {
        throw failure("REDIS_FAILURE_INBOX_PROTOCOL", "Prepared inbox operation identity is invalid.");
    }
    const now = Date.now();
    const job = createJob({ configuration, scenario: argumentsValue.scenario, operation, before, nowUnixMs: now });
    await storeJob(redis, configuration, job);
    return Object.freeze({
        verdict: "REDIS_FAILURE_OPERATION_PREPARED",
        scenario: argumentsValue.scenario,
        operationId: operation.operationId,
        eventId: operation.eventId,
        inboxStatus: submitted.status,
        jobExpiresAtUnixMs: job.expiresAtUnixMs,
        before: safeSnapshot(before),
        tokensLogged: false
    });
}

async function processMode(argumentsValue, configuration, modules, redis) {
    const job = await loadJob(redis, configuration, argumentsValue.operationId);
    const harness = await createRuntime(configuration, modules, redis, {
        pausePoint: argumentsValue.pausePoint,
        scenario: job.operation.scenario,
        operationId: argumentsValue.operationId
    });
    const record = await harness.operationInbox.get(configuration.playFabId, argumentsValue.operationId);
    if (!record || record.playFabId !== configuration.playFabId ||
        record.operationId !== job.operation.operationId ||
        record.operation?.eventId !== job.operation.eventId ||
        record.operation?.immutableHash !== job.operation.immutableHash) {
        throw failure("REDIS_FAILURE_INBOX_IDENTITY_MISMATCH", "Inbox operation differs from its strict job identity.");
    }
    const result = await harness.runtime.processHighValueOperation({
        playFabId: configuration.playFabId,
        operationId: argumentsValue.operationId,
        consumer: "redis_failure_certification"
    });
    const after = await harness.snapshotStore.readWithMetadata(configuration.playFabId);
    return Object.freeze({
        verdict: "REDIS_FAILURE_OPERATION_PROCESSED",
        scenario: job.operation.scenario,
        operationId: argumentsValue.operationId,
        pausePoint: argumentsValue.pausePoint,
        status: result.status,
        runtimeTtls: harness.runtimeTtls,
        after: safeSnapshot(after),
        tokensLogged: false
    });
}

async function readMode(argumentsValue, configuration, modules, redis) {
    const job = await loadJob(redis, configuration, argumentsValue.operationId);
    const harness = await createRuntime(configuration, modules, redis, {
        scenario: job.operation.scenario,
        operationId: argumentsValue.operationId
    });
    const [record, metadata, wal] = await Promise.all([
        harness.operationInbox.get(configuration.playFabId, argumentsValue.operationId),
        harness.snapshotStore.readWithMetadata(configuration.playFabId),
        harness.walStore.status(configuration.playFabId)
    ]);
    if (!record || record.operationId !== job.operation.operationId ||
        record.operation?.eventId !== job.operation.eventId ||
        record.operation?.immutableHash !== job.operation.immutableHash) {
        throw failure("REDIS_FAILURE_INBOX_IDENTITY_MISMATCH", "Inbox operation differs from its strict job identity.");
    }
    return Object.freeze({
        verdict: "REDIS_FAILURE_OPERATION_READ",
        scenario: job.operation.scenario,
        operationId: argumentsValue.operationId,
        inboxState: record.state,
        claimEpoch: record.claimEpoch,
        acknowledgedAtUnixMs: record.ackedAtUnixMs,
        snapshot: safeSnapshot(metadata),
        proofMatchesOperation: metadata.highValueProof?.operationId === argumentsValue.operationId,
        walPendingCount: wal.pendingCount,
        tokensLogged: false
    });
}

function safeError(error, configuration = null) {
    let message = typeof error?.message === "string" ? error.message : "Redis failure certification failed.";
    for (const secret of [configuration?.secretKey, configuration?.redisUrl]) {
        if (typeof secret === "string" && secret.length > 0) message = message.split(secret).join("[REDACTED]");
    }
    return Object.freeze({
        code: typeof error?.code === "string" ? error.code : "REDIS_FAILURE_UNEXPECTED",
        message
    });
}

async function main() {
    let configuration = null;
    let redis = null;
    try {
        const argumentsValue = parseRedisFailureArguments();
        configuration = loadRedisFailureConfiguration();
        const modules = await runtimeModules();
        redis = await connectRedis(configuration, modules);
        const result = argumentsValue.mode === "prepare"
            ? await prepareMode(argumentsValue, configuration, modules, redis)
            : argumentsValue.mode === "process"
                ? await processMode(argumentsValue, configuration, modules, redis)
                : await readMode(argumentsValue, configuration, modules, redis);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({
            verdict: "REDIS_FAILURE_CERTIFICATION_FAIL",
            error: safeError(error, configuration),
            tokensLogged: false
        })}\n`);
        process.exitCode = 1;
    } finally {
        if (redis) await redis.quit().catch(() => redis.disconnect());
    }
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) await main();
