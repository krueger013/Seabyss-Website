import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyServerEconomyPocPlayFabCasReadback,
    createServerEconomyPocPlayFabFencedPlayerLeases,
    createServerEconomyPocPlayFabSnapshotStore,
    PLAYFAB_CAS_RECONCILIATION_NOT_APPLIED,
    PLAYFAB_CAS_RECONCILIATION_PROOF_MISMATCH,
    PLAYFAB_CAS_RECONCILIATION_UNKNOWN,
    SERVER_ECONOMY_POC_PLAYFAB_AMMO_PROOF_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME
} from "../src/server-economy-poc-playfab-snapshot-store.js";
import { createMemoryServerEconomyPocPlayerLeases } from "../src/server-economy-poc-memory-stores.js";
import { createServerEconomyPocHighValueProviderProof } from "../src/server-economy-poc-provider-proof.js";
import { createServerEconomyPocAmmoBatchProof } from "../src/server-economy-poc-ammo-proof.js";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function fakePlayFab({ playFabId = "PF_PLAYER", entityId = "ENTITY_PLAYER" } = {}) {
    let profileVersion = 0;
    const objects = new Map();
    let failBeforeSet = false;
    let failAfterSet = false;
    let conflictingProofAfterSet = false;
    let delayedEconomyWrite = null;
    const calls = { account: 0, token: 0, get: 0, set: 0 };
    return {
        calls,
        failNextBeforeSet() { failBeforeSet = true; },
        failNextAfterSet() { failAfterSet = true; },
        failNextAfterSetWithConflictingProof() {
            failAfterSet = true; conflictingProofAfterSet = true;
        },
        delayNextEconomyWrite() {
            const entered = deferred();
            const release = deferred();
            delayedEconomyWrite = { entered, release };
            return {
                entered: entered.promise,
                release: () => release.resolve()
            };
        },
        async getUserAccountInfo() {
            calls.account += 1;
            return {
                UserInfo: {
                    PlayFabId: playFabId,
                    TitleInfo: { TitlePlayerAccount: { Id: entityId } }
                }
            };
        },
        async getEntityToken() {
            calls.token += 1;
            return { EntityToken: "FAKE_ENTITY_TOKEN" };
        },
        async getObjects(entity, token) {
            calls.get += 1;
            assert.deepEqual(entity, { Id: entityId, Type: "title_player_account" });
            assert.equal(token, "FAKE_ENTITY_TOKEN");
            return {
                ProfileVersion: profileVersion,
                Objects: Object.fromEntries([...objects.entries()].map(([name, value]) => [
                    name,
                    { DataObject: structuredClone(value) }
                ]))
            };
        },
        async setObjects(entity, token, expectedProfileVersion, writes) {
            calls.set += 1;
            assert.deepEqual(entity, { Id: entityId, Type: "title_player_account" });
            assert.equal(token, "FAKE_ENTITY_TOKEN");
            assert.ok(writes.length >= 1);
            const delayed = delayedEconomyWrite &&
                writes.some((entry) => entry.ObjectName === SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME);
            if (delayed) {
                const gate = delayedEconomyWrite;
                delayedEconomyWrite = null;
                gate.entered.resolve();
                await gate.release.promise;
            }
            if (expectedProfileVersion !== profileVersion) {
                throw Object.assign(new Error("version conflict"), {
                    code: "EntityProfileVersionMismatch",
                    status: 409
                });
            }
            if (failBeforeSet) {
                failBeforeSet = false;
                throw Object.assign(new Error("ambiguous transport failure"), { code: "ETIMEDOUT" });
            }
            for (const entry of writes) {
                assert.ok([
                    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME,
                    SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
                    SERVER_ECONOMY_POC_PLAYFAB_AMMO_PROOF_OBJECT_NAME,
                    SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME
                ].includes(entry.ObjectName));
                objects.set(entry.ObjectName, structuredClone(entry.DataObject));
            }
            if (conflictingProofAfterSet) {
                conflictingProofAfterSet = false;
                const proof = objects.get(SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME);
                objects.set(SERVER_ECONOMY_POC_PLAYFAB_PROOF_OBJECT_NAME, {
                    ...structuredClone(proof), immutableHash: "f".repeat(64)
                });
            }
            profileVersion += 1;
            if (failAfterSet) {
                failAfterSet = false;
                throw Object.assign(new Error("ambiguous transport failure"), { code: "ETIMEDOUT" });
            }
            return { ProfileVersion: profileVersion };
        }
    };
}

