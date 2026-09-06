import "./fixtures/diamonds-canary-legacy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    createDiamondsSandboxCanaryMigrationExecutor,
    createPlayFabDiamondsSandboxMigrationStore
} from "../src/diamonds-sandbox-canary-migration-executor.js";
import {
    createDiamondsMigrationProofAwarePlayFabClient,
    DIAMONDS_MIGRATION_PROOF_OBJECT_NAME,
    DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID,
    validateDiamondsMigrationProof
} from "../src/diamonds-migration-proof-companion.js";
import {
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
    DIAMONDS_TARGET_ADAPTER_VERSION,
    planProgressiveFinancialDomainMigration
} from "../src/progressive-financial-domain-migration.js";
import {
    createServerEconomyPocInitialSnapshot,
    serverEconomyPocDigest
} from "../src/server-economy-poc-model.js";
import {
    createServerEconomyPocPlayFabSnapshotStore,
    SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME
} from "../src/server-economy-poc-playfab-snapshot-store.js";
import { createPlayFabFinancialProfileClient } from "../src/playfab-financial-profile-store.js";
import { createDiamondsDomainServerComposition } from "../src/diamonds-domain-server-composition.js";

const PLAYER = DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID;
const TITLE = DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID;
const ENTITY = "714E7F12EDBEA385";
const SCANNER_HASH = "9".repeat(64);

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function fakePlayFab({ legacy = 0, target = createServerEconomyPocInitialSnapshot(PLAYER, 1), profileVersion = 10 } = {}) {
    const state = {
        legacy,
        profileVersion,
        objects: target === null ? {} : {
            [SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME]: { DataObject: clone(target) }
        },
        setCalls: [],
        failBeforeWrite: null,
        failAfterWrite: null,
        tamperAfterWrite: null
    };
    const api = {
        async getUserAccountInfo(playFabId) {
            return { UserInfo: { PlayFabId: playFabId, TitleInfo: { TitlePlayerAccount: { Id: ENTITY } } } };
        },
        async getUserInventory() { return { VirtualCurrency: { DM: state.legacy } }; },
        async getUserInternalData() { return { Data: {} }; },
        async getEntityToken() {
            return { Entity: { Id: TITLE, Type: "title" }, EntityToken: "test-entity-token" };
        },
        async getObjects() {
            return { ProfileVersion: state.profileVersion, Objects: clone(state.objects) };
        },
        async setObjects(entity, token, expectedProfileVersion, objects) {
            state.setCalls.push({ entity: clone(entity), expectedProfileVersion, objects: clone(objects) });
            if (expectedProfileVersion !== state.profileVersion) {
                const conflict = new Error("conflict");
                conflict.code = "EntityProfileVersionMismatch";
                throw conflict;
            }
            if (state.failBeforeWrite) throw state.failBeforeWrite;
            const next = clone(state.objects);
            for (const object of objects) next[object.ObjectName] = { DataObject: clone(object.DataObject) };
            state.objects = next;
            state.profileVersion += 1;
            state.tamperAfterWrite?.(state);
            if (state.failAfterWrite) throw state.failAfterWrite;
            return { ProfileVersion: state.profileVersion };
        }
    };
    return { api, state };
}

function fakeLeases({ epoch = 7 } = {}) {
    const state = { current: false, releases: 0, assertions: 0 };
    return {
        state,
        async acquire({ playFabId, token }) {
            state.current = true;
            state.token = token;
            return { status: "acquired", lease: { playFabId, token, epoch } };
        },
        async assertCurrent({ token, epoch: requestedEpoch }) {
            state.assertions += 1;
            if (state.failAtAssertion === state.assertions || !state.current ||
                token !== state.token || requestedEpoch !== epoch) {
                const error = new Error("stale");
                error.code = "POC_STALE_WRITER";
                throw error;
            }
            return { status: "current" };
        },
        async release() { state.current = false; state.releases += 1; return { status: "released" }; }
    };
}

