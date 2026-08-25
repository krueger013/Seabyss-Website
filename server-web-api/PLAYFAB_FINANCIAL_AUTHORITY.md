# PlayFab Financial Authority

## Safety status

`PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED` is `false` by default. This document describes the
only supported target contract. It does not authorize a live migration, checkout, payment, grant,
or deployment.

Current production-readiness verdict: **NOT READY**. The provider-side implementation and the
Unity projection contract exist locally, but the Unity runtime reader/writer is not connected to
this contract, the Economy v2 catalog mapping has not been published and verified, and no live
PlayFab/Redis/multi-process validation has been performed.

## Authority matrix

| Resource | Legacy Unity authority | Legacy payment authority | Canonical authority after cutover |
|---|---|---|---|
| Gold | PlayFab Legacy Economy VC `GD`; `profile_v1.gold` is a mirror | legacy profile copy when present | PlayFab Economy v2 currency item mapped from reward `gold` |
| Diamonds | PlayFab Legacy Economy VC `DM`; `profile_v1.diamonds` is a mirror | `SeabyssFinancialProfileV1.diamonds` | PlayFab Economy v2 currency item mapped from reward `diamonds` |
| Siren Tears | `profile_v1.sirenTears` | legacy profile copy when present | PlayFab Economy v2 currency item mapped from reward `siren_tears` |
| Elite Points | `profile_v1.elitePoints` | legacy profile copy when present | PlayFab Economy v2 currency item mapped from reward `elite_points` |
| Elite / Poison cannonballs | `profile_v1.ammo` | full copied profile in `SeabyssFinancialProfileV1` | PlayFab Economy v2 inventory |
| Thor's Wrath, Powders, Armor Plates, Stardust, Amulets | `profile_v1.usableItems` | full copied profile | PlayFab Economy v2 inventory |
| Carronades / Long Range Cannons | `profile_v1.cannons[].owned` | full copied profile | PlayFab Economy v2 inventory |
| Harpoon II (`harpoon_diamond_250`) | `profile_v1.harpoons.quantities` | full copied profile | PlayFab Economy v2 inventory |
| Premium tier and expiration | `profile_v1.shopEntitlements` | full copied profile | Entity Object `SeabyssFinancialAuthorityV2` with PlayFab ProfileVersion CAS |
| Red / Blue destination points | `profile_v1.ownedDestinationMarkerIds` | full copied profile | `SeabyssFinancialAuthorityV2.paidDestinationMarkerIds` |
| Blaky and other paid ship designs | `profile_v1.ownedShipDesignIds` | full copied profile | `SeabyssFinancialAuthorityV2.paidShipDesignIds` |
| Starter one-time ownership | receipts / durable transactions in `profile_v1` | full copied profile and central ledger | central ledger plus `SeabyssFinancialAuthorityV2.ownedStarterSkus` projection |
| Immutable receipts and step journal | xss1/xsd1/profile ledgers | xss2/xsd2 plus payment ledger | xss2/xsd2 plus central ledger; unchanged |
| Position, quests, ships, guild, combat progress | `profile_v1` | not payment-owned | gameplay profile only |

One resource has one active source of truth. Legacy `DM` and the financial fields left in
`profile_v1` become migration inputs/read-only compatibility projections after cutover; they must
not be dual-written as authorities.

## Why legacy DM cannot remain the payment authority

Legacy `Server/AddUserVirtualCurrency` has no idempotency key, no conditional version, and no
queryable operation identifier. If PlayFab commits the increment and the HTTP response is lost,
an automatic retry can double the balance and refusing the retry can lose the grant. A marker in a
second PlayFab operation does not make the two writes atomic.

The target therefore uses Economy v2 `ExecuteInventoryOperations` with a deterministic
`IdempotencyId`. The exact request is replayed after an ambiguous timeout. PlayFab retains the
idempotency result for 14 days. A still-ambiguous step outside that window is not retried and must
enter `ManualReview`; it cannot become `Completed`.

The gameplay writer deliberately omits an ETag from that idempotent provider request. It keeps the
pre-read ETag as journal evidence and uses the response ETag for bounded read-after-write
reconciliation. PlayFab documents ETag retries and idempotent retries as different strategies. The
migration apply path remains provider-write disabled until its snapshot seeding flow stops combining
the two strategies and has a separately approved ambiguous-result reconciliation algorithm.

## Field ownership

Financial server only:

- Economy v2 balances and quantities listed in the matrix;
- Premium tier/duration;
- paid destination markers and paid ship designs;
- Starter ownership and payment operation proofs;
- financial revision, migration proof, fencing token, and provider transaction evidence.

Gameplay server/client save path:

- position, map, health, progress, quest state, statistics, equipped selections, ships, captains,
  guild and other non-financial gameplay fields;
