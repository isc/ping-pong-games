# Protocole BLE du robot Butterfly Amicus Prime

Reverse-engineered à partir de :
1. Capture HCI Bluetooth (`btsnoop_hci.log`, via `adb bugreport` + `tshark`) pendant des sessions réelles avec le robot (mise à jour firmware, tests de tir, exercice à cadence connue de 20 balles/min).
2. Décompilation de l'app officielle Android `com.butterfly.amicusprimeplus` (via `jadx`), qui a permis de confirmer et nommer précisément tout ce qui avait été déduit du trafic.
3. Ressources embarquées dans l'APK : ~100 exercices préprogrammés (`u1/a.java`, avec valeurs numériques réelles) et le manuel utilisateur officiel (`assets/owners_manual_fr.pdf`), qui documentent les échelles humaines de chaque paramètre (place, vitesse, spin, etc.) avec captures d'écran de l'app à l'appui.

Device BLE : **"Amicus BTLE"**.

## GATT

| | |
|---|---|
| Service | `a7bdef44-a80c-11e7-abc4-cec278b6b50a` |
| Caractéristique de contrôle (write + indicate) | `a7bdf2aa-a80c-11e7-abc4-cec278b6b50a` |

La caractéristique est bidirectionnelle : l'app y écrit des commandes (Write Request) et le robot y répond/notifie via des Indications (nécessitent une confirmation ATT côté client, gérée automatiquement par la stack BLE).

Le robot expose aussi le service standard **Device Information** (`0000180a-...`) avec la caractéristique **Firmware Revision String** (`00002a26-...`), lue une fois juste après la connexion.

Note pratique : dans les captures, chaque frame de plus de quelques octets a été observée fragmentée par le firmware du robot en deux Indications ATT consécutives (une frame de 1 octet `2a` suivie du reste), même quand la taille tient largement dans le MTU — a priori un choix du firmware, pas une contrainte ATT. Il faut réassembler les fragments côté client avant de parser.

## Format de trame

```
[0x2a][longueur totale][0x00][cmdId][payload...]
```

- `0x2a` : octet magique fixe en tête de toute trame (requête comme réponse/notification)
- `longueur totale` : longueur de la trame entière, **magique inclus** (auto-inclusive — vérifié : une trame de config de 85 octets a bien le octet longueur = `0x55` = 85)
- `0x00` : réservé, toujours vu à 0
- `cmdId` : identifiant de commande (voir table ci-dessous), à l'octet d'indice 3 (`frame[3]`)
- `payload` : dépend de la commande

## Table des commandes identifiées

| cmdId (hex) | cmdId (dec) | Nom (issu du code) | Sens | Payload |
|---|---|---|---|---|
| `0x05` | 5 | GetAmicusMode / AmicusMode (notif) | requête + notif spontanée | 1 octet état (voir enum `AmicusMode`) |
| `0x14` | 20 | SetAllBalls | app → robot | tableau de descripteurs de balle, 8 octets chacun |
| `0x20` | 32 | **StartPlay** | app → robot | 1 octet mode : 0=NORMAL, 1=CYCLE, 2=WAIT |

**Corrigé après capture réelle avec l'app officielle (2026-07-06)** : hypothèse initiale fausse — mode
`NORMAL` ne joue PAS forcément une seule fois. Capture avec un exercice à 2 balles actives (upload
`SetAllBalls` + `StartPlay(NORMAL)` envoyé **une seule fois**) : le robot a bouclé nativement
(ball1→ball2→ball1→ball2...) pendant ~9s, sans aucune autre commande de l'app, jusqu'à un `StopPlay`
explicite. `SetGlobalCycle` est resté à `OFF` (0,0,0) pendant tout ce temps — donc ce réglage n'est
**pas** ce qui active le bouclage continu, contrairement à ce qu'on pensait.

