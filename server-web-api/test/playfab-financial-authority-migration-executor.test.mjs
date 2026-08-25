import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createMemoryFinancialAuthorityMigrationJobStore,
    createRedisFinancialAuthorityMigrationJobStore,
    createFinancialAuthorityMigrationJob,
    FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS
} from "../src/financial-authority-migration-job-store.js";
import {
    createPlayFabFinancialAuthorityMigrationExecutor,
    FinancialAuthorityMigrationSimulatedCrash
} from "../src/playfab-financial-authority-migration-executor.js";

const playFabId = "46789223F9CB1BB9";
const rewardIds = [
    "diamonds",
    "elite_ball",
    "poison_cannonball",
    "thors_wrath",
    "green_amulet",
    "blue_amulet",
    "red_amulet",
    "diamond_offensive_powder",
    "diamond_armor_plate",
    "harpoon_diamond_250",
    "star_dust",
    "carronade",
    "long_range_cannon"
];

function profile(id = playFabId, overrides = {}) {
    return {
        schemaVersion: 12,
        playerAccountId: id,
        ammo: [
            { id: "elite_ball", amount: 13_000 },
            { id: "poison_cannonball", amount: 0 }
        ],
        usableItems: [
            { id: "thors_wrath", amount: 5 },
            { id: "green_amulet", amount: 10 },
            { id: "blue_amulet", amount: 0 },
            { id: "red_amulet", amount: 0 },
            { id: "diamond_offensive_powder", amount: 100 },
            { id: "diamond_armor_plate", amount: 100 },
            { id: "star_dust", amount: 12 }
        ],
        cannons: [
            { id: "carronade", owned: 2, equipped: 0 },
            { id: "long_range_cannon", owned: 0, equipped: 0 }
        ],
        harpoons: { quantities: [{ id: "harpoon_diamond_250", amount: 100 }] },
        ownedDestinationMarkerIds: ["destination_red_point"],
        ownedShipDesignIds: [],
        shopEntitlements: [],
        durableEconomyTransactions: [],
        ...overrides
    };
}

function zeroEconomy() {
    return Object.fromEntries(rewardIds.map((id) => [id, 0]));
}

