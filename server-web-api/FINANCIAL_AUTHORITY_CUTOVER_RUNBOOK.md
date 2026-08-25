# Seabyss financial authority cutover runbook

Status: local preparation only. The active mode remains `Legacy`. This runbook does not authorize a PlayFab catalog publication, a player migration, a checkout, a payment, or a deployment.

## 1. Authority contract

The intended post-cutover ownership is:

| Domain | Canonical write authority | Legacy data after cutover |
|---|---|---|
| Gold, Diamonds, Siren Tears, Elite Points | PlayFab Economy v2 deterministic stacks | `GD`, `DM`, and `profile_v1` scalars are migration inputs only |
| Cannons, ammunition, consumables, harpoons | PlayFab Economy v2 deterministic stacks | `profile_v1` quantities are migration inputs only |
| Premium, paid markers, paid ship designs, Starter ownership | `SeabyssFinancialAuthorityV2` | legacy ownership is unioned once during migration |
| Equipped cannon counts, selected ammo, equipped harpoon/design | gameplay profile | stays non-financial gameplay state |
| XP, quests, map, position, health, settings | gameplay profile | unchanged |

No financial resource may have more than one writable authority in `Cutover` mode. Runtime SyncVars and SyncDictionaries are projections and caches, not durable authorities.

## 2. Prerequisites

Before any ShadowRead or Cutover activation, record and approve:

- exact Unity and backend revisions;
- an empty Git staging area;
- a backup and tested restore path for Redis and PlayFab authority objects;
- a dedicated Sandbox title and test accounts;
- a complete resource mapping registry whose digest is pinned to the release;
- a published Economy v2 catalog containing every mapped item and deterministic stack;
- PlayFab policies denying client writes to financial inventory and `SeabyssFinancialAuthorityV2`;
- live Redis with persistence and fencing-tested player leases;
- healthy payment and gameplay mutation workers;
- a completed legacy-access scan with no unapproved runtime writer;
- zero unresolved migration conflicts and zero ShadowRead mismatches for the rollout cohort.

The following gates remain false during local preparation:

```text
ShopPurchasesEnabled=false
PURCHASES_GLOBAL_ENABLED=false
PURCHASES_DIAMOND_ENABLED=false
PURCHASES_STARTER_ENABLED=false
PURCHASES_PREMIUM_ENABLED=false
PURCHASES_DOUBLER_ENABLED=false
XSOLLA_HARDENED_CATALOG_ENABLED=false
XSOLLA_CHECKOUT_SANDBOX_ENABLED=false
XSOLLA_CHECKOUT_PRODUCTION_ENABLED=false
PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=false
```

## 3. Economy catalog

1. Generate the required resource list from the canonical registry.
2. Create the catalog items in the Sandbox title manually under change control.
3. Use deterministic stack IDs; never use a generated stack for a fungible quantity.
4. Enter the real IDs in `PLAYFAB_ECONOMY_V2_CATALOG_MAPPINGS_JSON`.
5. Run registry validation. It must reject missing, extra, duplicate, whitespace-containing, wrong-kind, or shared-target mappings.
6. Verify every item through the PlayFab API and capture the catalog/version evidence.
7. Pin the registry digest and catalog evidence to the release candidate.

The repository deliberately contains no guessed live item IDs.

## 4. PlayFab policy

The backend/game-server identity may read and mutate the mapped Economy v2 collection and may read/CAS `SeabyssFinancialAuthorityV2`. A player entity may read only the projection required by the UI. It must not be able to:

- execute inventory additions or subtractions;
- set or replace `SeabyssFinancialAuthorityV2`;
- alter Premium, markers, designs, Starter ownership, revision, fencing, or applied-operation evidence;
- provide a catalog mapping, balance, price, grant quantity, or entitlement mutation to a trusted endpoint.

Certification requires negative live tests using a player EntityToken and positive tests using only the server identity. Store the exact protected resource identifier and policy evidence; configuration text alone is not certification.

## 5. Dry run

The dry-run input is a consistent read of:

- legacy `profile_v1`;
- legacy `GD` and `DM` balances;
- any existing financial projection;
- Economy v2 deterministic stacks and ETag;
- `SeabyssFinancialAuthorityV2` and object version;
- immutable Starter/payment ownership evidence.

For each player, persist an immutable plan containing legacy values, target values, proposed operations, conflicts, evidence digests, and `planHash`. A dry run performs no mutation. Any identity mismatch, duplicate legacy entry, unmapped resource, malformed timestamp, unknown paid unlock, or divergent existing target becomes a conflict.

## 6. ShadowRead

1. Keep gameplay writes on Legacy.
2. Enable ShadowRead only in Sandbox for an explicit cohort.
3. Read Legacy and V2 concurrently at login and at bounded revision refresh points.
4. Compare every quantity, Premium interval/tier, paid marker, paid design, and Starter ownership.
5. Log only identifiers and digests needed for diagnosis; never log secrets or session tickets.
6. Do not repair mismatches automatically.
7. Require zero unresolved mismatches across reconnects, game-server restarts, and payment-worker grants before migration approval.

ShadowRead never applies a reward and never changes gameplay state from the V2 result.

## 7. Migration apply

Migration apply remains disabled by default. Enabling it requires all of:

- an explicit migration gate;
- an approved immutable `planHash`;
- a transaction lease and a player lease;
- a fresh fencing epoch;
- an Economy v2 freshness proof and an explicitly approved concurrency strategy;
- an authority object version/CAS precondition;
- a durable intent journal before each provider mutation;
- deterministic idempotency IDs only on flows that do not retry with a changed ETag;
- a durable audit result.

