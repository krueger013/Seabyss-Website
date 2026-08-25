# Paiements Xsolla — runbook de préparation Production

## Portée et règle de sécurité

Ce runbook prépare une future mise en Production sans l'autoriser. Tant que chaque contrôle et
chaque action externe de la dernière section ne sont pas terminés et approuvés, les achats restent
désactivés. Aucun opérateur ne doit créer un paiement réel pour vérifier un déploiement.

Principes non négociables :

- le client ne décide jamais du prix, de la devise, des rewards, du PlayFabId ni du mode Xsolla ;
- les montants sont comparés en unités mineures entières et proviennent du plan serveur versionné ;
- un événement payé n'est accordé qu'après validation de signature, projet, environnement, SKU,
  identité, montant et devise ;
- les reçus, checkpoints et preuves d'idempotence sont durables avant tout grant ;
- les Starter Packs sont one-time dans le backend **et** dans Xsolla ;
- un remboursement, une annulation ou un chargeback ouvre un dossier auditable ; aucune reprise
  automatique de consommables déjà dépensés ;
- une readiness rouge interdit l'ouverture des achats, même si le processus répond en liveness.

## 1. Catalogue Xsolla à préparer, sans activation

Projet attendu : `310966`. Vérifier l'identité du projet dans le Dashboard avant toute mutation.
Les prix ci-dessous sont des prix fixes USD, taxes éventuelles traitées par la politique Xsolla.
Ne pas publier, promouvoir ou rendre achetable un produit pendant cette préparation.

### Starter Packs — limite one-time obligatoire

| Produit | SKU | Prix | Limite Xsolla obligatoire |
|---|---|---:|---|
| Starter Pack I | `seabyss_starter_pack_1` | 3,99 USD | `per_user.total = 1` |
| Starter Pack II | `seabyss_starter_pack_2` | 6,99 USD | `per_user.total = 1` |
| Starter Pack III | `seabyss_starter_pack_3` | 10,99 USD | `per_user.total = 1` |

Procédure Dashboard future :

1. Ouvrir le projet `310966`, puis le catalogue Store.
2. Rechercher le SKU exact ; ne jamais dupliquer ou renommer un SKU existant.
3. Vérifier type, prix USD et absence de promotion/override régional non approuvé.
4. Régler la limite d'achat par utilisateur à **1 au total** (`per_user.total = 1`). Une limite
   journalière ou une quantité maximale par commande n'est pas équivalente.
5. Relire la valeur via l'API de catalogue avec un compte de service en lecture seule si possible.
6. Conserver une capture/export horodaté des trois objets et leur identifiant Xsolla dans le ticket
   de changement. Masquer toute donnée personnelle ou credential.
7. Laisser les produits désactivés/non publiés jusqu'au go/no-go explicite.

Le backend doit rester la deuxième barrière one-time. La limite Dashboard réduit le risque, mais ne
remplace ni la réservation atomique, ni l'ownership PlayFab, ni la contrainte unique du ledger.

### Premium autonomes — créer seulement, ne pas activer

| Produit | SKU | Prix | Durée accordée | État demandé |
|---|---|---:|---:|---|
| Premium Bronze | `seabyss_premium_bronze` | 1,99 USD | 30 jours | désactivé/non publié |
| Premium Silver | `seabyss_premium_silver` | 3,99 USD | 30 jours | désactivé/non publié |
| Premium Gold | `seabyss_premium_gold` | 7,99 USD | 30 jours | désactivé/non publié |

Pour chaque Premium, vérifier le prix fixe USD et le SKU exact, puis conserver l'objet désactivé.
La durée est un contrat backend de 30 jours ; elle ne doit pas être dérivée d'un texte marketing ou
d'une valeur envoyée par le client. Ne pas confondre ces produits autonomes avec les durées Premium
incluses dans les Starter Packs (Bronze 1 jour, Silver 2 jours, Gold 7 jours).

## 2. Secrets et credentials

Secrets à gérer dans le coffre approuvé, jamais dans Git, un manifeste, un log, une capture ou une
ligne de commande conservée dans l'historique :

- clé secrète PlayFab serveur ;
- secret de signature du webhook Xsolla ;
- clé API Xsolla Production dédiée au projet `310966` ;
- credentials/ACL Redis et certificats TLS associés ;
- éventuel secret d'administration des outils paiements ;
- clés privées TLS du domaine public.

