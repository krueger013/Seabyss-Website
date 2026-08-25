# Seabyss financial mutation inventory

Snapshot scope: Unity runtime code under `Assets/_Seabyss/Scripts`, excluding Editor, Tests, and LoadTesting. This is a local source audit, not live PlayFab evidence.

## Summary

| Legacy access | Occurrences | Files |
|---|---:|---:|
| Direct assignments to `profile.gold` or `profile.diamonds` | 17 | 6 |
| Direct legacy virtual-currency provider calls | 17 | 5 |
| Gold grants through gameplay wrappers | 19 | 11 |
| Diamond grants through gameplay wrappers | 15 | 11 |
| Gold async debits | 12 | 5 |
| Diamond async debits | 7 | 4 |
| Item grants | 7 | 7 |
| Cannon grants | 5 | 5 |
| Ammo grants | 5 | 5 |
| Premium/entitlement grants | 8 | 4 |
| Destination marker grants | 1 | 1 |
| Ship-design grants | 4 | 4 |

Sixteen runtime files still participate in Gold/Diamond writes. Ten runtime files perform real inventory mutations. The active runtime mode is Legacy, so these are not yet migrated writers.

## Canonical resource matrix

| Resource/domain | Principal runtime readers | Principal runtime writers | Current durable store | Target store |
|---|---|---|---|---|
| Gold | HUD, Market, Tavern, Guild, boarding, profile UI | `PlayerRewardState`; Market/Tavern/Guild/boarding; NPC/boss/monster/chest/quest/exam/redeem | classic VC `GD` plus `profile_v1.gold` mirror | Economy v2 deterministic currency stack |
| Diamonds | HUD, Market, Tavern, Shop, profile UI | `PlayerRewardState`; Market/Tavern/Guild; NPC/boss/monster/chest/quest/exam/redeem; legacy Xsolla Diamond | classic VC `DM` plus `profile_v1.diamonds` mirror | Economy v2 deterministic currency stack |
| Siren Tears | Cauldron and profile/UI projections | NPC/boss/rewards and Cauldron spend | `profile_v1.sirenTears` | Economy v2 deterministic currency stack |
| Elite Points | ship progression/UI | gameplay rewards | `profile_v1.elitePoints` | Economy v2 deterministic currency stack; progression semantics retained |
| Cannons | combat, Shipyard, Market, Shop | Quest/exam/Market/Starter/redeem/Cauldron | `profile_v1.cannons` | Economy v2 quantities; equipped counts stay gameplay-owned |
| Ammunition | combat/HUD/Market/Shop | combat consumption; Quest/exam/Market/Starter/redeem/Cauldron | `profile_v1.ammo` | Economy v2 quantities with high-frequency reservation/delta journal |
| Consumables | health/combat/HUD/Market | health/combat consumption; Quest/exam/Market/Starter/redeem/Cauldron | `profile_v1.usableItems` | Economy v2 quantities with bounded server-authoritative flush |
| Harpoons | combat/HUD/Market/Shop | attack reservation/commit; Market/Starter | `profile_v1.harpoons.quantities` | Economy v2 quantities; equipped harpoon stays gameplay-owned |
| Premium | repair, respawn, quest slots, Market discount, floating chest | Shop/Starter/Premium receipts | `profile_v1.shopEntitlements` | `SeabyssFinancialAuthorityV2.premium` |
| Treasure Doubler | floating chest | Shop entitlement grant | `profile_v1.shopEntitlements` | financial authority entitlement contract (not yet implemented in V2 object) |
| Destination markers | map/UI/profile | Starter and redeem | `profile_v1.ownedDestinationMarkerIds` | `SeabyssFinancialAuthorityV2.paidDestinationMarkerIds`; free markers remain gameplay-owned |
| Paid ship designs | Shipyard/profile/UI | Market, Quest/redeem, Starter | `profile_v1.ownedShipDesignIds` | `SeabyssFinancialAuthorityV2.paidShipDesignIds`; non-paid progression designs need explicit policy |
| Starter ownership | Shop UI | payment transaction completion | durable transactions/receipt ledgers in `profile_v1` | central payment ledger plus `SeabyssFinancialAuthorityV2.ownedStarterSkus` |
| Captains | Tavern/Captain UI | Tavern purchase | `profile_v1.captains` | unresolved catalog/entitlement domain |
| Purchased pirates | Tavern/boarding | Tavern purchase, boarding transfer | `profile_v1` HP buckets | unresolved catalog/entitlement domain |
| Guild bank | Guild UI/services | deposits, tax, refunds | `guilds.json` | separate server authority coordinated atomically with player wallet |

