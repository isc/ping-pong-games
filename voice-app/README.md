# Amicus — controle vocal (prototype)

Petit projet intermediaire : page web qui ecoute le micro en continu (Web Speech API), envoie
la transcription a un LLM auto-heberge (serveur Charras, Ollama) pour interpreter la commande
en langage naturel, puis pilote le robot Amicus en Web Bluetooth. Voir [`../PROTOCOL.md`](../PROTOCOL.md)
pour le detail du protocole BLE decode, et [`../PROJECT_VOICE_APP.md`](../PROJECT_VOICE_APP.md)
pour le contexte produit.

## Lancer

Necessite Chrome ou Edge (Web Speech API + Web Bluetooth), servi en **http://localhost** ou en
**https** (obligatoire pour le micro et le Bluetooth — `file://` ne fonctionne pas) :

```bash
cd voice-app
python3 -m http.server 8000
# puis ouvrir http://localhost:8000 dans Chrome
```

1. Renseigner l'URL du serveur Charras si besoin (par defaut l'IP Tailscale `100.72.204.126:11434`,
   utilisable "from anywhere" per la doc `home-infra`; utiliser l'IP LAN si sur le meme reseau).
2. Cliquer **"Connecter le robot"** (necessite un geste utilisateur, exigence du navigateur) et
   choisir "Amicus BTLE" dans la popup de pairing.
3. Cliquer **"Demarrer l'ecoute"**. Ensuite tout se fait a la voix : "plus vite", "moins vite",
   "stop", "reprends", "des coups droits", "des revers a gauche/droite/au milieu".

## Point d'attention : CORS sur le serveur Charras

Le navigateur va faire des requetes cross-origin vers `http://<charras>:11434`. Si Ollama bloque
(erreur CORS dans la console), il faut autoriser l'origine sur le conteneur Ollama du serveur
(variable d'environnement `OLLAMA_ORIGINS`, ex. `*` ou l'origine exacte de la page), puis redemarrer
le conteneur. Pas fait automatiquement ici — a valider/configurer sur Charras si besoin.

## Ce qui est solide vs. ce qui est a calibrer

- **Solide** (protocole verifie par code + capture BLE reelle) : connexion BLE, StartPlay, StopPlay,
  SetBallPerMin/GetBallPerMin (cadence en balles/minute, valeur litterale), SetBallProperties/
  StartSample (tir d'une balle isolee sans toucher a l'exercice enregistre), et la formule de `place`
  (`placeAppToWire` dans `protocol.js` : -8..+8 cote app -> 0..16 cote fil, confirmee le 2026-07-06
  en capturant les 3 octets reels pour place=-8/0/+8).
- **A trancher (choix produit, pas technique)** : la correspondance exacte entre "revers a
  gauche/droite" et une valeur `place` -8..+8 (`ZONES` en haut de `app.js`). Seuls les points
  extremes (-8, +8) et le centre neutre (0, cle `center`) sont sans ambiguite d'apres le manuel
  utilisateur ; le decoupage fin de "revers gauche/droite" (`backhand_left`/`backhand_right`) reste une
  hypothese a valider avec l'usage reel. Voir aussi le pas de cadence (`SPEED_STEP`) et les bornes
  (`SPEED_MIN`/`SPEED_MAX`), choisies arbitrairement.
- **Bug corrige (2026-07-06, teste avec Charly)** : `sendShot()` retombait sur un tir extreme coup
  droit des que `shot_type` n'etait pas exactement `"backhand"`, ignorant totalement `zone` -- donc
  `{shot_type:null, zone:"center"}` (que le LLM produit couramment) envoyait le contraire du centre.
  `resolveZoneKey()` priorise desormais `zone`, avec une vraie entree `center` independante de
  forehand/backhand. Egalement corrige : collision BLE ("GATT operation already in progress") entre
  le keep-alive et une commande vocale simultanee -- toutes les ecritures passent maintenant par une
  file d'attente serialisee dans `robot.js`.
