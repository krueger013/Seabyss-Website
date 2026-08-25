# Progressive Financial Domain Migration

Status: preparation only. The active mode for Diamonds, Elite Cannonballs and
Premium is `Legacy`. This document does not authorize a migration or a cutover.

## Invariants

- Migration order is Diamonds, observation, Elite, observation, Premium,
  observation. Never enable several domains in the first canary.
- Legacy remains authoritative until the selected domain enters an explicitly
  allowlisted Canary.
- Shadow writes observations and comparisons; it never decides gameplay or
  repairs Legacy.
- A migration replaces the exact target value. It never adds Legacy to Target.
- Provider writes require a pre-approved plan hash, CAS revision, player lease,
  fencing epoch and an idempotent operation ID.
- A stale profile save cannot write financial Target fields. Gameplay profile
  persistence and financial persistence stay separate.
- Production title `142853` is not a migration or certification target.
- The only certified progressive Target contract is
  `SeabyssEconomyStateV1`. `SeabyssFinancialAuthorityV2` is deprecated and may
  be read only by migration/backward-compatibility tooling.

## Per-domain state machine

| State | Reader | Writer | Comparison | Allowed users |
|---|---|---|---|---|
| Legacy | Legacy adapter | Legacy adapter | none | all |
| Shadow | Legacy adapter | Legacy adapter | Legacy versus Target | explicit Shadow policy |
| Canary | Target for allowlist, Legacy otherwise | Target for allowlist, Legacy otherwise | mandatory | explicit IDs only |
| Cutover | Target | Target | monitoring only | all, after certification |

The configuration is independent for each domain:

```text
FINANCIAL_DIAMONDS_MODE=Legacy
FINANCIAL_DIAMONDS_CANARY_ENABLED=false
FINANCIAL_DIAMONDS_CUTOVER_ENABLED=false
FINANCIAL_DIAMONDS_MIGRATION_ENABLED=false
FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS=
```

Equivalent `ELITE` and `PREMIUM` variables exist. A wildcard canary is rejected.
In Legacy, any enabled canary/cutover/migration gate or non-empty allowlist is a
startup error. Environment switches alone cannot activate a domain: the runtime
composition must also inject a verified domain health certificate.
That certificate is bound to the domain, certified Target contract, scanner
baseline SHA-256, recomputed health evidence, issue/expiry times and Canary
certification. Raw `readyForCanary=true` booleans are rejected. Startup also
enforces Diamonds → Elite → Premium and allows at most one Canary domain.

## Domain architecture

### Diamonds

- Legacy reader/writer: the existing `DM` virtual currency adapter.
- Shadow: Legacy applies; the certified Shadow observer compares the operation.
- Target: the durable authoritative financial snapshot through the server-only
  PlayFab adapter.
- Migration source: exact `DM` balance.
- Conflict policy: DM wins only for a player without migration proof and with an
  empty/already-equal Target. A valid completed Target proof wins. A divergent
  non-empty Target is `ManualReview`; values are never summed.
- Revision: the Target snapshot revision and PlayFab ProfileVersion/ETag are
  checked by CAS. The common `playfab-profile` lease/fencing protects concurrent
  payments and gameplay.

Every gameplay and UI caller ultimately needs to use the Unity-side centralized
Diamonds abstraction. Direct `DM` access remains permitted only inside the
Legacy adapter and migration reader while the mode is Legacy.

### Elite Cannonballs

- Legacy reader/writer: current profile/ammo inventory adapter.
- Shadow: ordered observations, including distinct Market `+5` then `-5`.
- Target: authoritative financial snapshot.
- High-frequency path: hot server state, WAL and batching. No PlayFab request per
  shot.
- Migration source: exact non-negative Legacy quantity. The target is replaced,
  never incremented. Divergent non-empty Target requires `ManualReview`.
- Revision: same global snapshot CAS revision. The ordered operation/WAL sequence
  supplies the domain ordering; introducing a second independently writable
  object would create cross-domain proof conflicts and is intentionally avoided.

### Premium

- Legacy reader: `profile_v1.shopEntitlements`.
- Target: server-owned Financial Authority Premium state.
- Canonical value: tier 0..3, canonical UTC `effectiveAt` and expiration.
- Semantics: highest active tier, cumulative time, event `effectiveAt`, replay
  idempotence. No clock based on delayed observation processing time.
- Conflict policy: a valid newer Target financial proof wins and can never be
  shortened by Legacy. Any non-empty divergent Target without valid proof is
  `ManualReview`.
