# Seabyss — Portail de jeux navigateur

Seabyss est le portail du studio : catalogue de jeux, recherche, filtres, tri, favoris locaux et lecteur intégré avec ouverture dans un onglet. La direction visuelle pirate magique associe un noir profond, un navire fantôme, de l’or ancien et des lueurs vert spectral. Une brume mouvante et quelques particules lumineuses donnent vie au décor. L’accueil présente trois découvertes, puis le catalogue regroupe les quatre jeux d’aventure, stratégie et simulation avant Les sept machines de casino fictif. La recherche, les favoris et les tris affichent une liste globale sans regroupement.

Les deux bannières sont des illustrations décoratives générées pour le studio : un navire devant un portail abyssal et une salle au trésor. Les quatre jeux hors casino utilisent des captures de gameplay existantes, optimisées en WebP. Les sept machines utilisent leurs décors et personnages authentiques, avec un titre de couverture lisible ; ces cartes portent la mention « Illustration ». Les images ne sont plus désaturées ni assombries par un filtre global. Les polices Cormorant Garamond et Manrope sont servies localement ; leurs licences sont conservées dans `assets/fonts/`. Les commandes du lecteur restent accessibles au-dessus du jeu, et les cartes passent sur une colonne sur les petits écrans.

Les animations décoratives sont réalisées en CSS, sans bibliothèque ni boucle JavaScript. Le bouton d’ambiance mémorise un choix local sous `seabyss.motion.v1`. Les effets se mettent en pause hors écran, dans un onglet masqué et pendant la lecture d’un jeu. La préférence système de réduction des mouvements reste prioritaire ; le contenu reste accessible sans effets.

## Hébergement

Le catalogue comprend aussi Les sept machines de Seabyss Casino : Le Trésor des Abysses, Le Pacte de Minuit, SUPERNOVA, Le Jardin Sauvage, Monstres & Merveilles Le Trône du Dragon et Jungle Félins. Elles sont regroupées sous `games/seabyss-casino/`, avec leur hall et leur portefeuille fictif partagé. Les fichiers d’exécution proviennent de `C:\KRUEGER\Main Folder\Seabyss Game\Seabyss Casino` ; les tests et le serveur local ne sont pas publiés. Les crédits publics et les licences audio accompagnent les actifs. Les polices du casino sont chargées depuis Google Fonts.

Site statique HTML/CSS/JavaScript publié par GitHub Pages depuis la branche `main`. Le fichier `CNAME` conserve `www.seabyss.com`. Aucun serveur applicatif ni étape de compilation n’est nécessaire pour le portail ou les onze jeux actuels. Une modification publiée sur `main` déclenche le déploiement Pages ; vérifier le résultat dans les actions GitHub avant de considérer une publication terminée.

Pour prévisualiser le catalogue, servir la racine avec un serveur HTTP statique, puis ouvrir son adresse locale. L’ouverture directe de `index.html` avec `file://` ne suffit pas au chargement de `data/games.json`.

Castle War est publié sous `games/castle-war/` depuis les huit fichiers d’exécution de son dossier source. Son lien d’accueil est adapté au portail. Le jeu s’ouvre dans un onglet pour garder tout le terrain et ses commandes visibles. Le casino utilise les copies WebP produites par le script de construction du projet source ; les illustrations originales sont préservées.

## Fichiers principaux

- `index.html` : accueil, filtres, catalogue et lecteur.
- `css/style.css` : présentation du portail et de la confidentialité.
- `js/catalog.js` : chargement du catalogue et interactions.
- `js/atmosphere.js` : préférences d’animation et pauses automatiques.
- `data/games.json` : liste éditoriale des jeux réellement jouables.
- `games/<identifiant>/index.html` : entrée de chaque jeu intégré.
- `privacy.html` : informations sur le stockage local et l’hébergement.

## Ajouter ou mettre à jour un jeu

1. Préparer une version navigateur fonctionnelle. Copier uniquement ses fichiers d’exécution et les actifs nécessaires dans `games/<identifiant>/`, en conservant leurs chemins relatifs et les licences. Ne pas publier de sauvegardes personnelles, secrets, fichiers d’environnement, archives de versions, tests, captures de vérification ou prompts de création.
2. Tester l’entrée `games/<identifiant>/index.html` depuis le serveur HTTP.
3. Ajouter un objet à la liste JSON de `data/games.json`, ou mettre à jour son objet existant. Conserver un `id` stable : il sert à retrouver le jeu dans les favoris.
4. Vérifier la carte, les filtres, le lecteur et l’ouverture dans un onglet avant publication.

Exemple fondé sur un jeu effectivement intégré, à adapter sans créer de doublon dans le catalogue :

```json
{
  "id": "petits-compagnons",
  "title": "Petits Compagnons",
  "description": "Adopte un compagnon, prends soin de lui et découvre trois mini-jeux dans ton jardin.",
  "genre": "simulation",
  "tags": ["Animaux", "Détente"],
  "thumbnail": "assets/images/covers/petits-compagnons.webp",
  "coverKind": "gameplay",
  "rank": 4,
  "url": "games/petits-compagnons/index.html",
  "controls": ["Souris ou toucher", "Flèches et Espace dans certains mini-jeux"],
  "featured": true,
  "embed": true
}
```

Le fichier complet doit être un tableau JSON, même s’il ne contient qu’un jeu. Les champs acceptés sont :

