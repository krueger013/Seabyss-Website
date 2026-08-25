# Payment ledger operations and release contract

This document describes the local payment-ledger implementation. It does not authorize a
Production deployment, a service restart, a checkout, or a live provider mutation. Purchase
gates must remain off until the complete release checklist is approved.

## Runtime composition currently wired

`server.js` now composes the connected Redis client, Redis payment-ledger store, ledger service,
hardened Starter/Diamond processor, immutable xss2/xsd2 receipt stores, reversal processor and
scanners. Paid Starter/Diamond receipts that pass every gate and economic validation are inserted
in the ledger before PlayFab receipt persistence.

```js
const store = createRedisPaymentLedgerStore(connectedRedisClient);
const ledger = createPaymentLedger({ store });
const persistCatalogReceipt = createXsollaLedgeredReceiptProcessor({
    ledger,
    persistStarterPackReceiptV2,
    persistDiamondPackReceiptV2
});
```

`createMemoryPaymentLedgerStore()` exists only for deterministic local tests and single-process
development. It is not a Production durability mechanism.

The wired receipt processor creates a short-lived worker for the single checkpoint
`receipt_persisted`. It does not apply currencies, items, Premium, ownership, or profile rewards.
After that durable checkpoint it explicitly transitions `Processing` back to `Pending` and returns
`checkpoints_pending`; it no longer reports a false `Completed`. No server scheduler invokes
`worker.processPending()`. Production activation remains prohibited until the profile-grant
checkpoint and offline scheduler below are wired.

The durable identity is the unique pair `provider + providerTransactionId`. A transaction stores
the order, receipt, player, SKU, immutable plan version/hash, integer minor amount, currency,
environment, state, checkpoints, retry count, last error, lease ownership/expiry/fencing epoch,
reversal summary, timestamps, audit trail, and CAS version. Indexed, paginated lookups exist for
transaction ID, order ID, receipt ID, PlayFab ID, and SKU. Redis index keys hash their values so a
player ID, order, receipt, or SKU is not exposed in the key namespace.

Every Redis financial mutation is one Lua operation:

- insert transaction plus all indexes;
- acquire, renew, or release a token-checked transaction lease;
- immutable checkpoint/state CAS mutation;
- insert a unique reversal plus indexes and original-transaction link;
- transition a reversal plus its status index;
- acquire, renew, or release a player-profile resource lease with a persistent fencing epoch.

Redis must use persistence and authenticated local/private networking. Use AOF with an approved
fsync policy plus tested RDB backups. Do not configure eviction for this namespace. Monitor memory,
persistence errors, replication lag, and rejected writes. Idempotency evidence must never be
silently evicted or deleted; archive it to approved durable storage before any retention action.

## Worker exactly-once boundary

`worker.processTransaction({ provider, providerTransactionId })` is independent of player login.
`worker.processPending({ maximumTransactions })` scans and processes offline transactions.
These are implemented and deterministically tested primitives, not a persistent worker currently
wired in the server. `server.js` does not schedule `processPending()` and does not provide a concrete
PlayFab profile store.

The worker first acquires the transaction lease, then a `playfab-profile` resource lease. Distinct
transactions for the same player therefore cannot mutate that profile concurrently. Each
checkpoint receives:

- a deterministic `operationId` stable across restarts;
- the transaction lease fencing epoch;
- the player lease fencing epoch;
- the immutable ledger transaction.

The downstream PlayFab adapter must enforce the operation ID idempotently and reject stale fencing
epochs. When PlayFab exposes a usable data version, use `createCasProfileStep()` with a store that
implements `read(playFabId)` and `compareAndSet(...)`. A timeout after an accepted write must return
`already_applied` when retried with the same operation ID. Without downstream idempotency/fencing,
no cross-system design can claim exactly once across the crash window between PlayFab success and
ledger checkpoint persistence.

`PaymentWorkerCrash` is a test-only crash signal: it deliberately leaves leases and Processing
state intact so expiry/takeover recovery can be verified. Ordinary failures persist `Failed`, keep
completed checkpoints, release owned leases, and resume only missing checkpoints.

The remaining Production composition is explicitly:

```js
const profileGrantStep = createCasProfileStep({
    name: "profile_granted",
    profileStore: realPlayFabCasStore,
    mutate: applyImmutableReceiptSnapshot
});
const offlineWorker = createPaymentWorker({ ledger, workerId: instanceId,
    steps: [immutableReceiptStep, profileGrantStep] });
scheduleBoundedPendingScans(offlineWorker);
```

