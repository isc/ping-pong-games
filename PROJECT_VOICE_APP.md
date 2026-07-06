# Projet : interface vocale pour robot de ping-pong Amicus

## Objectif

Une web app minimaliste, **sans aucun bouton ni écran à regarder pendant le jeu** : elle écoute en continu au micro et pilote le robot Butterfly Amicus Prime en Bluetooth (Web Bluetooth) à la voix, pour qu'on puisse s'entraîner seul sans interrompre le jeu pour toucher un écran.

Le protocole BLE du robot est déjà entièrement décodé dans [`PROTOCOL.md`](./PROTOCOL.md) (service/caractéristique GATT, format de trame, commandes StartPlay/StopPlay/SetBallPerMin/SetAllBalls/SetGlobalCycle/StartClusterMemoryPlay, notifications PlayingBall/AmicusMode).

## Commandes vocales à reconnaître

| Commande dite | Effet attendu | Commande BLE (déjà décodée) | Confiance |
|---|---|---|---|
| "stop" | Arrête le lancer de balles immédiatement | `StopPlay` (`0x21`) | Haute |
| "reprends" | Relance l'exercice en cours | `StartPlay` (`0x20`, mode NORMAL) | Haute |
| "plus vite" | Augmente le rythme/la vitesse | à préciser : `SetBallPerMin` (cadence, `0x22`) et/ou champ `speed` par balle dans `SetAllBalls` | À trancher |
| "moins vite" | Diminue le rythme/la vitesse | idem, en sens inverse | À trancher |
| "des coups droits" | Envoie des balles côté coup droit | upload `SetAllBalls` avec un pattern coup droit (placement à construire) | À construire/calibrer |
| "des revers à gauche" | Envoie des balles en revers, zone gauche | upload `SetAllBalls`, placement gauche | À construire/calibrer |
| "des revers à droite" | Envoie des balles en revers, zone droite | upload `SetAllBalls`, placement droite | À construire/calibrer |
| "des revers au milieu" | Envoie des balles en revers, zone centrale | upload `SetAllBalls`, placement centre | À construire/calibrer |

## Architecture technique envisagée

- **Reconnaissance vocale** : Web Speech API (`SpeechRecognition`, `continuous: true`, `lang: 'fr-FR'`), écoute permanente pendant que la page est ouverte, pas d'interaction bouton.
- **Interprétation des commandes** : correspondance simple par mots-clés au départ (pas besoin de NLU complexe vu le nombre limité de commandes) ; prévoir des variantes/synonymes probables ("stoppe", "arrête", "vas-y", "continue", etc.) et un minimum de tolérance au bruit de reconnaissance.
- **Pilotage du robot** : Web Bluetooth (`navigator.bluetooth`), connexion au service `a7bdef44-...`, écriture/écoute de la caractéristique `a7bdf2aa-...` selon `PROTOCOL.md`.
- **Retour utilisateur** : pas d'écran à regarder pendant le jeu → un retour **sonore** (bip, ou synthèse vocale courte type "OK", "vitesse augmentée") est probablement préférable à un retour visuel, pour rester cohérent avec le principe "mains libres / yeux libres".

## Inconnues à lever avant de coder les commandes de placement

Ces points ont été identifiés en décodant le protocole mais pas encore vérifiés empiriquement :

1. **"plus vite" / "moins vite" agit sur quoi ?** La cadence (balles/minute, `SetBallPerMin`) ou la vitesse de la balle (champ `speed` par balle, 0-24) ? Peut-être les deux à la fois selon le sens naturel voulu. À décider (question produit, pas juste technique).
2. **Comment coder "coup droit" vs "revers gauche/droite/milieu" en `place`/`sector`** dans le descripteur de balle `SetAllBalls`. La formule d'encodage (moyenne/écart sur un octet) est connue, mais la correspondance avec la position réelle sur la table reste à calibrer en envoyant des programmes de test et en observant où tombent les balles.
3. Le robot a 10 "cluster memory" préenregistrés (`StartClusterMemoryPlay`, `0x29`) — aucune app ne les nomme "coup droit"/"revers" dans le code décompilé, donc il n'y a probablement pas de raccourci tout fait : il faudra construire nos propres programmes `SetAllBalls` plutôt que de nous appuyer sur des presets existants (sauf si on découvre empiriquement que l'un des 10 clusters correspond à un pattern utile).

## Prochaine étape proposée

Avant d'attaquer l'interface vocale elle-même, faire un petit script de test Web Bluetooth pour calibrer `place`/`sector` (envoyer quelques valeurs, observer où tombe la balle), ce qui débloquera les commandes de placement ("coup droit", "revers gauche/droite/milieu"). Le "stop"/"reprends" et la cadence peuvent être branchés dès maintenant, ils ne dépendent d'aucune inconnue.
