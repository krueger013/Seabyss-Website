# Beta59 payments: quarantine and production configuration qualification

2026-09-25. Continues backend `63d5898`; no deployment or live configuration change. Current user policy permits unresolved V1 payment outcomes in durable manual quarantine without vetoing unrelated gameplay, never guessing or replaying them. Exact authorization for local production-shape preparation is in the Unity repository `Docs/MonetaryV2/BetaMigrationPolicy.md` sections 9-10.

## Durable outcomes and quarantine

The accepted verified receipt still reaches the bounded fsynced custody file before authority routing. Transaction/recipient/plan/amount/hash remain immutable. Provable V2 submissions preserve their operation on duplicate, lost response and restart; confirmed V1 handoffs never generate another V2 grant.

A V1 attempt with unprovable fulfillment when authority reaches V2 now receives a fsynced `quarantine` record: `LEGACY_RECEIPT_OUTCOME_UNKNOWN`, original hash, timestamp and cutover epoch/source hash. The original receipt/attempt remain intact. Quarantine is excluded from automatic retry and cannot be converted to handoff by the existing method. No balance is inferred or replayed. There is no new mutation/repair tool.

Health exposes pending/retryable/quarantined/capacity and HEALTHY/DEGRADED/RECONCILING. A valid custody store with quarantine is still ready: the real backend /health/ready returns 200 and an unrelated accepted purchase proceeds. Existing finite capacity and checkout safety thresholds remain. Gameplay does not wait for manual receipt reconciliation.

A first production callback may itself be old even when no receipt is in the profile. Absence and provider timestamp are NOT proof of nonfulfillment. The service must announce `unprovenPaymentPolicy=quarantine`; the backend rejects older services without that contract. Unknown first identities enter service ManualReview (`production_payment_origin_unproven`), whose durable handoff reason/timestamp is also visible in the local quarantine audit. Already proved V2 outcomes retain their original result. There is no grant by missing history.

The earlier subscription `plan_id` format is distinct from the three standalone Premium SKUs. Its existing `createXsollaPremiumEventProcessor` validates the configured numeric/external plan identifiers, payment mode, reliable billing period, transaction and user before a replacement persistence callback writes `legacy_subscription` into the same bounded custody journal. Signature verification remains the existing webhook layer. The complete verified parsed payload, original identifiers and period are retained with `LEGACY_SUBSCRIPTION_REQUIRES_RECONCILIATION`; no SKU, tier, price or grant is invented. Duplicate/restart retain the original, contradictory same-transaction payloads or cross-family reuse are rejected, and recovery never sends this manual case to a grant service. There is no assertion that the old subscription path was never used in production.

Private read-only diagnostics:

```text
node src/monetary-v2-payment-quarantine-cli.js <absolute-hold-file> production 142853 50 "" <authority-config-sha256>
```

Use returned `next` for pagination. The output includes original TransactionId, recipient, hash, reason and timestamp, never credentials or complete profiles. Keep it in a private administrator console. It cannot release quarantine or grant value. A future resolution requires independent outcome proof and separately authorized audited tooling.

## Exact executable production configuration

This uses production/142853, not a sandbox label. Only test fixtures use synthetic IDs/fake secrets; runtime is not restricted to them. Prepare these values, but activate them only during a future authorized cutover:

```text
NODE_ENV=production
PLAYFAB_TITLE_ID=142853
SEABYSS_MONETARY_V2_PAYMENTS_ENABLED=true
SEABYSS_MONETARY_V2_PAYMENT_ENVIRONMENT=production
SEABYSS_MONETARY_V2_PAYMENT_PRODUCTION_AUTHORITY=durable-v2-provider-off
SEABYSS_MONETARY_V2_PROVIDER_DISPATCH_MODE=OFF
SEABYSS_MONETARY_V2_PAYMENT_AUTHORITY_SHA256=<SHA256 of exact immutable service authority JSON>
SEABYSS_MONETARY_V2_PAYMENT_ORIGIN=http://127.0.0.1:<private-port>/
SEABYSS_MONETARY_V2_PAYMENT_TOKEN_FILE=<private existing token file>
SEABYSS_MONETARY_V2_PAYMENT_FENCE_FILE=<preprovisioned production fence file>
SEABYSS_MONETARY_V2_PAYMENT_HOLD_FILE=<preprovisioned production custody file>
PAYMENT_WORKER_ENABLED=false
PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=false
PLAYFAB_FINANCIAL_PROFILE_ENABLED=false
PURCHASES_GLOBAL_ENABLED=true
PURCHASES_DIAMOND_ENABLED=true
PURCHASES_STARTER_ENABLED=true
PURCHASES_PREMIUM_ENABLED=false
PURCHASES_DOUBLER_ENABLED=false
XSOLLA_HARDENED_CATALOG_ENABLED=true
XSOLLA_CHECKOUT_CLOSED=true
XSOLLA_CHECKOUT_MODE=production
XSOLLA_CHECKOUT_PRODUCTION_ENABLED=true
XSOLLA_PREMIUM_PLAN_ID=<preserve existing exact configured legacy subscription plan>
XSOLLA_PREMIUM_PLAN_EXTERNAL_ID=<preserve existing exact configured external plan>
```