This is a contract, not code currently wired in `server.js`. The scheduler needs controlled
shutdown, bounded backoff, lease-aware retries and observable health. The PlayFab adapter must prove
timeout-after-write idempotence and stale fencing rejection before `Completed` can mean grant final.

## Reversals and disputes

`createPaymentReversalService({ ledger })` accepts `refund`, `order_canceled`, and `chargeback`.
The unique reversal identity is `provider + reversalEventId`. Currency must match the original and
cumulative reversal minor units cannot exceed the original amount.

Default policy is `flag_account_financial_review` (urgent for chargeback) plus
`manual_review_no_automatic_clawback`. Automatic debit of already-spent consumables is rejected.
Allowed policies require review before revoking a non-consumable or suspending a future
entitlement. Support resolves a case with `ledger.transitionReversal(...)`; unresolved reversals
remain visible to scanners.

## Reconciliation and secured administration

`createPaymentReconciliationService({ ledger, worker, auditSink })` exposes:

- `lookup(...)`: indexed/paginated lookup with operator, reason, query, and result count audited;
- `safeRetry(...)`: refuses Completed, Quarantined, DuplicatePaid, RefundRequired, ManualReview,
  and active-lease Processing records; it resumes only Pending, Failed, or an expired Processing
  lease and logs request/result/failure.

`createPaymentAdminCommand({ reconciliation })` is the command parser for an authenticated admin
shell. The authenticated wrapper supplies `operator` and `reason`; command arguments cannot
override operator identity. Examples:

```text
payments lookup --provider xsolla --transaction 706956443
payments lookup --order 706956443 --cursor 0 --limit 50
payments lookup --receipt <receipt-id>
payments lookup --user <PlayFabId>
payments lookup --sku seabyss_starter_pack_1
payments retry --provider xsolla --transaction 706956443
```

The module intentionally does not open a public HTTP endpoint. Production integration must put it
behind the existing strict admin authentication, authorization, rate limit, and a durable append-only
audit sink. The provided memory audit sink is for local tests only.
It is not imported or mounted by `server.js` today; the examples above are therefore not yet an
available operator surface.

## Scanners, metrics, and probes

`createPaymentScanners({ ledger })` reports, with a bounded paginated scan:

- Pending older than the configured threshold;
- Quarantined transactions;
- expired transaction leases;
- receipt-linked transactions not Completed;
- reversals not resolved.

`createPaymentMetrics()` accepts a fixed, low-cardinality metric vocabulary. It includes webhook,
checkout, pending/completed/quarantined/failed, retry, reversal, Redis, PlayFab, ledger,
duplicate-paid, reconciliation, stalled-worker, and scanner events. Transaction, order, receipt,
and player IDs are prohibited as metric labels. A bounded recent-event window supports alert
evaluation.

`createPaymentHealthProbes(...)` separates:

- liveness: process is alive; it must not depend on Redis or PlayFab;
- readiness: ledger, Redis, non-mutating PlayFab probe, and worker health all pass within timeout.

Current server integration is intentionally more limited:

- `/health/live` is a process-only liveness route;
- `/health/ready` checks ledger and Redis, uses PlayFab configuration presence, reports
  `production_profile_cas_adapter_not_configured` when purchases are enabled, and consumes the
  cached scanner report;
- scanners run once at startup then every 60 seconds on an `unref` interval; readiness is red on
  scanner error or truncation;
- `/health` publishes `activationReady: false`;
- `createPaymentHealthProbes()` and `evaluatePaymentAlerts()` are not wired into `server.js`;
- in-memory metric counters are not exported to a collector.

The HTTP health routes and scanner scheduler are wired. Worker/PlayFab readiness, metric export and
alert delivery remain activation blockers.

Recommended initial alerts, tuned after Sandbox load testing:

| Signal | Initial threshold | Severity |
|---|---:|---|
| Invalid webhook signatures | 10 in 5 minutes | Critical |
| Redis/ledger/PlayFab failure | 1 | Critical |
| Quarantined | greater than 0 | Critical |
| Duplicate-paid Starter | greater than 0 | Critical |
| Reconciliation mismatch | greater than 0 | Critical |
| Pending older than 15 minutes | greater than 0 | Warning |
| Expired lease / unresolved reversal | greater than 0 | Warning |
| Worker active longer than 120 seconds | 1 | Critical |
| TLS certificate expiry | 30 days warning, 14 days critical | Warning/Critical |

## Immutable host layout

