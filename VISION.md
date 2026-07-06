# Vision du projet : Ping-Pong Scorer Automatique

**Contexte**

Un lanceur de balle de ping-pong Butterfly Amicus Prime est utilisé pour faire jouer des enfants. On veut construire un système qui compte et annonce les points automatiquement, en temps réel, sans intervention humaine.

**Règles du jeu**

Le lanceur envoie des balles aux enfants qui doivent les renvoyer avec une raquette :
- **1 point** si l'enfant renvoie la balle et qu'elle atterrit dans le filet du lanceur (peu importe si elle a touché la table avant ou pas)
- **3 points** si en plus la balle touche la table de l'autre côté du filet avant d'atterrir dans le filet du lanceur (renvoi "propre", comme un vrai point de ping-pong)

**Architecture cible**

1. **Pilotage du robot en Bluetooth Low Energy (Web Bluetooth API)** — l'application web devient le client BLE unique du robot (device "Amicus BTLE"), remplaçant l'app officielle Butterfly. Ça permet de :
   - Déclencher précisément chaque lancer de balle (donc connaître le "top départ" sans ambiguïté)
   - Gérer le cycle de vie complet d'une partie (démarrage, pause, fréquence adaptée au niveau de l'enfant, relance automatique après un point)

2. **Vision par ordinateur (caméra + OpenCV.js/MediaPipe en WASM dans le navigateur)** — détecte les événements côté joueur, armée uniquement dans une fenêtre de temps courte après chaque déclenchement BLE (pour limiter les faux positifs dus au bruit visuel : balles au sol, mouvement des enfants, etc.) :
   - Contact raquette (changement brutal de direction/vitesse de la balle)
   - Rebond sur la table adverse (changement brutal de vélocité verticale dans le polygone de la table)
   - Entrée dans le filet du lanceur (balle atteint le polygone du filet et s'arrête)

   Calibration manuelle une fois : l'utilisateur délimite les polygones (table, filet, zone de jeu) à la souris.

3. **State machine de jeu** — combine les événements BLE (balle lancée) et vision (contact / rebond / filet) pour déterminer et calculer le score de chaque échange par joueur.

4. **UI + annonce vocale** — overlay vidéo affichant le score en temps réel, annonce des points via Web Speech API (`speechSynthesis`).

**Stack technique retenue**

100% web (PWA/artifact), pas de backend nécessaire :
- Web Bluetooth API pour le contrôle du robot
- OpenCV.js / MediaPipe (WASM) pour la vision
- Web Speech API pour le TTS
- `getUserMedia` pour le flux caméra (limite de perf probable : framerate webcam ~30-60fps, pas le calcul)

**Contrainte connue sur le robot** : une seule connexion BLE possible à la fois — une fois que notre app pilote le robot, l'app officielle Butterfly ne peut plus s'y connecter en parallèle (ce qui est acceptable puisqu'on ne compte de toute façon plus l'utiliser).

## État d'avancement

- ✅ **Protocole BLE du robot** : entièrement reverse-engineered (capture HCI + décompilation de
  l'app officielle + validation empirique) — voir [`PROTOCOL.md`](PROTOCOL.md). Ce qui était le
  "prérequis technique bloquant" ci-dessus est donc résolu : `protocol.js`/`robot.js` pilotent
  déjà le robot en Web Bluetooth (démarrer/arrêter le lanceur, régler la cadence, cibler une
  position de balle, exercices en alternance).
- ✅ **Pilotage vocal du robot** (`app.js`/`llm.js`/`voice.js`) : premier cas d'usage construit sur
  cette base BLE — contrôler le robot à la voix pendant l'entraînement ("plus vite", "stop",
  "envoie un coup droit"...). Voir [`PROJECT_VOICE_APP.md`](PROJECT_VOICE_APP.md) pour le détail.
  C'est une brique utile en soi, et une validation en conditions réelles du pilotage BLE avant
  d'attaquer la vision par ordinateur.
- ⬜ **Vision par ordinateur** (détection contact raquette / rebond table / entrée filet) : pas
  commencé.
- ⬜ **State machine de score** (1 pt / 3 pts) : pas commencée.
- ⬜ **UI overlay + annonce vocale du score** : la synthèse vocale existe déjà côté pilotage vocal
  (`voice.js`), réutilisable ici.
