import { createDiamondsDomainTargetHttpHandlers } from "./diamonds-domain-target-http.js";
import { createDiamondsDomainTargetAdapter } from "./diamonds-domain-target-adapter.js";

const MODES = new Set(["Legacy", "Shadow", "Canary", "Cutover"]);

function coded(code, message, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function canonical(value, name, maximumLength = 160) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function validateAdapter(adapter) {
    return adapter && typeof adapter.read === "function" && typeof adapter.mutate === "function" &&
        typeof adapter.adapterVersion === "string";
}

function validateHealth(value) {
    return value && value.targetHealthy === true && value.redisHealthy === true &&
        value.playFabHealthy === true && value.snapshotCasSupported === true;
}

function exactCanary(value) {
    if (!Array.isArray(value) || value.length !== 1) {
        throw coded("DIAMONDS_CANARY_ALLOWLIST_INVALID",
            "Diamonds Canary requires exactly one explicit Sandbox player.", 400);
    }
    return Object.freeze([canonical(value[0], "Diamonds canary PlayFabId")]);
}

/**
 * Composes the certified Target adapter into the runtime while preserving an
 * inert Legacy default. Non-Legacy modes never fall back to Legacy when a
 * dependency, health proof, certificate, or exact canary identity is absent.
 */
export async function createDiamondsDomainTargetRuntime({
    mode = "Legacy",
    titleId = null,
    forbiddenTitleIds = [],
    canaryPlayFabIds = [],
    canonicalRuntime = null,
    targetAdapter = null,
    healthProbe = null,
    readinessCertificate = null,
    verifyReadinessCertificate = null,
    authenticateGameServer = null,
    authorizePlayer = null,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (!MODES.has(mode)) throw new TypeError("Diamonds domain mode is invalid.");
    if (!Array.isArray(forbiddenTitleIds) || typeof nowMilliseconds !== "function") {
        throw new TypeError("Diamonds Target runtime configuration is invalid.");
    }

    const resolvedTargetAdapter = targetAdapter ?? (canonicalRuntime
        ? createDiamondsDomainTargetAdapter({ canonicalRuntime })
        : null);
    const configured = validateAdapter(resolvedTargetAdapter);
    const inactive = mode === "Legacy";
    if (inactive) {
        const deny = async () => {
            throw coded("DIAMONDS_TARGET_MODE_INACTIVE", "Diamonds Target is inactive in Legacy mode.", 404);
        };
        return Object.freeze({
            domain: "Diamonds",
            mode,
            active: false,
            targetAdapterComposed: configured,
            targetAdapterSource: canonicalRuntime && !targetAdapter ? "canonical_runtime" :
                targetAdapter ? "explicit_adapter" : "missing",
            adapter: Object.freeze({ read: deny, mutate: deny }),
            handlers: null,
            health: Object.freeze({ ready: false, reason: "legacy_mode", probed: false }),
            canaryPlayFabIds: Object.freeze([])
        });
    }

    if (!configured) {
        throw coded("DIAMONDS_TARGET_ADAPTER_MISSING", "Diamonds Target adapter is not composed.");
    }
    const selectedTitle = canonical(titleId, "Diamonds Target Title ID");
    const forbidden = forbiddenTitleIds.map((value) => canonical(value, "forbidden Title ID"));
    if (forbidden.includes(selectedTitle)) {
        throw coded("DIAMONDS_TARGET_TITLE_FORBIDDEN", "Diamonds Target Title is explicitly forbidden.", 400);
    }
    if (typeof healthProbe !== "function") {
        throw coded("DIAMONDS_TARGET_HEALTH_MISSING", "Diamonds Target health probe is absent.");
    }
    const health = await healthProbe({ domain: "Diamonds", titleId: selectedTitle, mode });
    if (!validateHealth(health)) {
        throw coded("DIAMONDS_TARGET_UNHEALTHY", "Diamonds Target Redis/PlayFab/CAS health is incomplete.");
    }

    let allowlist = Object.freeze([]);
    if (mode === "Canary") allowlist = exactCanary(canaryPlayFabIds);
    if (mode === "Cutover" && canaryPlayFabIds.length !== 0) {
        throw coded("DIAMONDS_CUTOVER_ALLOWLIST_INVALID", "Domain Cutover cannot retain a canary allowlist.", 400);
    }

    if (["Canary", "Cutover"].includes(mode)) {
        if (!readinessCertificate || typeof verifyReadinessCertificate !== "function") {
            throw coded("DIAMONDS_READINESS_CERTIFICATE_MISSING",
                "Diamonds Target activation requires a readiness certificate.");
        }
        const nowUnixMs = nowMilliseconds();
        const certification = await verifyReadinessCertificate({
            certificate: readinessCertificate,
            domain: "Diamonds",
            titleId: selectedTitle,
            nowUnixMs
        });
        if (certification?.valid !== true || certification.domain !== "Diamonds" ||
            certification.titleId !== selectedTitle ||
            !Number.isSafeInteger(certification.expiresAtUnixMs) ||
            certification.expiresAtUnixMs <= nowUnixMs) {
            throw coded("DIAMONDS_READINESS_CERTIFICATE_INVALID",
                "Diamonds readiness certificate is invalid, expired, or bound to another Title.");
        }
    }

    function selected(playFabId) {
        const player = canonical(playFabId, "playFabId");
        return mode !== "Canary" || allowlist.includes(player);
    }

    const gatedAdapter = Object.freeze({
        async read(input = {}) {
            if (!selected(input.playFabId)) {
                throw coded("DIAMONDS_CANARY_PLAYER_DENIED", "Player is outside the Diamonds canary allowlist.", 403);
            }
            return resolvedTargetAdapter.read(input);
        },
        async mutate(input = {}) {
            if (mode === "Shadow") {
                throw coded("DIAMONDS_TARGET_SHADOW_READ_ONLY", "Diamonds Shadow Target is read-only.", 403);
            }
            if (!selected(input.playFabId)) {
                throw coded("DIAMONDS_CANARY_PLAYER_DENIED", "Player is outside the Diamonds canary allowlist.", 403);
            }
            return resolvedTargetAdapter.mutate(input);
        },
        adapterVersion: resolvedTargetAdapter.adapterVersion,
        domain: "Diamonds"
    });

    const handlers = ["Canary", "Cutover"].includes(mode)
        ? createDiamondsDomainTargetHttpHandlers({
            adapter: gatedAdapter,
            authenticateGameServer,
            authorizePlayer
        })
        : null;

    return Object.freeze({
        domain: "Diamonds",
        mode,
        active: mode !== "Legacy",
        mutationActive: ["Canary", "Cutover"].includes(mode),
        targetAdapterComposed: true,
        targetAdapterSource: canonicalRuntime && !targetAdapter ? "canonical_runtime" : "explicit_adapter",
        adapter: gatedAdapter,
        handlers,
        health: Object.freeze({ ready: true, probed: true, ...health }),
        titleId: selectedTitle,
        canaryPlayFabIds: allowlist
    });
}
