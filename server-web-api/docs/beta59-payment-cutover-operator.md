# Beta59 payment cutover controller

Local tooling qualification, 2026-09-25. No production command was run. This extends approved backend `700b261`; it neither deploys nor grants money. New checkout remains closed after activation.

## Private configuration and provisioning

Keep the previously qualified production/142853 provider-OFF configuration, existing callback verification secrets, original Premium plan IDs and catalogue plans. Keep global / Diamond / Starter callback gates enabled; `XSOLLA_CHECKOUT_CLOSED=true` closes new tokens only. `PAYMENT_WORKER_ENABLED=false`, `PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=false`, financial shadow and financial refresh disabled. Production V1 fallback remains forbidden. The V2 service still requires the exact durable authority configuration SHA and proof-or-quarantine policy.

Add all five variables (none is optional once any is present):

| Variable, prefix `SEABYSS_MONETARY_V2_PAYMENT_CUTOVER_` | Value |
| --- | --- |
| `STATE_FILE` | Absolute private append-only control journal path |
| `PLAN_SHA256` | SHA256 of the immutable pre-drain maintenance plan; final migration plan is bound later |
| `INVENTORY_DIRECTORY` | Absolute private directory for immutable Redis inventories |
| `CONTROL_ORIGIN` | Separate literal `http://127.0.0.1:49152–65535/` endpoint |
| `CONTROL_TOKEN_FILE` | Private file containing a separate 64–256 printable-byte token |

The control token must differ from the PG-service token; the listener must differ from its origin. Never expose this listener via nginx/public ingress. The callback HTTP route and signature verification are unchanged. Protect token readers with a dedicated service group. Run the custody backend as a **new dedicated UID/unit**, distinct from every OS-fenced V1 backend/game writer. Keep old writer units persistently masked and their UID fenced throughout and after migration; starting V2 must not unmask/re-enable them.

Provisioning is explicit and does not start a process or contact any provider:

```
node src/monetary-v2-payment-cutover-cli.js provision /absolute/private/provision.json
```

The provisioning `planSha256` is this maintenance identity, not a guessed future cohort hash. Strict JSON fields: `schema:1`, `configurationSha256`, `planSha256`, `custodyFile`, `fenceFile`, `inventoryDirectory`, `stateFile`. Hashes are 64 lowercase hex. Custody, fence and state files must be distinct. Parent directories already exist; the tool can create its inventory directory. Existing files are validated, never truncated/reinitialized. Files are fsynced; Linux parent directories are also fsynced. Provision as the intended service UID (or arrange explicit, audited ownership before startup). Mutable files need that UID's write permission. On Linux, source paths reject symlinks, other owners except root, writable shared parents and files with group-write/other-access or multiple hard links. Root-owned sticky `/tmp` is allowed only as an ancestor of the private test directory; production uses `/var/lib/seabyss/payments/...`.

Preserve custody, fence, control journal and every immutable inventory across release switches, backups and restarts. Never put them inside a replaceable release directory. Capacity is fail-closed: state 1,024 generations / 2 MiB, inventory 20,000 keys / 32 MiB per snapshot and 64 snapshots / 128 MiB total; the existing custody inbox remains bounded. Do not delete histories to clear capacity. Late tokens are finite liabilities; a full or invalid inbox refuses acknowledgment so the provider can retry, never discards a verified acknowledged payment.

## Operator HTTP contract

Header: `X-Seabyss-Cutover-Token`. Responses contain counts and hashes, not receipt identities or secrets. Errors are sanitized. All mutations use an exact `expectedGeneration` CAS and reject extra request fields.

| Endpoint | JSON request |
| --- | --- |
| `GET /v1/payment-cutover/status` | None |
| `POST /v1/payment-cutover/bind` | `{ "expectedGeneration": N, "maintenancePlanSha256": "...", "planSha256": "...", "rootFenceReceiptSha256": "..." }` |
| `POST /v1/payment-cutover/hold` | `{ "expectedGeneration": N }` |
| `POST /v1/payment-cutover/prepare` | `{ "expectedGeneration": N, "planSha256": "...", "rootFenceReceiptSha256": "..." }` |
| `POST /v1/payment-cutover/activate` | `{ "expectedGeneration": N, "planSha256": "..." }` |

