import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
    diamondsMigrationProofResultHash,
    diamondsMigrationProofUtf8Bytes,
    createDiamondsMigrationProofAwarePlayFabClient,
    createInitialDiamondsMigrationProof,
    DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION,
    DIAMONDS_MIGRATION_PROOF_OBJECT_NAME,
    DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION,
    DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID
} from "../src/diamonds-migration-proof-companion.js";
import {
    DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID,
    DIAMONDS_PROGRESSIVE_MIGRATION_VERSION
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

const PLAYER = DIAMONDS_SANDBOX_CANARY_PLAYFAB_ID;
const TITLE = DIAMONDS_FINANCIAL_SANDBOX_TITLE_ID;
const ENTITY = "TEST_DIAMONDS_ENTITY";
const LEASE_TOKEN = "proof-aware-grant-spend-lease";
const FENCING_EPOCH = 2;
const PLAYFAB_ENTITY_OBJECT_LIMIT_BYTES = 1_024;

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function bytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function providerFailure(message, code = "PLAYFAB_TIMEOUT") {
    return Object.assign(new Error(message), { code, retryable: true });
}

function makeBaseline() {
    const snapshot = {
        ...createServerEconomyPocInitialSnapshot(PLAYER, 1_777_777_777_000),
        revision: 1,
        fencingEpoch: FENCING_EPOCH
    };
    const plan = {
        domain: "Diamonds",
        titleId: TITLE,
        playFabId: PLAYER,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        legacyValue: 0,
        proposedTarget: 0,
        planHash: "a".repeat(64),
        operationId: "diamonds-migration-v1:proof-aware-pipeline-test"
    };
    const migrationProof = createInitialDiamondsMigrationProof({
        plan,
        scannerHash: "b".repeat(64),
        appliedAt: "2026-08-24T12:00:00.000Z",
        fencingEpoch: FENCING_EPOCH,
        targetSnapshot: snapshot
    });
    const fence = {
        schemaVersion: 1,
        playFabId: PLAYER,
        fencingEpoch: FENCING_EPOCH,
        leaseTokenDigest: sha256(LEASE_TOKEN),
        activatedAtUnixMs: 1_777_777_777_000
    };
    return { snapshot, migrationProof, fence };
}

function fakePlayFab() {
    const baseline = makeBaseline();
    const state = {
        profileVersion: 10,
        objects: {
            [SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME]: { DataObject: clone(baseline.snapshot) },
            [SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME]: { DataObject: clone(baseline.fence) },
            [DIAMONDS_MIGRATION_PROOF_OBJECT_NAME]: { DataObject: clone(baseline.migrationProof) }
        },
        requests: [],
        successfulWrites: 0,
        failBeforeStateWriteOnce: false,
        failAfterStateWriteOnce: false
    };
    const api = {
        async getUserAccountInfo(playFabId) {
            return {
                UserInfo: {
                    PlayFabId: playFabId,
                    TitleInfo: { TitlePlayerAccount: { Id: ENTITY } }
                }
            };
        },
        async getUserInventory() { return { VirtualCurrency: { DM: 0 } }; },
        async getUserInternalData() { return { Data: {} }; },
        async getEntityToken() {
            return { Entity: { Id: TITLE, Type: "title" }, EntityToken: "test-token" };
        },
        async getObjects() {
            return { ProfileVersion: state.profileVersion, Objects: clone(state.objects) };
        },
        async setObjects(entity, token, expectedProfileVersion, objects) {
            const request = {
                endpoint: "/Object/SetObjects",
                entity: clone(entity),
                expectedProfileVersion,
                objects: clone(objects),
                committed: false
            };
            state.requests.push(request);
            if (expectedProfileVersion !== state.profileVersion) {
                throw Object.assign(new Error("profile version conflict"), {
                    code: "EntityProfileVersionMismatch",
                    providerErrorCode: 1352
                });
            }
            const stateMutation = objects.some((entry) =>
                entry.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
            for (const entry of objects) {
                if (bytes(entry.DataObject) > PLAYFAB_ENTITY_OBJECT_LIMIT_BYTES) {
                    throw Object.assign(new Error("entity object exceeds provider limit"), {
                        code: "PlayFabApiError",
                        providerError: "OverLimit",
                        providerErrorCode: 1214,
                        statusCode: 400
                    });
                }
            }
            if (stateMutation && state.failBeforeStateWriteOnce) {
                state.failBeforeStateWriteOnce = false;
                throw providerFailure("response lost before write");
            }
            const next = clone(state.objects);
            for (const entry of objects) {
                next[entry.ObjectName] = { DataObject: clone(entry.DataObject) };
            }
            state.objects = next;
            state.profileVersion += 1;
            state.successfulWrites += 1;
            request.committed = true;
            if (stateMutation && state.failAfterStateWriteOnce) {
                state.failAfterStateWriteOnce = false;
                throw providerFailure("response lost after write");
            }
            return { ProfileVersion: state.profileVersion };
        }
    };
    return { api, state };
}

function createHarness({ provider = fakePlayFab() } = {}) {
    const proofAwarePlayFab = createDiamondsMigrationProofAwarePlayFabClient({
        client: provider.api,
        titleId: TITLE,
        canaryPlayFabIds: [PLAYER]
    });
    const snapshotStore = createServerEconomyPocPlayFabSnapshotStore({
        client: proofAwarePlayFab,
        assertPlayerFence: async ({ playFabId, token, epoch }) => {
            assert.equal(playFabId, PLAYER);
            assert.equal(token, LEASE_TOKEN);
            assert.equal(epoch, FENCING_EPOCH);
        }
    });

    async function apply({ operationId, delta, operationHash = sha256(operationId) }) {
        const previous = await proofAwarePlayFab.verifyTrustedOperation({
            playFabId: PLAYER,
            operationId,
            operationHash
        });
        if (previous.verified) {
            return { status: "already_applied", snapshot: previous.snapshot, providerWriteCount: 0 };
        }
        const current = await snapshotStore.readWithMetadata(PLAYER);
        const resultingBalance = current.snapshot.diamonds + delta;
        if (resultingBalance < 0) {
            return { status: "insufficient_funds", snapshot: current.snapshot, providerWriteCount: 0 };
        }
        const nextSnapshot = {
            ...clone(current.snapshot),
            revision: current.snapshot.revision + 1,
            diamonds: resultingBalance,
            highValueAppliedThroughSequence: current.snapshot.highValueAppliedThroughSequence + 1,
            updatedAtUnixMs: current.snapshot.updatedAtUnixMs + 1
        };
        const operationProof = {
            schemaVersion: 1,
            playFabId: PLAYER,
            sequence: nextSnapshot.highValueAppliedThroughSequence,
            operationId,
            eventId: `event:${operationId}`,
            immutableHash: operationHash
        };
        const result = await snapshotStore.compareAndSet({
            playFabId: PLAYER,
            expectedRevision: current.snapshot.revision,
            leaseToken: LEASE_TOKEN,
            fencingEpoch: FENCING_EPOCH,
            nextSnapshot,
            operationProof
        });
        return {
            status: result.status,
            snapshot: result.snapshot,
            operationProof,
            providerWriteCount: result.status === "updated" ? 1 : 0
        };
    }
    return { provider, proofAwarePlayFab, snapshotStore, apply };
}

function seedPersistedV1Grant(provider) {
    const baseline = makeBaseline();
    const operationId = "diamonds:test:v1-grant-25";
    const operationHash = sha256(operationId);
    const snapshot = {
        ...clone(baseline.snapshot),
        revision: 2,
        diamonds: 25,
        highValueAppliedThroughSequence: 1,
        updatedAtUnixMs: baseline.snapshot.updatedAtUnixMs + 1
    };
    const appliedTargetOperation = {
        operationId,
        operationHash,
        delta: 25,
        resultingRevision: 2,
        resultingValue: 25
    };
    const proof = clone(baseline.migrationProof);
    proof.schemaVersion = DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION;
    proof.targetValue = 25;
    proof.targetRevision = 2;
    proof.targetDigest = serverEconomyPocDigest(25);
    proof.targetOnlyOperationCount = 1;
    proof.appliedTargetOperations = [appliedTargetOperation];
    delete proof.operationsChainHash;
    delete proof.latestTargetOperation;
    delete proof.resultHash;
    proof.resultHash = diamondsMigrationProofResultHash(proof, snapshot);
    provider.state.objects[SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME] = { DataObject: clone(snapshot) };
    provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME] = { DataObject: clone(proof) };
    provider.state.objects[SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME] = { DataObject: {
        schemaVersion: 1,
        playFabId: PLAYER,
        sequence: 1,
        operationId,
        eventId: `event:${operationId}`,
        immutableHash: operationHash
    } };
    return { snapshot, proof };
}

function stateWrite(request) {
    return request.objects.find((entry) => entry.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
}

function successfulStateWrites(provider) {
    return provider.state.requests.filter((request) => request.committed && stateWrite(request));
}

test("proof-aware PlayFab grant and spend share one canonical snapshot SetObjects pipeline", async () => {
    const value = createHarness();
    const grant = await value.apply({ operationId: "diamonds:test:grant-25", delta: 25 });
    const spend = await value.apply({ operationId: "diamonds:test:spend-10", delta: -10 });

    assert.equal(grant.snapshot.diamonds, 25);
    assert.equal(grant.snapshot.revision, 2);
    assert.equal(grant.snapshot.highValueAppliedThroughSequence, 1);
    assert.equal(spend.snapshot.diamonds, 15);
    assert.equal(spend.snapshot.revision, 3);
    assert.equal(spend.snapshot.highValueAppliedThroughSequence, 2);
    assert.equal(spend.operationProof.sequence, 2);

    const writes = successfulStateWrites(value.provider);
    assert.equal(writes.length, 2);
    assert.deepEqual(
        writes[0].objects.map((entry) => entry.ObjectName).sort(),
        writes[1].objects.map((entry) => entry.ObjectName).sort()
    );
    assert.equal(stateWrite(writes[0]).DataObject.diamonds, 25);
    assert.equal(stateWrite(writes[1]).DataObject.diamonds, 15);
    assert.ok(writes.every((request) => request.endpoint === "/Object/SetObjects"));
    assert.ok(value.provider.state.requests.every((request) => !/subtract/iu.test(request.endpoint)));
    assert.ok(writes.every((request) => request.objects.every((entry) =>
        bytes(entry.DataObject) <= PLAYFAB_ENTITY_OBJECT_LIMIT_BYTES)));

    const writesBeforeReplay = value.provider.state.successfulWrites;
    const replay = await value.apply({ operationId: "diamonds:test:spend-10", delta: -10 });
    assert.equal(replay.status, "already_applied");
    assert.equal(replay.snapshot.diamonds, 15);
    assert.equal(value.provider.state.successfulWrites, writesBeforeReplay);

    const insufficient = await value.apply({ operationId: "diamonds:test:spend-20", delta: -20 });
    assert.equal(insufficient.status, "insufficient_funds");
    assert.equal(insufficient.snapshot.diamonds, 15);
    assert.equal(value.provider.state.successfulWrites, writesBeforeReplay);
});

test("ambiguous spend readback distinguishes APPLIED from NOT_APPLIED and retries the same operationId", async () => {
    const applied = createHarness();
    await applied.apply({ operationId: "diamonds:test:grant-25", delta: 25 });
    applied.provider.state.failAfterStateWriteOnce = true;
    const recovered = await applied.apply({ operationId: "diamonds:test:spend-after-write", delta: -10 });
    assert.equal(recovered.status, "updated");
    assert.equal(recovered.snapshot.diamonds, 15);
    assert.equal((await applied.proofAwarePlayFab.verifyTrustedOperation({
        playFabId: PLAYER,
        operationId: "diamonds:test:spend-after-write",
        operationHash: sha256("diamonds:test:spend-after-write")
    })).verified, true);

    const notApplied = createHarness();
    await notApplied.apply({ operationId: "diamonds:test:grant-25", delta: 25 });
    notApplied.provider.state.failBeforeStateWriteOnce = true;
    await assert.rejects(
        notApplied.apply({ operationId: "diamonds:test:spend-before-write", delta: -10 }),
        (error) => {
            assert.equal(error.code, "POC_PLAYFAB_NOT_APPLIED");
            assert.equal(error.classification, "NOT_APPLIED");
            return true;
        }
    );
    assert.equal((await notApplied.snapshotStore.read(PLAYER)).diamonds, 25);
    const retry = await notApplied.apply({ operationId: "diamonds:test:spend-before-write", delta: -10 });
    assert.equal(retry.status, "updated");
    assert.equal(retry.snapshot.diamonds, 15);
    const replayWrites = notApplied.provider.state.successfulWrites;
    assert.equal((await notApplied.apply({
        operationId: "diamonds:test:spend-before-write",
        delta: -10
    })).status, "already_applied");
    assert.equal(notApplied.provider.state.successfulWrites, replayWrites);
});

test("concurrent grant and spend serialize through profile-version CAS without lost update", async () => {
    const value = createHarness();
    await value.apply({ operationId: "diamonds:test:baseline-25", delta: 25 });
    const grantInput = { operationId: "diamonds:test:concurrent-grant-5", delta: 5 };
    const spendInput = { operationId: "diamonds:test:concurrent-spend-10", delta: -10 };
    const firstPass = await Promise.all([value.apply(grantInput), value.apply(spendInput)]);
    const conflictIndex = firstPass.findIndex((result) => result.status === "version_conflict");
    assert.notEqual(conflictIndex, -1);
    await value.apply(conflictIndex === 0 ? grantInput : spendInput);
    const final = await value.snapshotStore.read(PLAYER);
    assert.equal(final.diamonds, 20);
    assert.equal(final.revision, 4);
    assert.equal(final.highValueAppliedThroughSequence, 3);
});

test("persisted V1 +25 proof converts atomically to bounded V2 on the first -10 spend", async () => {
    const provider = fakePlayFab();
    const legacy = seedPersistedV1Grant(provider);
    assert.equal(legacy.proof.schemaVersion, DIAMONDS_MIGRATION_PROOF_LEGACY_SCHEMA_VERSION);
    assert.equal(legacy.snapshot.diamonds, 25);
    const profileVersionBefore = provider.state.profileVersion;
    const value = createHarness({ provider });

    const spend = await value.apply({ operationId: "diamonds:test:v1-spend-10", delta: -10 });
    assert.equal(spend.status, "updated");
    assert.equal(spend.snapshot.diamonds, 15);
    assert.equal(spend.snapshot.revision, 3);
    assert.equal(spend.snapshot.highValueAppliedThroughSequence, 2);
    assert.equal(provider.state.profileVersion, profileVersionBefore + 1);

    const persisted = provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME].DataObject;
    assert.equal(persisted.schemaVersion, DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION);
    assert.equal(persisted.targetOnlyOperationCount, 2);
    assert.equal(persisted.latestTargetOperation.d, -10);
    assert.equal(persisted.latestTargetOperation.h, sha256("diamonds:test:v1-spend-10"));
    assert.equal("appliedTargetOperations" in persisted, false);
    assert.ok(diamondsMigrationProofUtf8Bytes(persisted) <= PLAYFAB_ENTITY_OBJECT_LIMIT_BYTES);

    const atomicWrite = successfulStateWrites(provider).at(-1);
    assert.ok(atomicWrite.objects.some((entry) =>
        entry.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME));
    assert.ok(atomicWrite.objects.some((entry) =>
        entry.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME));
    assert.ok(atomicWrite.objects.some((entry) =>
        entry.ObjectName === DIAMONDS_MIGRATION_PROOF_OBJECT_NAME));
});

test("100 alternating safe advances keep compact proof bounded instead of growing with history", async () => {
    const value = createHarness();
    const sizes = [];
    for (let index = 0; index < 100; index += 1) {
        const delta = index % 2 === 0 ? 2 : -1;
        const result = await value.apply({
            operationId: `diamonds:test:bounded-${String(index).padStart(3, "0")}`,
            delta
        });
        assert.equal(result.status, "updated");
        const proof = value.provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME].DataObject;
        const size = diamondsMigrationProofUtf8Bytes(proof);
        assert.equal(proof.schemaVersion, DIAMONDS_MIGRATION_PROOF_SCHEMA_VERSION);
        assert.equal("appliedTargetOperations" in proof, false);
        assert.ok(size <= PLAYFAB_ENTITY_OBJECT_LIMIT_BYTES);
        sizes.push(size);
    }
    const final = await value.snapshotStore.read(PLAYER);
    assert.equal(final.diamonds, 50);
    assert.equal(final.revision, 101);
    assert.equal(final.highValueAppliedThroughSequence, 100);
    const finalProof = value.provider.state.objects[DIAMONDS_MIGRATION_PROOF_OBJECT_NAME].DataObject;
    assert.equal(finalProof.targetOnlyOperationCount, 100);
    assert.equal(finalProof.latestTargetOperation.d, -1);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 16);
    assert.ok(sizes.at(-1) <= sizes[9] + 10);
});