**Cause réelle identifiée (2026-07-06)** : ce n'est pas le nombre de balles actives, ni `SetGlobalCycle`,
ni `SetBallPerMin`, ni un problème d'encodage (vérifié en rejouant les octets *exacts* capturés chez
l'app officielle, bit à bit, sans passer par notre propre encodeur — même résultat : arrêt après 3
balles). C'est un **keep-alive requis pendant la lecture continue** : le robot exige de recevoir des
commandes régulièrement (l'app officielle envoie `GetAmicusMode` en continu toutes les ~1.6s pendant
*toute* la session, pas seulement pour du monitoring) et arrête le lanceur de lui-même après quelques
secondes sans nouvelle commande — vraisemblablement une sécurité mécanique (éviter que le robot
continue à éjecter des balles si l'app plante ou perd la connexion). Cohérent avec l'observation que
verrouiller un iPhone connecté coupe aussi le robot (l'app arrête son activité BLE en arrière-plan).

**Confirmé par test direct** : envoyer `GetAmicusMode` (`0x05`) régulièrement via `setInterval` pendant
`StartPlay(NORMAL)` fait boucler le robot indéfiniment, sans ce polling il s'arrête systématiquement
après ~3 balles quelle que soit la configuration (1 ou 2 balles actives, `SetGlobalCycle` OFF/REPEAT,
`SetBallPerMin` par défaut ou 40). Implémenté dans `robot.js` : `startPlay()`/`stopPlay()` démarrent/
arrêtent automatiquement ce heartbeat.

**Seuil réel testé par dichotomie (2026-07-06)** : `5000ms` fonctionne (boucle indéfiniment), `6000ms`
**échoue**, `10000ms` échoue — le vrai seuil est donc entre **5000 et 6000ms**, bien plus serré qu'estimé
au premier essai (on avait d'abord supposé la zone d'échec plutôt vers 7-9s). Le cadencement de ~1.6s
observé chez l'app officielle n'était donc qu'une imitation par défaut, pas la fréquence minimale réelle
nécessaire.

**Marge de sécurité contre un aléa isolé** : un premier choix de `3000ms` avait été fait en supposant
qu'un écart de 6000ms (si un seul appel est raté) passerait — **invalidé** par le test direct de 6000ms
qui échoue. De plus, le keep-alive ne fait que **maintenir** une lecture déjà en cours : si le robot
s'est déjà arrêté (parce qu'un beat a été raté), renvoyer `GetAmicusMode` ne le relance pas — il
faudrait un vrai `StartPlay`. D'où le choix final de **2500ms** (`KEEP_ALIVE_INTERVAL_MS` dans
`robot.js`) : un appel raté à 2.5s ne donne qu'un écart de 5000ms jusqu'au suivant — exactement la
valeur **confirmée** fonctionnelle par test direct (pas juste une supposition, contrairement au choix
précédent de 3000ms) — la marge de sécurité prime sur l'optimisation du trafic BLE.