Initial state is `HOLDING`, generation 0, with `planSha256:null` and `migrationPlanBound:false`. The immutable header retains the maintenance plan identity. After the old writers and sources are independently held, capture the fresh cohort and compute the final operator plan. `bind` appends that final plan and OS-fact hash once, using CAS/fsync while HOLDING and drained. It changes no custody, fence, inventory or header. Identical rebinding is idempotent; any other plan/hash is refused, including after restart or a later hold. `/prepare` requires this final binding and the identical root-fact hash. This avoids prebinding a financial migration to a cohort captured before shutdown. `hold` persists HOLDING **before** awaiting already-started monetary calls; callbacks continue their original verification and durable fsynced custody. The recovery loop makes no PG authority/submission request in HOLDING or READY. A 30-second drain timeout leaves HOLDING in place and ownership retained; it never claims the outstanding call was cancelled or drained. A late response may finish and be recorded. Requery status; do not proceed while `inFlight != 0`. Nonpayment financial review callbacks are not acknowledged or dispatched while held, preserving provider retry rather than falsely reporting a durable review.

`status` includes `phase`, `generation`, `stateSha256`, `configurationSha256`, `maintenancePlanSha256`, `planSha256`, `migrationPlanBound`, `bindRootFenceReceiptSha256`, `checkoutClosed`, `custodyOwned`, `custodyHealthy`, `inFlight`, `legacyWorkerRunning`, `inventorySha256`, `inventoryContentSha256`, `legacyInventoryCurrent`, `rootFenceReceiptSha256`, `readyForMigration`, and aggregate custody counts. An invalid/unreadable journal or lost inventory fails closed. `custodyHealthy` means the owned inbox passed its strict full read, not that its monetary obligations are resolved. Public payment `activationReady` is false in HOLDING/READY.

### Required order with ROOT's independent OS barrier

1. Preserve/back up the complete existing Redis payment namespace and other required legacy source evidence before changing units. No accepted receipt/index is cleared. Keep the existing authenticated persistent Redis deployment; a fixture is not its replacement.
2. Start the **new** custody backend with the exact configuration and initial HOLDING state. Its startup and custody readiness work with PG unavailable. Confirm HOLDING, matching maintenance/config, `custodyOwned=true`, `custodyHealthy=true`, `inFlight=0`, `legacyWorkerRunning=false` and checkout closed.
3. ROOT independently stops/drains and persistently masks all old V1 game/backend writers, verifies empty cgroups, applies the old UID's egress fence and freezes the captured source files. The new custody UID remains separate and reachable for callbacks. ROOT computes its canonical OS-fact hash.
4. With those sources already frozen, recapture and validate the actual fresh cohort, then produce the final immutable operator migration plan. ROOT posts `bind` with current generation, maintenance SHA, final plan SHA and OS-fact SHA. Confirm the returned final binding and zero dispatch. ROOT then posts `prepare` with its new generation, final plan SHA and the identical OS-fact SHA. The controller drains, requires ownership/no legacy worker/no in-flight call, captures the raw Redis inventory twice with exact equality, fsyncs an immutable snapshot, then appends READY. Any mismatch leaves it held. Requery and require `phase=READY_FOR_MIGRATION`, `readyForMigration=true`, `legacyInventoryCurrent=true`, exact plan/config/root hash and all previous ownership/drain checks.
5. ROOT **independently revalidates** OS facts and this live HTTP state for each fresh signed migration barrier receipt. `rootFenceReceiptSha256` is only a linkage: the backend does not validate/sign an OS fence and never manufactures `LegacyWriterFenced=true`. A caller-supplied hash alone does not authorize migration. The signed receipt remains the existing Core contract, bound to the account, migration, source, epoch, plan/capture and freshness. The operator should retain the latest accepted generation/state hash in its immutable evidence and reject rollback to an older control-file prefix; the local checksum chain alone cannot authenticate restoration of an entire old valid file.
6. Complete the already-qualified migration and **global authority activation** using ROOT/A's operator. Only then post `activate`. The backend checks READY, exact current raw inventory, plan, drainage, and the current PG production health/config SHA/provider OFF/proof-or-quarantine policy before appending V2_ACTIVE. This endpoint is not itself the global activation operation.
7. V2 recovery now routes retained receipts through the durable service. First unproven production identities are manual review, never a grant inferred from absent history. Existing proven durable receipts replay consistently. Checkout stays closed until a separately qualified durable new-checkout admission exists. All old OS writer fences remain held.