test("oversized V2 proof fails TOO_LARGE before any provider request", () => {
    const provider = fakePlayFab();
    const maximum = Number.MAX_SAFE_INTEGER;
    const targetSnapshot = {
        ...createServerEconomyPocInitialSnapshot(PLAYER, maximum),
        revision: maximum,
        fencingEpoch: maximum,
        diamonds: maximum
    };
    const plan = {
        domain: "Diamonds",
        titleId: TITLE,
        playFabId: PLAYER,
        migrationVersion: DIAMONDS_PROGRESSIVE_MIGRATION_VERSION,
        legacyValue: maximum,
        proposedTarget: maximum,
        planHash: "c".repeat(64),
        operationId: "M".repeat(200)
    };
    assert.throws(() => createInitialDiamondsMigrationProof({
        plan,
        scannerHash: "d".repeat(64),
        appliedAt: "2026-08-24T12:00:00.000Z",
        fencingEpoch: maximum,
        targetSnapshot
    }), (error) => {
        assert.equal(error.code, "DIAMONDS_MIGRATION_PROOF_TOO_LARGE");
        assert.equal(error.providerRequestAttempted, false);
        assert.notEqual(error.code, "POC_PLAYFAB_NOT_APPLIED");
        return true;
    });
    assert.equal(provider.state.requests.length, 0);
});
