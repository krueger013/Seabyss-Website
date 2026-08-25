import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createCanonicalServerEconomyPoc } from "./server-economy-poc-canonical.js";
import { createPlayFabFinancialProfileClient } from "./playfab-financial-profile-store.js";
import {
    createDiamondsMigrationProofAwarePlayFabClient,
    DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID
} from "./diamonds-migration-proof-companion.js";
import { createObservedServerEconomyPocPlayFabSnapshotStore } from "./server-economy-poc-playfab-snapshot-store-observed.js";
import { createServerEconomyPocPlayFabFencedPlayerLeases } from "./server-economy-poc-playfab-snapshot-store.js";
import { createRedisServerEconomyPocPlayerLeases } from "./server-economy-poc-redis-player-leases.js";
import {
    createRedisCompatibleServerEconomyPocOperationInbox,
    createRedisCompatibleServerEconomyPocWalStore
} from "./server-economy-poc-redis-stores.js";
import { createStandaloneRedisServerEconomyPocGameplayResolutionStore } from "./server-economy-poc-gameplay-resolution-store.js";
import {
    createRedisServerEconomyPocEventIndex,
    createRedisServerEconomyPocProviderTransactionGuard
} from "./server-economy-poc-global-identity-stores.js";
import { createDiamondsDomainTargetRuntime } from "./diamonds-domain-target-runtime.js";
import { validateFinancialDomainReadinessCertificate } from "./progressive-financial-domain-migration.js";

export const DIAMONDS_PRODUCTION_TITLE_ID = "142853";
export const DIAMONDS_TARGET_DEFAULT_REDIS_PREFIX = "seabyss:financial:diamonds:target:v1:";

function coded(code, message, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function canonical(value, name, maximumLength = 255) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw coded("DIAMONDS_TARGET_RUNTIME_DEPENDENCY_MISSING", `${name} is absent or invalid.`);
    }
    return value;
}

function exactMode(value) {
    if (!["Legacy", "Shadow", "Canary", "Cutover"].includes(value)) {
        throw new TypeError("Diamonds domain mode is invalid.");
    }
    return value;
}

function header(request, name) {
    const direct = request?.get?.(name);
    if (typeof direct === "string") return direct;
    const raw = request?.headers?.[name.toLowerCase()];
    return typeof raw === "string" ? raw : null;
}

function constantTimeEqual(left, right) {
    const actual = Buffer.from(String(left || ""), "utf8");
    const expected = Buffer.from(String(right || ""), "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function gameServerAuthority({ gameServerId, gameServerToken }) {
    const serverId = canonical(gameServerId, "FINANCIAL_DIAMONDS_GAME_SERVER_ID", 160);
    const token = canonical(gameServerToken, "FINANCIAL_DIAMONDS_GAME_SERVER_TOKEN", 4096);
    if (Buffer.byteLength(token, "utf8") < 32) {
        throw coded("DIAMONDS_TARGET_RUNTIME_DEPENDENCY_MISSING",
            "FINANCIAL_DIAMONDS_GAME_SERVER_TOKEN must contain at least 32 bytes.");
    }
    const gameplayPrincipal = Object.freeze({
        kind: "diamonds_target_game_server",
        serverId
    });

    async function authenticateGameServer(request) {
        const authorization = header(request, "Authorization");
        const requestServerId = header(request, "X-Seabyss-Financial-Server-Id");
        const supplied = typeof authorization === "string" && authorization.startsWith("Bearer ")
            ? authorization.slice(7) : "";
        if (!constantTimeEqual(requestServerId, serverId) || !constantTimeEqual(supplied, token)) return null;
        return Object.freeze({
            authenticated: true,
            authenticationType: "GameServer",
            serverId
        });
    }

    async function authorizePlayer({ principal, playFabId }) {
        const player = canonical(playFabId, "playFabId", 160);
        const authorized = principal?.authenticated === true &&
            principal.authenticationType === "GameServer" && principal.serverId === serverId;
        return Object.freeze({ authorized, playFabId: player });
    }

    async function authorizeSession(input = {}) {
        const playFabId = canonical(input.playFabId, "playFabId", 160);
        canonical(input.sessionId, "sessionId", 200);
        if (!Number.isSafeInteger(input.sessionEpoch) || input.sessionEpoch <= 0) {
            throw coded("DIAMONDS_TARGET_SESSION_INVALID", "Trusted game-server session epoch is invalid.", 400);
        }
        return Object.freeze({
            authorized: true,
            playFabId,
            sessionId: input.sessionId,
            sessionEpoch: input.sessionEpoch,
            principal: gameplayPrincipal
        });
    }

    async function authorizeGameplay({ principal, playFabId }) {
        return Object.freeze({
            authorized: principal === gameplayPrincipal,
            playFabId: canonical(playFabId, "playFabId", 160)
        });
    }

    return Object.freeze({ authenticateGameServer, authorizePlayer, authorizeSession, authorizeGameplay });
}

export function loadDiamondsReadinessCertificate({
    mode = "Legacy",
    certificatePath = "",
    readFile = readFileSync
} = {}) {
    const selectedMode = exactMode(mode);
    if (selectedMode === "Legacy") return null;
    const path = canonical(certificatePath, "FINANCIAL_DIAMONDS_READINESS_CERTIFICATE_PATH", 4096);
    if (typeof readFile !== "function") throw new TypeError("Readiness certificate reader is invalid.");
    let raw;
    try {
        raw = readFile(path, "utf8");
    } catch {
        throw coded("DIAMONDS_READINESS_CERTIFICATE_MISSING",
            "Diamonds readiness certificate cannot be read.");
    }
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
        throw coded("DIAMONDS_READINESS_CERTIFICATE_INVALID",
            "Diamonds readiness certificate exceeds its safe bound.");
    }
    try {
        const certificate = JSON.parse(raw);
        if (!certificate || typeof certificate !== "object" || Array.isArray(certificate)) throw new Error();
        return Object.freeze(structuredClone(certificate));
    } catch {
        throw coded("DIAMONDS_READINESS_CERTIFICATE_INVALID",
            "Diamonds readiness certificate is malformed.");
    }
}