- Gameplay benefits must read the central Premium service. Repair, respawn,
  quest slots, Market discount and floating chest multipliers keep their current
  values; only the reader is routed.

## Migration dry-run and executor

`planProgressiveFinancialDomainMigration` is read-only and produces:

- Legacy and observed Target values;
- exact proposed Target value;
- source/target revision inputs;
- stable SHA-256 `planHash` and operation ID;
- conflicts and authority winner;
- rollback availability and point of no return.

Rules:

1. Unmigrated + empty Target: propose exact Legacy value.
2. Unmigrated + equal Target: produce the same idempotent plan and persist the
   missing migration proof; equality alone does not mark a player migrated.
3. Unmigrated + divergent non-empty Target: `ManualReview`.
4. Valid completed proof matching Target: `already_migrated`, Target wins.
5. Both stores claim post-cutover and diverge: `ManualReview`.
6. Never add Legacy and Target.

The executor defaults to `enabled=false` and `providerWritesEnabled=false`. When
future authorization enables it, it requires the approved plan hash and passes
the exact replacement, expected revision, stable operation ID and fencing epoch
to `replaceIdempotent`. An exact provider readback must confirm value and
revision before its durable marker is put with CAS. Retrying a marker requires a
second matching readback before returning `already_migrated`.

## Rollback

| Domain | Safe automatic rollback window | Point of no return |
|---|---|---|
| Diamonds | After exact migration, before the first Target-only balance mutation | First Target-only grant/spend |
| Elite | After exact migration, before the first Target-only grant/consume/WAL sequence | First Target-only ordered ammo operation |
| Premium | After exact migration, before the first Target-only duration/tier mutation | First Target-only Premium mutation |

Safe rollback order: disable the domain gate, drain pending operations, verify
the Target proof has `targetOnlyOperationCount=0`, compare exact values, then
restore Legacy routing. Once the point of no return is passed, automated rollback
is forbidden. Reconciliation or a forward repair plan requires ManualReview.

## Domain health and preconditions

Each domain exposes:

- `readyForCanary` and `readyForCutover`;
- intentional/migration-only/forbidden Legacy access counts;
- Shadow mismatch count;
- migration conflicts;
- pending operations;
- rollback availability.

`readyForCanary` requires all of:

- scanner certification and zero forbidden direct writer;
- certified dry-run and zero conflict;
- zero unexplained Shadow mismatch;
- zero pending financial operation;
- healthy Target, Redis and PlayFab;
- valid rollback plan.

`readyForCutover` additionally requires successful Canary operation and a
separately verified cutover certificate. The current server intentionally loads
no such certificate, so any non-Legacy environment mode fails startup.

## Legacy access classification

Scanner results are no longer a raw occurrence count. Each reader/writer is one
of:

- `intentional_legacy_adapter`: allowed only inside the centralized adapter;
- `migration_only`: read-only migration/backward-compatibility source;
- `forbidden_direct_access`: must be removed before Canary.

The checked-in structured baseline is validated by
`progressive-financial-domain-access-validator.js`. A future activation
certificate must contain its SHA-256 and the certified per-domain health input;
the current server loads no activation certificate. Intentional adapter accesses
may remain during Canary for non-allowlisted players; forbidden direct writers
must be zero for the selected domain.

Current classified baseline:

| Domain | Active reader/writer baseline | Forbidden direct paths | Ready for Canary |
|---|---:|---:|---|
| Diamonds | 32 mutation expressions, 33 facade reads, 20 profile mirror accesses | 5 | no |
| Elite | 13 external readers, 9 external routes, 8 internal raw writes | 4 | no |
| Premium | 8 reader paths, 3 writer layers, 2 compatibility paths | 4 | no |

The new Unity routing services and selective instance stale-save fence are
compiled and tested, but the production factories and the remaining classified
call sites intentionally stay Legacy in this preparation build. Consequently no
domain is certified for a real Canary yet.

## Metrics

Bounded per-domain metrics are:

- `domain_mode`;
- `migration_dry_run`;
- `migration_conflict`;
- `canary_operation`;
- `legacy_direct_access`;
- `shadow_observation_failure` (Unity outbox/WAL replay required; never fails
  Legacy gameplay);
- `rollback_available`.

Player IDs, transaction IDs and operation IDs are deliberately not metric labels.

## Current safe state

```text
Diamonds = Legacy
Elite = Legacy
Premium = Legacy
FINANCIAL_SHADOW_MODE_ENABLED=false
PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=false
all per-domain Canary/Cutover/Migration gates=false
all purchase and checkout gates=false
```