async function harness({ legacy = 500, target = createServerEconomyPocInitialSnapshot(PLAYER, 1) } = {}) {
    const provider = fakePlayFab({ legacy, target });
    const leases = fakeLeases();
    const store = createPlayFabDiamondsSandboxMigrationStore({
        client: provider.api,
        titleId: TITLE,
        assertPlayerFence: (input) => leases.assertCurrent(input),
        nowMilliseconds: () => 1_777_777_777_000
    });
    const observation = await store.readObservation(PLAYER);
    const plan = planProgressiveFinancialDomainMigration({
        domain: "Diamonds",
        playFabId: PLAYER,
        titleId: TITLE,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        legacyValue: observation.legacyValue,
        targetValue: observation.targetValue,
        targetRevision: observation.targetRevision,
        providerProfileVersion: observation.providerProfileVersion,
        providerStateDigest: observation.providerStateDigest,
        migrationProof: observation.migrationProof
    });
    const readiness = {
        valid: true,
        scannerForbidden: 0,
        scannerBaselineDigest: SCANNER_HASH,
        adapterVersion: DIAMONDS_TARGET_ADAPTER_VERSION,
        dryRunPlanHash: plan.planHash,
        healthChecks: {
            casSupported: true,
            identityVerified: true,
            playFabHealthy: true,
            redisHealthy: true,
            rollbackAvailable: true,
            scannerZeroForbidden: true,
            snapshotReadHealthy: true,
            targetAdapterComposed: true,
            targetHealthy: true,
            zeroPendingPayment: true
        }
    };
    const executor = createDiamondsSandboxCanaryMigrationExecutor({
        enabled: true,
        providerWritesEnabled: true,
        titleId: TITLE,
        canaryPlayFabIds: [PLAYER],
        playerLeases: leases,
        migrationStore: store,
        verifyReadiness: async () => readiness,
        tokenFactory: () => "migration-test-token"
    });
    return { provider, leases, store, observation, plan, readiness, executor };
}

test("migration executor replaces exactly and atomically writes state, proof and fence", async () => {
    const value = await harness({ legacy: 500 });
    const result = await value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    });
    assert.equal(result.status, "completed");
    assert.equal(result.observation.targetValue, 500);
    assert.equal(result.proof.legacyValue, 500);
    assert.equal(result.proof.targetValue, 500);
    assert.equal(result.proof.targetOnlyOperationCount, 0);
    assert.equal(value.provider.state.setCalls.length, 1);
    assert.deepEqual(value.provider.state.setCalls[0].objects.map((item) => item.ObjectName), [
        SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
        DIAMONDS_MIGRATION_PROOF_OBJECT_NAME,
        SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME
    ]);
    assert.equal(value.leases.state.releases, 1);
});

test("migration never adds Legacy to an already equal Target balance", async () => {
    const target = { ...createServerEconomyPocInitialSnapshot(PLAYER, 1), diamonds: 500 };
    const value = await harness({ legacy: 500, target });
    const result = await value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    });
    assert.equal(result.observation.targetValue, 500);
    assert.notEqual(result.observation.targetValue, 1_000);
    assert.equal(result.proof.legacyValue, 500);
    assert.equal(result.proof.targetValue, 500);
});

test("migration replay returns already_migrated without a second provider write", async () => {
    const value = await harness({ legacy: 500 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const replay = await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    assert.equal(replay.status, "already_migrated");
    assert.equal(replay.providerWriteCount, 0);
    assert.equal(value.provider.state.setCalls.length, 1);
    assert.equal(value.provider.state.objects[SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME].DataObject.diamonds, 500);
});

test("stale plan is rejected before SetObjects and releases the player lease", async () => {
    const value = await harness({ legacy: 500 });
    value.provider.state.legacy = 501;
    await assert.rejects(value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    }), { code: "DOMAIN_MIGRATION_PLAN_STALE" });
    assert.equal(value.provider.state.setCalls.length, 0);
    assert.equal(value.leases.state.releases, 1);
});