Apply quantitative operations atomically when they share the same collection and fit the provider operation bound. Union historical paid ownership with existing authority ownership. Premium uses server UTC, cumulative duration, and the highest active tier. Reapplying the same plan must be a no-op with identical final state.

Do not combine an ETag precondition with `IdempotencyId` in the migration provider request. A known
ETag conflict invalidates the approved plan and requires a new dry run and new operation ID. An
ambiguous result must be reconciled against the exact `before` and `target` snapshots before any new
attempt. The local migration provider-write gates stay off until this flow is implemented and
Sandbox-certified.

Never migrate a conflicted account automatically. Move it to ManualReview.

## 8. Mismatch scan

After migration, read all stores again and compare them to the approved plan. The cohort is eligible for Cutover only when:

- every plan is Completed;
- no provider result is ambiguous;
- every Economy v2 quantity is exact;
- every entitlement union is exact;
- every `financialRevision` is monotonic;
- no runtime legacy writer has appeared since the pinned code-scan digest;
- payment worker, gameplay mutation service, Redis, and PlayFab probes are healthy.

## 9. Cutover

Use a small canary cohort first.

1. Stop new legacy financial mutations for the cohort.
2. Drain in-flight gameplay and payment mutations.
3. Take a final Legacy/V2 comparison under player lease.
4. Switch reads and writes together to `Cutover`; never enable a read-only or write-only half-cutover.
5. Project V2 state into runtime SyncVars/SyncDictionaries and refresh UI from the projection.
6. Save only gameplay-owned state. Financial fields in `profile_v1` remain inert migration evidence and are never merged into V2 again.
7. Poll/revalidate `financialRevision` at login, before financial actions, after an external payment signal, and at a bounded cache expiry. A refresh reloads state; it never reapplies a grant.
8. For atomic gameplay Add/Subtract, replay only the identical `IdempotencyId` request and use the response ETag for reconciliation. For an ETag-governed migration conflict, invalidate the plan and require a fresh approved operation ID.
9. Monitor mismatches, lease conflicts, CAS conflicts, ambiguous results, latency, rate limits, and manual-review volume.

Production startup must fail closed if mappings, policy evidence, reader, writer, revision refresh, worker, ledger, Redis, or PlayFab configuration is missing.

## 10. Online player and stale-save protection

Runtime financial values are a cache tagged with Economy ETag plus authority `financialRevision` and object version. If a payment changes revision 20 to 21 while a game server holds 20:

- the payment writes only Economy v2/authority V2;
- a gameplay save writes only gameplay-owned data and cannot write either V2 store;
- the next financial action or bounded refresh observes 21;
- the game server replaces its cache and notifies UI;
- the old `profile_v1` mirror is ignored and cannot be promoted again.

Equipped selections remain gameplay data but must be validated against freshly loaded ownership. A stale selection save may update the selection only; it cannot remove ownership or quantities.

## 11. Rollback

Rollback to Legacy is allowed only before the first V2-only mutation. During Legacy and ShadowRead, disable the new mode and continue using untouched legacy stores.

The point of no return is the first accepted gameplay or payment mutation whose only durable result exists in Economy v2 or `SeabyssFinancialAuthorityV2`. After that point, switching Legacy back on would create dual authority and is forbidden. Recovery is forward-only: pause mutations, repair/reconcile V2, then resume Cutover.

Never copy V2 balances back into `GD`, `DM`, or `profile_v1` as an emergency rollback.

## 12. Required tests before approval

Local and Sandbox evidence must cover:

- currency load, grant, spend, insufficient funds, replay, ambiguous retry, stale ETag, and refresh;
- inventory grant/consume, atomic market spend+grant, concurrent mutation, and reload;
- Premium stacking, tier effects, paid marker/design duplicate no-op, and Starter ownership;
- Quest, NPC, boss online/offline, monster, Pirate Exam, floating chest, Market, Tavern, Guild, admin/redeem, combat ammo, consumables, and harpoons;
- gameplay save racing a payment grant;
- at least ten concurrent workers and two simultaneous transactions for one player;
- game-server, backend, and Redis restarts;
- client attempts to write balances, inventory, Premium, unlocks, and authority objects;
- payment xss2/xsd2 worker regression tests;
- a real Sandbox PlayFab test account and real Redis processes.

Rate-limit and performance tests must prove that combat does not issue a provider request per shot. High-frequency ammo, harpoon, and consumable use requires a server-owned reservation/delta journal with bounded flushes and crash reconciliation, or another tested server-authoritative strategy. It must not fall back to a writable `profile_v1` cache.

PlayFab's current public pages expose different throttling figures for `ExecuteInventoryOperations`
(20 per 60 seconds in the general limits table and 60 per 90 seconds on the versioned endpoint
page). Capacity planning must use the stricter 20-per-minute player budget until Sandbox evidence
and PlayFab support confirm otherwise. Either published limit is far below combat fire rate.

## 13. Monitoring and stop conditions

Stop the rollout immediately on any:

- negative balance or lost quantity;
- duplicate operation;
- stale fencing write accepted;
- unresolved provider outcome;
- financial revision regression;
- legacy/V2 mismatch;
- client-authorized financial write;
- Redis/ledger/worker readiness failure;
- provider throttling beyond the approved retry budget.

Paused transactions remain Pending or move to ManualReview; they never become Completed without durable reward evidence.

## 14. External actions still requiring explicit authorization

- create/publish the Sandbox and production Economy v2 catalog items;
- install and certify PlayFab policy;
- provision and restart-test persistent Redis;
- run live Sandbox migration and malicious-client tests on dedicated accounts;
- configure production credentials and host hardening;
- deploy the reviewed release and run a production smoke test;
- configure final Xsolla per-user limits and production hostname.
