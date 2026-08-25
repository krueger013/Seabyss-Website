import { createHash, randomUUID } from "node:crypto";
import { planPlayFabFinancialAuthorityMigration } from "./playfab-financial-authority-migration.js";
import { createFinancialAuthorityMigrationJob } from "./financial-authority-migration-job-store.js";

const ECONOMY_CHECKPOINT = "economy_v2_seed";
const AUTHORITY_CHECKPOINT = "authority_v2_initialize";
const VERIFIED_CHECKPOINT = "migration_verified";

export class FinancialAuthorityMigrationError extends Error {
    constructor(code, message, { retryable = false, conflicts = [], cause = null } = {}) {
        super(message);
        this.name = "FinancialAuthorityMigrationError";
        this.code = code;
        this.retryable = retryable;
        this.conflicts = conflicts;
        if (cause) this.cause = cause;
    }
}

export class FinancialAuthorityMigrationSimulatedCrash extends Error {
    constructor(point) {
        super(`Simulated financial migration crash at ${point}.`);
        this.name = "FinancialAuthorityMigrationSimulatedCrash";
        this.code = "SIMULATED_MIGRATION_CRASH";
        this.simulatedCrash = true;
        this.point = point;
    }
}

function fail(code, message, options) {
    throw new FinancialAuthorityMigrationError(code, message, options);
}

function canonical(value, name, maximumLength = 320) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
        value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${name} is invalid.`);
    }
    return value;
}

function positive(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} is invalid.`);
    return value;
}

function safeNow(nowMilliseconds) {
    const value = nowMilliseconds();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Migration clock is invalid.");
    return value;
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
            result[key] = canonicalize(value[key]);
        }
        return result;
    }
    return value;
}

function stableJson(value) {
    return JSON.stringify(canonicalize(value));
}

function digest(value) {
    return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function clone(value) {
    return structuredClone(value);
}

function same(left, right) {
    return stableJson(left) === stableJson(right);
}

function errorRecord(error) {
    const code = typeof error?.code === "string" && error.code.length <= 160
        ? error.code
        : "FINANCIAL_MIGRATION_FAILURE";
    const message = typeof error?.message === "string" && error.message.length > 0
        ? error.message.slice(0, 1024)
        : "Financial migration failed.";
    return { code, message, retryable: error?.retryable === true };
}

function sourceInput(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        fail("MIGRATION_SOURCE_INVALID", "Financial migration source snapshot is invalid.");
    }
    const economyV2Quantities = raw.economyV2Quantities || {};
    if (!economyV2Quantities || typeof economyV2Quantities !== "object" ||
        Array.isArray(economyV2Quantities)) {
        fail("MIGRATION_SOURCE_INVALID", "Economy v2 quantity snapshot is invalid.");
    }
    const normalized = canonicalize({
        profileV1: raw.profileV1,
        financialProfileV1: raw.financialProfileV1 ?? null,
        legacyDmBalance: raw.legacyDmBalance,
        economyV2Quantities
    });
    normalized.economyV2Etag = raw.economyV2Etag ?? null;
    return normalized;
}

function sourceEvidence(sources) {
    return digest({
        profileV1: sources.profileV1,
        financialProfileV1: sources.financialProfileV1,
        legacyDmBalance: sources.legacyDmBalance
    });
}

function operationId(playFabId, planHash, step) {
    return `financial-migration:${createHash("sha256")
        .update(playFabId, "utf8")
        .update("\0", "utf8")
        .update(planHash, "utf8")
        .update("\0", "utf8")
        .update(step, "utf8")
        .digest("base64url")}:v1`;
}

function checkpointIntent({ operationId: id, requestHash, intent, epoch, playerEpoch, nowUnixMs }) {
    return {
        status: "StepPending",
        operationId: id,
        requestHash,
        intent: clone(intent),
        jobLeaseEpoch: epoch,
        playerLeaseEpoch: playerEpoch,
        createdAtUnixMs: nowUnixMs
    };
}

function appliedCheckpoint(pending, evidence, nowUnixMs) {
    return {
        ...clone(pending),
        status: "StepApplied",
        evidence: clone(evidence),
        appliedAtUnixMs: nowUnixMs
    };
}

function verifyAuthority(snapshot, plan) {
    if (!snapshot?.migrated || !snapshot.authority) return false;
    return same(snapshot.authority.migration?.sourceDigests, plan.sourceDigests);
}