function createMockEnvironment({ nowRef = { value: 1_777_000_000_000 }, failEconomyOnce = false,
    authorityConflictOnce = false } = {}) {
    const profiles = new Map();
    const economy = new Map();
    const authorities = new Map();
    const authorityVersions = new Map();
    const economyOperations = new Map();
    const playerLeases = new Map();
    const playerEpochs = new Map();
    let economyEffectCount = 0;
    let authorityEffectCount = 0;
    let economyCalls = 0;
    let authorityCalls = 0;
    let shouldFailEconomy = failEconomyOnce;
    let shouldConflictAuthority = authorityConflictOnce;

    function ensure(id) {
        if (!profiles.has(id)) profiles.set(id, profile(id));
        if (!economy.has(id)) economy.set(id, { quantities: zeroEconomy(), etag: `etag-${id}-0` });
        if (!authorityVersions.has(id)) authorityVersions.set(id, 0);
    }

    async function loadSources(id) {
        ensure(id);
        const state = economy.get(id);
        return {
            profileV1: structuredClone(profiles.get(id)),
            financialProfileV1: null,
            legacyDmBalance: 1_000,
            economyV2Quantities: structuredClone(state.quantities),
            economyV2Etag: state.etag
        };
    }

    const economyAdapter = {
        async grant(request) {
            economyCalls += 1;
            const serialized = JSON.stringify(request);
            const existing = economyOperations.get(request.operationId);
            if (existing) {
                assert.equal(existing.request, serialized, "idempotent replay must preserve the exact Economy body");
                return structuredClone(existing.result);
            }
            if (shouldFailEconomy) {
                shouldFailEconomy = false;
                const error = new Error("mock 429");
                error.code = "PLAYFAB_THROTTLED";
                error.retryable = true;
                error.retryAfterMilliseconds = 2_000;
                throw error;
            }
            ensure(request.playFabId);
            const state = economy.get(request.playFabId);
            assert.equal(request.etag, state.etag);
            for (const reward of request.rewards) state.quantities[reward.rewardId] += reward.quantity;
            economyEffectCount += 1;
            state.etag = `etag-${request.playFabId}-${economyEffectCount}`;
            const result = {
                status: "confirmed",
                idempotencyId: request.operationId,
                transactionIds: [`tx-${economyEffectCount}`],
                etag: state.etag,
                operationCount: request.rewards.length
            };
            economyOperations.set(request.operationId, { request: serialized, result: structuredClone(result) });
            return result;
        },
        async verify(request) {
            return { ...(await this.grant(request)), status: "verified" };
        }
    };

    const authorityStore = {
        async read(id) {
            ensure(id);
            const authority = authorities.get(id) || null;
            return {
                migrated: authority !== null,
                objectVersion: authorityVersions.get(id),
                financialRevision: authority?.financialRevision ?? 0,
                authority: authority ? structuredClone(authority) : null
            };
        },
        async initialize({ playFabId: id, expectedObjectVersion, authority }) {
            authorityCalls += 1;
            ensure(id);
            if (authorities.has(id)) {
                return { applied: false, reason: "already_migrated", ...(await this.read(id)) };
            }
            if (shouldConflictAuthority) {
                shouldConflictAuthority = false;
                authorityVersions.set(id, authorityVersions.get(id) + 1);
                return { applied: false, reason: "version_conflict", ...(await this.read(id)) };
            }
            if (expectedObjectVersion !== authorityVersions.get(id)) {
                return { applied: false, reason: "version_conflict", ...(await this.read(id)) };
            }
            authorities.set(id, structuredClone(authority));
            authorityVersions.set(id, authorityVersions.get(id) + 1);
            authorityEffectCount += 1;
            return { applied: true, reason: "migrated", ...(await this.read(id)) };
        }
    };

    const playerLeaseManager = {
        async acquireResourceLease({ resourceType, resourceId, owner, token, ttlMilliseconds }) {
            assert.equal(resourceType, "playfab-profile");
            const key = `${resourceType}:${resourceId}`;
            const existing = playerLeases.get(key);
            if (existing && existing.expiresAtUnixMs > nowRef.value) {
                return existing.token === token
                    ? { status: "acquired", lease: structuredClone(existing) }
                    : { status: "busy", lease: structuredClone(existing) };
            }
            const epoch = (playerEpochs.get(key) || 0) + 1;
            playerEpochs.set(key, epoch);
            const lease = { owner, token, epoch, expiresAtUnixMs: nowRef.value + ttlMilliseconds };
            playerLeases.set(key, lease);
            return { status: "acquired", lease: structuredClone(lease) };
        },
        async renewResourceLease({ resourceType, resourceId, token, ttlMilliseconds }) {
            const key = `${resourceType}:${resourceId}`;
            const existing = playerLeases.get(key);
            if (!existing || existing.token !== token || existing.expiresAtUnixMs <= nowRef.value) {
                return { status: "lease_conflict", lease: existing ? structuredClone(existing) : null };
            }
            existing.expiresAtUnixMs = nowRef.value + ttlMilliseconds;
            return { status: "renewed", lease: structuredClone(existing) };
        },
        async releaseResourceLease({ resourceType, resourceId, token }) {
            const key = `${resourceType}:${resourceId}`;
            const existing = playerLeases.get(key);
            if (!existing || existing.token !== token) return { status: "lease_conflict" };
            playerLeases.delete(key);
            return { status: "released", lease: structuredClone(existing) };
        }
    };

    return {
        nowRef,
        loadSources,
        economyAdapter,
        authorityStore,
        playerLeaseManager,
        profiles,
        economy,
        authorities,
        stats() {
            return { economyEffectCount, authorityEffectCount, economyCalls, authorityCalls };
        }
    };
}

function executor(store, environment, overrides = {}) {
    let token = 0;
    return createPlayFabFinancialAuthorityMigrationExecutor({
        enabled: true,
        allowProviderWrites: true,
        jobStore: store,
        loadSources: environment.loadSources,
        economyAdapter: environment.economyAdapter,
        authorityStore: environment.authorityStore,
        playerLeaseManager: environment.playerLeaseManager,
        workerId: overrides.workerId || "migration-test-worker",
        leaseTtlMilliseconds: 300,
        retryBaseMilliseconds: 100,
        retryMaximumMilliseconds: 10_000,
        loopIntervalMilliseconds: 1_000,
        nowMilliseconds: () => environment.nowRef.value,
        makeToken: () => `${overrides.workerId || "worker"}-token-${++token}`,
        faultInjector: overrides.faultInjector || (async () => {}),
        ...overrides
    });
}