**Implication pratique** : l'appareil qui héberge la page (Mac, téléphone...) doit rester actif pendant
toute la session — s'il se met en veille, le `setInterval` du keep-alive s'arrête (ou la connexion BLE
est coupée par l'OS) et le robot s'arrêtera de la même façon. Voir `app.js` pour l'usage de
la Screen Wake Lock API à cet effet.
| `0x21` | 33 | **StopPlay** | app → robot | aucun payload — trame `[0x2a,0x04,0x00,0x21]` |
| `0x22` | 34 | **SetBallPerMin** | app → robot | 1 octet = cadence **littérale** en balles/minute (confirmé empiriquement : `0x14`=20 capturé pendant une session réglée à "20 balles/min") |
| `0x2b` | 43 | GetBallPerMin | app → robot (requête) | aucun payload — trame `[0x2a,0x04,0x00,0x2b]` ; réponse : 1 octet valeur courante à `frame[4]` |
| `0x27` | 39 | SetGlobalCycle | app → robot | 3 octets : cycleState, playOrRepeat, pause |
| `0x29` | 41 | StartClusterMemoryPlay | app → robot | 1 octet = numéro de "cluster memory" (1..10) — lance un programme préenregistré côté robot |
| `0x2c` | 44 | PlayingBall (notif) | robot → app | ballNumber(1o), remainingTimeMs(2o LE), baseMemory(1o) |
| `0x11` | 17 | SelectBall | app → robot | 1 octet = numéro de balle (1..10), synchronise l'UI sur ce slot |
| `0x12` | 18 | **SetBallProperties** | app → robot | 9 octets : `[slotIndex][descripteur de balle 8 octets identique à SetAllBalls]` — met à jour **une seule balle** du programme sans re-uploader les 10 |
| `0x23` | 35 | **StartSample** | app → robot | aucun payload — trame `[0x2a,0x04,0x00,0x23]`, correspond au bouton "Sample" du manuel : teste une balle avec les réglages courants sans lancer tout l'exercice |

Toutes les commandes suivent le même schéma générique côté app : classe qui implémente une interface commune (`J1.b`) avec `b()`=cmdId, `c()`=nom, `d(params)`=encodeur, `a(frame)`=décodeur de réponse.

Codes de statut génériques observés dans les réponses (`GET`/`SET`) : `0xf0` (240) = succès/OK.

### `AmicusMode` (état du robot, valeur retournée par cmdId `0x05`)

| Valeur | Nom |
|---|---|
| 0 | STEPPER_MOTOR_INITIALIZATION |
| 1 | HEAD_MOTOR_INITIALIZATION |
| 2 | **STOPPED** |
| 3 | **PLAYING** |
| 4 | **STOPPING** |
| 5, 6 | réservé |
| 7 | BALL_JAMMED_FIRST |
| 8 | BALL_JAMMED_REVERSE |
| 9 | BALL_JAMMED_FORWARD |
| 10 | BALL_PERMANENTLY_JAMMED |
| 11 | CYCLE_WAIT_MODE |
| 12 | START_HEAD_MOTORS_CALIBRATION_MODE |
| 13 | HEAD_MOTORS_CALIBRATION_MODE |
| 14 | RF_TRANSMITTER_LEARNING_MODE |
| 15 | WAITING_FOR_SERVER |
| 64 | BOOTLOADER_MODE |

Cycle observé lors d'un tir : `STOPPED(2)` → écriture StartPlay → `PLAYING(3)` (pendant toute la durée du programme) → `STOPPING(4)` (transition brève, ~1s) → `STOPPED(2)`.

### `SetAllBalls` — descripteur d'une balle (8 octets)

Champs (noms exacts du code, classe `Ball` : `state, trajectoryLow, trajectoryHigh, spin, sideSpin, speed, place, ballPerMin, sector`) :

| Octet | Champ | Encodage / plage |
|---|---|---|
| 0 | state | `DISABLED`=0, `ENABLED`=1, `SERVE`=2, `UNCHANGED`=255 |
| 1 | trajectoryLow | 0..175 (ou 255 = inchangé) |
| 2 | trajectoryHigh | 0..255 |
| 3 | spin | 0..12 |
| 4 | sideSpin | 0..12 |
| 5 | speed | 0..24 |
| 6 | place + sector combinés | voir formule ci-dessous |
| 7 | ballPerMin | 0..12 (probablement un **index de preset**, à ne pas confondre avec la cadence littérale de `SetBallPerMin`) |

Formule de l'octet 6 (fonction `r(place, sector)` du code, clamp `place`/`sector` sur 0..16 chacun) :
```
mean = round((place + sector) / 2)
diff = round(|place - sector| / 2)
octet6 = (clamp(diff, 0, 7) << 5) | clamp(mean, 0, 31)
```
C'est un encodage "moyenne + écart" (probablement position gauche/droite + étalement de la zone de chute), pas un encodage direct des deux valeurs — à valider empiriquement si besoin.

Règle générale de clamp (fonction `Z(valeur, max)` du code) : si `valeur == 255`, la commande signifie "ne pas modifier ce champ" ; sinon la valeur doit être dans `0..max` (sinon exception côté app).

### Modèle applicatif (niveau app) vs modèle fil (niveau BLE)

L'app manipule un modèle plus simple, `com.butterfly.amicus.data.model.Ball`, avant de le convertir en
descripteur fil (8 octets ci-dessus). Signature confirmée (`Ball.java` décompilé) :

```
Ball(state: String, place: Int, speed: Int, spin: Int, sideSpin: Int, ballPerMin: Int, verticalAngle: Int, sector: Int?)
```

Les échelles humaines de ces champs sont documentées dans le manuel utilisateur officiel (embarqué dans
l'APK, `assets/owners_manual_fr.pdf`, page 9-10, avec captures d'écran de l'app) :

| Champ (app) | Échelle | Signification |
|---|---|---|
| `place` | **-8 (extrême gauche/revers) .. 0 (centre) .. +8 (extrême droite/coup droit)** | position gauche-droite sur la table |
| `sector` | zone autour d'un point median, tailles paires 0,2,4,6,8 (sélectionnable 0-7 en +/-) | remplace `place` par une zone au lieu d'un point fixe |
| `speed` | **1 (très lent) .. 25 (très rapide)**, défaut 13 | vitesse de la balle |
| `spin` | **-5 (backspin extrême) .. 0 (aucun effet) .. +7 (topspin extrême)** | topspin si positif, backspin si négatif |
| `sideSpin` | pas de **15° par cran** à partir de 0, positif = rotation vers la droite, négatif = vers la gauche | effet latéral |
| `verticalAngle` (= "Trajectoire") | 0 = tir direct legerement vers le haut ; positif = angle de plus en plus haut ; négatif = angle pour rebond cote robot (utilisé pour les services | angle de lancer vertical |
| `ballPerMin` (par balle, **IFC** = "Individual Frequency Control") | delta relatif (ex. -40..+40 vu sur les captures d'écran) | ralentit (négatif) ou accélère (positif) le timing *entre cette balle et la précédente*, PAS une cadence absolue — à ne pas confondre avec la commande globale `SetBallPerMin` (0x22) qui elle est bien litterale |

Confirmé sur les ~100 exercices préprogrammés (`u1/a.java`) : par ex. Exercise 79 "1 topspin to BH, 1
topspin to FH" = `[Ball(place=-6, speed=12, spin=2, ...), Ball(place=6, speed=12, spin=2, ...)]` — topspin
léger (spin=2), vitesse 12, revers (place négatif) puis coup droit (place positif). Le "milieu" (MID)
correspond a `place=0` (ex. Exercise 80 "1 topspin to FH, 1 topspin to MID").

**Mise à jour — confirmé par capture réelle (2026-07-06)** : en testant `place=-8`, `place=0`, `place=+8`
sur un exercice à une balle et en capturant les trames `SetBallProperties` (0x12) résultantes, la formule
s'avère être **linéaire et simple** quand aucune zone (`sector`) n'est utilisée (donc `diff=0` dans la
formule de l'octet 6, qui se réduit alors à `octet = mean = place_fil`) :

```
place_fil (0..16) = place_app (-8..+8) + 8
```

Vérifié sur les 3 échantillons capturés (slot=1, state=ENABLED, trajectoryLow=0x5c, trajectoryHigh=0,
spin=5, sideSpin=6, speed=12, ballPerMin=6 — constants entre les 3 tests, seul l'octet place/sector varie) :

| `place` app | octet fil observé |
|---|---|
| -8 | `0x00` |
| 0 | `0x08` |
| +8 | `0x10` |

La conversion pour `speed`/`spin`/`sideSpin`/`trajectoryLow`/`trajectoryHigh` (et pour `sector` en tant
que zone plutôt que point) n'a pas encore été vérifiée de la même façon — probablement une table de
calibration comme suspecté (point d'appel : `S1/s.java:231`), à vérifier au cas par cas si besoin avec
la même méthode (capturer pendant qu'on joue une valeur connue sur l'app réelle).

### `SetGlobalCycle` — payload (3 octets)

| Octet | Champ | Encodage |
|---|---|---|
| 0 | cycleState | 0=OFF, 1=TIMER, 2=REPEAT, 3=SEQUENCE_UNIQUE |
| 1 | playOrRepeat | 0..255 |
| 2 | pause | 0..255 |

Captures réelles : `2a070027000000` = (OFF, 0, 0) ; `2a070027000a05` = (OFF, 10, 5).
Unités de `playOrRepeat`/`pause` non confirmées (nombre de cycles ? dixièmes de seconde ? à déterminer empiriquement).

### `PlayingBall` — notification (robot → app), 8 octets

```java
// X2/e.java:441-454 (decompile)
if ((frame[3] & 255) == 44) {
    return new PlayingBallInfo(
        frame[4] & 255,                              // ballNumber
        (frame[5] & 255) + ((frame[6] & 255) << 8),   // remainingTimeMs (little-endian 16 bits)
        frame[7] & 255                                // baseMemory
    );
}
```

Poussée en continu pendant `PLAYING`, une fois par balle. Exemple capturé : `2a08002c01ee0200` → ballNumber=1, remainingTimeMs=0x02ee=750ms, baseMemory=0.

## Séquence de contrôle observée (StartPlay)

1. (optionnel) quelques `SET` de paramètres cosmétiques
2. `SetBallPerMin` : `[0x2a,0x05,0x00,0x22,<balles/min>]`
3. `SetAllBalls` : upload du programme (positions/vitesse/spin par balle), via Prepare Write + Execute Write si la trame dépasse le MTU
4. `SetGlobalCycle` (optionnel selon le mode)
5. **`StartPlay`** : `[0x2a,0x05,0x00,0x20,0x00]` (mode=NORMAL) → déclenche réellement le lancer
6. Le robot passe `STOPPED(2)` → `PLAYING(3)`, pousse des notifications `PlayingBall` (`0x2c`) à chaque balle
7. Fin du programme : `PLAYING(3)` → `STOPPING(4)` → `STOPPED(2)`

## Pour piloter le robot depuis une app Web Bluetooth

Minimum viable pour déclencher un tir avec la config déjà en mémoire du robot :
```js
const CONTROL_SERVICE = 'a7bdef44-a80c-11e7-abc4-cec278b6b50a';
const CONTROL_CHAR    = 'a7bdf2aa-a80c-11e7-abc4-cec278b6b50a';

// device = résultat de navigator.bluetooth.requestDevice({ filters: [{ services: [CONTROL_SERVICE] }] })
const server = await device.gatt.connect();
const service = await server.getPrimaryService(CONTROL_SERVICE);
const char = await service.getCharacteristic(CONTROL_CHAR);
await char.startNotifications();
char.addEventListener('characteristicvaluechanged', (e) => {
  // reassembler les fragments (cf. note plus haut) puis parser selon frame[3]
});

// Régler la cadence a 20 balles/min
await char.writeValue(new Uint8Array([0x2a, 0x05, 0x00, 0x22, 20]));

// Declencher le lancer (mode NORMAL)
await char.writeValue(new Uint8Array([0x2a, 0x05, 0x00, 0x20, 0x00]));
```

## Ce qui reste à valider empiriquement

- **Résolu** : les échelles humaines de `place` (-8..+8), `speed` (1..25), `spin` (-5..+7),
  `sideSpin` (pas de 15°), `verticalAngle`, et le sens de `ballPerMin` par balle (IFC relatif, pas un
  index ni une cadence absolue) — confirmés par le manuel utilisateur officiel + les ~100 exercices
  préprogrammés. Voir section "Modèle applicatif" ci-dessus.
- **Résolu** : `place` app (-8..+8) → octet fil (0..16) est confirmé **linéaire** : `octet = place + 8`
  (capture réelle du 2026-07-06, cf. section dédiée ci-dessus).
- **Toujours ouvert** : la conversion de `speed`/`spin`/`sideSpin`/`trajectoryLow`/`trajectoryHigh` (et de
  `sector` en tant que zone) vers leurs octets fil respectifs n'a pas été vérifiée de la même façon —
  probablement une table de calibration (`S1/s.java:231`), à vérifier au cas par cas par capture réelle
  si besoin (même méthode : jouer une valeur connue sur l'app connectée au robot et observer l'octet).
- Unités de `playOrRepeat`/`pause` dans `SetGlobalCycle` (nombre de cycles ? dixièmes de seconde ?)
- Structure de `SetAllBalls` confirmée : tableau **fixe de 10 balles** (`1 octet réservé (0x00) + 10 × 8
  octets` = 81 octets de payload = 85 octets de trame totale, correspond exactement à la longueur `0x55`
  observée), les emplacements inutilisés étant mis à `state=DISABLED(0)` avec le reste à zéro.