function exactEconomy(sources, plan) {
    const actual = sources.economyV2Quantities || {};
    for (const [rewardId, target] of Object.entries(plan.targetQuantities)) {
        if ((actual[rewardId] ?? 0) !== target) return false;
    }
    for (const [rewardId, quantity] of Object.entries(actual)) {
        if (!Object.hasOwn(plan.targetQuantities, rewardId) && quantity !== 0) return false;
    }
    return true;
}

function deterministicBackoff(playFabId, attemptCount, baseMilliseconds, maximumMilliseconds) {
    const exponential = Math.min(maximumMilliseconds,
        baseMilliseconds * (2 ** Math.min(20, Math.max(0, attemptCount - 1))));
    const seed = createHash("sha256").update(`${playFabId}:${attemptCount}`, "utf8").digest().readUInt32BE(0);
    return Math.min(maximumMilliseconds, Math.floor(exponential * (0.75 + (seed / 0xffffffff) * 0.5)));
}

function requireEnabledDependencies({ jobStore, loadSources, authorityStore }) {
    for (const [name, dependency, methods] of [
        ["jobStore", jobStore, ["create", "get", "acquireLease", "renewLease", "releaseLease",
            "compareAndSet", "promoteDryRun", "scan", "ping"]],
        ["authorityStore", authorityStore, ["read", "initialize"]]
    ]) {
        if (!dependency || methods.some((method) => typeof dependency[method] !== "function")) {
            throw new TypeError(`${name} is not configured for financial migration.`);
        }
    }
    if (typeof loadSources !== "function") throw new TypeError("loadSources is not configured for financial migration.");
}

function requireWriteDependencies({ economyAdapter, playerLeaseManager }) {
    if (!economyAdapter || typeof economyAdapter.grant !== "function" ||
        typeof economyAdapter.verify !== "function") {
        throw new TypeError("economyAdapter is not configured for financial migration writes.");
    }
    if (!playerLeaseManager || ["acquireResourceLease", "renewResourceLease", "releaseResourceLease"]
        .some((method) => typeof playerLeaseManager[method] !== "function")) {
        throw new TypeError("playerLeaseManager is not configured for financial migration writes.");
    }
}

