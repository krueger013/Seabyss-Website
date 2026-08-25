# Diamonds Sandbox Canary Runbook

Preparation only. Do not execute this runbook until a separately authorized
Sandbox Canary change window. It never targets Production title `142853`.

## Scope and fixed order

- Domain: Diamonds only.
- Sandbox title: `1D0C16`.
- One explicit Sandbox PlayFabId; no wildcard.
- Elite and Premium remain Legacy.
- Purchases, Xsolla checkout and global financial cutover remain off.

## 1. Preconditions

1. Confirm the selected user belongs to Sandbox title `1D0C16`.
2. Confirm Production host/title refusal is active.
3. Confirm Redis, PlayFab adapter, CAS, fencing and worker health.
4. Confirm no Pending/Processing payment for the user.
5. Run the Legacy scanner and require Diamonds
   `forbiddenDirectAccess=0`. Intentional DM adapter and migration-only reads are
   permitted.
6. Require unexplained Diamonds Shadow mismatch count `0` over the approved
   observation window.
7. Confirm every purchase, checkout, Shadow and Cutover gate is currently off.

Stop on any failed precondition.

## 2. Read-only dry-run

1. Read exact Legacy `DM` balance and its evidence.
2. Read Target Diamonds, Target revision/ProfileVersion and existing migration
   proof.
3. Run `planProgressiveFinancialDomainMigration` for `Diamonds`.
4. Require `status=ready` or a matching `already_migrated` proof.
5. Require zero conflicts and record the stable `planHash` without credentials.
6. Independently verify: `proposedTarget === Legacy DM`. Never add Target to DM.

If Target is non-empty and divergent, stop in `ManualReview`.

## 3. Approve and migrate exact Target

This step requires a separate explicit mutation authorization.

1. Enable only `FINANCIAL_DIAMONDS_MIGRATION_ENABLED` in the isolated migration
   process, not in the gameplay service.
2. Submit the approved `planHash`.
3. Acquire transaction/player lease and fencing epoch.
4. Execute the exact idempotent replacement with the expected Target revision.
5. Persist/read back the completed proof and exact Target balance.
6. Re-run the same plan; require `already_migrated`, zero provider writes and the
   unchanged balance.
7. Disable the migration gate immediately.

Do not continue if readback, proof, revision or digest differs.

## 4. Enable one-user Canary

After migration and a second approval:

```text
FINANCIAL_DIAMONDS_MODE=Canary
FINANCIAL_DIAMONDS_CANARY_ENABLED=true
FINANCIAL_DIAMONDS_CUTOVER_ENABLED=false
FINANCIAL_DIAMONDS_MIGRATION_ENABLED=false
FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS=<ONE_SANDBOX_PLAYFAB_ID>
```

Elite and Premium remain `Legacy`. The runtime must also load the verified
Diamonds `readyForCanary` health certificate; environment variables alone are
rejected.

## 5. Verify Canary

1. Login, reload and reconnect.
2. Verify Target is the Diamonds reader only for the canary.
3. Exercise one controlled grant, one spend, insufficient funds and operation
   replay.
4. Verify exact balance, monotonic revision, idempotent operation proof and no
   stale Legacy save.
5. Verify a non-allowlisted Sandbox user still uses Legacy.
6. Verify Elite and Premium remain Legacy.
7. Observe mismatch, pending operations, CAS/fencing rejects, queue age and
   provider/Redis health.

## 6. Safe rollback before point of no return

Automatic rollback is allowed only while the completed proof states
`targetOnlyOperationCount=0`.

1. Disable `FINANCIAL_DIAMONDS_CANARY_ENABLED` and set mode `Legacy`.
2. Drain and verify Pending/Processing equals zero.
3. Verify exact Legacy/Target equality and the unpassed rollback marker.
4. Restart/reload the isolated Sandbox composition in Legacy.
5. Verify no Target writer remains active and clear the canary allowlist.

If a Target-only grant or spend occurred, the point of no return is passed. Do
not automatically copy Target to DM or DM to Target. Stop in ManualReview and
prepare a forward reconciliation plan.

## 7. End-of-window safe state

```text
FINANCIAL_DIAMONDS_MODE=Legacy
FINANCIAL_DIAMONDS_CANARY_ENABLED=false
FINANCIAL_DIAMONDS_CUTOVER_ENABLED=false
FINANCIAL_DIAMONDS_MIGRATION_ENABLED=false
FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS=
FINANCIAL_ELITE_MODE=Legacy
FINANCIAL_PREMIUM_MODE=Legacy
FINANCIAL_SHADOW_MODE_ENABLED=false
PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED=false
```

Stop Sandbox workers and Redis test infrastructure. Record evidence without any
session ticket, entity token, Secret Key or Authorization header.