- it may request an authenticated financial mutation, but it may not submit an absolute financial
  balance, entitlement, unlock set, revision, or migration marker.

The existing full `profile_v1` serializer is not a permitted writer of canonical financial data.
In Cutover, the isolated profile wrapper restores the loaded legacy financial baseline before
writing `profile_v1`; canonical quantities and entitlements remain in V2 only. A canonical load
then overlays `FinancialProfileSnapshotV2`, so a stale gameplay save cannot lower V2 state.

## Revisions, CAS, leases, and fencing

`SeabyssFinancialAuthorityV2` contains `financialRevision`, `lastFencingToken`, operation proofs,
and migration evidence. Every server mutation:

1. owns the central-ledger transaction lease and player lease;
2. reads the current PlayFab Entity Object/ProfileVersion;
3. rejects a stale fencing epoch;
4. builds the mutation from the current authority;
5. writes with `ExpectedProfileVersion`;
6. reads back and verifies the operation proof.

CAS conflicts are rebuilt from a fresh snapshot. A lost SetObjects response is reconciled by
reading the same operation proof; it is never blindly applied again. Unity's projection contract
detects `expectedRevision < canonicalRevision` and preserves gameplay fields while replacing all
financial fields. The contract is not yet wired to the live profile store/coordinator.

## Worker flow

```text
xss2/xsd2 immutable receipt
  -> central ledger Pending
  -> transaction + player leases
  -> StepPending economy_v2_granted
  -> ExecuteInventoryOperations(IdempotencyId)
  -> StepApplied + checkpoint economy_v2_granted
  -> StepPending entitlements_granted
  -> Entity Object CAS + operation/fencing proof
  -> StepApplied + checkpoint entitlements_granted
  -> idempotent provider replay + authority readback
  -> checkpoint profile_granted
  -> Completed
```

`Completed` is forbidden when the player is unmigrated, any catalog mapping is missing, the
provider result is ambiguous, either checkpoint lacks evidence, or final verification fails.

## Online and offline flow

Offline target flow: the worker mutates Economy v2 and the V2 authority without a Unity process.
At the next login Unity obtains a financial snapshot from those same sources and overlays it on the
gameplay profile. The receipt is already complete, so login observes and never re-grants it.

Online target flow: a financial revision change invalidates the cached financial projection. The
game server reloads the financial snapshot and sends the refreshed wallet/inventory/entitlements
to the client. A save based on the old revision cannot set financial fields; its gameplay fields are
merged onto the new financial projection. No game-server grant is invoked.

The local Unity code now provides the projection/merge contract, PlayFab V2 reader/writer,
revision-aware cache/refresh primitives, isolated profile wrapper, and Legacy-composed factory
boundaries. Cutover target-store composition, gameplay event call-sites, UI refresh subscription,
and server action resolver remain deliberately unwired.

## Deterministic migration

Migration is per player and never automatic during an ordinary payment grant:

1. read legacy `profile_v1`;
2. read `SeabyssFinancialProfileV1`, if present;
3. read legacy VC `DM`;
4. read current Economy v2 inventory;
5. compute and persist source hashes;
6. build an idempotent Economy v2 migration batch;
7. create `SeabyssFinancialAuthorityV2` at revision 1 with CAS;
8. verify both stores before recording migration `Completed`.

Conflict policy:

- Diamonds: legacy `DM` is the one-time migration input; JSON diamond fields are ignored and
  recorded only for audit.
- Quantitative inventory: if `profile_v1` and the V1 financial copy differ, migration stops in
  `ManualReview`; consumption versus grant cannot be guessed.
- Existing non-zero Economy v2 quantities that differ from the target also require manual review.
- Permanent unlocks/ownership are a monotonic union of server-owned legacy sources.
- Differing Premium tier/expiration requires manual review.

No account is migrated by the local implementation in this mission.

## Activation checks

When cutover is requested, startup fails unless all of the following are explicit and coherent:

- Economy v2 and FinancialAuthorityV2 enabled;
- Unity authority version and migration version are `financial_v2`;
- revision CAS, server-owned financial fields, and financial refresh are enabled;
- every additive Starter/Diamond reward has a published Economy v2 catalog mapping;
- durable ledger, Redis, worker, PlayFab credentials, receipts, purchase gates, and checkout gates
  satisfy the existing Production guards.

The example configuration keeps every purchase/cutover flag off.

## Rollback

Before activation, rollback is simply leaving the cutover and purchase gates off. After a real
migration begins, never restore dual-write. A safe incident response is: disable purchases and the
worker, preserve ledger/receipts/provider evidence, reconcile affected operations, then resume the
same authority. Returning migrated accounts to legacy `DM/profile_v1` requires a separately
designed reverse migration and is not an operational toggle.
