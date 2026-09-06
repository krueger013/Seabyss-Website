# Approved five Diamond packs (2026-09-05)

Current Diamond product plans are v2; Starter and Premium stay on v1. Current values:

| SKU | Diamonds | USD minor units | Plan hash |
|---|---:|---:|---|
| seabyss_diamond_pack_1 | 1000 | 199 | db5fc0094047c450821065e993ee983a8b9c0c8f6c77d5bf5c0c322e3bba0b48 |
| seabyss_diamond_pack_2 | 2500 | 399 | 29534788b148a9b8d25fa11215082306a72f57a073ca27dc2035b6856cb2a51d |
| seabyss_diamond_pack_3 | 5000 | 699 | 20cf5f4bb8cc07ea339b86c89692879526fcbce1871414daf678a13637f10bb9 |
| seabyss_diamond_pack_4 | 8000 | 999 | dc16ddbbf43a0dbba4b93e30a10f1f8c75aeab65be03c801edcf27d10030e821 |
| seabyss_diamond_pack_5 | 20000 | 1899 | 002dac0f76443c77df57b9d94e6cb8a6351587378c9d22e8e62db7bffc185cf3 |

Historical v1 Diamond plans remain 500/1200/3000 and 199/399/799 minor units with their original hashes. The current registry is the only backend Diamond quantity source. The profile/payment adapter, financial-authority adapter and trusted receipt mapper select by the immutable receipt version.

xsd2 must contain an explicit plan version. Original six-field xsd1 payloads keep their bytes and old rewards. New xsd1 writes include productPlanVersion=2; receipt persistence first checks for an existing immutable receipt and never silently upgrades it. Unity's updated reader supports all five current SKUs and old versionless I-III. Old strict Unity readers reject new payloads rather than misgranting. No receipt migration or provider financial test was performed.

Xsolla project310966: PUT I-III HTTP204, POST IV-V HTTP201, individual and final GET readbacks PASS. Approved quantities/default USD prices match this table. Existing regional/non-USD prices were preserved; pack III base/US USD is6.99. No other products changed. No checkout/payment.

Validation: focused local backend tests 105/105 PASS; Unity EditMode 19/19 and PlayMode 25/25 PASS. Five current SKUs cover valid, duplicate, restart/recovery replay, trusted projection and invalid input; historical v1 hashes and amounts remain covered. Approved five images and five-resolution captures are documented in the Unity repo at Docs/Shop/FiveDiamondPacks-2026-09-05.md.

All purchase/checkout, Shadow, migration, Canary and Cutover gates remain OFF. No deployment or push. Production payments remain disabled and are not certified for activation by this task. Frozen historical Canary data was not touched.

Savepoint: codex/savepoint-before-five-diamond-packs at f803061cd5859c843b3b437e2a0b16c6a2d4f181, with the interrupted dirty diff backed up outside Git. This document is part of the scoped final Diamond commit.