Règles :

1. Séparer strictement Sandbox et Production, avec clés, allowlists et droits différents.
2. Appliquer le moindre privilège. Une clé de vérification catalogue ne doit pas pouvoir publier ou
   rembourser ; une clé de runtime n'a aucun accès au dépôt ou au système de release.
3. Injecter les secrets uniquement depuis `/etc/seabyss/server-web-api.env`, monté en lecture seule
   pour le service. Ne pas afficher l'environnement complet avec `env`, `set` ou un diagnostic.
4. Journaliser seulement la présence/absence d'une configuration, jamais sa valeur. Expurger les
   tickets de session, tokens Pay Station, signatures et données personnelles.
5. Documenter propriétaire, portée, date de création, expiration et procédure de rotation dans le
   gestionnaire de secrets, pas dans ce dépôt.
6. Effectuer une rotation contrôlée avant Production, tester la nouvelle clé, puis révoquer
   l'ancienne. Révoquer immédiatement toute clé temporaire Sandbox devenue inutile.
7. Une fuite suspectée impose : fermeture des gates, révocation, rotation, audit des accès et des
   transactions, puis incident formel avant toute réouverture.

## 3. Gates et sélection du catalogue — valeurs sûres par défaut

Toutes les gates doivent être `false` après installation, rollback, reboot et déploiement. Une
valeur absente, invalide ou de casse différente doit être interprétée comme `false`.

| Paramètre | Valeur sûre actuelle | Rôle |
|---|---|---|
| client `ShopPurchaseGate.ShopPurchasesEnabled` | `false` | première barrière côté client |
| `PURCHASES_GLOBAL_ENABLED` | `false` | kill switch backend de tout checkout/grant payable |
| `PURCHASES_DIAMOND_ENABLED` | `false` | gate famille Diamond |
| `PURCHASES_STARTER_ENABLED` | `false` | gate famille Starter |
| `PURCHASES_PREMIUM_ENABLED` | `false` | gate famille Premium |
| `PURCHASES_DOUBLER_ENABLED` | `false` | gate famille Doubler |
| `XSOLLA_HARDENED_CATALOG_ENABLED` | `false` | processeur payable strict, obligatoire avant Production |
| `XSOLLA_CHECKOUT_MODE` | `sandbox` | mode serveur explicite ; ce n'est pas une autorisation |
| `XSOLLA_CHECKOUT_SANDBOX_ENABLED` | `false` | création de tokens Sandbox |
| `XSOLLA_CHECKOUT_PRODUCTION_ENABLED` | `false` | création de tokens Production |
| `XSOLLA_CHECKOUT_ALLOWED_SKUS` | vide | allowlist exacte des SKU pouvant recevoir un checkout |
| `XSOLLA_ALLOW_SANDBOX_GRANTS` | `false` | grants Sandbox Diamond/compatibilité historique |
| `XSOLLA_SANDBOX_TEST_PLAYFAB_IDS` | vide | allowlist Sandbox associée, jamais Production |
| `XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS` | `false` | grants Starter Sandbox |
| `XSOLLA_STARTER_SANDBOX_TEST_PLAYFAB_IDS` | vide | allowlist Starter Sandbox associée, jamais Production |
| `XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS` | `false` | grants Production des trois Starter |
| `XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS` | `false` | grants Production des trois Diamond |
| `XSOLLA_ENABLE_STANDALONE_PREMIUM_PRODUCTS` | `false` | Premium autonome legacy ; plans aussi `catalogEnabled:false` |

Les allowlists Sandbox restent vides en Production. Une gate familiale, une allowlist ou un SKU
autorisé ne peut jamais contourner la gate globale. Un checkout exige simultanément : gate client,
gate globale, gate famille, `catalogEnabled:true`, environnement autorisé, SKU présent dans
`XSOLLA_CHECKOUT_ALLOWED_SKUS` et gate checkout du mode courant. Les Premium sont définis mais non
achetables ; le Doubler demeure non achetable. Toute activation future est un changement séparé.

Une future allowlist Production ne contient que les SKU publiés et approuvés. Les six candidats
actuellement définis avec `catalogEnabled:true` sont exactement :