test("same migration operation with a different planHash is a proof mismatch", async () => {
    const value = await harness({ legacy: 500 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const conflicting = { ...value.plan, planHash: "a".repeat(64) };
    await assert.rejects(value.executor.execute({
        plan: conflicting,
        approvedPlanHash: conflicting.planHash
    }), { code: "DIAMONDS_MIGRATION_PROOF_MISMATCH" });
    assert.equal(value.provider.state.setCalls.length, 1);
});

test("executor replay rejects a tampered plan payload even when planHash and operationId are unchanged", async () => {
    const value = await harness({ legacy: 500 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const tampered = { ...value.plan, legacyValue: 501, proposedTarget: 501 };
    await assert.rejects(value.executor.execute({
        plan: tampered,
        approvedPlanHash: value.plan.planHash
    }), { code: "DIAMONDS_MIGRATION_PROOF_MISMATCH" });
    assert.equal(value.provider.state.setCalls.length, 1);
});

test("store replay independently rejects a tampered full plan payload", async () => {
    const value = await harness({ legacy: 500 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const lease = await value.leases.acquire({ playFabId: PLAYER, token: "store-replay-token" });
    const tampered = { ...value.plan, legacyValue: 501, proposedTarget: 501 };
    await assert.rejects(value.store.applyMigrationAtomic({
        plan: tampered,
        leaseToken: "store-replay-token",
        fencingEpoch: lease.lease.epoch,
        scannerHash: SCANNER_HASH
    }), { code: "DIAMONDS_MIGRATION_PROOF_MISMATCH" });
    assert.equal(value.provider.state.setCalls.length, 1);
});

test("failed atomic SetObjects leaves neither replacement nor migration proof", async () => {
    const value = await harness({ legacy: 500 });
    value.provider.state.failBeforeWrite = Object.assign(new Error("network down"), { code: "PLAYFAB_TIMEOUT" });
    await assert.rejects(value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    }), { code: "DIAMONDS_MIGRATION_PROVIDER_AMBIGUOUS" });
    assert.equal(value.provider.state.objects[SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME].DataObject.diamonds, 0);
    assert.equal(value.provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME], undefined);
});

test("successful provider response still fails readback when the atomic fence differs", async () => {
    const value = await harness({ legacy: 500 });
    value.provider.state.tamperAfterWrite = (state) => {
        state.objects[SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME].DataObject.activatedAtUnixMs += 1;
    };
    await assert.rejects(value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    }), { code: "DIAMONDS_MIGRATION_READBACK_CONFLICT" });
});

test("ambiguous provider recovery requires the exact atomic fence readback", async () => {
    const value = await harness({ legacy: 500 });
    value.provider.state.tamperAfterWrite = (state) => {
        state.objects[SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME].DataObject.activatedAtUnixMs += 1;
    };
    value.provider.state.failAfterWrite = Object.assign(new Error("lost response"), { code: "PLAYFAB_TIMEOUT" });
    await assert.rejects(value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    }), { code: "DIAMONDS_MIGRATION_PROVIDER_AMBIGUOUS" });
});

test("stale Redis fencing immediately before provider CAS blocks every PlayFab write", async () => {
    const value = await harness({ legacy: 500 });
    value.leases.state.failAtAssertion = 4;
    await assert.rejects(value.executor.execute({
        plan: value.plan,
        approvedPlanHash: value.plan.planHash
    }), { code: "POC_STALE_WRITER" });
    assert.equal(value.provider.state.setCalls.length, 0);
    assert.equal(value.provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME], undefined);
    assert.equal(value.leases.state.releases, 1);
});