export function createRealDiamondsCanonicalRuntime({
    redis,
    titleId,
    secretKey,
    redisPrefix = DIAMONDS_TARGET_DEFAULT_REDIS_PREFIX,
    gameServerId,
    gameServerToken,
    canaryPlayFabIds = [],
    migrationProofRequired = false,
    timeoutMs = 8_000,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (typeof redis?.sendCommand !== "function" || typeof redis?.ping !== "function") {
        throw coded("DIAMONDS_TARGET_RUNTIME_DEPENDENCY_MISSING",
            "Diamonds Target requires the configured durable Redis client.");
    }
    const selectedTitle = canonical(titleId, "PLAYFAB_TITLE_ID", 160);
    if (selectedTitle === DIAMONDS_PRODUCTION_TITLE_ID) {
        throw coded("DIAMONDS_TARGET_TITLE_FORBIDDEN",
            "The Diamonds Sandbox Target cannot use the Production PlayFab Title.", 400);
    }
    const selectedSecret = canonical(secretKey, "PLAYFAB_SECRET_KEY", 4096);
    const prefix = canonical(redisPrefix, "FINANCIAL_DIAMONDS_TARGET_REDIS_PREFIX", 160);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000 ||
        typeof nowMilliseconds !== "function") {
        throw coded("DIAMONDS_TARGET_RUNTIME_DEPENDENCY_MISSING",
            "Diamonds Target timeout or clock is invalid.");
    }
    const authority = gameServerAuthority({ gameServerId, gameServerToken });
    const candidateLeases = createRedisServerEconomyPocPlayerLeases({ redis, prefix });
    const assertPlayerFence = (input) => candidateLeases.assertCurrent(input);
    const basePlayFab = createPlayFabFinancialProfileClient({
        titleId: selectedTitle,
        secretKey: selectedSecret,
        timeoutMs
    });
    const proofAwarePlayFab = migrationProofRequired
        ? createDiamondsMigrationProofAwarePlayFabClient({
            client: basePlayFab,
            titleId: selectedTitle,
            canaryPlayFabIds
        })
        : null;
    const playFab = proofAwarePlayFab || basePlayFab;
    const snapshotStore = createObservedServerEconomyPocPlayFabSnapshotStore({
        client: playFab,
        assertPlayerFence,
        nowMilliseconds
    });
    const playerLeases = createServerEconomyPocPlayFabFencedPlayerLeases({
        candidateLeases,
        snapshotStore
    });
    const operationInbox = createRedisCompatibleServerEconomyPocOperationInbox({
        redis,
        prefix,
        nowMilliseconds,
        assertPlayerFence,
        requireSequenceAllocationFence: true
    });
    const walStore = createRedisCompatibleServerEconomyPocWalStore({ redis, prefix });
    const gameplayResolutionStore = createStandaloneRedisServerEconomyPocGameplayResolutionStore({
        redis,
        prefix,
        assertPlayerFence
    });
    const canonicalRuntime = createCanonicalServerEconomyPoc({
        snapshotStore,
        operationInbox,
        walStore,
        playerLeases,
        sequenceLeases: candidateLeases,
        gameplayResolutionStore,
        eventIndexStore: createRedisServerEconomyPocEventIndex({ redis, prefix }),
        providerTransactionGuard: createRedisServerEconomyPocProviderTransactionGuard({ redis, prefix }),
        authorizeSession: authority.authorizeSession,
        authorizeGameplay: authority.authorizeGameplay,
        nowMilliseconds
    });
    return Object.freeze({
        canonicalRuntime,
        authority,
        snapshotStore,
        playerLeases,
        candidateLeases,
        operationInbox,
        gameplayResolutionStore,
        walStore,
        redis,
        titleId: selectedTitle,
        redisPrefix: prefix,
        realRedis: true,
        realPlayFabServerApi: true,
        expectedProfileVersionCas: snapshotStore.expectedProfileVersionCas === true,
        migrationProofRequired,
        proofAwarePlayFab
    });
}