Keep approved Diamond/Starter SKU allowlists and existing private authentication, session and Redis configuration. Close only new checkout: keep callback global/family/SKU gates configured for earlier tokens. Do not use those gates to close checkout. Production now REQUIRES XSOLLA_CHECKOUT_CLOSED=true and its canCreateCheckout remains false. Reopening requires a separately qualified durable new-checkout admission proof; it is not available in this initial Beta configuration. Premium standalone/Doubler production checkout stays closed; no new product family is opened. Known legacy standalone Premium paid callbacks are nevertheless captured: the hardened validator checks original SKU, immutable plan, price/currency, quantity, identity and signature before custody, independently of closed Premium sales gates. Only the V2 proof-or-quarantine service receives them; there is no direct/legacy entitlement grant. Unsupported or unverified products are not invented or acknowledged as fulfilled.

Startup, authority, submit and review verify authenticated /v1/health: protocol1, production/142853, authority postgresql, providerMode disabled, providerDispatchAllowed false, allowV1Fallback false and exact productionAuthorityHash. The service binds that hash to immutable DB identity/origin and a durable fence. Backend custody/fence headers bind the same hash. Repointing them fails closed. Literal high-port loopback/private token constraints remain.

Contradictory old PlayFab worker/cutover requirements are replaced only after this exact explicit configuration verifies. Default production denial, Redis/session/authentication requirements and old V1-path guards remain. A positive V1 authority result in production never calls a legacy monetary writer; custody waits for migration. No live configuration has been enabled.

## Real historical evidence: bounded observation

Agent A's inspected copies have 3 durable Xsolla operations, all Completed, and 0 observed Xsolla UNKNOWN/PARTIAL. This is not exhaustive payment certification. All21 dedicated keys remain preserved:16 starter_txn_,1 xsp1_,1 xspm1_,3 xsd1_.

The xsp1/xspm1 pair references the SAME transaction represented in one shopEntitlement with grantSource=xsolla_sandbox. It is legacy Premium snapshot evidence, not a durable Completed transaction or two unknown purchases. All3 xsd1 IDs are in appliedTransactionIds and their original receipts also carry source=xsolla_sandbox. No real-money payment is demonstrated by these three sandbox receipts, which is not proof that no real payment ever occurred. Preserve these distinct proofs. UNKNOWN Gold debits -2040/-400 are not Xsolla payments.

These paid receipts are on one of the six accounts without a proved wallet opening. Completed fulfillment does NOT prove the remaining purchased balance or authorize its loss in a zero-opening reset. The cohort must retain one separate immutable PAID_BALANCE_OPENING_UNPROVEN manual case linked to all original receipt/source hashes, with paymentWaiver=false, no replay and no guessed compensation. This is distinct from zero observed UNKNOWN fulfillment operations. The existing immutable Beta59Reset.auditJson in migrations.evidence_json retains full original inputs and the stable manual case, without fabricating a callback or adding a non-pra1 archive to the strict archive mapper.

All new callback-unknown test cases are synthetic. No real profile, payment or journal was mutated.

## Targeted evidence

Artifacts: Unity workspace Logs/MonetaryV2/payment-cutover-qualification/.

- backend-quarantine-01.tap:65 PASS,0 FAIL (61 reused plus4 new quarantine cases).
- backend-production-shape-01.tap:80 PASS,0 FAIL (adds15 production HTTP/receipt/guard cases using real loopback HTTP and a deterministic service fixture).
- backend-server-production-shape-01.tap:1 PASS: actual server.js startup, readiness with quarantine, registered shutdown coordinator and restart.
- Previous intermediate backend-production-final-02.tap: **82 PASS /0 FAIL /0 CANCELLED /0 SKIP**, SHA256 `249505dab44e731451cf09a3c4b101ad1d595de7361d59d235c5e543a294b984`. Includes unsafe/missing opt-in, wrong hash, mixed V1, remote endpoint and original default-deny startup cases.

Final bounded group: **84 distinct PASS /0 FAIL /0 CANCELLED /0 SKIP**, `backend-production-final-03.tap`, SHA256 `4d58c32a78e183f1045ffe82bc2b6249e72011664f89465f2502d0f306aa1c18`. This includes the actual server boot/readiness/shutdown/restart test (not an extra PASS), rejection of an old service policy, and an old first callback after cutover with absent profile receipt: quarantine, zero grant, identical replay/restart, independent proved payment still succeeds.