## Explicit quantitative registry

Currencies:

- `gold`
- `diamonds`
- `siren_tears`
- `elite_points`

Cannons:

- `iron_cannon`
- `carronade`
- `long_range_cannon`

Ammunition:

- `hollow_ball`
- `elite_ball`
- `illuminated_ball` (legacy/disabled but must be preserved during migration)
- `poison_cannonball`
- `ice_cannonball`
- `electric_cannonball`

Consumables:

- `green_amulet`
- `blue_amulet`
- `red_amulet`
- `star_dust`
- `thors_wrath`
- `gold_offensive_powder`
- `diamond_offensive_powder`
- `gold_armor_plate`
- `diamond_armor_plate`

Harpoons:

- `harpoon_gold_125`
- `harpoon_diamond_250`

Paid destination IDs currently referenced by product plans are `destination_red_point` and `destination_blue_point`. Historical/free destination ownership also includes `destination_default`, `destination_skull_abyssal`, and `destination_spider`; migration must not accidentally classify free progression ownership as paid ownership.

Paid ship designs currently found are:

- `design_blaky`
- `design_seashell`
- `design_rex_abyssi`
- `design_mersea`
- `design_krystal_ice`
- `design_evilz_sharky`

## Gameplay path matrix

| Producer/consumer | Existing entry points | Legacy mutation seam to replace |
|---|---|---|
| Quest | `QuestRewardService.ExecuteAsync`; completion-item consumption in `PlayerQuestState` | durable steps ultimately call classic VC and in-memory/profile inventory |
| Pirate Exams | `PirateExamRewardService.BuildRewardSteps` | same legacy durable steps |
| NPC | `CombatTarget.AwardSingleKillerRewardsAsync` | `PlayerRewardState` plus local inventory dictionaries |
| Boss online | `CombatTarget.ApplyBossRewardShareToConnectedPlayerAsync` | connected-player legacy components |
| Boss offline | `CombatTarget.ApplyBossRewardShareToOfflineProfileAsync` | direct classic VC plus direct `profile_v1` mutation |
| Boss delivery worker | `BossRewardProfileDeliveryProcessor.ProcessOfflineAsync` | direct classic VC plus JSON item mutation |
| Sea monster | `SeaMonsterRewardService.GrantAsync` | `PlayerRewardState` and compensating legacy rollbacks |
| Floating chest | `FloatingLootChestManager.TryGrantRewardAsync` | legacy currency wrapper; Premium/Doubler read from profile projection |
| Cauldron | reward and rollback paths in `CauldronManager` | legacy currency and inventory component writes |
| Combat ammo | `PlayerCombatController` -> `PlayerCannonInventory.TryConsumeAmmoForVolley` | synchronous SyncDictionary decrement then profile save |
| Powder/plate | `PlayerCannonInventory.ConsumeActiveCombatConsumable` | synchronous SyncDictionary decrement |
| Thor/amulets/stardust | consumption in `PlayerHealthState` | synchronous SyncDictionary decrement |
| Harpoon attack | reservation/commit/rollback partial in `PlayerHarpoonInventory` | synchronous SyncDictionary mutation |
| Market | `PlayerCannonInventory.ServerHandleMarketPurchaseAsync` | wallet debit, provisional local grant, rollback, profile save |
| Tavern captains | `PlayerCaptainInventory.ServerExecuteCaptainPurchaseAsync` | wallet debit plus `profile_v1.captains` |
| Tavern pirates/boarding | purchase/refund/transfer in `PlayerPirateCrew` | wallet debit/credit plus profile HP buckets |
| Guild | create/deposit/refund in `GuildService`; tax in `GuildService.DailyTax` | player wallet and separate guild JSON are not one atomic transaction |
| Starter Shop | `XsollaStarterPackGrantService` | legacy component grant path; must be disabled in V2 worker mode |
| Diamond Shop | `PlayFabPlayerProfileStore.XsollaDiamond` | direct `AddUserVirtualCurrency` and profile mirror |
| Premium Shop | pending Premium receipt processor | profile entitlement ledger |
| Redeem/admin | `ServerGrantRedeemRewardsAsync` | legacy durable currency/inventory/design steps |
| Save/load | `PlayerProfileCoordinator.ServerBuildSnapshot/ServerApplySnapshot`; `PlayFabPlayerProfileStore.SaveAsync` | full financial snapshot is written to `profile_v1` without financial revision fence |