- `seabyss_starter_pack_1` ;
- `seabyss_starter_pack_2` ;
- `seabyss_starter_pack_3` ;
- `seabyss_diamond_pack_1` ;
- `seabyss_diamond_pack_2` ;
- `seabyss_diamond_pack_3`.

Les trois Premium ne sont pas ajoutés tant que leurs objets Xsolla n'existent pas et que leurs plans
restent `catalogEnabled:false`.

Contrôle non secret avant et après maintenance : comparer les noms de gates à la matrice approuvée
sans imprimer le fichier d'environnement. Si l'outil d'exploitation ne peut pas masquer les valeurs
sensibles voisines, ne pas utiliser de dump global : vérifier chaque booléen explicitement.

## 4. Release immuable et permissions hôte

Layout cible :

```text
/opt/seabyss/releases/<release-id>/server-web-api   root:root
/opt/seabyss/current                                symlink atomique root-owned
/etc/seabyss/server-web-api.env                     root:seabyss 0640
/var/lib/seabyss/payments                           seabyss:seabyss, état mutable seulement
/var/log/seabyss                                    journald ou seabyss:seabyss
```

Exigences :

- répertoires de release : propriétaire `root:root`, mode `0755` ;
- fichiers de release : propriétaire `root:root`, mode `0644` ;
- environnement : `root:seabyss`, mode `0640` ;
- processus : utilisateur non privilégié `seabyss`, sources et configuration en lecture seule ;
- seules les zones explicitement mutables sont accessibles en écriture ;
- le runtime ne modifie jamais sources, lockfile, manifestes, checksums ou symlink courant ;
- service durci au minimum avec `NoNewPrivileges=true`, `PrivateTmp=true`,
  `ProtectSystem=strict`, `ProtectHome=true` et `ReadWritePaths` borné.

Préparer les permissions hors ligne dans le nouvel arbre, puis vérifier qu'un processus lancé comme
`seabyss` ne peut écrire ni dans `src`, ni dans le manifeste, ni dans l'environnement. Ne jamais
corriger les droits récursivement sur `/opt`, `/etc` ou une variable de chemin non résolue.

## 5. Manifeste, checksums et rollback

Chaque release possède un manifeste signé ou approuvé contenant au minimum :

- identifiant de release, commit source revu et heure UTC de construction ;
- versions Node/npm et plateforme ;
- hash du lockfile et inventaire des dépendances ;
- SHA-256 de chaque fichier déployé, hors secrets ;
- version du schéma ledger/reçus et hashes des plans économiques/rewards ;
- résultats des tests et identifiant de l'artefact ;
- release précédente autorisée pour rollback.

Avant bascule, recalculer les SHA-256 depuis l'artefact reçu et comparer au manifeste. Toute
différence est un no-go. Ne jamais inclure `.env`, clés, tokens ou dumps Redis dans l'artefact.

Bascule future : installer dans un nouveau dossier, vérifier, puis remplacer atomiquement le
symlink `/opt/seabyss/current`. Ne jamais éditer la release courante en place.

Rollback :

1. Fermer toutes les gates et arrêter les nouveaux checkouts.
2. Laisser finir les workers ou attendre les leases ; relever les transactions `Processing`.
3. Vérifier la compatibilité du ledger et des receipts avec la release précédente. Les données
   financières ne sont jamais restaurées vers un état plus ancien pour « annuler » un déploiement.
4. Rebasculer atomiquement vers l'artefact précédent déjà vérifié.
5. Redémarrer le service dans la fenêtre approuvée, contrôler liveness/readiness, scanners et logs.
6. Garder les achats OFF et ouvrir un incident si une transaction reste ambiguë.

## 6. Redis et maintenance OS

Redis Production doit être privé/authentifié, persistant et sans éviction des preuves financières.
Utiliser AOF avec politique fsync approuvée, snapshots RDB chiffrés et sauvegardes hors hôte.
Surveiller erreurs de persistance, mémoire, politique d'éviction, réplication, latence et disque.
Ne jamais purger automatiquement receipts, indexes, audit trail, leases ou clés d'idempotence.

### Avant maintenance