test("proof-aware client atomically companions the certified snapshot CAS and verifies operation hash", async () => {
    const value = await harness({ legacy: 0 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const companion = createDiamondsMigrationProofAwarePlayFabClient({
        client: value.provider.api,
        titleId: TITLE,
        canaryPlayFabIds: [PLAYER]
    });
    await companion.getUserAccountInfo(PLAYER);
    const current = value.provider.state.objects[SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME].DataObject;
    const next = { ...clone(current), revision: current.revision + 1, fencingEpoch: 8,
        diamonds: current.diamonds + 25, highValueAppliedThroughSequence: 1, updatedAtUnixMs: 1_777_777_778_000 };
    const operationHash = "b".repeat(64);
    await companion.setObjects(
        { Id: ENTITY, Type: "title_player_account" },
        "test-entity-token",
        value.provider.state.profileVersion,
        [
            { ObjectName: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME, DataObject: next },
            { ObjectName: SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME, DataObject: {
                schemaVersion: 1,
                playFabId: PLAYER,
                sequence: 1,
                operationId: "gameplay:grant:25",
                eventId: "event:grant:25",
                immutableHash: operationHash
            } }
        ]
    );
    const proof = value.provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME].DataObject;
    validateDiamondsMigrationProof(proof, { targetSnapshot: next });
    assert.equal(proof.schemaVersion, 2);
    assert.equal(proof.targetOnlyOperationCount, 1);
    assert.equal(proof.latestTargetOperation.d, 25);
    assert.equal(proof.latestTargetOperation.h, operationHash);
    const verified = await companion.verifyTrustedOperation({
        playFabId: PLAYER,
        operationId: "gameplay:grant:25",
        operationHash
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.delta, 25);
    assert.equal(verified.balance, 25);
    assert.equal(verified.targetOnlyOperationCount, 1);
    const lastWrite = value.provider.state.setCalls.at(-1).objects;
    assert.ok(lastWrite.some((entry) => entry.ObjectName === DIAMONDS_MIGRATION_PROOF_OBJECT_NAME));
});

test("proof-aware snapshot CAS recovers APPLIED only from exact state and migration proof", async () => {
    const value = await harness({ legacy: 0 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const companion = createDiamondsMigrationProofAwarePlayFabClient({
        client: value.provider.api,
        titleId: TITLE,
        canaryPlayFabIds: [PLAYER]
    });
    const snapshotStore = createServerEconomyPocPlayFabSnapshotStore({
        client: companion,
        assertPlayerFence: async () => {}
    });
    const current = await snapshotStore.readWithMetadata(PLAYER);
    const operationHash = "c".repeat(64);
    const next = {
        ...clone(current.snapshot),
        revision: current.snapshot.revision + 1,
        diamonds: current.snapshot.diamonds + 25,
        highValueAppliedThroughSequence: current.snapshot.highValueAppliedThroughSequence + 1,
        updatedAtUnixMs: current.snapshot.updatedAtUnixMs + 1
    };
    const operationProof = {
        schemaVersion: 1,
        playFabId: PLAYER,
        sequence: next.highValueAppliedThroughSequence,
        operationId: "gameplay:ambiguous:applied",
        eventId: "event:ambiguous:applied",
        immutableHash: operationHash
    };
    const setCallsBefore = value.provider.state.setCalls.length;
    value.provider.state.failAfterWrite = Object.assign(new Error("lost response"), { code: "PLAYFAB_TIMEOUT" });
    const result = await snapshotStore.compareAndSet({
        playFabId: PLAYER,
        expectedRevision: current.snapshot.revision,
        leaseToken: "migration-test-token",
        fencingEpoch: current.snapshot.fencingEpoch,
        nextSnapshot: next,
        operationProof
    });
    assert.equal(result.status, "updated");
    assert.equal(value.provider.state.setCalls.length, setCallsBefore + 1);
    const verified = await companion.verifyTrustedOperation({
        playFabId: PLAYER,
        operationId: operationProof.operationId,
        operationHash
    });
    assert.equal(verified.verified, true);
    assert.equal(verified.balance, 25);
});

test("proof-aware snapshot CAS never masks a conflicting migration proof as APPLIED", async () => {
    const value = await harness({ legacy: 0 });
    await value.executor.execute({ plan: value.plan, approvedPlanHash: value.plan.planHash });
    const companion = createDiamondsMigrationProofAwarePlayFabClient({
        client: value.provider.api,
        titleId: TITLE,
        canaryPlayFabIds: [PLAYER]
    });
    const snapshotStore = createServerEconomyPocPlayFabSnapshotStore({
        client: companion,
        assertPlayerFence: async () => {}
    });
    const current = await snapshotStore.readWithMetadata(PLAYER);
    const operationHash = "d".repeat(64);
    const next = {
        ...clone(current.snapshot),
        revision: current.snapshot.revision + 1,
        diamonds: current.snapshot.diamonds + 25,
        highValueAppliedThroughSequence: current.snapshot.highValueAppliedThroughSequence + 1,
        updatedAtUnixMs: current.snapshot.updatedAtUnixMs + 1
    };
    const operationProof = {
        schemaVersion: 1,
        playFabId: PLAYER,
        sequence: next.highValueAppliedThroughSequence,
        operationId: "gameplay:ambiguous:proof-conflict",
        eventId: "event:ambiguous:proof-conflict",
        immutableHash: operationHash
    };
    const setCallsBefore = value.provider.state.setCalls.length;
    value.provider.state.tamperAfterWrite = (state) => {
        state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME].DataObject.resultHash = "e".repeat(64);
    };
    value.provider.state.failAfterWrite = Object.assign(new Error("lost response"), { code: "PLAYFAB_TIMEOUT" });
    await assert.rejects(snapshotStore.compareAndSet({
        playFabId: PLAYER,
        expectedRevision: current.snapshot.revision,
        leaseToken: "migration-test-token",
        fencingEpoch: current.snapshot.fencingEpoch,
        nextSnapshot: next,
        operationProof
    }), (error) => {
        assert.equal(error.code, "DIAMONDS_MIGRATION_PROOF_MISMATCH");
        assert.equal(error.providerReconciliationClassification, "PROOF_MISMATCH");
        return true;
    });
    assert.equal(value.provider.state.setCalls.length, setCallsBefore + 1);
});

test("proof-aware client refuses Canary snapshot writes before migration proof", async () => {
    const provider = fakePlayFab({ legacy: 0 });
    const companion = createDiamondsMigrationProofAwarePlayFabClient({
        client: provider.api,
        titleId: TITLE,
        canaryPlayFabIds: [PLAYER]
    });
    await companion.getUserAccountInfo(PLAYER);
    const current = provider.state.objects[SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME].DataObject;
    await assert.rejects(companion.setObjects(
        { Id: ENTITY, Type: "title_player_account" },
        "test-entity-token",
        provider.state.profileVersion,
        [{ ObjectName: SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME, DataObject: {
            ...current, revision: 1, fencingEpoch: 1, updatedAtUnixMs: 2
        } }]
    ), { code: "DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED" });
    assert.equal(provider.state.profileVersion, 10);
});

test("migration executor refuses wildcard, another player and Production composition", () => {
    const dependencies = {
        enabled: true,
        providerWritesEnabled: true,
        playerLeases: { acquire() {}, assertCurrent() {}, release() {} },
        migrationStore: { readObservation() {}, applyMigrationAtomic() {}, verifyProof() {} },
        verifyReadiness() {}
    };
    assert.throws(() => createDiamondsSandboxCanaryMigrationExecutor({
        ...dependencies,
        titleId: TITLE,
        canaryPlayFabIds: ["*"]
    }), { code: "DIAMONDS_CANARY_ALLOWLIST_INVALID" });
    assert.throws(() => createDiamondsSandboxCanaryMigrationExecutor({
        ...dependencies,
        titleId: "142853",
        canaryPlayFabIds: [PLAYER]
    }), { code: "DIAMONDS_CANARY_ALLOWLIST_INVALID" });
});

test("real PlayFab client exposes read-only Server/GetUserInventory without leaking the secret", async () => {
    let request;
    const client = createPlayFabFinancialProfileClient({
        titleId: TITLE,
        secretKey: "sandbox-test-secret",
        fetchImpl: async (url, options) => {
            request = { url, options };
            return {
                ok: true,
                status: 200,
                headers: { get() { return null; } },
                async json() { return { code: 200, data: { VirtualCurrency: { DM: 0 } } }; }
            };
        }
    });
    const result = await client.getUserInventory(PLAYER);
    assert.equal(result.VirtualCurrency.DM, 0);
    assert.match(request.url, /\/Server\/GetUserInventory$/u);
    assert.equal(request.options.headers["X-SecretKey"], "sandbox-test-secret");
    assert.doesNotMatch(request.url, /sandbox-test-secret/u);
    assert.doesNotMatch(request.options.body, /sandbox-test-secret/u);
    assert.deepEqual(JSON.parse(request.options.body), { PlayFabId: PLAYER });
});

test("Canary startup health fails closed when the durable migration proof is absent", async () => {
    const certificate = JSON.parse(readFileSync(
        new URL("../config/diamonds-domain-readiness-certificate.local.json", import.meta.url),
        "utf8"
    ));
    const configuration = Object.freeze({
        domain: "Diamonds",
        mode: "Canary",
        canaryEnabled: true,
        cutoverEnabled: false,
        migrationEnabled: false,
        canaryPlayFabIds: Object.freeze([PLAYER])
    });
    await assert.rejects(createDiamondsDomainServerComposition({
        configuration,
        readinessCertificate: certificate,
        titleId: TITLE,
        nowMilliseconds: () => Date.parse(certificate.issuedAtUtc) + 1_000,
        buildCanonicalRuntime: async () => ({
            redis: { async ping() { return "PONG"; } },
            snapshotStore: { async probe() { return true; } },
            canonicalRuntime: { async readSnapshot() { return createServerEconomyPocInitialSnapshot(PLAYER, 1); } },
            authority: {
                async authenticateGameServer() { return { authenticated: true }; },
                async authorizePlayer() { return { authorized: true, playFabId: PLAYER }; }
            },
            proofAwarePlayFab: {
                async readDiamondsMigrationProof() {
                    const error = new Error("missing");
                    error.code = "DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED";
                    throw error;
                }
            },
            expectedProfileVersionCas: true
        })
    }), { code: "DIAMONDS_CANARY_MIGRATION_PROOF_REQUIRED" });
});

test("server composition exposes canonical runtime and exact payment-canary readiness", async () => {
    const certificate = JSON.parse(readFileSync(
        new URL("../config/diamonds-domain-readiness-certificate.local.json", import.meta.url),
        "utf8"
    ));
    const configuration = Object.freeze({
        domain: "Diamonds", mode: "Canary", canaryEnabled: true, cutoverEnabled: false,
        migrationEnabled: false, canaryPlayFabIds: Object.freeze([PLAYER])
    });
    const composition = await createDiamondsDomainServerComposition({
        configuration,
        readinessCertificate: certificate,
        titleId: TITLE,
        nowMilliseconds: () => Date.parse(certificate.issuedAtUtc) + 1_000,
        buildCanonicalRuntime: async () => ({
            redis: { async ping() { return "PONG"; } },
            snapshotStore: { async probe() { return true; } },
            canonicalRuntime: {
                async readSnapshot() { return createServerEconomyPocInitialSnapshot(PLAYER, 1); },
                trustedDiamonds: { async execute() {} },
                async consumeValidatedXsollaReceipt() {}
            },
            authority: {
                async authenticateGameServer() { return { authenticated: true }; },
                async authorizePlayer() { return { authorized: true, playFabId: PLAYER }; }
            },
            proofAwarePlayFab: {
                async readDiamondsMigrationProof() { return { proof: { state: "Completed" } }; },
                async verifyTrustedOperation() { return { verified: true }; }
            },
            expectedProfileVersionCas: true
        })
    });
    assert.equal(typeof composition.canonicalRuntime.consumeValidatedXsollaReceipt, "function");
    assert.equal(typeof composition.canonicalRuntime.verifyTrustedOperation, "function");
    assert.deepEqual(await composition.verifyPaymentCanaryReadiness({ playFabId: PLAYER }), {
        ready: true,
        domain: "Diamonds",
        titleId: TITLE,
        playFabId: PLAYER,
        certificateValid: true,
        migrationProofValid: true,
        redisHealthy: true,
        playFabHealthy: true,
        scannerForbiddenCount: 0
    });
    await assert.rejects(
        composition.verifyPaymentCanaryReadiness({ playFabId: "OTHER" }),
        { code: "DIAMONDS_CANARY_ALLOWLIST_INVALID" }
    );
});