## Legacy currency writers

- `Assets/_Seabyss/Scripts/Entities/PlayerRewardState.cs`
- `Assets/_Seabyss/Scripts/Persistence/PlayFab/PlayFabVirtualCurrencyStore.cs`
- `Assets/_Seabyss/Scripts/Persistence/PlayFab/PlayFabPlayerProfileStore.XsollaDiamond.cs`
- `Assets/_Seabyss/Scripts/Persistence/PlayerProfileCoordinator.cs`
- `Assets/_Seabyss/Scripts/Persistence/StarterProfilePolicy.cs`
- `Assets/_Seabyss/Scripts/Persistence/DurableRewardTransactionService.cs`
- `Assets/_Seabyss/Scripts/Persistence/BossRewardProfileDeliveryProcessor.cs`
- `Assets/_Seabyss/Scripts/Entities/npcs/CombatTarget.cs`
- `Assets/_Seabyss/Scripts/SeaMonsters/SeaMonsterRewardService.cs`
- `Assets/_Seabyss/Scripts/Loot/FloatingLootChestManager.cs`
- `Assets/_Seabyss/Scripts/Cauldron/CauldronManager.cs`
- `Assets/_Seabyss/Scripts/Entities/Combat/PlayerCannonInventory.cs`
- `Assets/_Seabyss/Scripts/Captains/PlayerCaptainInventory.cs`
- `Assets/_Seabyss/Scripts/Boarding/PlayerPirateCrew.cs`
- `Assets/_Seabyss/Scripts/Guilds/GuildService.cs`
- `Assets/_Seabyss/Scripts/Guilds/GuildService.DailyTax.cs`

## Mandatory bypass closures

1. New-profile starting financial values must become an idempotent canonical bootstrap operation.
2. Login must never promote `GD`, `DM`, or a `profile_v1` mirror after migration.
3. Offline boss rewards must call the same canonical mutation service as connected rewards.
4. The boss delivery worker must stop editing `profile_v1` quantities.
5. Guild tax/deposit/refund must coordinate the player wallet mutation with the guild ledger.
6. The xsd1/legacy Diamond processor must remain backward-readable but must not grant new V2 receipts.
7. The old Starter currency initializer must not run for migrated accounts.
8. Gameplay saves must not write either canonical financial store.
9. Local JSON mode must be test-only in Cutover and cannot be a second production authority.
10. Online refresh must replace caches only and must never invoke grant code.

## Current conclusion

The inventory is exhaustive enough to define the migration registry and the central seams, but the source snapshot still contains approved legacy writers because the active mode remains `Legacy`. A Cutover build must fail closed until those writers are routed or explicitly confined to migration/backward-compatibility code, the high-frequency consumption journal is implemented, and the remaining Captain/Pirate/Guild ownership decisions are approved.