function deferredRealRuntime(build) {
    let pending = null;
    let resolved = null;
    async function resolve() {
        if (resolved) return resolved;
        if (!pending) {
            pending = Promise.resolve().then(build).then((value) => {
                resolved = value;
                return value;
            }).catch((error) => {
                pending = null;
                throw error;
            });
        }
        return pending;
    }
    return Object.freeze({
        canonicalRuntime: Object.freeze({
            proofCapabilities: Object.freeze({
                atomicStateProofCas: true,
                migrationProof: true,
                fencing: true
            }),
            readSnapshot: async (...args) => (await resolve()).canonicalRuntime.readSnapshot(...args),
            trustedDiamonds: Object.freeze({
                execute: async (...args) => (await resolve()).canonicalRuntime.trustedDiamonds.execute(...args)
            }),
            consumeValidatedXsollaReceipt: async (...args) =>
                (await resolve()).canonicalRuntime.consumeValidatedXsollaReceipt(...args),
            verifyTrustedOperation: async (...args) => {
                const proofClient = (await resolve()).proofAwarePlayFab;
                if (typeof proofClient?.verifyTrustedOperation !== "function") {
                    throw coded("DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED",
                        "Diamonds Target operation proof verifier is unavailable.");
                }
                return proofClient.verifyTrustedOperation(...args);
            }
        }),
        resolve,
        diagnostics: () => Object.freeze({ constructed: resolved !== null, constructionPending: pending !== null && resolved === null })
    });
}