function nextSnapshot(current, { diamonds, epoch, highValueSequence, now }) {
    return {
        ...structuredClone(current),
        revision: current.revision + 1,
        fencingEpoch: epoch,
        diamonds,
        highValueAppliedThroughSequence: highValueSequence,
        updatedAtUnixMs: now
    };
}

function permissiveFence() {
    return async () => {};
}

async function activate(store, {
    playFabId = "PF_PLAYER",
    leaseToken = "LEASE_TOKEN",
    fencingEpoch = 1
} = {}) {
    return store.activateFence({ playFabId, leaseToken, fencingEpoch });
}

function providerProof(label, playFabId = "PF_PLAYER") {
    return createServerEconomyPocHighValueProviderProof({
        playFabId,
        sequence: 1,
        operation: {
            operationId: `OP_${label}`,
            eventId: `EVENT_${label}`,
            immutableHash: "a".repeat(64)
        }
    });
}

function ammoProof(playFabId = "PF_PLAYER") {
    return createServerEconomyPocAmmoBatchProof({
        playFabId,
        entries: [{
            playFabId,
            sequence: 1,
            eventId: "AMMO_PROVIDER_PROOF_EVENT",
            immutableHash: "b".repeat(64)
        }]
    });
}

test("PlayFab store fails closed without a fence authority and refuses implicit initialization", async () => {
    const client = fakePlayFab();
    assert.throws(() => createServerEconomyPocPlayFabSnapshotStore({ client }), TypeError);
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await assert.rejects(store.read("PF_PLAYER"), {
        code: "POC_PLAYFAB_SNAPSHOT_NOT_INITIALIZED"
    });
    assert.equal(client.calls.set, 0);
    assert.equal(store.objectName, "SeabyssEconomyStateV1");
    assert.equal(store.fenceObjectName, "SeabyssEconomyFenceV1");
    assert.equal(store.providerLinearizedFenceRequired, true);
});

test("PlayFab initialization, provider fence activation, and ExpectedProfileVersion CAS persist a strict snapshot", async () => {
    const client = fakePlayFab();
    const fences = [];
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: async (input) => fences.push(input)
    });
    const initialized = await store.initialize({
        playFabId: "PF_PLAYER",
        expectedObjectVersion: 0,
        initializedAtUnixMs: 1000
    });
    assert.equal(initialized.status, "initialized");
    const providerFence = await activate(store);
    assert.equal(providerFence.status, "activated");
    assert.equal(providerFence.fence.fencingEpoch, 1);
    assert.notEqual(providerFence.fence.leaseTokenDigest, "LEASE_TOKEN");

    const current = await store.read("PF_PLAYER");
    const next = nextSnapshot(current, {
        diamonds: 500,
        epoch: 1,
        highValueSequence: 1,
        now: 2000
    });
    const updated = await store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: next,
        operationProof: providerProof("BASIC")
    });
    assert.equal(updated.status, "updated");
    assert.equal((await store.read("PF_PLAYER")).diamonds, 500);
    assert.ok(fences.some((value) =>
        value.playFabId === "PF_PLAYER" && value.token === "LEASE_TOKEN" && value.epoch === 1));
    assert.equal(store.expectedProfileVersionCas, true);
});

test("PlayFab ammo cursor and exact batch proof share one ExpectedProfileVersion CAS", async () => {
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    await activate(store);
    const current = await store.read("PF_PLAYER");
    const intended = {
        ...structuredClone(current),
        revision: 1,
        fencingEpoch: 1,
        eliteBall: 5,
        ammoAppliedThroughSequence: 1,
        updatedAtUnixMs: 2000
    };
    const exactProof = ammoProof();
    await assert.rejects(store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: intended
    }), { code: "POC_AMMO_PROOF_REQUIRED" });
    const updated = await store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: intended,
        ammoProof: exactProof
    });
    assert.equal(updated.status, "updated");
    assert.deepEqual(await store.readAmmoBatchProof("PF_PLAYER"), exactProof);
    assert.deepEqual((await store.readWithMetadata("PF_PLAYER")).ammoProof, exactProof);
    assert.equal((await store.read("PF_PLAYER")).eliteBall, 5);
    assert.equal(store.ammoProofObjectName, "SeabyssEconomyAmmoProofV1");
    assert.equal(store.atomicAmmoProof, true);
});