Prepare a new release offline and do not alter the current live directory in place:

```text
/opt/seabyss/releases/<release-id>/server-web-api   root:root, directories 755, files 644
/opt/seabyss/current                                root-owned atomic symlink
/etc/seabyss/server-web-api.env                     root:seabyss 640
/var/lib/seabyss/payments                           seabyss:seabyss, mutable state only
/var/log/seabyss                                    seabyss:seabyss or journald
```

Validation commands for the approved maintenance window (review paths before execution):

```sh
find /opt/seabyss/releases/<release-id> -type d -exec chmod 755 {} +
find /opt/seabyss/releases/<release-id> -type f -exec chmod 644 {} +
chown -R root:root /opt/seabyss/releases/<release-id>
chown root:seabyss /etc/seabyss/server-web-api.env
chmod 640 /etc/seabyss/server-web-api.env
sudo -u seabyss test ! -w /opt/seabyss/releases/<release-id>/server-web-api/src
```

The systemd service should use the unprivileged `seabyss` account and at least
`NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, and an
explicit `ReadWritePaths` limited to approved mutable directories. The runtime must not write its
source, lockfile, release manifest, or environment file.

## Reproducible release and rollback

For a future approved savepoint:

1. Start from a reviewed commit and clean dedicated release worktree; do not use the current dirty
   development tree as an artifact.
2. Record commit ID, Node version, OS target, and SHA-256 of `package-lock.json` in a build manifest.
3. Install exactly the lockfile with `npm ci` in the isolated build environment; run the complete
   Node test suite and security checks without Production credentials.
4. Package tracked runtime files only. Exclude `.env`, logs, sessions, caches, coverage, and mutable
   financial data.
5. Generate SHA-256 checksums for the archive and each manifest-listed runtime file; verify them on
   the host before extracting into a new root-owned release directory.
6. Run syntax/tests and non-mutating dependency probes from the candidate directory. Keep all
   purchase gates false.
7. In an explicitly approved window, atomically switch `/opt/seabyss/current`, restart only the
   intended unit, then verify liveness, readiness, login/session, signed Sandbox fixtures, scanners,
   and that checkout remains denied.
8. Roll back by restoring the prior root-owned symlink and restarting the same unit. Never roll back
   or delete ledger/idempotency data.

No commit, tag, deployment, restart, permission change, live Redis mutation, or Production probe was
performed while creating this implementation.

## Host and Redis maintenance runbook

Kernel, libc, Redis, and reboot work requires a separately approved window:

1. Confirm recent encrypted backups for Redis persistence and application configuration; restore
   them to an isolated host and verify keys, indexes, TTL leases, and sample immutable evidence.
2. Capture current package versions, Redis persistence status, replication/backup health, disk
   capacity, scanner report, and readiness.
3. Stop new checkout creation through already-default-off gates. Let active workers finish or leases
   expire; confirm no unexplained Processing records.
4. Update one layer at a time according to the supported OS/Redis release path. Do not combine a
   schema migration with the first infrastructure update.
5. Reboot only when approved. Verify time synchronization, filesystem ownership/modes, Redis AOF/RDB
   load, memory policy, service sandbox, liveness, readiness, worker progress, and all scanners.
6. Keep purchases off. Run mocks/Sandbox fixtures only; Production checkout/payment smoke remains a
   separate explicit authorization.

## Remaining integration gates

Before this subsystem can be considered deployed:

- create and connect the Production Redis client with persistence/no-eviction policy;
- keep the wired webhook-to-ledger receipt path and add a persistent offline worker scheduler that
  resumes bounded `Pending`/`Failed` work;
- implement the real PlayFab CAS/idempotency/fencing adapter, add the profile-grant checkpoint and
  validate timeout-after-write plus stale-worker takeover;
- mount the admin command only in an authenticated/rate-limited operator surface with durable audit;
- keep the exposed liveness/readiness routes, but replace the PlayFab configuration check with a
  bounded non-mutating probe and include health from the real worker;
- export metrics to the selected collector, wire alert evaluation and route it to on-call/support;
- execute backup restore, multi-instance Sandbox load, release, rollback, and host maintenance drills.

Already integrated locally and no longer TODO: Redis-backed ledger construction in `server.js`,
hardened Starter/Diamond receipt creation through that ledger, reversal routing, `/health/live` and
`/health/ready`, plus the cached scanner started once then refreshed every 60 seconds. These pieces
remain undeployed and every purchase/checkout/grant gate stays OFF.