async function dryRunAndApprove(service, id = playFabId) {
    assert.equal((await service.enqueueDryRun(id)).status, "created");
    const dry = await service.process(id);
    assert.equal(dry.status, "dry_run_completed");
    const planHash = (await service.get(id)).plan.planHash;
    assert.equal((await service.approveApply({ playFabId: id, expectedPlanHash: planHash })).status, "promoted");
    return planHash;
}

describe("FinancialAuthorityV2 migration executor", () => {
    test("is inert without explicit enablement and provider-write gates", async () => {
        const disabled = createPlayFabFinancialAuthorityMigrationExecutor();
        assert.deepEqual(await disabled.enqueueDryRun(playFabId), { status: "disabled", record: null });
        assert.equal((await disabled.scanOnce()).processed, 0);
        assert.equal(disabled.start().status, "disabled");
        assert.equal(disabled.health().allowProviderWrites, false);

        const environment = createMockEnvironment();
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const dryOnly = createPlayFabFinancialAuthorityMigrationExecutor({
            enabled: true,
            allowProviderWrites: false,
            jobStore: store,
            loadSources: environment.loadSources,
            authorityStore: environment.authorityStore,
            nowMilliseconds: () => environment.nowRef.value,
            makeToken: () => "dry-only-token"
        });
        await dryOnly.enqueueDryRun(playFabId);
        assert.equal((await dryOnly.process(playFabId)).status, "dry_run_completed");
        const planHash = (await dryOnly.get(playFabId)).plan.planHash;
        assert.equal((await dryOnly.approveApply({ playFabId, expectedPlanHash: planHash })).status,
            "writes_disabled");
        assert.deepEqual(environment.stats(), {
            economyEffectCount: 0, authorityEffectCount: 0, economyCalls: 0, authorityCalls: 0
        });
    });

    test("dry-run durably records an immutable plan and cannot mutate providers", async () => {
        const environment = createMockEnvironment();
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const service = executor(store, environment);
        await service.enqueueDryRun(playFabId);
        const result = await service.process(playFabId);
        assert.equal(result.status, "dry_run_completed");
        const saved = await service.get(playFabId);
        assert.equal(saved.state, "DryRunCompleted");
        assert.match(saved.plan.planHash, /^[a-f0-9]{64}$/u);
        assert.equal(saved.checkpoints.plan_created.planHash, saved.plan.planHash);
        assert.equal(environment.stats().economyCalls, 0);
        assert.equal(environment.stats().authorityCalls, 0);
        assert.equal((await service.approveApply({ playFabId, expectedPlanHash: "f".repeat(64) })).status,
            "invalid_state");
        assert.equal((await service.get(playFabId)).mode, "dry_run");
    });

    test("planner conflict becomes terminal ManualReview with zero provider effects", async () => {
        const environment = createMockEnvironment();
        environment.profiles.set(playFabId, profile(playFabId));
        const originalLoader = environment.loadSources;
        environment.loadSources = async (id) => ({
            ...(await originalLoader(id)),
            financialProfileV1: profile(id, { ammo: [{ id: "elite_ball", amount: 12_999 }] })
        });
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const service = executor(store, environment);
        await service.enqueueDryRun(playFabId);
        const result = await service.process(playFabId);
        assert.equal(result.status, "manual_review");
        assert.equal((await service.get(playFabId)).state, "ManualReview");
        assert.equal(environment.stats().economyEffectCount, 0);
        assert.equal(environment.stats().authorityEffectCount, 0);
    });

    test("approved migration applies exact quantities, initializes authority and completes", async () => {
        const environment = createMockEnvironment();
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const service = executor(store, environment);
        await dryRunAndApprove(service);
        const result = await service.process(playFabId);
        assert.equal(result.status, "completed");
        const job = await service.get(playFabId);
        assert.equal(job.state, "Completed");
        assert.equal(job.checkpoints.economy_v2_seed.status, "StepApplied");
        assert.equal(job.checkpoints.authority_v2_initialize.status, "StepApplied");
        assert.equal(job.checkpoints.migration_verified.status, "Completed");
        const quantities = environment.economy.get(playFabId).quantities;
        assert.equal(quantities.diamonds, 1_000);
        assert.equal(quantities.elite_ball, 13_000);
        assert.equal(quantities.harpoon_diamond_250, 100);
        assert.equal(quantities.carronade, 2);
        assert.equal(environment.stats().economyEffectCount, 1);
        assert.equal(environment.stats().authorityEffectCount, 1);
        assert.equal(environment.authorities.get(playFabId).migration.state, "Completed");
    });

    test("crash after Economy commit resumes with identical idempotency body and no double delta", async () => {
        const environment = createMockEnvironment();
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const setup = executor(store, environment, { workerId: "setup" });
        await dryRunAndApprove(setup);
        let crashed = false;
        const first = executor(store, environment, {
            workerId: "crasher",
            faultInjector: async (point) => {
                if (point === "after_economy_provider" && !crashed) {
                    crashed = true;
                    throw new FinancialAuthorityMigrationSimulatedCrash(point);
                }
            }
        });
        await assert.rejects(first.process(playFabId), (error) => error.simulatedCrash === true);
        assert.equal(environment.stats().economyEffectCount, 1);
        assert.equal((await first.get(playFabId)).checkpoints.economy_v2_seed.status, "StepPending");
        environment.nowRef.value += 301;
        const restarted = executor(store, environment, { workerId: "restart" });
        const resumed = await restarted.scanOnce();
        assert.equal(resumed.results[0].status, "completed");
        assert.equal(environment.stats().economyEffectCount, 1);
        assert.ok(environment.stats().economyCalls >= 3, "grant replay plus final verification were exercised");
        assert.equal(environment.economy.get(playFabId).quantities.diamonds, 1_000);
    });

    test("ten concurrent workers have one lease winner and one provider effect", async () => {
        const environment = createMockEnvironment();
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const setup = executor(store, environment, { workerId: "setup-multi" });
        await dryRunAndApprove(setup);
        const services = Array.from({ length: 10 }, (_, index) =>
            executor(store, environment, { workerId: `multi-${index}` }));
        const results = await Promise.all(services.map((service) => service.process(playFabId)));
        assert.equal(results.filter((result) => result.status === "completed").length, 1);
        assert.equal(results.filter((result) => result.status === "busy" || result.status === "terminal").length, 9);
        assert.equal(environment.stats().economyEffectCount, 1);
        assert.equal(environment.stats().authorityEffectCount, 1);
    });

    test("retry schedule survives executor reconstruction and honors Retry-After", async () => {
        const environment = createMockEnvironment({ failEconomyOnce: true });
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const first = executor(store, environment, { workerId: "retry-a" });
        await dryRunAndApprove(first);
        const failed = await first.process(playFabId);
        assert.equal(failed.status, "retry_scheduled");
        let saved = await first.get(playFabId);
        assert.equal(saved.state, "Failed");
        assert.equal(saved.nextAttemptAtUnixMs, environment.nowRef.value + 2_000);
        const restarted = executor(store, environment, { workerId: "retry-b" });
        assert.equal((await restarted.scanOnce()).processed, 0);
        environment.nowRef.value += 2_000;
        assert.equal((await restarted.scanOnce()).results[0].status, "completed");
        saved = await restarted.get(playFabId);
        assert.equal(saved.state, "Completed");
        assert.equal(environment.stats().economyEffectCount, 1);
    });

    test("authority CAS conflict is retried without changing the approved plan", async () => {
        const environment = createMockEnvironment({ authorityConflictOnce: true });
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const service = executor(store, environment);
        const planHash = await dryRunAndApprove(service);
        assert.equal((await service.process(playFabId)).status, "completed");
        assert.equal((await service.get(playFabId)).plan.planHash, planHash);
        assert.equal(environment.stats().authorityCalls, 2);
        assert.equal(environment.stats().authorityEffectCount, 1);
    });

    test("source drift after approval is quarantined in ManualReview before provider mutation", async () => {
        const environment = createMockEnvironment();
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const service = executor(store, environment);
        await dryRunAndApprove(service);
        environment.profiles.get(playFabId).usableItems[0].amount += 1;
        const result = await service.process(playFabId);
        assert.equal(result.status, "manual_review");
        assert.equal(result.record.lastError.code, "MIGRATION_SOURCE_DRIFT");
        assert.equal(environment.stats().economyEffectCount, 0);
        assert.equal(environment.stats().authorityEffectCount, 0);
    });

    test("stale transaction fencing rejects a worker after lease takeover", async () => {
        const nowRef = { value: 10_000 };
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        await store.create(createFinancialAuthorityMigrationJob({ playFabId, nowUnixMs: nowRef.value }));
        const first = await store.acquireLease(playFabId, {
            owner: "a", token: "token-a", ttlMilliseconds: 100, nowUnixMs: nowRef.value
        });
        nowRef.value += 101;
        const second = await store.acquireLease(playFabId, {
            owner: "b", token: "token-b", ttlMilliseconds: 100, nowUnixMs: nowRef.value
        });
        assert.equal(second.record.leaseEpoch, first.record.leaseEpoch + 1);
        const forged = structuredClone(first.record);
        forged.state = "Completed";
        const stale = await store.compareAndSet(playFabId, {
            expectedVersion: first.record.version,
            token: "token-a",
            epoch: first.record.leaseEpoch,
            next: forged,
            nowUnixMs: nowRef.value
        });
        assert.ok(["version_conflict", "lease_conflict"].includes(stale.status));
        assert.equal((await store.get(playFabId)).state, "Processing");
    });

    test("existing mismatched authority proof is ManualReview and is never overwritten", async () => {
        const environment = createMockEnvironment();
        const other = profile(playFabId);
        const store = createMemoryFinancialAuthorityMigrationJobStore();
        const first = executor(store, environment);
        await first.enqueueDryRun(playFabId);
        environment.authorities.set(playFabId, {
            schemaVersion: 2,
            authorityVersion: "financial_v2",
            legacyPlayFabId: playFabId,
            financialRevision: 1,
            lastFencingToken: 0,
            appliedOperations: [],
            appliedTransactionIds: [],
            paidDestinationMarkerIds: [],
            paidShipDesignIds: [],
            ownedStarterSkus: [],
            premium: { tier: 0, activatedAtUtcIso8601: null, expiresAtUtcIso8601: null },
            migration: {
                state: "Completed",
                migratedAtUtc: new Date(environment.nowRef.value).toISOString(),
                sourceDigests: {
                    profileV1: "a".repeat(64), financialV1: "b".repeat(64), legacyDm: "c".repeat(64)
                }
            }
        });
        environment.profiles.set(playFabId, other);
        const result = await first.process(playFabId);
        assert.equal(result.status, "manual_review");
        assert.equal(environment.stats().authorityEffectCount, 0);
        assert.equal(environment.stats().economyEffectCount, 0);
    });
});