export async function createDiamondsDomainServerComposition({
    configuration,
    readinessCertificate = null,
    redis = null,
    titleId = null,
    secretKey = null,
    redisPrefix = DIAMONDS_TARGET_DEFAULT_REDIS_PREFIX,
    gameServerId = null,
    gameServerToken = null,
    timeoutMs = 8_000,
    nowMilliseconds = () => Date.now(),
    buildCanonicalRuntime = createRealDiamondsCanonicalRuntime
} = {}) {
    const mode = exactMode(configuration?.mode);
    if (typeof buildCanonicalRuntime !== "function") throw new TypeError("Diamonds runtime builder is invalid.");
    const deferred = deferredRealRuntime(() => buildCanonicalRuntime({
        redis, titleId, secretKey, redisPrefix, gameServerId, gameServerToken,
        timeoutMs, nowMilliseconds,
        canaryPlayFabIds: configuration.canaryPlayFabIds || [],
        migrationProofRequired: mode === "Canary"
    }));

    const verifyReadinessCertificate = async ({ certificate, domain, titleId: expectedTitle, nowUnixMs }) => {
        const validation = validateFinancialDomainReadinessCertificate({
            certificate,
            configuration,
            nowUtc: new Date(nowUnixMs).toISOString()
        });
        return Object.freeze({
            valid: validation.valid === true,
            domain,
            titleId: certificate?.sandboxTitleId === expectedTitle ? expectedTitle : certificate?.sandboxTitleId,
            expiresAtUnixMs: Date.parse(certificate?.expiresAtUtc || "")
        });
    };

    const healthProbe = async () => {
        const stack = await deferred.resolve();
        const pong = await stack.redis.ping();
        const playFabHealthy = await stack.snapshotStore.probe();
        const canary = configuration.canaryPlayFabIds?.[0];
        if (mode === "Canary" && !canary) {
            throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID", "Diamonds Canary identity is absent.", 400);
        }
        if (canary) {
            const snapshot = await stack.canonicalRuntime.readSnapshot(canary);
            if (snapshot?.playFabId !== canary) {
                throw coded("DIAMONDS_TARGET_IDENTITY_MISMATCH", "Target snapshot belongs to another player.");
            }
            if (mode === "Canary") {
                if (canary !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID ||
                    typeof stack.proofAwarePlayFab?.readDiamondsMigrationProof !== "function") {
                    throw coded("DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED",
                        "Diamonds Canary requires its exact durable migration proof.", 503);
                }
                await stack.proofAwarePlayFab.readDiamondsMigrationProof(canary);
            }
        }
        return Object.freeze({
            targetHealthy: true,
            redisHealthy: pong === "PONG",
            playFabHealthy: playFabHealthy === true,
            snapshotCasSupported: stack.expectedProfileVersionCas === true
        });
    };

    const authenticateGameServer = async (request) =>
        (await deferred.resolve()).authority.authenticateGameServer(request);
    const authorizePlayer = async (input) =>
        (await deferred.resolve()).authority.authorizePlayer(input);

    const verifyPaymentCanaryReadiness = async ({ playFabId } = {}) => {
        if (mode !== "Canary" || configuration.canaryPlayFabIds?.length !== 1 ||
            playFabId !== configuration.canaryPlayFabIds[0] ||
            playFabId !== DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID) {
            throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID",
                "Payment Target readiness requires the one exact Diamonds Sandbox canary.", 403);
        }
        const certificateValidation = await verifyReadinessCertificate({
            certificate: readinessCertificate,
            domain: "Diamonds",
            titleId,
            nowUnixMs: nowMilliseconds()
        });
        if (certificateValidation.valid !== true || certificateValidation.titleId !== titleId ||
            certificateValidation.expiresAtUnixMs <= nowMilliseconds()) {
            throw coded("DIAMONDS_READINESS_CERTIFICATE_INVALID",
                "Payment Target readiness certificate is invalid or expired.", 503);
        }
        const health = await healthProbe();
        const scannerForbiddenCount = readinessCertificate?.healthInput?.legacyAccess?.forbiddenDirectAccess;
        const ready = health.redisHealthy === true && health.playFabHealthy === true &&
            health.targetHealthy === true && health.snapshotCasSupported === true &&
            scannerForbiddenCount === 0;
        if (!ready) {
            throw coded("DIAMONDS_CANARY_PAYMENT_READINESS_FAILED",
                "Diamonds payment Target readiness is incomplete.", 503);
        }
        return Object.freeze({
            ready: true,
            domain: "Diamonds",
            titleId,
            playFabId,
            certificateValid: true,
            migrationProofValid: true,
            redisHealthy: true,
            playFabHealthy: true,
            scannerForbiddenCount: 0
        });
    };

    const runtime = await createDiamondsDomainTargetRuntime({
        mode,
        titleId,
        forbiddenTitleIds: [DIAMONDS_PRODUCTION_TITLE_ID],
        canaryPlayFabIds: configuration.canaryPlayFabIds || [],
        canonicalRuntime: deferred.canonicalRuntime,
        healthProbe,
        readinessCertificate,
        verifyReadinessCertificate,
        authenticateGameServer,
        authorizePlayer,
        nowMilliseconds
    });
    return Object.freeze({
        ...runtime,
        canonicalRuntime: deferred.canonicalRuntime,
        verifyPaymentCanaryReadiness,
        runtimeDiagnostics: deferred.diagnostics,
        lazyRealRuntime: true,
        productionTitleForbidden: true
    });
}