1. Obtenir une fenêtre et un plan de retour approuvés.
2. Confirmer sauvegardes récentes de Redis et de la configuration chiffrée.
3. Restaurer la sauvegarde sur un hôte isolé ; vérifier nombre de clés, indexes, quelques receipts,
   transactions/checkpoints et cohérence AOF/RDB sans exposer d'identifiants dans le rapport.
4. Capturer versions OS/kernel/Redis, synchronisation UTC, espace disque, mémoire, réplication,
   statut AOF/RDB, scanners paiements et readiness.
5. Confirmer toutes les gates OFF. Attendre la fin des workers et relever toute lease active ou
   transaction `Pending`/`Processing`/`Quarantined`.

### Mise à jour et reboot

Mettre à jour une couche à la fois selon le chemin supporté. Ne pas combiner mise à jour OS/Redis,
migration de schéma et activation commerciale. Le reboot exige une approbation distincte.

Après reboot, vérifier dans cet ordre : heure/NTP, montages et espace disque, propriétaires/modes,
chargement AOF/RDB, absence d'éviction, réplication, service non privilégié, liveness, readiness,
worker, scanners et logs. Garder les achats OFF durant toute l'observation.

## 7. Monitoring et alertes initiales

Les métriques utilisent des labels à faible cardinalité. Ne jamais mettre PlayFabId, order ID,
transaction ID, receipt ID, token ou signature dans les labels. Les événements structurés peuvent
référencer un identifiant haché/corrélé selon la politique de confidentialité.

État local actuel : `/health/live` et `/health/ready` sont exposés. La readiness vérifie le ledger,
Redis, la présence de configuration PlayFab, le blocker du worker offline et le dernier rapport du
scanner planifié toutes les 60 secondes ; elle passe rouge sur erreur ou scan tronqué. Le probe
PlayFab reste toutefois un contrôle de configuration, pas un appel non mutant réel. Les compteurs
sont en mémoire et ne sont pas encore exportés ; l'évaluateur d'alertes n'est pas branché à une
astreinte. Ces limites interdisent l'activation même si la liveness et les scanners sont verts.

| Signal | Seuil initial | Sévérité |
|---|---:|---|
| signature webhook invalide | 10 en 5 min | critique |
| Redis, ledger ou PlayFab indisponible | 1 échec de readiness | critique |
| transaction `Quarantined` | > 0 | critique |
| Starter payé en doublon | > 0 | critique |
| incohérence de réconciliation | > 0 | critique |
| `Pending` depuis plus de 15 min | > 0 | avertissement |
| lease expirée | > 0 | avertissement |
| reversal non résolu | > 0 | avertissement |
| worker actif depuis plus de 120 s | 1 | critique |
| erreur webhook 5xx | > 1 % sur 5 min ou 3 consécutives | critique |
| latence webhook p95 | > 2 s sur 10 min | avertissement |
| certificat TLS public | expiration à 30 j / 14 j | avertissement / critique |
| sauvegarde Redis vérifiée | aucune depuis 24 h | critique |

Tester le routage des alertes avant ouverture : astreinte primaire, secondaire et canal incident.
Les alertes critiques ne doivent pas dépendre du même hôte que l'API. Vérifier chaque jour la date
d'expiration du certificat et tester le renouvellement au moins 45 jours avant échéance ; valider la
chaîne complète, le nom d'hôte, OCSP/CRL selon la politique et le rechargement sans perte de webhook.
Aucun renouvellement ne doit réactiver une gate.

## 8. Procédure future de déploiement et smoke, sans achat réel

Cette procédure ne peut être exécutée qu'en fenêtre approuvée. Elle ne comporte aucun paiement.

1. **Préflight** — relire ticket, approbations, release/rollback, manifeste, checksums, sauvegarde
   restaurée, capacité disque, certificats et matrice des gates. Toutes les gates restent OFF.
2. **Drain** — empêcher les nouveaux checkouts, attendre les workers/leasing, sauvegarder le relevé
   des transactions non terminales et des scanners.
3. **Installer** — déposer l'artefact dans un nouveau répertoire immuable, appliquer les permissions
   exactes et prouver que l'utilisateur runtime ne peut écrire les sources.