test("PlayFab CAS rejects epoch zero and a positive external lease without an activated provider fence", async () => {
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    const current = await store.read("PF_PLAYER");
    const intended = nextSnapshot(current, {
        diamonds: 1,
        epoch: 1,
        highValueSequence: 1,
        now: 1
    });
    await assert.rejects(store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 0,
        nextSnapshot: { ...intended, fencingEpoch: 0 }
    }), { code: "POC_INVALID_ARGUMENT" });
    await assert.rejects(store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: intended
    }), { code: "POC_STALE_WRITER" });
    assert.equal(client.calls.set, 1);
});

test("PlayFab ambiguous financial write is reconciled by exact readback under the active provider fence", async () => {
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    await activate(store);
    const current = await store.read("PF_PLAYER");
    const intended = nextSnapshot(current, {
        diamonds: 1000,
        epoch: 1,
        highValueSequence: 1,
        now: 3000
    });
    client.failNextAfterSet();
    const result = await store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: intended,
        operationProof: providerProof("AMBIGUOUS")
    });
    assert.equal(result.status, "updated");
    assert.equal(result.recovered, true);
    assert.deepEqual(await store.read("PF_PLAYER"), intended);
});

test("non-version timeout with a conflicting proof remains terminal PROOF_MISMATCH", async () => {
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    await activate(store);
    const current = await store.read("PF_PLAYER");
    const intended = nextSnapshot(current, {
        diamonds: 25,
        epoch: 1,
        highValueSequence: 1,
        now: 3001
    });
    client.failNextAfterSetWithConflictingProof();
    await assert.rejects(store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: intended,
        operationProof: providerProof("TIMEOUT_CONFLICT")
    }), {
        code: "POC_PROVIDER_PROOF_MISMATCH"
    });
    const readback = await store.readWithMetadata("PF_PLAYER");
    assert.equal(readback.snapshot.diamonds, 25);
    assert.equal(readback.highValueProof.operationId, "OP_TIMEOUT_CONFLICT");
    assert.equal(readback.highValueProof.immutableHash, "f".repeat(64));
});

test("PlayFab ambiguous write with exact unchanged provider evidence is NOT_APPLIED", async () => {
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    await activate(store);
    const before = await store.readWithMetadata("PF_PLAYER");
    const intended = nextSnapshot(before.snapshot, {
        diamonds: 25,
        epoch: 1,
        highValueSequence: 1,
        now: 3001
    });
    client.failNextBeforeSet();
    await assert.rejects(store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: before.snapshot.revision,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: intended,
        operationProof: providerProof("NOT_APPLIED")
    }), {
        code: "POC_PLAYFAB_NOT_APPLIED",
        classification: PLAYFAB_CAS_RECONCILIATION_NOT_APPLIED
    });
    const after = await store.readWithMetadata("PF_PLAYER");
    assert.equal(after.objectVersion, before.objectVersion);
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.deepEqual(after.fence, before.fence);
    assert.deepEqual(after.highValueProof, before.highValueProof);
    assert.deepEqual(after.ammoProof, before.ammoProof);
});

