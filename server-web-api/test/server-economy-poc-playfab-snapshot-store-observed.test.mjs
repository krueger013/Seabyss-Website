import test from "node:test";
import assert from "node:assert/strict";
import {
    createObservedServerEconomyPocPlayFabSnapshotStore
} from "../src/server-economy-poc-playfab-snapshot-store-observed.js";
import {
    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME
} from "../src/server-economy-poc-playfab-snapshot-store.js";
import { createServerEconomyPocHighValueProviderProof } from "../src/server-economy-poc-provider-proof.js";

function fakePlayFab() {
    let profileVersion = 0;
    const objects = new Map();
    const calls = { account: 0, token: 0, get: 0, set: 0 };
    return {
        calls,
        async getUserAccountInfo(playFabId) {
            calls.account += 1;
            return {
                UserInfo: {
                    PlayFabId: playFabId,
                    TitleInfo: { TitlePlayerAccount: { Id: `ENTITY_${playFabId}` } }
                }
            };
        },
        async getEntityToken() {
            calls.token += 1;
            return {
                EntityToken: "FAKE_TOKEN_NEVER_LOGGED",
                TokenExpiration: "2099-01-01T00:00:00.000Z"
            };
        },
        async getObjects(entity, token) {
            calls.get += 1;
            assert.equal(entity.Type, "title_player_account");
            assert.equal(token, "FAKE_TOKEN_NEVER_LOGGED");
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
            assert.equal(entity.Type, "title_player_account");
            assert.equal(token, "FAKE_TOKEN_NEVER_LOGGED");
            if (expectedProfileVersion !== profileVersion) {
                throw Object.assign(new Error("version conflict"), {
                    code: "EntityProfileVersionMismatch",
                    status: 409
                });
            }
            for (const entry of writes) {
                objects.set(entry.ObjectName, structuredClone(entry.DataObject));
            }
            profileVersion += 1;
            return { ProfileVersion: profileVersion };
        }
    };
}

function counter(snapshot, name, labels = "") {
    return snapshot.counters[`${name}|${labels}`] || 0;
}

function nextSnapshot(current, { diamonds = 100, epoch = 1 } = {}) {
    return {
        ...structuredClone(current),
        revision: current.revision + 1,
        fencingEpoch: epoch,
        diamonds,
        highValueAppliedThroughSequence: current.highValueAppliedThroughSequence + 1,
        updatedAtUnixMs: current.updatedAtUnixMs + 1
    };
}

function providerProof() {
    return createServerEconomyPocHighValueProviderProof({
        playFabId: "OBSERVED_PLAYER",
        sequence: 1,
        operation: {
            operationId: "OBSERVED_OPERATION",
            eventId: "OBSERVED_EVENT",
            immutableHash: "b".repeat(64)
        }
    });
}

test("observed PlayFab snapshot store reports actual HTTP calls separately from SetObjects writes", async () => {
    const client = fakePlayFab();
    const clock = { now: 1_000 };
    let monotonic = 0;
    const store = createObservedServerEconomyPocPlayFabSnapshotStore({
        client,
        nowMilliseconds: () => clock.now,
        monotonicMilliseconds: () => ++monotonic,
        contextCacheTtlMilliseconds: 60_000,
        assertPlayerFence: async () => {}
    });

    await store.initialize({
        playFabId: "OBSERVED_PLAYER",
        expectedObjectVersion: 0,
        initializedAtUnixMs: clock.now
    });
    await store.activateFence({
        playFabId: "OBSERVED_PLAYER",
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1
    });
    const current = await store.read("OBSERVED_PLAYER");
    const updated = await store.compareAndSet({
        playFabId: "OBSERVED_PLAYER",
        expectedRevision: current.revision,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: nextSnapshot(current),
        operationProof: providerProof()
    });
    assert.equal(updated.status, "updated");

    const metrics = store.httpMetricsSnapshot();
    assert.equal(counter(metrics, "playfab_http_total"), 12);
    assert.equal(counter(metrics, "playfab_http_method_total", "method=GetUserAccountInfo"), 1);
    assert.equal(counter(metrics, "playfab_http_method_total", "method=GetEntityToken"), 1);
    assert.equal(counter(metrics, "playfab_http_method_total", "method=GetObjects"), 7);
    assert.equal(counter(metrics, "playfab_http_method_total", "method=SetObjects"), 3);
    assert.equal(counter(metrics, "playfab_set_objects_total"), 3);
    assert.equal(client.calls.account, 1);
    assert.equal(client.calls.token, 1);
    assert.equal(client.calls.get, 7);
    assert.equal(client.calls.set, 3);
    assert.equal(store.reportsActualPlayFabHttpCalls, true);
    assert.equal(store.contextCachePolicy.bounded, true);

    clock.now += 60_001;
    await store.read("OBSERVED_PLAYER");
    assert.equal(client.calls.account, 2);
    assert.equal(client.calls.token, 2);
    assert.equal(client.calls.get, 8);
    await store.probe();
    assert.equal(client.calls.token, 3);
    assert.equal(counter(store.httpMetricsSnapshot(), "playfab_http_total"), 16);
});

test("observed PlayFab store rejects a stale player fence before any SetObjects mutation", async () => {
    const client = fakePlayFab();
    const store = createObservedServerEconomyPocPlayFabSnapshotStore({
        client,
        assertPlayerFence: async () => {
            throw Object.assign(new Error("stale worker"), { code: "POC_STALE_PLAYER_FENCE" });
        }
    });
    await store.initialize({ playFabId: "STALE_FENCE_PLAYER", expectedObjectVersion: 0 });
    const current = await store.read("STALE_FENCE_PLAYER");
    const setCallsBefore = client.calls.set;
    await assert.rejects(store.compareAndSet({
        playFabId: "STALE_FENCE_PLAYER",
        expectedRevision: current.revision,
        leaseToken: "STALE_LEASE",
        fencingEpoch: 1,
        nextSnapshot: nextSnapshot(current)
    }), { code: "POC_STALE_PLAYER_FENCE" });
    assert.equal(client.calls.set, setCallsBefore);
    assert.equal(counter(store.httpMetricsSnapshot(), "playfab_set_objects_total"), 1);
});