class RedisMigrationHarness {
    constructor() {
        this.values = new Map();
        this.sortedSets = new Map();
    }
    async get(key) { return this.values.get(key) ?? null; }
    async mGet(keys) { return keys.map((key) => this.values.get(key) ?? null); }
    async ping() { return "PONG"; }
    async zRange(key, start, stop) {
        return [...(this.sortedSets.get(key) || new Map()).entries()]
            .sort(([left, leftScore], [right, rightScore]) => leftScore - rightScore || left.localeCompare(right))
            .slice(start, stop + 1).map(([member]) => member);
    }
    zadd(key, score, member) {
        const values = this.sortedSets.get(key) || new Map();
        values.set(member, Number(score));
        this.sortedSets.set(key, values);
    }
    response(status, record = null) {
        return [status, record === null ? "" : JSON.stringify(record)];
    }
    async eval(script, { keys, arguments: args }) {
        const marker = script.split("\n", 1)[0];
        if (marker.includes("CREATE")) {
            const existing = this.values.get(keys[0]);
            if (existing) return ["existing", existing];
            this.values.set(keys[0], args[0]);
            this.zadd(keys[1], args[1], keys[0]);
            return ["created", args[0]];
        }
        const text = this.values.get(keys[0]);
        if (!text) return this.response("missing");
        const record = JSON.parse(text);
        if (marker.includes("ACQUIRE")) {
            const now = Number(args[0]);
            const active = record.leaseToken !== null && record.leaseExpiresAtUnixMs > now;
            if (active) return this.response(record.leaseToken === args[2] ? "acquired" : "busy", record);
            if (!["Queued", "Failed", "Processing"].includes(record.state)) return this.response("terminal", record);
            record.state = "Processing";
            record.leaseOwner = args[1];
            record.leaseToken = args[2];
            record.leaseEpoch += 1;
            record.leaseExpiresAtUnixMs = now + Number(args[3]);
            record.attemptCount += 1;
            record.updatedAtUnixMs = now;
            record.version += 1;
            this.values.set(keys[0], JSON.stringify(record));
            return this.response("acquired", record);
        }
        if (marker.includes("RENEW")) {
            const now = Number(args[0]);
            if (record.leaseToken !== args[1] || record.leaseEpoch !== Number(args[2]) ||
                record.leaseExpiresAtUnixMs <= now) return this.response("lease_conflict", record);
            record.leaseExpiresAtUnixMs = now + Number(args[3]);
            record.updatedAtUnixMs = now;
            record.version += 1;
            this.values.set(keys[0], JSON.stringify(record));
            return this.response("renewed", record);
        }
        if (marker.includes("RELEASE")) {
            if (record.leaseToken !== args[1] || record.leaseEpoch !== Number(args[2])) {
                return this.response("lease_conflict", record);
            }
            record.leaseOwner = null;
            record.leaseToken = null;
            record.leaseExpiresAtUnixMs = null;
            record.updatedAtUnixMs = Number(args[0]);
            record.version += 1;
            this.values.set(keys[0], JSON.stringify(record));
            return this.response("released", record);
        }
        if (marker.includes("REPLACE")) {
            const now = Number(args[0]);
            if (record.version !== Number(args[1])) return this.response("version_conflict", record);
            if (record.leaseToken !== args[2] || record.leaseEpoch !== Number(args[3]) ||
                record.leaseExpiresAtUnixMs <= now) return this.response("lease_conflict", record);
            const next = JSON.parse(args[5]);
            next.version = record.version + 1;
            next.updatedAtUnixMs = now;
            this.values.set(keys[0], JSON.stringify(next));
            return this.response("replaced", next);
        }
        if (marker.includes("PROMOTE")) {
            if (record.version !== Number(args[0])) return this.response("version_conflict", record);
            if (record.mode !== "dry_run" || record.state !== "DryRunCompleted" ||
                record.plan?.planHash !== args[2]) return this.response("invalid_state", record);
            record.mode = "apply";
            record.state = "Queued";
            record.updatedAtUnixMs = Number(args[1]);
            record.version += 1;
            this.values.set(keys[0], JSON.stringify(record));
            return this.response("promoted", record);
        }
        throw new Error(`Unexpected script ${marker}`);
    }
}