test("PlayFab ambiguous classifier keeps changed or incoherent metadata UNKNOWN and conflicts terminal", async () => {
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    await activate(store);
    const current = await store.readWithMetadata("PF_PLAYER");
    const intended = nextSnapshot(current.snapshot, {
        diamonds: 25,
        epoch: 1,
        highValueSequence: 1,
        now: 3002
    });
    const exactProof = providerProof("STRICT");

    const revisionChanged = {
        ...structuredClone(current),
        objectVersion: current.objectVersion + 1,
        snapshot: {
            ...structuredClone(current.snapshot),
            revision: current.snapshot.revision + 1,
            updatedAtUnixMs: current.snapshot.updatedAtUnixMs + 1
        }
    };
    assert.equal(classifyServerEconomyPocPlayFabCasReadback({
        current,
        latest: revisionChanged,
        nextSnapshot: intended,
        verifiedProof: exactProof
    }), PLAYFAB_CAS_RECONCILIATION_UNKNOWN);

    const proofConflicted = {
        ...structuredClone(current),
        objectVersion: current.objectVersion + 1,
        highValueProof: providerProof("CONFLICT")
    };
    assert.equal(classifyServerEconomyPocPlayFabCasReadback({
        current,
        latest: proofConflicted,
        nextSnapshot: intended,
        verifiedProof: exactProof
    }), PLAYFAB_CAS_RECONCILIATION_PROOF_MISMATCH);

    const balanceOnly = {
        ...structuredClone(current),
        objectVersion: current.objectVersion + 1,
        snapshot: {
            ...structuredClone(current.snapshot),
            diamonds: intended.diamonds
        }
    };
    assert.equal(classifyServerEconomyPocPlayFabCasReadback({
        current,
        latest: balanceOnly,
        nextSnapshot: intended,
        verifiedProof: exactProof
    }), PLAYFAB_CAS_RECONCILIATION_UNKNOWN);
});

test("PlayFab store rejects identity mismatch and non-monotonic provider state", async () => {
    const wrong = createServerEconomyPocPlayFabSnapshotStore({
        client: fakePlayFab({ playFabId: "SOMEONE_ELSE" }),
        assertPlayerFence: permissiveFence()
    });
    await assert.rejects(
        wrong.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 }),
        { code: "POC_PLAYFAB_IDENTITY_MISMATCH" }
    );

    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: permissiveFence()
    });
    await store.initialize({ playFabId: "PF_PLAYER", expectedObjectVersion: 0 });
    await activate(store);
    const current = await store.read("PF_PLAYER");
    const invalid = nextSnapshot(current, {
        diamonds: 1,
        epoch: 1,
        highValueSequence: 1,
        now: 1000
    });
    invalid.revision = 2;
    await assert.rejects(
        store.compareAndSet({
            playFabId: "PF_PLAYER",
            expectedRevision: 0,
            leaseToken: "LEASE_TOKEN",
            fencingEpoch: 1,
            nextSnapshot: invalid
        }),
        { code: "POC_SNAPSHOT_CAS_INVALID" }
    );
});

test("provider-linearized takeover prevents delayed stale writer A from publishing", async () => {
    const clock = { now: 10_000 };
    const candidateLeases = createMemoryServerEconomyPocPlayerLeases({
        nowMilliseconds: () => clock.now
    });
    const client = fakePlayFab();
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client,
        nowMilliseconds: () => clock.now,
        assertPlayerFence: async (input) => candidateLeases.assertCurrentSync(input)
    });
    await store.initialize({
        playFabId: "PF_PLAYER",
        expectedObjectVersion: 0,
        initializedAtUnixMs: clock.now
    });
    const leases = createServerEconomyPocPlayFabFencedPlayerLeases({
        candidateLeases,
        snapshotStore: store
    });
    const leaseA = (await leases.acquire({
        playFabId: "PF_PLAYER",
        owner: "WORKER_A",
        token: "TOKEN_A",
        ttlMilliseconds: 1000
    })).lease;
    const currentA = await store.read("PF_PLAYER");
    const intendedA = nextSnapshot(currentA, {
        diamonds: 7,
        epoch: leaseA.epoch,
        highValueSequence: 1,
        now: clock.now
    });
    const gate = client.delayNextEconomyWrite();
    const delayedA = store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: leaseA.token,
        fencingEpoch: leaseA.epoch,
        nextSnapshot: intendedA,
        operationProof: providerProof("STALE_A")
    }).then(
        (value) => ({ value }),
        (error) => ({ error })
    );
    await gate.entered;

    clock.now += 1001;
    const leaseB = (await leases.acquire({
        playFabId: "PF_PLAYER",
        owner: "WORKER_B",
        token: "TOKEN_B",
        ttlMilliseconds: 1000
    })).lease;
    assert.ok(leaseB.epoch > leaseA.epoch);
    gate.release();
    const staleResult = await delayedA;
    assert.equal(staleResult.error?.code, "POC_STALE_WRITER");
    assert.equal((await store.read("PF_PLAYER")).diamonds, 0);

    const currentB = await store.read("PF_PLAYER");
    const intendedB = nextSnapshot(currentB, {
        diamonds: 9,
        epoch: leaseB.epoch,
        highValueSequence: 1,
        now: clock.now
    });
    const winner = await store.compareAndSet({
        playFabId: "PF_PLAYER",
        expectedRevision: 0,
        leaseToken: leaseB.token,
        fencingEpoch: leaseB.epoch,
        nextSnapshot: intendedB,
        operationProof: providerProof("WINNER_B")
    });
    assert.equal(winner.status, "updated");
    assert.equal((await store.readWithMetadata("PF_PLAYER")).fence.fencingEpoch, leaseB.epoch);
    assert.equal((await store.read("PF_PLAYER")).diamonds, 9);
});

