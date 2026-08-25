# Xsolla product receipt contracts

Receipts are server-authored only after Xsolla signature, project, player, SKU, environment and
economic validation. Client-supplied rewards, prices, quantities or durations are never
authoritative.

## Primary immutable receipts

### Starter Pack (`xss2_`, schema 2)

- Supported SKUs map exactly to `starter_pack_1`, `starter_pack_2` and `starter_pack_3`.
- Key: `xss2_${base64url(sha256(transactionId UTF-8))}`.
- Exact fields: `schemaVersion`, `transactionId`, `notificationType`, `orderId`, `provider`,
  `providerTransactionId`, `userId`, `createdAtUtc`, `environment`, `productId`, `xsollaSku`,
  `productType`, `source`, `productPlanVersion`, `rewardPlanVersion`, `rewardPlanHash`, `rewards`,
  `currency`, `unitAmountMinor`, `quantity`, `totalAmountMinor`, `promotionPolicy`.
- `provider` is `xsolla`, `providerTransactionId` equals `transactionId`, `userId` is the legacy
  PlayFabId, and `productType` is `starter_pack`.
- Price and rewards are immutable snapshots of the versioned backend product and reward plans.
  Rewards are not reconstructed from the Unity catalogue.
- Quantity is exactly `1` and promotions are disabled.

### Diamond Pack (`xsd2_`, schema 2)

- Supported SKUs map exactly to `diamond_pack_1`, `diamond_pack_2` and `diamond_pack_3`.
- Key: `xsd2_${base64url(sha256(transactionId UTF-8))}`.
- Exact fields: `schemaVersion`, `transactionId`, `notificationType`, `orderId`, `provider`,
  `providerTransactionId`, `userId`, `createdAtUtc`, `environment`, `productId`, `xsollaSku`,
  `productType`, `source`, `productPlanVersion`, `currency`, `unitAmountMinor`, `quantity`,
  `totalAmountMinor`, `promotionPolicy`.
- The receipt embeds the validated versioned product and economic snapshot. Quantity is exactly `1`
  and promotions are disabled.

For both formats, `notificationType` is `payment` or `order_paid`; `order_paid` requires a canonical
order ID. The source and environment must agree (`xsolla_sandbox`/`sandbox` or
`xsolla_production`/`production`). Existing values are compared byte-for-byte, conflicting writes
fail closed, and new writes are read back before persistence is accepted.

## Legacy compatibility receipts (`xss1_` and `xsd1_`)

The v2 stores dual-write the corresponding minimal schema-1 receipt for compatibility:

- Starter key: `xss1_${base64url(sha256(transactionId UTF-8))}`.
- Diamond key: `xsd1_${base64url(sha256(transactionId UTF-8))}`.
- Exact fields: `schemaVersion`, `transactionId`, `productId`, `xsollaSku`, `productType`, `source`.

These records are write-once compatibility artifacts. A missing legacy record may be created beside
the primary v2 record; an existing different value is an immutable conflict. They are not the
primary economic or reward contract and must not be used to reconstruct rewards from Unity.

## Ledger state after receipt persistence

The verified transaction is created in the durable payment ledger before PlayFab receipt
persistence. The receipt-only worker executes only the `receipt_persisted` checkpoint. Once that
checkpoint is durable, it transitions `Processing` back to `Pending` and returns
`checkpoints_pending`.

A replay of a `Pending` transaction that already has `receipt_persisted` returns the same
`checkpoints_pending` status without rewriting the receipt. `Completed` is reserved for the future
offline profile worker after every required grant/profile checkpoint succeeds; receipt persistence
alone never means that rewards were granted.

## Standalone Premium (`xsp2_`)

- Supported SKUs map exactly to the `bronze`, `silver` and `gold` tiers.
- Key: `xsp2_${base64url(sha256(transactionId UTF-8))}`.
- Exact fields: `schemaVersion`, `transactionId`, `productId`, `xsollaSku`, `productType`,
  `premiumTier`, `activatedAtUtc`, `expiresAtUtc`, `source`.
- `schemaVersion` is `2`; `productId` and `productType` are `premium`.
- The backend clock sets activation and exactly 30 days of entitlement. Payload duration is never
  authoritative; package quantity, when present, must be numeric `1` and is never stored.
- Legacy subscription receipts remain on the unchanged `xsp1_` calendar-period path.