A final bounded callback correction follows that84-case result: three known old Premium tiers must be retained despite closed new sales. It does not enable checkout or direct grants. Only the invalidated subset was rerun:

- backend-old-premium-01.tap:5 new PASS/0 FAIL, three tiers quarantine/duplicate/restart plus invalid price/quantity and signature refusal. SHA256 `0328b624365248649da17c6d328422eb7c00e430828a428c84449e85c400dd24`.
- backend-premium-related-01.tap:12 existing hardened/gate PASS/0 FAIL. SHA256 `615f20c76e7da5d82ac885c85981d4793e42bdd6b533cd0d6c5f2873e0eeeff2`.
- backend-premium-existing-purchases-01.tap:2 existing Diamond/Starter shared-path PASS/0 FAIL. SHA256 `1468c0e219e3d6ad52a6ec38f99c5c2f6672e842c502cb75ced06714998993f8`.

The final old-subscription correction has separate evidence, with no broad campaign:

- backend-old-subscription-01.tap:4 PASS/1 FAIL. The new fixture expected500 for an unknown user; the unchanged webhook contract correctly returns400 INVALID_USER. No runtime assertion was relaxed.
- backend-old-subscription-02.tap:10 PASS/0 FAIL:5 new old-format cases (full original evidence, closed checkout, duplicate/conflict, invalid identity/plan/period/signature, before/after-fsync restart) plus5 existing Diamond/Starter/standalone paths. SHA256 `0a497e63588cfb34ac1527ea8d42bde00c66aba7222f3f472a394dceaf7dc7dc`.
- backend-old-subscription-custody-regression-01.tap:32 existing affected custody PASS/0 FAIL, SHA256 `8302c2aa9d3cf250b1837732a9419728a1c36e2204d94828ba31df2c85d6fb13`.

The previous124 baseline cases are reused; the84-case group adds23 distinct cases (4 quarantine and19 production cases), followed by5 new Premium SKU capture cases and5 old-subscription cases. Final84 overlap61 baseline cases. Do not add overlapping runs or claim147 executed in one campaign.

Actual server composition uses a limited loopback RESP fixture for existing Redis session/scanner startup, implementing only CLIENT/PING/empty ZRANGE/GET/QUIT. It stores no money/payment state. This proves executable composition/lifecycle, not Redis persistence or deployment. Mandatory production Redis remains unchanged. Every test child blocks external fetch/TCP/DNS/UDP and uses an empty dotenv file.

## Direct Node to real local PostgreSQL service

`backend-production-postgres-seam-03.json`: **8 PASS/0 FAIL**, SHA256 `2e39dc592102acc096359e89e77c67712f96ebe5538fecfe4fc9c4dd1927a93e`. Actual backend signature verification, fsynced custody and private HTTP reached the actual isolated production/142853 PostgreSQL service (provider OFF). Two fresh synthetic identities, Diamond and standalone Premium, became durable ManualReview with zero grant. Duplicates and backend/service restarts retained exact replies. An existing Completed V2 receipt returned without granting again. The authoritative account, sequence, head hash, Gold995, Diamonds2100 and reserves were identical before/after. The service was stopped gracefully and returned to its owner for separate compatible-runtime qualification.

Service SHA256 `c105e91459d5bcc73e6fa2a2972bc5bd6c57a1babd4b257b597ca9a3377c024a`; immutable production-authority config SHA256 `bc651d949889b4b178473910776fb8da858f015eb55f8f6864e557fca01c7402`. Fixture account/transactions only. This is custody/quarantine and proved-receipt replay qualification; it is NOT permission to create new production checkout or grant an unproved first payment.

The preserved seam01 artifact is0 PASS/1 FAIL: the child inherited the backend cwd while the monitor correctly requires its private directory under the service workspace. The runner now supplies that workspace; no monitor guard was removed. Seam02 is1 PASS/1 FAIL: the fixture compared ownerEpoch together with money, although LocalVerifiedPaymentRuntime legitimately acquires/releases its offline owner lease before admission. The corrected oracle retains every economic dimension (account, sequence, head, balances, reserves), independently of lease epoch. Diamond custody/ManualReview had already succeeded in that attempt. No runtime money logic changed for either fixture correction.

The old-subscription quarantine extension came after this seam; it sends no service request. Its five dedicated cases and32 affected journal cases above passed afterward; the existing catalogue callback paths shared with this seam were also rechecked. No complete service campaign was repeated.

## Scope

No live production, billing, provider mutation, deployment or release. No broad campaign, optional optimization or unrelated Unity change. Unknown payment quarantine is an accepted safe outcome under current Beta policy; it is not successful fulfillment, a complete historical-payment census or permission to replay.