export function createPlayFabFinancialAuthorityMigrationExecutor({
    enabled = false,
    allowProviderWrites = false,
    jobStore = null,
    loadSources = null,
    planner = planPlayFabFinancialAuthorityMigration,
    economyAdapter = null,
    authorityStore = null,
    playerLeaseManager = null,
    workerId = `financial-migration-${process.pid}`,
    leaseTtlMilliseconds = 30_000,
    loopIntervalMilliseconds = 5_000,
    scanPageSize = 100,
    maximumRetries = 6,
    maximumCasAttempts = 5,
    retryBaseMilliseconds = 1_000,
    retryMaximumMilliseconds = 300_000,
    nowMilliseconds = () => Date.now(),
    makeToken = () => randomUUID(),
    faultInjector = async () => {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    metrics = null
} = {}) {
    if (enabled !== true && enabled !== false || allowProviderWrites !== true && allowProviderWrites !== false) {
        throw new TypeError("Financial migration gates must be booleans.");
    }
    canonical(workerId, "workerId", 160);
    for (const [name, value] of [
        ["leaseTtlMilliseconds", leaseTtlMilliseconds],
        ["loopIntervalMilliseconds", loopIntervalMilliseconds],
        ["scanPageSize", scanPageSize],
        ["maximumRetries", maximumRetries],
        ["maximumCasAttempts", maximumCasAttempts],
        ["retryBaseMilliseconds", retryBaseMilliseconds],
        ["retryMaximumMilliseconds", retryMaximumMilliseconds]
    ]) positive(value, name);
    if (typeof planner !== "function" || typeof nowMilliseconds !== "function" ||
        typeof makeToken !== "function" || typeof faultInjector !== "function" ||
        typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
        throw new TypeError("Financial migration executor functions are invalid.");
    }
    if (enabled) requireEnabledDependencies({ jobStore, loadSources, authorityStore });
    if (enabled && allowProviderWrites) requireWriteDependencies({ economyAdapter, playerLeaseManager });

    let running = false;
    let timer = null;
    let activeLoop = null;
    let lastLoopAtUnixMs = null;
    let lastLoopError = null;

    function metric(name, details = {}) {
        try { metrics?.increment?.(name, details); } catch { /* metrics cannot change financial behavior */ }
    }

    async function get(playFabId) {
        canonical(playFabId, "playFabId", 128);
        if (!enabled) return null;
        return jobStore.get(playFabId);
    }

    async function enqueueDryRun(playFabId) {
        canonical(playFabId, "playFabId", 128);
        if (!enabled) return Object.freeze({ status: "disabled", record: null });
        const record = createFinancialAuthorityMigrationJob({
            playFabId,
            mode: "dry_run",
            nowUnixMs: safeNow(nowMilliseconds)
        });
        return jobStore.create(record);
    }

    async function approveApply({ playFabId, expectedPlanHash }) {
        canonical(playFabId, "playFabId", 128);
        canonical(expectedPlanHash, "expectedPlanHash", 128);
        if (!enabled) return Object.freeze({ status: "disabled", record: null });
        if (!allowProviderWrites) return Object.freeze({ status: "writes_disabled", record: await jobStore.get(playFabId) });
        const record = await jobStore.get(playFabId);
        if (!record) return Object.freeze({ status: "missing", record: null });
        return jobStore.promoteDryRun(playFabId, {
            expectedVersion: record.version,
            expectedPlanHash,
            nowUnixMs: safeNow(nowMilliseconds)
        });
    }

    async function assertJobLease(playFabId, token, epoch) {
        const record = await jobStore.get(playFabId);
        const now = safeNow(nowMilliseconds);
        if (!record || record.leaseToken !== token || record.leaseEpoch !== epoch ||
            record.leaseExpiresAtUnixMs === null || record.leaseExpiresAtUnixMs <= now) {
            fail("STALE_MIGRATION_WORKER", "Financial migration worker no longer owns the job lease.");
        }
        return record;
    }

    async function updateJob(playFabId, token, epoch, transform) {
        for (let attempt = 1; attempt <= maximumCasAttempts; attempt += 1) {
            const current = await assertJobLease(playFabId, token, epoch);
            const next = transform(clone(current));
            const result = await jobStore.compareAndSet(playFabId, {
                expectedVersion: current.version,
                token,
                epoch,
                next,
                nowUnixMs: safeNow(nowMilliseconds)
            });
            if (result.status === "replaced") return result.record;
            if (result.status === "version_conflict") continue;
            if (result.status === "lease_conflict") {
                fail("STALE_MIGRATION_WORKER", "Financial migration CAS was rejected by fencing.");
            }
            fail("MIGRATION_STORE_PROTOCOL", "Financial migration job store returned an invalid CAS result.");
        }
        fail("MIGRATION_JOB_CAS_EXHAUSTED", "Financial migration job CAS retries were exhausted.", {
            retryable: true
        });
    }

    async function setTerminal(playFabId, token, epoch, state, {
        conflicts = [], lastError = null, nextAttemptAtUnixMs = null
    } = {}) {
        return updateJob(playFabId, token, epoch, (next) => {
            next.state = state;
            next.conflicts = clone(conflicts);
            next.lastError = lastError === null ? null : clone(lastError);
            next.nextAttemptAtUnixMs = nextAttemptAtUnixMs;
            return next;
        });
    }

    async function ensureCheckpoint(playFabId, token, epoch, name, checkpoint) {
        return updateJob(playFabId, token, epoch, (next) => {
            const existing = next.checkpoints[name];
            if (existing && !same(existing, checkpoint)) {
                fail("MIGRATION_CHECKPOINT_CONFLICT", `Financial migration checkpoint ${name} conflicts.`);
            }
            if (!existing) next.checkpoints[name] = clone(checkpoint);
            return next;
        });
    }

    async function applyCheckpoint(playFabId, token, epoch, name, evidence) {
        return updateJob(playFabId, token, epoch, (next) => {
            const current = next.checkpoints[name];
            if (!current) fail("MIGRATION_CHECKPOINT_MISSING", `${name} intent is missing.`);
            if (current.status === "StepApplied") return next;
            if (current.status !== "StepPending") {
                fail("MIGRATION_CHECKPOINT_CONFLICT", `${name} intent is invalid.`);
            }
            next.checkpoints[name] = appliedCheckpoint(current, evidence, safeNow(nowMilliseconds));
            return next;
        });
    }

    async function buildAndPersistPlan(playFabId, token, epoch) {
        const current = await assertJobLease(playFabId, token, epoch);
        if (current.plan !== null) return current;
        const migratedAtUtc = new Date(safeNow(nowMilliseconds)).toISOString();
        const sources = sourceInput(await loadSources(playFabId));
        const authority = await authorityStore.read(playFabId);
        const planned = planner({
            playFabId,
            profileV1: sources.profileV1,
            financialProfileV1: sources.financialProfileV1,
            legacyDmBalance: sources.legacyDmBalance,
            economyV2Quantities: sources.economyV2Quantities,
            migratedAtUtc
        });
        if (planned?.status === "manual_review") {
            const conflicts = clone(planned.conflicts || []);
            await setTerminal(playFabId, token, epoch, "ManualReview", {
                conflicts,
                lastError: {
                    code: "MIGRATION_PLAN_CONFLICT",
                    message: "Legacy and FinancialAuthorityV2 sources require manual review.",
                    retryable: false
                }
            });
            return jobStore.get(playFabId);
        }
        if (planned?.status !== "ready") {
            fail("MIGRATION_PLAN_INVALID", "Financial migration planner returned an invalid result.");
        }
        if (authority?.migrated && !same(authority.authority?.migration?.sourceDigests, planned.sourceDigests)) {
            await setTerminal(playFabId, token, epoch, "ManualReview", {
                conflicts: [{ resource: "FinancialAuthorityV2", reason: "existing_migration_proof_conflict" }],
                lastError: {
                    code: "EXISTING_AUTHORITY_CONFLICT",
                    message: "Existing FinancialAuthorityV2 proof differs from this migration plan.",
                    retryable: false
                }
            });
            return jobStore.get(playFabId);
        }
        const rewards = [];
        for (const [rewardId, target] of Object.entries(planned.targetQuantities)) {
            const before = sources.economyV2Quantities[rewardId] ?? 0;
            if (target > before) rewards.push({ rewardId, quantity: target - before });
        }
        rewards.sort((left, right) => left.rewardId.localeCompare(right.rewardId));
        if (rewards.length > 0) canonical(sources.economyV2Etag, "economyV2Etag", 1024);
        const basis = {
            schemaVersion: 1,
            authorityVersion: "financial_v2",
            playFabId,
            migratedAtUtc,
            idempotencyCreatedAtUtc: migratedAtUtc,
            plannerOperationId: planned.operationId,
            sourceEvidence: sourceEvidence(sources),
            sourceDigests: clone(planned.sourceDigests),
            targetQuantities: clone(planned.targetQuantities),
            observedEconomyV2Quantities: clone(sources.economyV2Quantities),
            economyV2Etag: sources.economyV2Etag,
            economyRewards: rewards,
            initialAuthority: clone(planned.initialAuthority),
            authorityObjectVersion: authority?.objectVersion ?? 0
        };
        const planHash = digest(basis);
        const economyOperationId = operationId(playFabId, planHash, ECONOMY_CHECKPOINT);
        const economyRequest = {
            playFabId,
            operationId: economyOperationId,
            idempotencyCreatedAtUtc: basis.idempotencyCreatedAtUtc,
            rewards,
            etag: basis.economyV2Etag
        };
        const plan = {
            ...basis,
            planHash,
            economyOperationId,
            economyRequestHash: digest(economyRequest)
        };
        const persisted = await updateJob(playFabId, token, epoch, (next) => {
            if (next.plan !== null && next.plan.planHash !== planHash) {
                fail("MIGRATION_PLAN_IMMUTABLE", "A different financial migration plan is already persisted.");
            }
            if (next.plan === null) {
                next.plan = clone(plan);
                next.checkpoints.plan_created = {
                    status: "Completed",
                    planHash,
                    sourceEvidence: plan.sourceEvidence,
                    createdAtUnixMs: safeNow(nowMilliseconds)
                };
            }
            return next;
        });
        await faultInjector("after_plan_persisted", { playFabId, plan: clone(plan), epoch });
        return persisted;
    }

    async function sourceDriftCheck(playFabId, plan) {
        const sources = sourceInput(await loadSources(playFabId));
        const currentPlan = planner({
            playFabId,
            profileV1: sources.profileV1,
            financialProfileV1: sources.financialProfileV1,
            legacyDmBalance: sources.legacyDmBalance,
            economyV2Quantities: sources.economyV2Quantities,
            migratedAtUtc: plan.migratedAtUtc
        });
        if (currentPlan?.status !== "ready" || !same(currentPlan.sourceDigests, plan.sourceDigests) ||
            !same(currentPlan.targetQuantities, plan.targetQuantities)) {
            fail("MIGRATION_SOURCE_DRIFT", "Financial migration sources changed after dry-run approval.", {
                conflicts: currentPlan?.conflicts || []
            });
        }
        return sources;
    }

    async function processEconomy(playFabId, token, epoch, playerEpoch, plan, renewLeases) {
        let job = await assertJobLease(playFabId, token, epoch);
        let checkpoint = job.checkpoints[ECONOMY_CHECKPOINT];
        if (!checkpoint) {
            const sources = await sourceDriftCheck(playFabId, plan);
            if (!same(sources.economyV2Quantities, plan.observedEconomyV2Quantities) ||
                sources.economyV2Etag !== plan.economyV2Etag) {
                fail("MIGRATION_ECONOMY_DRIFT", "Economy v2 changed after the approved dry-run.", {
                    conflicts: [{ resource: "EconomyV2", reason: "pre_intent_drift" }]
                });
            }
            if (plan.economyRewards.length === 0) {
                checkpoint = {
                    status: "NoOpVerified",
                    operationId: plan.economyOperationId,
                    requestHash: plan.economyRequestHash,
                    observedQuantities: clone(sources.economyV2Quantities),
                    jobLeaseEpoch: epoch,
                    playerLeaseEpoch: playerEpoch,
                    createdAtUnixMs: safeNow(nowMilliseconds)
                };
            } else {
                checkpoint = checkpointIntent({
                    operationId: plan.economyOperationId,
                    requestHash: plan.economyRequestHash,
                    intent: {
                        idempotencyCreatedAtUtc: plan.idempotencyCreatedAtUtc,
                        rewards: plan.economyRewards,
                        etag: plan.economyV2Etag
                    },
                    epoch,
                    playerEpoch,
                    nowUnixMs: safeNow(nowMilliseconds)
                });
            }
            job = await ensureCheckpoint(playFabId, token, epoch, ECONOMY_CHECKPOINT, checkpoint);
            checkpoint = job.checkpoints[ECONOMY_CHECKPOINT];
            await faultInjector("after_economy_intent", { playFabId, checkpoint: clone(checkpoint), epoch });
        }
        if (checkpoint.status === "NoOpVerified" || checkpoint.status === "StepApplied") return checkpoint;
        if (checkpoint.status !== "StepPending" || checkpoint.operationId !== plan.economyOperationId ||
            checkpoint.requestHash !== plan.economyRequestHash) {
            fail("MIGRATION_CHECKPOINT_CONFLICT", "Economy migration intent differs from the approved plan.");
        }
        await renewLeases();
        const result = await economyAdapter.grant({
            playFabId,
            operationId: checkpoint.operationId,
            idempotencyCreatedAtUtc: checkpoint.intent.idempotencyCreatedAtUtc,
            rewards: clone(checkpoint.intent.rewards),
            etag: checkpoint.intent.etag
        });
        await faultInjector("after_economy_provider", { playFabId, result: clone(result), epoch });
        job = await applyCheckpoint(playFabId, token, epoch, ECONOMY_CHECKPOINT, {
            status: result.status,
            idempotencyId: result.idempotencyId,
            transactionIds: clone(result.transactionIds),
            etag: result.etag,
            operationCount: result.operationCount
        });
        await faultInjector("after_economy_checkpoint", {
            playFabId,
            checkpoint: clone(job.checkpoints[ECONOMY_CHECKPOINT]),
            epoch
        });
        return job.checkpoints[ECONOMY_CHECKPOINT];
    }

    async function processAuthority(playFabId, token, epoch, playerEpoch, plan, renewLeases) {
        let job = await assertJobLease(playFabId, token, epoch);
        let checkpoint = job.checkpoints[AUTHORITY_CHECKPOINT];
        let snapshot = await authorityStore.read(playFabId);
        if (snapshot?.migrated && !verifyAuthority(snapshot, plan)) {
            fail("EXISTING_AUTHORITY_CONFLICT", "Existing FinancialAuthorityV2 migration proof differs.", {
                conflicts: [{ resource: "FinancialAuthorityV2", reason: "migration_proof_conflict" }]
            });
        }
        if (!checkpoint) {
            const id = operationId(playFabId, plan.planHash, AUTHORITY_CHECKPOINT);
            checkpoint = checkpointIntent({
                operationId: id,
                requestHash: digest({ playFabId, authority: plan.initialAuthority }),
                intent: {
                    authority: plan.initialAuthority,
                    initialExpectedObjectVersion: snapshot?.objectVersion ?? plan.authorityObjectVersion
                },
                epoch,
                playerEpoch,
                nowUnixMs: safeNow(nowMilliseconds)
            });
            job = await ensureCheckpoint(playFabId, token, epoch, AUTHORITY_CHECKPOINT, checkpoint);
            checkpoint = job.checkpoints[AUTHORITY_CHECKPOINT];
            await faultInjector("after_authority_intent", { playFabId, checkpoint: clone(checkpoint), epoch });
        }
        if (checkpoint.status === "StepApplied") return checkpoint;
        if (checkpoint.status !== "StepPending" ||
            checkpoint.requestHash !== digest({ playFabId, authority: plan.initialAuthority })) {
            fail("MIGRATION_CHECKPOINT_CONFLICT", "Authority migration intent differs from the approved plan.");
        }
        let result = null;
        for (let attempt = 1; attempt <= maximumCasAttempts; attempt += 1) {
            await renewLeases();
            snapshot = await authorityStore.read(playFabId);
            if (snapshot?.migrated) {
                if (!verifyAuthority(snapshot, plan)) {
                    fail("EXISTING_AUTHORITY_CONFLICT", "FinancialAuthorityV2 appeared with another proof.");
                }
                result = { applied: false, reason: "already_migrated", ...snapshot };
                break;
            }
            result = await authorityStore.initialize({
                playFabId,
                expectedObjectVersion: snapshot.objectVersion,
                authority: clone(checkpoint.intent.authority)
            });
            if (result?.applied === true || result?.reason === "already_migrated") break;
            if (result?.reason !== "version_conflict") {
                fail("MIGRATION_AUTHORITY_PROTOCOL", "Authority store returned an invalid initialization result.");
            }
        }
        if (!result || result.reason === "version_conflict") {
            fail("MIGRATION_AUTHORITY_CAS_EXHAUSTED", "Authority initialization CAS retries were exhausted.", {
                retryable: true
            });
        }
        await faultInjector("after_authority_provider", { playFabId, result: clone(result), epoch });
        if (!verifyAuthority(result, plan)) {
            fail("MIGRATION_AUTHORITY_VERIFY_FAILED", "Authority initialization proof is absent.");
        }
        job = await applyCheckpoint(playFabId, token, epoch, AUTHORITY_CHECKPOINT, {
            status: result.applied === true ? "applied" : "already_migrated",
            objectVersion: result.objectVersion,
            financialRevision: result.financialRevision
        });
        await faultInjector("after_authority_checkpoint", {
            playFabId,
            checkpoint: clone(job.checkpoints[AUTHORITY_CHECKPOINT]),
            epoch
        });
        return job.checkpoints[AUTHORITY_CHECKPOINT];
    }

    async function verifyFinal(playFabId, token, epoch, plan, renewLeases) {
        await renewLeases();
        const job = await assertJobLease(playFabId, token, epoch);
        const economyStep = job.checkpoints[ECONOMY_CHECKPOINT];
        if (!economyStep || !["NoOpVerified", "StepApplied"].includes(economyStep.status) ||
            job.checkpoints[AUTHORITY_CHECKPOINT]?.status !== "StepApplied") {
            fail("MIGRATION_CHECKPOINT_MISSING", "Final migration checkpoints are incomplete.");
        }
        let economyEvidence = null;
        if (economyStep.status === "StepApplied") {
            economyEvidence = await economyAdapter.verify({
                playFabId,
                operationId: economyStep.operationId,
                idempotencyCreatedAtUtc: economyStep.intent.idempotencyCreatedAtUtc,
                rewards: clone(economyStep.intent.rewards),
                etag: economyStep.intent.etag
            });
        }
        const sources = await sourceDriftCheck(playFabId, plan);
        const authority = await authorityStore.read(playFabId);
        if (!exactEconomy(sources, plan) || !verifyAuthority(authority, plan)) {
            fail("MIGRATION_FINAL_VERIFY_FAILED", "Final Economy v2 or FinancialAuthorityV2 state differs from the plan.", {
                conflicts: [{ resource: "financial_v2", reason: "final_state_mismatch" }]
            });
        }
        const verification = {
            status: "Completed",
            planHash: plan.planHash,
            economyOperationId: economyStep.operationId,
            economyIdempotencyId: economyEvidence?.idempotencyId ?? null,
            authorityObjectVersion: authority.objectVersion,
            authorityFinancialRevision: authority.financialRevision,
            verifiedAtUnixMs: safeNow(nowMilliseconds)
        };
        await ensureCheckpoint(playFabId, token, epoch, VERIFIED_CHECKPOINT, verification);
        await faultInjector("before_completed", { playFabId, verification: clone(verification), epoch });
        return setTerminal(playFabId, token, epoch, "Completed");
    }

    async function process(playFabId) {
        canonical(playFabId, "playFabId", 128);
        if (!enabled) return Object.freeze({ status: "disabled", record: null });
        const before = await jobStore.get(playFabId);
        if (!before) return Object.freeze({ status: "missing", record: null });
        if (before.mode === "apply" && !allowProviderWrites) {
            return Object.freeze({ status: "writes_disabled", record: before });
        }
        const token = canonical(makeToken(), "job lease token", 320);
        const acquired = await jobStore.acquireLease(playFabId, {
            owner: workerId,
            token,
            ttlMilliseconds: leaseTtlMilliseconds,
            nowUnixMs: safeNow(nowMilliseconds)
        });
        if (acquired.status !== "acquired") return acquired;
        const epoch = acquired.record.leaseEpoch;
        let playerLease = null;
        let playerToken = null;
        let crashed = false;
        let completed = null;
        let heartbeatTimer = null;
        let heartbeatPromise = null;
        let heartbeatError = null;

        async function renewLeases() {
            const renewed = await jobStore.renewLease(playFabId, {
                token,
                epoch,
                ttlMilliseconds: leaseTtlMilliseconds,
                nowUnixMs: safeNow(nowMilliseconds)
            });
            if (renewed.status !== "renewed") {
                fail("STALE_MIGRATION_WORKER", "Financial migration job lease renewal was rejected.");
            }
            if (playerLease) {
                const player = await playerLeaseManager.renewResourceLease({
                    resourceType: "playfab-profile",
                    resourceId: playFabId,
                    token: playerToken,
                    ttlMilliseconds: leaseTtlMilliseconds
                });
                if (player.status !== "renewed" && player.status !== "acquired") {
                    fail("STALE_MIGRATION_PLAYER_WORKER", "Financial migration player lease renewal was rejected.");
                }
                playerLease = player.lease || playerLease;
            }
            if (heartbeatError) throw heartbeatError;
        }

        function scheduleHeartbeat() {
            if (heartbeatTimer !== null) clearTimeoutImpl(heartbeatTimer);
            heartbeatTimer = setTimeoutImpl(() => {
                heartbeatPromise = renewLeases().catch((error) => { heartbeatError ||= error; });
                heartbeatPromise.finally(() => {
                    heartbeatPromise = null;
                    if (!crashed && completed === null) scheduleHeartbeat();
                });
            }, Math.max(1, Math.floor(leaseTtlMilliseconds / 3)));
            heartbeatTimer?.unref?.();
        }

        async function stopHeartbeat() {
            if (heartbeatTimer !== null) clearTimeoutImpl(heartbeatTimer);
            heartbeatTimer = null;
            if (heartbeatPromise) await heartbeatPromise;
        }

        try {
            scheduleHeartbeat();
            await faultInjector("after_claim", { playFabId, epoch });
            let job = await buildAndPersistPlan(playFabId, token, epoch);
            if (job.state === "ManualReview") {
                completed = Object.freeze({ status: "manual_review", record: job });
                return completed;
            }
            const plan = job.plan;
            if (job.mode === "dry_run") {
                job = await setTerminal(playFabId, token, epoch, "DryRunCompleted");
                completed = Object.freeze({ status: "dry_run_completed", record: job });
                metric("financial_migration_dry_run_completed");
                return completed;
            }
            if (!allowProviderWrites) {
                fail("MIGRATION_WRITES_DISABLED", "Financial migration provider writes are disabled.");
            }
            playerToken = canonical(makeToken(), "player lease token", 255);
            const player = await playerLeaseManager.acquireResourceLease({
                resourceType: "playfab-profile",
                resourceId: playFabId,
                owner: workerId,
                token: playerToken,
                ttlMilliseconds: leaseTtlMilliseconds
            });
            if (player.status !== "acquired") {
                fail("MIGRATION_PLAYER_BUSY", "The shared PlayFab profile lease is busy.", { retryable: true });
            }
            playerLease = player.lease;
            await processEconomy(playFabId, token, epoch, playerLease.epoch, plan, renewLeases);
            await processAuthority(playFabId, token, epoch, playerLease.epoch, plan, renewLeases);
            job = await verifyFinal(playFabId, token, epoch, plan, renewLeases);
            completed = Object.freeze({ status: "completed", record: job });
            metric("financial_migration_completed");
            return completed;
        } catch (error) {
            if (error?.simulatedCrash === true) {
                crashed = true;
                throw error;
            }
            const stale = error?.code === "STALE_MIGRATION_WORKER" ||
                error?.code === "STALE_MIGRATION_PLAYER_WORKER";
            if (stale) {
                completed = Object.freeze({ status: "stale_worker", record: await jobStore.get(playFabId), error });
                metric("financial_migration_fencing_reject");
                return completed;
            }
            try {
                const latest = await assertJobLease(playFabId, token, epoch);
                const conflicts = Array.isArray(error?.conflicts) ? error.conflicts : [];
                if (error?.retryable === true && latest.attemptCount < maximumRetries) {
                    const delay = error?.retryAfterMilliseconds && Number.isSafeInteger(error.retryAfterMilliseconds)
                        ? Math.min(retryMaximumMilliseconds, Math.max(1, error.retryAfterMilliseconds))
                        : deterministicBackoff(playFabId, latest.attemptCount,
                            retryBaseMilliseconds, retryMaximumMilliseconds);
                    const failed = await setTerminal(playFabId, token, epoch, "Failed", {
                        lastError: errorRecord(error),
                        nextAttemptAtUnixMs: safeNow(nowMilliseconds) + delay
                    });
                    completed = Object.freeze({ status: "retry_scheduled", record: failed, error });
                    metric("financial_migration_retry_scheduled");
                    return completed;
                }
                const reviewed = await setTerminal(playFabId, token, epoch, "ManualReview", {
                    conflicts,
                    lastError: errorRecord(error)
                });
                completed = Object.freeze({ status: "manual_review", record: reviewed, error });
                metric("financial_migration_manual_review");
                return completed;
            } catch (persistError) {
                completed = Object.freeze({
                    status: "stale_worker",
                    record: await jobStore.get(playFabId),
                    error: persistError
                });
                metric("financial_migration_fencing_reject");
                return completed;
            }
        } finally {
            await stopHeartbeat();
            if (!crashed) {
                if (playerLease) {
                    await playerLeaseManager.releaseResourceLease({
                        resourceType: "playfab-profile",
                        resourceId: playFabId,
                        token: playerToken
                    }).catch(() => {});
                }
                await jobStore.releaseLease(playFabId, {
                    token,
                    epoch,
                    nowUnixMs: safeNow(nowMilliseconds)
                }).catch(() => {});
            }
        }
    }

    async function scanOnce() {
        if (!enabled) return Object.freeze({ status: "disabled", processed: 0, results: [] });
        const results = [];
        let cursor = "0";
        do {
            const page = await jobStore.scan({ cursor, limit: scanPageSize });
            for (const job of page.items) {
                const now = safeNow(nowMilliseconds);
                const eligible = job.state === "Queued" ||
                    job.state === "Failed" && (job.nextAttemptAtUnixMs === null || job.nextAttemptAtUnixMs <= now) ||
                    job.state === "Processing" && (job.leaseExpiresAtUnixMs === null || job.leaseExpiresAtUnixMs <= now);
                if (!eligible || job.mode === "apply" && !allowProviderWrites) continue;
                results.push(await process(job.playFabId));
            }
            cursor = page.nextCursor;
        } while (cursor !== null);
        lastLoopAtUnixMs = safeNow(nowMilliseconds);
        lastLoopError = null;
        return Object.freeze({ status: "ok", processed: results.length, results: Object.freeze(results) });
    }

    function scheduleLoop() {
        if (!running) return;
        timer = setTimeoutImpl(() => {
            activeLoop = scanOnce().catch((error) => {
                lastLoopError = errorRecord(error);
                metric("financial_migration_loop_failure");
            }).finally(() => {
                activeLoop = null;
                scheduleLoop();
            });
        }, loopIntervalMilliseconds);
        timer?.unref?.();
    }

    function start() {
        if (!enabled) return Object.freeze({ status: "disabled" });
        if (running) return Object.freeze({ status: "already_running" });
        running = true;
        scheduleLoop();
        return Object.freeze({ status: "started" });
    }

    async function stop() {
        running = false;
        if (timer !== null) clearTimeoutImpl(timer);
        timer = null;
        if (activeLoop) await activeLoop;
        return Object.freeze({ status: "stopped" });
    }

    function health() {
        return Object.freeze({
            enabled,
            allowProviderWrites,
            running,
            durableStore: jobStore?.durable === true,
            lastLoopAtUnixMs,
            lastLoopError: lastLoopError ? clone(lastLoopError) : null,
            authorityVersion: "financial_v2"
        });
    }

    return Object.freeze({
        enqueueDryRun,
        approveApply,
        get,
        process,
        scanOnce,
        start,
        stop,
        health
    });
}