- **Corrige (2026-07-06, suite a la session Charly)** : le LLM renvoie desormais un **tableau
  d'actions** (`{actions:[...], question, say}` dans `llm.js`) au lieu d'une action unique -- une
  phrase composee ("remets au milieu et ralentis et relance") execute maintenant les 3 actions dans
  l'ordre au lieu d'en perdre 2 silencieusement. Nouvelle action `"pattern"` : un exercice en
  alternance ("une balle a gauche, une a droite" en boucle) charge un vrai programme multi-balles via
  `robot.setAllBalls()` puis `StartPlay` (2 a 10 positions, cf. `sendPattern()` dans `app.js`) --
  confirme par capture reelle que le robot boucle nativement entre les positions actives.
- **Pas encore capture** : `speed`/`spin`/`sideSpin`/`trajectoryLow`/`trajectoryHigh` dans
  `DEFAULT_SHOT_PARAMS` sont les valeurs fil reellement observees pendant le test de calibration
  (donc plausibles), mais leur echelle app correspondante (speed 1-25, spin -5..+7, cf. PROTOCOL.md)
  n'a pas ete capturee point par point comme `place` — a faire de la meme facon si besoin de varier
  vitesse/effet a la voix plus tard.
- **"reprends" + keep-alive** : `StartPlay(NORMAL)` boucle nativement sur le robot, MAIS seulement si
  un heartbeat (`GetAmicusMode`) est envoye regulierement pendant la lecture (sinon le robot s'arrete
  tout seul apres ~3 balles, quelle que soit la config — confirme par de nombreux tests, cf.
  PROTOCOL.md). `robot.js` gere ca automatiquement (`startPlay()`/`stopPlay()` demarrent/arretent un
  `setInterval` de 2.5s, seuil reel teste entre 5000ms/OK et 6000ms/echec — cf. PROTOCOL.md pour le
  detail de la marge de securite choisie). Implication : l'appareil qui heberge la page doit rester
  actif pendant toute la session ; `app.js` utilise la Screen Wake Lock API pour empecher l'ecran de
  s'eteindre pendant qu'on ecoute (n'empeche pas une veille systeme complete, ex. capot ferme).

## Evals (validation automatique du LLM sans micro ni robot)

`evals/` rejoue des transcripts reels (issus de sessions de test, ex. avec Charly) contre le vrai
serveur Charras, et verifie que l'interpretation produit les actions attendues -- utile pour valider
un changement de prompt/schema sans avoir a retester a la voix a chaque fois.

```bash
cd voice-app
node evals/run.mjs                          # tous les cas, contre le Charras par defaut
node evals/run.mjs --filter pattern         # seulement les cas dont le nom contient "pattern"
LLM_BASE_URL=http://192.168.1.50:11434 node evals/run.mjs   # contre un autre serveur
EVAL_VERBOSE=1 node evals/run.mjs           # avec les logs [LLM]/[STT] de llm.js
```

Les cas sont dans `evals/cases.mjs` (ajouter un cas = ajouter une entree `{name, turns, expect}` ;
`turns` est une sequence de transcripts envoyes a la meme instance de `LlmInterpreter`, pour couvrir
les enchainements multi-tours comme clarify -> reponse).

## Fichiers

- `protocol.js` — encodage/decodage des trames BLE (pure, sans dependance navigateur)
- `robot.js` — wrapper Web Bluetooth (connexion, envoi de commandes, notifications)
- `llm.js` — appel au serveur Charras (Ollama, **API native `/api/chat`**, pas l'endpoint compatible
  OpenAI -- bug Ollama #15293 ou `think` n'est pas transmis a Gemma 4 via `/v1/chat/completions`) avec
  le prompt d'interpretation (schema `{actions:[...], question, say}`)
- `voice.js` — reconnaissance vocale continue + synthese pour le retour oral
- `app.js` — orchestration (glue) + configuration des zones/cadence + execution de la liste d'actions
- `index.html` — page (deux boutons pour les gestes utilisateur obligatoires, sinon 100% vocal)
- `evals/` — harnais de test du LLM (cf. section ci-dessus), independant du navigateur/robot
