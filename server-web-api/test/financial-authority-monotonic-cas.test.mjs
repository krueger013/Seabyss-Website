import assert from "node:assert/strict";
import test from "node:test";
import {
    applyFinancialEntitlementGrant,
    createInitialFinancialAuthority
} from "../src/financial-authority-v2.js";
import { createPlayFabFinancialAuthorityStore } from "../src/playfab-financial-authority-store.js";

const playFabId = "46789223F9CB1BB9";
const objectName = "SeabyssFinancialAuthorityV2";

function clientHarness(initialAuthority) {
    let authority = structuredClone(initialAuthority);
    let profileVersion = 1;
    let writes = 0;
    return {
        async getUserAccountInfo(id) {
            return {
                UserInfo: {
                    PlayFabId: id,
                    TitleInfo: { TitlePlayerAccount: { Id: "title-player-account" } }
                }
            };
        },
        async getEntityToken() {
            return { EntityToken: "title-entity-token" };
        },
        async getObjects() {
            return {
                ProfileVersion: profileVersion,
                Objects: { [objectName]: { DataObject: structuredClone(authority) } }
            };
        },
        async setObjects(_entity, _token, expectedProfileVersion, objects) {
            assert.equal(expectedProfileVersion, profileVersion);
            authority = structuredClone(objects[0].DataObject);
            profileVersion += 1;
            writes += 1;
            return { ProfileVersion: profileVersion };
        },
        writes() { return writes; }
    };
}

function initialAuthority() {
    return createInitialFinancialAuthority({
        playFabId,
        migratedAtUtc: "2026-08-22T00:00:00.000Z",
        sourceDigests: {
            profileV1: "a".repeat(64),
            financialV1: "b".repeat(64),
            legacyDm: "c".repeat(64)
        },
        premium: {
            tier: 1,
            activatedAtUtcIso8601: "2026-08-23T00:00:00.000Z",
            expiresAtUtcIso8601: "2026-08-30T00:00:00.000Z",
            lastTransactionId: "premium-old"
        },
        paidDestinationMarkerIds: ["destination_red_point"],
        paidShipDesignIds: ["design_blaky"],
        ownedStarterSkus: ["seabyss_starter_pack_1"],
        appliedTransactionIds: ["old-transaction"]
    });
}

function candidate(snapshot, operationId, fencingToken) {
    const value = structuredClone(snapshot.authority);
    value.financialRevision += 1;
    value.lastFencingToken = fencingToken;
    value.appliedOperations.push(operationId);
    value.appliedTransactionIds.push(operationId + "-transaction");
    return value;
}

test("FinancialAuthorityV2 CAS is monotonic for durable proofs, ownership and Premium", async () => {
    const client = clientHarness(initialAuthority());
    const store = createPlayFabFinancialAuthorityStore({ client });
    const snapshot = await store.read(playFabId);

    const removedUnlock = candidate(snapshot, "remove-unlock", 1);
    removedUnlock.paidDestinationMarkerIds = [];
    await assert.rejects(store.compareAndSet({
        playFabId,
        expectedObjectVersion: snapshot.objectVersion,
        expectedFinancialRevision: snapshot.financialRevision,
        authority: removedUnlock,
        operationId: "remove-unlock",
        fencingToken: 1
    }), /cannot remove durable evidence/u);

    const reducedPremium = candidate(snapshot, "reduce-premium", 1);
    reducedPremium.premium.expiresAtUtcIso8601 = "2026-08-29T00:00:00.000Z";
    await assert.rejects(store.compareAndSet({
        playFabId,
        expectedObjectVersion: snapshot.objectVersion,
        expectedFinancialRevision: snapshot.financialRevision,
        authority: reducedPremium,
        operationId: "reduce-premium",
        fencingToken: 1
    }), /Premium expiration cannot decrease/u);

    assert.equal(client.writes(), 0);

    const valid = applyFinancialEntitlementGrant(snapshot.authority, {
        sku: "seabyss_starter_pack_2",
        transactionId: "valid-starter-2",
        operationId: "valid-operation",
        fencingToken: 1,
        productPlanVersion: 1,
        rewardPlanVersion: 1,
        nowUtc: new Date("2026-08-23T00:00:00.000Z")
    }).authority;
    const applied = await store.compareAndSet({
        playFabId,
        expectedObjectVersion: snapshot.objectVersion,
        expectedFinancialRevision: snapshot.financialRevision,
        authority: valid,
        operationId: "valid-operation",
        fencingToken: 1
    });
    assert.equal(applied.applied, true);
    assert.equal(client.writes(), 1);
    assert.ok(applied.authority.paidDestinationMarkerIds.includes("destination_red_point"));
    assert.ok(applied.authority.paidDestinationMarkerIds.includes("destination_blue_point"));
    assert.ok(applied.authority.paidShipDesignIds.includes("design_blaky"));
    assert.ok(applied.authority.ownedStarterSkus.includes("seabyss_starter_pack_1"));
    assert.ok(applied.authority.ownedStarterSkus.includes("seabyss_starter_pack_2"));
    assert.ok(Date.parse(applied.authority.premium.expiresAtUtcIso8601) >=
        Date.parse(snapshot.authority.premium.expiresAtUtcIso8601));
});
