# Publication Beta Seabyss

Ce document fixe la convention officielle a utiliser pour publier les mises a jour Beta du client Seabyss.

## Convention officielle

Pour les versions Beta, garder le format suivant partout :

```text
0.1.7-beta.X
```

Exemples valides :

```text
0.1.7-beta.8
0.1.7-beta.9
0.1.7-beta.10
```

Ne pas utiliser le format `beta-0.1` comme valeur de `gameVersion` dans le manifest du launcher.

## Pourquoi

Le launcher actuel compare mieux les versions au format :

```text
0.1.7-beta.X
```

Le format `beta-0.1` peut empecher le launcher de detecter correctement une mise a jour.

## Champs a garder coherents

Pour chaque publication Beta, ces trois elements doivent utiliser le meme numero :

```text
gameVersion: 0.1.7-beta.X
GitHub Release tag: 0.1.7-beta.X
ZIP client: SeabyssClient-Beta-0.1.7-beta.X.zip
```

Exemple pour `0.1.7-beta.9` :

```text
gameVersion = 0.1.7-beta.9
GitHub Release tag = 0.1.7-beta.9
ZIP client = SeabyssClient-Beta-0.1.7-beta.9.zip
```

## Regle de bump

Chaque update du launcher ou du client qui doit etre detectee par le launcher doit incrementer le dernier numero.

La prochaine version apres :

```text
0.1.7-beta.8
```

sera :

```text
0.1.7-beta.9
```

Puis :

```text
0.1.7-beta.10
```

## Manifest launcher

Le manifest public est :

```text
launcher/seabyss_manifest.json
```

Lors d'une publication Beta, mettre a jour au minimum :

```text
gameVersion
downloadUrl
notes
```

Garder `exePath` et `launchArguments` coherents avec la Beta courante, sauf demande explicite contraire.