| Champ | Format et usage |
| --- | --- |
| `id` | Chaîne non vide et unique ; obligatoire. |
| `title` | Titre réel non vide ; obligatoire. |
| `url` | Entrée jouable ; obligatoire. Chemin relatif du site ou URL HTTPS. |
| `description` | Courte description fidèle au jeu ; chaîne facultative. |
| `genre` | `action`, `adventure`, `arcade`, `puzzle`, `strategy` `simulation` ou `casino`. Une valeur absente ou inconnue est classée `arcade`. |
| `tags` | Tableau facultatif de chaînes, utilisé notamment par la recherche. |
| `thumbnail` | Chemin ou URL HTTPS d’une image autorisée ; facultatif. |
| `coverKind` | `gameplay` pour une capture réelle, `artwork` pour une couverture illustrée. |
| `coverLabel` | Courte accroche au-dessus du titre dans une couverture illustrée. |
| `coverCharacter` | Image transparente du personnage, chemin local ou HTTPS ; facultatif. |
| `coverSprite` | Sprite existant `flowers` ou `monsters`, affiché depuis son atlas ; facultatif. |
| `rank` | Nombre déterminant l’ordre éditorial dans La sélection ; 100 par défaut. |
| `controls` | Chaîne ou tableau de chaînes décrivant les commandes. |
| `releaseDate` | Date de publication au catalogue au format ISO `AAAA-MM-JJ`, facultative ; sert au tri des nouveautés. Les trois jeux initiaux ont été ajoutés le 1er novembre 2026. |
| `featured` | Booléen ; `true` met le jeu en avant dans la sélection. |
| `embed` | Booléen, `true` par défaut. Utiliser `false` si le jeu doit s’ouvrir dans un onglet au lieu du lecteur. |

Pour un jeu externe, vérifier que son propriétaire autorise l’intégration, que son adresse est en HTTPS et que ses réglages permettent l’affichage dans une iframe. Mettre à jour la confidentialité si un nouvel hébergeur, une collecte de données ou un service tiers est ajouté. Les jeux actuels sont hébergés avec le portail.

## Versions intégrées et sauvegardes

Les dossiers de jeux sont des copies de publication des projets locaux, avec leurs fichiers HTML/CSS/JavaScript et leurs ressources ; ils ne modifient pas les dossiers de travail originaux. Aucun moteur Unity ou Godot ni export supplémentaire n’est requis pour ces versions.

- `petits-compagnons` : Petits Compagnons, avec musique et bruitages locaux ; crédits et licences audio conservés.
- `marios-ghost` : Mario’s Ghost — Les cinq sceaux de minuit, version 5.
- `les-heures-perdues` : Les Heures Perdues — Le Testament de l’astronome, version 1.4 ; licences des polices conservées.

Les favoris utilisent `seabyss.favoriteGames.v1` dans localStorage. Les sauvegardes des jeux utilisent des clés distinctes : `petits-compagnons-v1`, `marios-ghost-adventure-v1` et `les-heures-perdues-v1`. Ce stockage dépend de l’origine (protocole, domaine et port) et du navigateur. Une partie ouverte auparavant depuis un fichier local ne migre pas automatiquement vers le site, et un changement de domaine ou de port peut donner l’impression d’une partie vide. Ne pas effacer les données d’un navigateur existant pour effectuer les tests ; utiliser un profil séparé.

## Compatibilité de l’ancien site

Les anciens écrans compte, connexion, inscription, profil, téléchargement, boutique et support redirigent vers le catalogue. La page de confidentialité décrit le nouveau portail. Le nouveau front ne charge pas les anciens scripts d’authentification ni l’API du MMO.

`launcher/` et ses manifests signés restent disponibles à leurs adresses historiques pour les installations existantes, hors navigation du catalogue. Ne pas déplacer, renommer ou modifier les manifests et leurs signatures lors d’une mise à jour éditoriale.

`server-web-api/`, `deploy/` et les documents de déploiement historiques restent dans le dépôt pour compatibilité et maintenance. L’API externe et les données du jeu sont distinctes du portail statique ; une publication du catalogue ne les désactive pas. Leur présence ne signifie pas qu’il faut lancer le backend pour servir le catalogue. Préserver également les anciennes ressources nécessaires à ces éléments tant que leur migration n’est pas organisée.

## Vérifications manuelles avant publication

- Sur ordinateur et sur mobile : vérifier les cartes, les images, l’absence de débordement et la navigation au clavier.
- Rechercher un titre et un mot de description, changer de catégorie, trier et réinitialiser une recherche sans résultat.
- Ajouter puis retirer un favori ; recharger la page et vérifier sa conservation dans le même navigateur.
- Ouvrir chaque jeu dans le lecteur, cliquer sur Lancer, utiliser ses commandes et tester l’ouverture dans un onglet. Tester le plein écran lorsque le navigateur le permet.
- Fermer le lecteur et vérifier l’arrêt de l’audio ; vérifier que le focus revient au catalogue.
- Dans un profil de test, avancer dans chaque jeu puis recharger pour vérifier sa sauvegarde. Garder les parties réelles à l’écart des tests.
- Vérifier la page de confidentialité et les anciennes adresses HTML : elles doivent ramener au catalogue sans proposer les anciens écrans MMO.
- Vérifier dans les outils réseau du navigateur l’absence d’actifs manquants et d’appels à l’ancienne API depuis le portail.
- Après publication, confirmer le succès du déploiement GitHub Pages, l’accès au domaine et la disponibilité inchangée des manifests historiques.