test("provider-fenced recovery acquires strictly above a durable fence after Redis epoch loss", async () => {
    const clock = { now: 20_000 };
    const client = fakePlayFab();
    const bootstrap = createServerEconomyPocPlayFabSnapshotStore({
        client,
        nowMilliseconds: () => clock.now,
        assertPlayerFence: permissiveFence()
    });
    await bootstrap.initialize({
        playFabId: "PF_PLAYER",
        expectedObjectVersion: 0,
        initializedAtUnixMs: clock.now
    });
    await bootstrap.activateFence({
        playFabId: "PF_PLAYER",
        leaseToken: "OLD_PROVIDER_TOKEN",
        fencingEpoch: 7
    });

    const candidateLeases = createMemoryServerEconomyPocPlayerLeases({
        nowMilliseconds: () => clock.now
    });
    const recoveryStore = createServerEconomyPocPlayFabSnapshotStore({
        client,
        nowMilliseconds: () => clock.now,
        assertPlayerFence: async (input) => candidateLeases.assertCurrentSync(input)
    });
    const leases = createServerEconomyPocPlayFabFencedPlayerLeases({
        candidateLeases,
        snapshotStore: recoveryStore
    });
    const recovered = await leases.acquire({
        playFabId: "PF_PLAYER",
        owner: "RECOVERY_WORKER",
        token: "RECOVERY_TOKEN",
        ttlMilliseconds: 1_000
    });
    assert.equal(recovered.status, "acquired");
    assert.equal(recovered.lease.epoch, 8);
    assert.equal((await recoveryStore.readWithMetadata("PF_PLAYER")).fence.fencingEpoch, 8);
    assert.throws(() => candidateLeases.assertCurrentSync({
        playFabId: "PF_PLAYER",
        token: "OLD_PROVIDER_TOKEN",
        epoch: 7
    }), { code: "POC_STALE_WRITER" });
});

test("provider-fenced acquire safely retries a race with a newly advanced provider fence", async () => {
    const clock = { now: 30_000 };
    const candidateLeases = createMemoryServerEconomyPocPlayerLeases({
        nowMilliseconds: () => clock.now
    });
    let providerEpoch = 7;
    let activationCount = 0;
    const snapshotStore = {
        async readWithMetadata() {
            return { exists: true, fence: { fencingEpoch: providerEpoch } };
        },
        async activateFence({ fencingEpoch }) {
            activationCount += 1;
            if (activationCount === 1) {
                providerEpoch = 8;
                throw Object.assign(new Error("provider fence raced"), {
                    code: "POC_STALE_WRITER"
                });
            }
            assert.ok(fencingEpoch > providerEpoch);
            providerEpoch = fencingEpoch;
            return { status: "activated", objectVersion: activationCount };
        },
        async assertActiveFence() {
            return { status: "active" };
        }
    };
    const leases = createServerEconomyPocPlayFabFencedPlayerLeases({
        candidateLeases,
        snapshotStore,
        maximumProviderFenceAcquireAttempts: 3
    });
    const recovered = await leases.acquire({
        playFabId: "PF_PLAYER",
        owner: "RECOVERY_WORKER",
        token: "RECOVERY_TOKEN",
        ttlMilliseconds: 1_000
    });
    assert.equal(activationCount, 2);
    assert.equal(recovered.lease.epoch, 9);
    assert.equal(providerEpoch, 9);
    assert.throws(() => candidateLeases.assertCurrentSync({
        playFabId: "PF_PLAYER",
        token: "RECOVERY_TOKEN",
        epoch: 8
    }), { code: "POC_STALE_WRITER" });
});