Stop the private control listener before stopping custody recovery. Shutdown retains custody ownership until in-flight writes settle. V2 transport is bounded; this does not claim that arbitrary historical V1 adapter promises or the whole OS shutdown are always bounded.

## Exact Redis preservation scope

Only read commands are used: SCAN, TYPE, GET and ZRANGE WITHSCORES. The whole `seabyss:payments:ledger:v1:*` namespace is preserved as original strings and ordered zset entries, including wrappers, checkpoints, audit records, indexes, leases and epochs. Transaction/reversal all-index membership must exactly match the records; missing/disappearing/duplicate/unsupported/corrupt entries refuse readiness. Two identical bounded scans are necessary but do not replace the independently held OS writers. A change after capture invalidates readiness/activation.

Every source-declared non-Completed transaction receives an `OPEN_MANUAL_RECONCILIATION` obligation with its exact raw SHA, original state, `replayAllowed:false` and `paymentWaiver:false`. **Completed is a source declaration, not a new financial proof.** The snapshot explicitly records `verification:exact-raw-preservation-only` and `completionAuthority:false`; it never imports a receipt as fulfilled, grants, retries, waives or computes a balance. The old `immutableHash` is retained verbatim and checked structurally, not reconstructed by guessing whether its optional creation timestamp originally participated. Resolving payment execution still requires the authoritative original proof; absent or ambiguous proof stays quarantined. A full Redis backup with its persistence/TTL metadata is still required separately for disaster recovery; this forensic inventory is not an automatic Redis replacement/restore format.

A genuine pre-custody V1 write was removed from the production V2 Starter path: the old reservation/reconciliation coordinator could mutate Redis or PlayFab before custody. Production V2 now captures the already validated original Starter receipt without calling that coordinator, then applies the existing service proof-or-quarantine policy. Legacy and sandbox behavior remain unchanged. This does not declare a reservation valid, authorize an entitlement, or open checkout. Existing Premium catalogue and old-subscription custody remain intact.

## Targeted local evidence

Windows Node 24.19.0. Dependencies unchanged; project requires Node >=20. Tests explicitly preload `test/fixtures/local-network-only.mjs`, set `DOTENV_CONFIG_PATH=test/fixtures/empty-test-env.txt`, and never invoke npm/pretest (which has a live validation hook).

- `backend-cutover-tooling-01.tap`: **126 PASS / 0 FAIL / 0 SKIP**, SHA256 `acb3463071429fa9d2f82eb8f17f6ac8921e62981b65f5e2d9aa99b80fef59b6`. Five affected files: new control, previous custody/cutover, production payment, V2 payments, hardened catalogue tests.
- After permission/health review, reran only invalidated control and production groups: `backend-cutover-tooling-review-02.tap`: **56 PASS / 0 FAIL / 0 SKIP**, SHA256 `825f32bbd820ffffe1150f792282ef03aba24015bdf78ed7f33fb9614e1ff459`. These overlap the first campaign; that stage covers **127 distinct tests**, not 182.
- After adding the post-freeze final-plan bind, reran only its two affected groups: `backend-cutover-final-bind-03.tap`: **57 PASS / 0 FAIL / 0 SKIP**, SHA256 `399d0e94bc4490dee009586315697db1dcf2a5f11c3b454c321c671755378c03`. Total distinct coverage is now **128 tests**; the 57 are overlapping, not another independent 57 cases. The new case binds a different final plan, preserves a pending payment byte-for-byte, rejects old-plan prepare/rebinding, reloads the same binding and proves zero authority/submission calls while held.
- Real child-process exit before/after fsync leaves the original/new generation respectively; kernel custody ownership can be reacquired after process death. Malformed tails/modified rows/wrong binding reject restart. Invalid transitions are rejected before journal append. Concurrent prepares have one CAS winner.
- Actual `server.js` starts HOLDING and restarts READY using production/142853 configuration shape while PG is unavailable: zero service requests; exact private control interface works; checkout/financial activation remain closed.
- Hold during authority wait forbids a later submit; hold after a submit drains and records its late result; a second callback remains held. Existing callback duplicate/crash/late-token/old Premium tests remain green. Invalid Starter price remains rejected; its V1 coordinator is forbidden in the new test.
- These Windows groups use deterministic Redis/RESP fixtures; they do not prove real Redis persistence or Linux fencing. Separate native evidence follows.