4. **Basculer** — changer atomiquement le symlink, puis redémarrer uniquement le service autorisé.
5. **Santé** — vérifier liveness locale, readiness Redis/ledger, véritable probe PlayFab non mutant,
   statut du worker de grant, scanner planifié, logs structurés, métriques exportées et réception des
   alertes de test. La readiness actuelle ne fournit pas encore toutes ces garanties d'activation.
6. **Smoke API non financier** — vérifier `/health`, authentification de session avec un compte de
   test autorisé et réponses fail-closed du checkout puisque la gate globale est OFF. Le test doit
   prouver qu'aucun appel Xsolla créateur de token et aucun grant n'a lieu.
7. **Smoke webhook non financier** — utiliser des fixtures locales signées et des doublons rejoués
   contre l'environnement de test isolé. En Production, se limiter au type non financier approuvé
   (par exemple validation utilisateur) si Xsolla l'exige ; aucun événement `payment` réel/simulé
   ne doit pouvoir accorder une reward tant que les gates sont OFF.
8. **Observation** — surveiller au minimum 30 minutes : readiness, erreurs, latence, Redis, workers,
   scanners et certificats. Toute anomalie déclenche le rollback, toujours avec gates OFF.
9. **Clôture** — joindre hashes, résultats, état des gates et preuves expurgées au ticket. Une
   activation commerciale ultérieure est un changement séparé avec approbation explicite.

Interdits pendant ce smoke : ouvrir Pay Station, générer une commande Production, utiliser une carte,
payer même un petit montant, rejouer un vrai événement payé, modifier manuellement un profil ou
effacer une preuve financière.

## 9. Actions restantes avant tout go-live

Ce document ne réalise aucune de ces actions :

### Intégration logicielle encore bloquante

- brancher un worker offline persistant et son scheduler sur les transactions `Pending`/`Failed` ;
- implémenter l'adaptateur PlayFab réel de CAS/idempotence/fencing, puis faire du grant profil un
  checkpoint distinct avant de considérer une transaction `Completed` ;
- monter les commandes lookup/retry derrière une authentification et une autorisation opérateur
  strictes, un rate limit et un audit append-only durable ;
- exporter les métriques vers le collecteur retenu, brancher l'évaluateur d'alertes et tester
  l'astreinte ;
- remplacer le contrôle PlayFab de configuration par un probe non mutant borné et intégrer la santé
  du worker réel à la readiness.

Le ledger est déjà branché à la création des receipts Starter/Diamond durcis, les scanners ont leur
intervalle de 60 secondes avec cache, et `/health/live` plus `/health/ready` existent. Ces éléments ne
sont donc plus des TODO ; ils ne compensent pas les blockers worker/CAS/export/admin ci-dessus.
Après le checkpoint durable `receipt_persisted`, le processeur de receipt remet explicitement la
transaction en `Pending` avec le statut `checkpoints_pending`; seul le futur worker de profil pourra
la marquer `Completed` après tous les grants.

### Actions Dashboard, infrastructure et exploitation

- configurer et relire dans le Dashboard Xsolla `per_user.total = 1` pour les trois Starter Packs ;
- créer/vérifier Bronze, Silver et Gold aux SKU/prix/durée ci-dessus en les laissant désactivés ;
- confirmer les six prix USD, absence de promotion et projet `310966` par export/API Xsolla ;
- créer/rotater les secrets Production dans le coffre et révoquer les credentials temporaires ;
- établir les fichiers d'environnement Production avec toutes les gates OFF et allowlists vides ;
- construire, signer, vérifier et approuver un artefact immuable depuis un commit propre ;
- appliquer les propriétaires/modes et le sandbox systemd sur l'hôte ;
- configurer Redis Production persistant, privé, sans éviction, puis réussir un restore drill ;
- brancher métriques/alertes/astreinte et tester le renouvellement TLS ;
- exécuter les tests multi-instance, crash/retry, réconciliation et rollback en Sandbox isolée ;
- approuver puis exécuter la fenêtre de déploiement, reboot éventuel et smoke non financier ;
- obtenir un go/no-go écrit distinct avant toute activation de gate ou transaction Production.

État sûr attendu à la fin de chaque étape : service sain ou rollbacké, toutes les gates `false`, aucun
checkout réel, aucun paiement, aucun grant manuel et aucune modification de preuve durable.