describe("durable Redis financial migration job store", () => {
    test("persists jobs across store reconstruction and fences stale epochs atomically", async () => {
        const redis = new RedisMigrationHarness();
        const firstStore = createRedisFinancialAuthorityMigrationJobStore(redis);
        const created = createFinancialAuthorityMigrationJob({ playFabId, nowUnixMs: 1_000 });
        assert.equal((await firstStore.create(created)).status, "created");
        assert.equal((await firstStore.create(created)).status, "existing");
        const firstLease = await firstStore.acquireLease(playFabId, {
            owner: "redis-a", token: "redis-token-a", ttlMilliseconds: 100, nowUnixMs: 1_000
        });
        const reconstructed = createRedisFinancialAuthorityMigrationJobStore(redis);
        assert.equal((await reconstructed.get(playFabId)).leaseEpoch, 1);
        const secondLease = await reconstructed.acquireLease(playFabId, {
            owner: "redis-b", token: "redis-token-b", ttlMilliseconds: 100, nowUnixMs: 1_101
        });
        assert.equal(secondLease.record.leaseEpoch, 2);
        const staleNext = structuredClone(firstLease.record);
        staleNext.state = "Completed";
        await assert.rejects(firstStore.compareAndSet(playFabId, {
            expectedVersion: firstLease.record.version,
            token: "redis-token-a",
            epoch: firstLease.record.leaseEpoch,
            next: staleNext,
            nowUnixMs: 1_101
        }), /immutable invariant/u);
        assert.equal((await reconstructed.scan()).items.length, 1);
        assert.equal(await reconstructed.ping(), true);
    });

    test("Redis scripts enforce CAS, active lease, epoch and plan-hash approval", () => {
        assert.match(FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS.replace, /version_conflict/u);
        assert.match(FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS.replace, /leaseEpoch/u);
        assert.match(FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS.replace, /leaseExpiresAtUnixMs/u);
        assert.match(FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS.promote, /record\.plan\.planHash ~= ARGV\[3\]/u);
        assert.match(FINANCIAL_AUTHORITY_MIGRATION_REDIS_SCRIPTS.acquire, /record\.leaseEpoch.*\+ 1/u);
    });
});