## Isolated native Linux qualification

The user explicitly authorized transfer and isolated tests on the owned infrastructure. All work ran inside unprivileged LXC `seabyss-v2-prep`, with only loopback and no external route. Host production services, provider credentials and live payment data were not used. Node 24.21.0 and the network-denying test preload were used; Redis was the container's own process, with synthetic records in DB 15.

- `backend-linux-01.tap`: **116 PASS, 2 file-level failures**, SHA256 `46380ba11803ce50912e24d33ccc3cb333322daebe61085380e6f7c3d8ed9999`. The test port allocator recursively requested an ephemeral port until one exceeded 49151. Linux repeatedly returned a lower port; one fixture exhausted memory and its identified blocked sibling was stopped. Raw failure evidence is preserved. Runtime port restrictions were not relaxed.
- The fixture now binds explicit random ports in the permitted interval with at most 128 collision retries. Only the two affected groups were rerun: `backend-linux-02.tap`, **57 PASS / 0 FAIL / 0 SKIP**, SHA256 `c5f1cf287428d5034155edc25e4b472c90c5eca9362b47392cec9d351e7b070e`. The other 71 distinct cases already passed: 128 distinct Linux cases at this stage, not the sum of overlapping runs.
- Real Redis exposed a fail-closed inventory key mismatch: the established ledger adapter uses SHA256 **base64url**, while the new inventory validator initially expected hex. The validator now follows the actual adapter, with a new direct adapter contract test. Only the affected control group was rerun: `backend-linux-redis-fix-03.tap`, **27 PASS / 0 FAIL / 0 SKIP**, SHA256 `58adf4a8d6bf6cfa2285c4cef00454dfda5a6f0afad203a4b7b1359be379c0f9`. Final distinct Linux coverage: **129 tests**. No receipt was removed or replaced to pass.
- Actual Redis: `backend-linux-real-redis-proof.json`, SHA256 `29cdc95f6612839895a4cd1037f93d9c7c6a049f76d8e3e5f1836d4a11ddc534`. One synthetic source-declared Pending receipt created by the actual Redis adapter remains byte-for-byte unchanged; its immutable inventory contains one manual obligation, zero grants and zero provider calls. This proves the real key/index/read contract, not fulfillment.
- Actual `server.js` runs in a separate systemd unit and UID 2003 with private files and real container Redis. `backend-linux-persistent-controller-proof.json`, SHA256 `7940dfe73d5b35ac16e37ae049d1efb8c720054f13d7e4f306097c7314bec3a2`, records HOLDING generation 0, custody owned/healthy, one pending synthetic receipt, no in-flight or legacy worker, checkout closed and public activation false. PostgreSQL may remain unavailable. This proof does not claim final bind or activation.
- A fresh Redis `SAVE` of the existing synthetic records at **2026-09-25 12:19:53 UTC** produced a 1,668-byte RDB, SHA256 `bbc6d5157bf6d5411f17f899dcca521aeb6650bcaaab389e78aea7e6f4be170c`, LASTSAVE `1790338793`, DB 15 keys **6 before / 6 after**. The copied RDB matches the saved source hash. This is staged backup material, not a restore proof or monetary mutation.

The joined OS shutdown/fence, fresh cohort migration, PostgreSQL activation, compatible rollback and restore are ROOT/A/C's separate rehearsal evidence. Backend results do not claim host power-loss resilience, cluster operation, external provider qualification or production deployment. New checkout remains closed; a first unproven production payment is quarantined, never granted by inferring absence of history.

Raw reports remain under the Unity workspace's ignored `Logs/MonetaryV2/`. No real payer IDs, credentials, private receipts or generated inventories are committed. No new charge, provider call, production config change, checkout mutation or deployment occurred.
