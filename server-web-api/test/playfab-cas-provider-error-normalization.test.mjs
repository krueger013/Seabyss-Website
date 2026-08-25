import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
    createPlayFabFinancialProfileClient,
    createPlayFabFinancialProfileStore
} from "../src/playfab-financial-profile-store.js";
import {
    createServerEconomyPocPlayFabSnapshotStore,
    SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME,
    SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME
} from "../src/server-economy-poc-playfab-snapshot-store.js";
import { createServerEconomyPocInitialSnapshot } from "../src/server-economy-poc-domain-model.js";

const playFabId = "SANDBOX_PLAYER";
const entityId = "SANDBOX_ENTITY";

function profile(diamonds = 0) {
    return {
        schemaVersion: 12,
        playerAccountId: playFabId,
        diamonds,
        ammo: [],
        usableItems: [],
        cannons: [],
        harpoons: { quantities: [], equippedHarpoonId: "" },
        ownedDestinationMarkerIds: [],
        ownedShipDesignIds: [],
        shopEntitlements: [],
        shopReceiptLedger: { appliedTransactionIds: [] },
        durableEconomyTransactions: []
    };
}

function numericConflict(code = 1352) {
    return Object.assign(new Error("provider conflict"), {
        code,
        providerErrorCode: code,
        status: 400
    });
}

test("PlayFab HTTP errors preserve the provider name and numeric code", async () => {
    const client = createPlayFabFinancialProfileClient({
        titleId: "1D0C16",
        secretKey: "not-logged",
        fetchImpl: async () => ({
            ok: false,
            status: 400,
            headers: { get: () => null },
            json: async () => ({
                code: 400,
                error: "EntityProfileVersionMismatch",
                errorCode: 1352,
                errorMessage: "conflict"
            })
        })
    });
    await assert.rejects(
        client.setObjects({ Id: entityId, Type: "title_player_account" }, "token", 4, []),
        (error) => error.code === "EntityProfileVersionMismatch" &&
            error.providerError === "EntityProfileVersionMismatch" &&
            error.providerErrorCode === 1352 && error.status === 400
    );
});

for (const providerErrorCode of [1352, 1133]) {
    test(`financial profile CAS recognizes numeric provider conflict ${providerErrorCode}`, async () => {
        const envelope = {
            schemaVersion: 1,
            legacyPlayFabId: playFabId,
            lastFencingToken: 0,
            appliedOperations: [],
            playerProfile: profile()
        };
        const client = {
            getUserAccountInfo: async () => ({ UserInfo: { TitleInfo: { TitlePlayerAccount: { Id: entityId } } } }),
            getEntityToken: async () => ({ EntityToken: "token" }),
            getUserInternalData: async () => ({ Data: {} }),
            getObjects: async () => ({
                ProfileVersion: 4,
                Objects: { SeabyssFinancialProfileV1: { DataObject: structuredClone(envelope) } }
            }),
            setObjects: async () => { throw numericConflict(providerErrorCode); }
        };
        const store = createPlayFabFinancialProfileStore({ client });
        const result = await store.compareAndSet({
            playFabId,
            expectedVersion: 4,
            profile: profile(1),
            operationId: `numeric-${providerErrorCode}`,
            fencingToken: 1
        });
        assert.deepEqual(result, { applied: false, reason: "version_conflict", version: 4 });
    });
}

function snapshotClient({ readbackFails = false } = {}) {
    const snapshot = createServerEconomyPocInitialSnapshot(playFabId, 0);
    const fence = {
        schemaVersion: 1,
        playFabId,
        fencingEpoch: 1,
        leaseTokenDigest: createHash("sha256").update("LEASE_TOKEN", "utf8").digest("hex"),
        activatedAtUnixMs: 1
    };
    let reads = 0;
    return {
        getUserAccountInfo: async () => ({
            UserInfo: { PlayFabId: playFabId, TitleInfo: { TitlePlayerAccount: { Id: entityId } } }
        }),
        getEntityToken: async () => ({ EntityToken: "token" }),
        getObjects: async () => {
            reads += 1;
            if (readbackFails && reads > 1) throw Object.assign(new Error("readback unavailable"), { code: "ETIMEDOUT" });
            return {
                ProfileVersion: 4,
                Objects: {
                    [SERVER_ECONOMY_POC_PLAYFAB_OBJECT_NAME]: { DataObject: structuredClone(snapshot) },
                    [SERVER_ECONOMY_POC_PLAYFAB_FENCE_OBJECT_NAME]: { DataObject: structuredClone(fence) }
                }
            };
        },
        setObjects: async () => { throw numericConflict(1352); }
    };
}

function nextSnapshot() {
    return {
        ...createServerEconomyPocInitialSnapshot(playFabId, 0),
        revision: 1,
        fencingEpoch: 1,
        updatedAtUnixMs: 2
    };
}

test("snapshot CAS recognizes numeric 1352 and returns only verified readback", async () => {
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client: snapshotClient(),
        assertPlayerFence: async () => {}
    });
    const result = await store.compareAndSet({
        playFabId,
        expectedRevision: 0,
        leaseToken: "LEASE_TOKEN",
        fencingEpoch: 1,
        nextSnapshot: nextSnapshot()
    });
    assert.equal(result.status, "version_conflict");
    assert.equal(result.snapshot.revision, 0);
});

test("snapshot CAS fails ambiguous when conflict readback cannot be verified", async () => {
    const store = createServerEconomyPocPlayFabSnapshotStore({
        client: snapshotClient({ readbackFails: true }),
        assertPlayerFence: async () => {}
    });
    await assert.rejects(
        store.compareAndSet({
            playFabId,
            expectedRevision: 0,
            leaseToken: "LEASE_TOKEN",
            fencingEpoch: 1,
            nextSnapshot: nextSnapshot()
        }),
        (error) => error.code === "POC_PLAYFAB_AMBIGUOUS_RESULT"
    );
});
