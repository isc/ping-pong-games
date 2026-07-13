import { AmicusRobot } from './robot.js';
import { LlmInterpreter } from './llm.js';
import { VoiceIO } from './voice.js';
import { BALL_STATE, START_PLAY_MODE, APP_RANGE, appBallToWire } from './protocol.js';

// --- Cadence (balles/minute), pilotee par la commande globale SetBallPerMin (independante du
//     descripteur de balle). C'est le parametre "cadence" de l'action adjust. ---
const CADENCE_STEP = 5; // balles/minute par cran "normal"
const CADENCE_MIN = 5;
// Max = 120 balles/min, confirme par l'utilisateur sur l'app officielle (le defaut usine est 40).
const CADENCE_MAX = 120;
const DEFAULT_BALL_PER_MIN = 30; // cadence posee au 1er lancer d'une session (avant, on heritait d'une valeur residuelle)

// Facteurs de "magnitude" appliques a tous les crans (adjust.magnitude). "un peu" -> plus petit,
// "beaucoup" -> plus gros. Arrondi au cran entier le plus proche.
const MAGNITUDE_FACTOR = { small: 0.5, normal: 1, large: 2 };

// Crans par cran "normal", en UNITES APP (echelles humaines du manuel), pour les parametres du
// descripteur de balle. On travaille en modele app puis on convertit via appBallToWire (formules
// exactes de l'app officielle, cf. protocol.js) -- calibration certaine, plus empirique.
//   ball_speed : speed 1..25 (defaut 13)      -> +loin
//   trajectory : verticalAngle -92..+61 deg   -> +haut (et +loin, cf. calibration 2026-07-08)
//   spin       : -5 (backspin) .. +7 (topspin) -> +topspin fait replonger la balle (plus court)
//   side_spin  : -90..+90 deg, pas de 15       -> +droite
const APP_STEP = {
  ball_speed: 1, // cran de vitesse
  trajectory: 10, // degres d'angle
  spin: 1, // cran d'effet
  side_spin: 15, // un cran = 15 deg
};

// Mapping parametre "adjust" -> champ du modele app (currentShot). "cadence" est traite a part
// (commande globale SetBallPerMin, pas un champ de balle).
const PARAM_TO_APP_FIELD = { ball_speed: 'speed', trajectory: 'verticalAngle', spin: 'spin', side_spin: 'sideSpin' };
const APP_FIELD_RANGE = { speed: APP_RANGE.speed, verticalAngle: APP_RANGE.verticalAngle, spin: APP_RANGE.spin, sideSpin: APP_RANGE.sideSpin };

// `place` cote app : -8 (revers/extreme gauche) .. 0 (milieu) .. +8 (coup droit/extreme droite),
// cf. manuel utilisateur officiel. Formule vers l'octet fil CONFIRMEE par capture BLE reelle
// le 2026-07-06 (place_fil = place_app + 8, cf. PROTOCOL.md) -- fiable, pas une hypothese.
// Ce qui reste un choix arbitraire (a valider avec l'utilisateur) : la correspondance exacte entre
// "revers a gauche/droite/au milieu" et une position -8..+8 precise -- seuls les points extremes
// (-8 et +8) et le centre (0) sont confirmes sans ambiguite par le manuel.
// Positions (place app -8..+8) : gauche = negatif, droite = positif, centre = 0. Modele DROITIER pour
// l'instant (coup droit = cote droit, revers = cote gauche) -- l'inversion gaucher est sur la roadmap
// (cf. VISION.md). Valeurs +/-6 = clairement d'un cote sans aller a l'extreme bord (facile a ajuster).
const ZONE_LEFT = -6;
const ZONE_RIGHT = 6;
const ZONE_CENTER = 0;

// Reglages de balle par defaut, en UNITES APP. C'est la config du vrai drill Butterfly (exercice 79)
// VALIDEE sur le robot le 2026-07-08 : elle tombe au milieu de la table. Le topspin (spin=2) est
// essentiel -- sans lui (spin=0) la balle file tout droit et sort. verticalAngle=0 = arc neutre.
const DEFAULT_SHOT = { speed: 12, spin: 2, sideSpin: 0, verticalAngle: 0 };

// Etat persistant du "tir courant" (unites app) : les reglages continus (vitesse/hauteur/effet) que les
// commandes "adjust" modifient par crans, et que shot/pattern reutilisent comme base.
let currentShot = { ...DEFAULT_SHOT };

// Programme courant = liste des positions (app -8..+8) que le robot alimente en boucle. Une seule
// position = flux continu a cet endroit ; plusieurs = alternance. Sert de base a chaque (re)lancer.
let currentProgram = [ZONE_CENTER];
// `playing` : le robot alimente-t-il un flux en ce moment ? Sert a decider si un "adjust" doit
// re-appliquer le programme au vol (echange en cours) ou juste memoriser le reglage (a plat).
let playing = false;
// La cadence a-t-elle ete fixee dans cette session ? Sinon on ne connait pas la valeur du robot (residu
// d'une session/calibration precedente) -> on pose DEFAULT_BALL_PER_MIN au 1er lancer. Ensuite elle
// persiste et suit les "plus vite"/"moins vite".
let cadenceInitialized = false;

const log = document.getElementById('log');
const statusEl = document.getElementById('status');
function addLog(line) {
  const el = document.createElement('div');
  el.textContent = line;
  log.prepend(el);
  bufferRemoteLog(line); // miroir vers le serveur (analyse a distance, cf. flushLogs)
}
function setStatus(text) {
  statusEl.textContent = text;
}

// --- Journal distant -------------------------------------------------------------------------------
// Envoie le journal de session au serveur (Charras) pour pouvoir l'analyser sans avoir a copier-coller
// l'ecran du telephone. Bufferise puis flush toutes les quelques secondes + a la fermeture de la page
// (fetch keepalive survit a l'unload). Cote serveur : nginx ecrit le corps brut dans /logs/client.log.
const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-');
const remoteLogBuffer = [];
let remoteLogHeaderSent = false;

function bufferRemoteLog(line) {
  const ts = new Date().toISOString().slice(11, 23); // hh:mm:ss.mmm
  remoteLogBuffer.push(`${ts} ${line}`);
}

async function flushLogs(useKeepalive = false) {
  if (!remoteLogBuffer.length) return;
  const batch = remoteLogBuffer.splice(0, remoteLogBuffer.length);
  // En-tete de session une seule fois, pour delimiter les sessions dans le fichier serveur.
  const header = remoteLogHeaderSent ? '' : `\n===== session ${SESSION_ID} (${navigator.userAgent}) =====\n`;
  const body = header + batch.join('\n') + '\n';
  const apiKey = document.getElementById('llm-api-key')?.value.trim() || '';
  try {
    await fetch('log', {
      method: 'POST',
      keepalive: useKeepalive,
      headers: { 'Content-Type': 'text/plain', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
      body,
    });
    remoteLogHeaderSent = true;
  } catch {
    // Echec (reseau/serveur down) : on remet le batch en tete pour reessayer au prochain flush.
    remoteLogBuffer.unshift(...batch);
  }
}

setInterval(() => flushLogs(false), 5000);
window.addEventListener('pagehide', () => flushLogs(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushLogs(true);
});

let lastLoggedMode = null; // dernier etat robot journalise, pour ne pas repeter les PLAYING du keep-alive

const robot = new AmicusRobot({
  onEvent: (evt) => {
    if (evt.kind === 'connected') {
      addLog(`🔵 Robot connecte: ${evt.name}`);
      listenButton.disabled = false;
      listenButton.title = '';
    }
    if (evt.kind === 'disconnected') {
      addLog('⚪ Robot deconnecte');
      listenButton.disabled = true;
      listenButton.title = "Connecte d'abord le robot";
      playing = false;
      cadenceInitialized = false; // nouvelle connexion = nouvelle session, on reposera la cadence par defaut
      if (listening) {
        voice.stop();
        listening = false;
        listenButton.textContent = "🎤 Demarrer l'ecoute";
        setStatus('En attente...');
        releaseWakeLock();
      }
    }
    // Le keep-alive interroge l'etat toutes les 2,5s -> on ne logge QUE les changements, sinon le journal
    // se noie sous des dizaines de "Etat robot: PLAYING" identiques (constate en session reelle).
    if (evt.kind === 'frame' && evt.type === 'AmicusMode' && evt.name !== lastLoggedMode) {
      lastLoggedMode = evt.name;
      addLog(`Etat robot: ${evt.name}`);
      // Le robot peut s'arreter de lui-meme (fin de programme, bourrage, keep-alive rate) : on
      // resynchronise `playing` pour ne pas croire qu'un echange tourne encore.
      if (evt.name === 'STOPPED' || evt.name === 'STOPPING') playing = false;
    }
  },
});
window.robot = robot; // pour tester des commandes a la main depuis la console (bypass LLM/voix)

let llm = null;
let voice = null;
let listening = false;
let wakeLock = null;
let intentionalWakeRelease = false; // vrai quand C'EST NOUS qui relachons (stop ecoute) -> pas une veille subie

// Le robot exige un keep-alive regulier pendant la lecture continue (cf. PROTOCOL.md) -- si l'appareil
// qui heberge cette page se met en veille, plus rien ne s'envoie et le robot s'arrete tout seul (meme
// symptome que sur iOS quand le telephone se verrouille). Le Wake Lock API empeche l'ECRAN de s'eteindre
// pendant qu'on ecoute -- ca ne garantit pas contre une veille systeme complete (ex. capot ferme), mais
// couvre le cas courant (ecran qui s'eteint tout seul apres inactivite).
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    addLog("⚠️ Wake Lock non supporte par ce navigateur -- l'ecran peut s'eteindre et arreter le robot");
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      // On distingue le relachement VOLONTAIRE (on a stoppe l'ecoute) du relachement SPONTANE (l'OS
      // reprend l'ecran / onglet en arriere-plan) -- seul ce dernier est un vrai symptome a diagnostiquer.
      if (intentionalWakeRelease) {
        intentionalWakeRelease = false;
        addLog('🔓 Wake lock relache (ecoute stoppee)');
      } else {
        addLog('⚠️ Wake lock relache SPONTANEMENT (ecran en veille / onglet en arriere-plan ?)');
      }
    });
    addLog('🔒 Ecran maintenu actif (wake lock)');
  } catch (err) {
    addLog(`⚠️ Impossible d'obtenir le wake lock: ${err.message}`);
  }
}

function releaseWakeLock() {
  intentionalWakeRelease = true; // marque avant release() : l'event 'release' saura que c'est volontaire
  wakeLock?.release();
  wakeLock = null;
}

// Le navigateur relache automatiquement le wake lock quand l'onglet passe en arriere-plan ; on le
// redemande quand elle redevient visible, tant qu'on est toujours en train d'ecouter.
document.addEventListener('visibilitychange', () => {
  if (listening && document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
});

document.getElementById('connect-robot').addEventListener('click', async () => {
  try {
    await robot.connect();
  } catch (err) {
    addLog(`Erreur connexion robot: ${err.message}`);
  }
});

// La cle API n'est jamais codee en dur dans le depot (public) : saisie une fois a la main sur le
// telephone et conservee en localStorage, pour ne pas avoir a la retaper a chaque session.
const apiKeyInput = document.getElementById('llm-api-key');
const STORED_API_KEY = localStorage.getItem('llm-api-key');
if (STORED_API_KEY) apiKeyInput.value = STORED_API_KEY;

const listenButton = document.getElementById('start-listening');
listenButton.addEventListener('click', () => {
  if (!listening) {
    if (!robot.connected) {
      addLog("⚠️ Connecte d'abord le robot avant de demarrer l'ecoute");
      return;
    }
    const baseUrl = document.getElementById('llm-url').value.trim();
    const model = document.getElementById('llm-model').value.trim();
    const apiKey = apiKeyInput.value.trim();
    localStorage.setItem('llm-api-key', apiKey);
    llm = new LlmInterpreter({ baseUrl, model, apiKey });
    // Precharge le modele tout de suite (Ollama l'a decharge apres ~5 min d'inactivite) pour que la
    // 1ere commande ne parte pas a froid (bug "Failed to fetch" en debut de session). Non bloquant.
    addLog('⏳ prechauffage du modele LLM...');
    llm.warmup().then((ok) => addLog(ok ? '✅ modele LLM pret' : '⚠️ prechauffage LLM incertain'));
    voice = new VoiceIO({
      onTranscript: handleTranscript,
      onError: (err) => addLog(`Erreur reconnaissance vocale: ${err}`),
    });
    voice.start();
    listening = true;
    listenButton.textContent = "🛑 Stopper l'ecoute";
    setStatus('🎤 En ecoute...');
    acquireWakeLock();
  } else {
    voice.stop();
    listening = false;
    listenButton.textContent = "🎤 Demarrer l'ecoute";
    setStatus('En attente...');
    releaseWakeLock();
  }
});

// Un seul transcript traite a la fois : tant qu'on interprete OU qu'on parle, on IGNORE les nouveaux
// transcripts. Casse la boucle larsen (en session reelle l'app entendait sa propre voix "C'est note,
// j'accelere le rythme" et la reprenait comme commande -> cadence qui s'emballe 25->50) ET le flot de
// fragments successifs ("plus", "plus vite", "plus vite les"...) qui saturait notre rate-limit (503).
let handling = false;

async function handleTranscript(transcript) {
  if (handling) {
    addLog(`⏳ ignore (occupe) : "${transcript}"`);
    return;
  }
  handling = true;
  try {
    await handleTranscriptInner(transcript);
  } finally {
    handling = false;
  }
}

async function handleTranscriptInner(transcript) {
  addLog(`🗣️ "${transcript}"`);
  setStatus('🤔 Interpretation...');
  let result;
  try {
    result = await llm.interpret(transcript);
  } catch (err) {
    addLog(`Erreur LLM: ${err.message}`);
    setStatus('🎤 En ecoute...');
    return;
  }
  addLog(`→ ${JSON.stringify(result)}`);
  setStatus('🎤 En ecoute...');

  // "des deux cotes", "a gauche et a droite"... : le LLM produit parfois PLUSIEURS "shot" successifs la
  // ou il faut une ALTERNANCE. Or deux "shot" s'ecrasent (chacun recharge le programme -> seule la
  // derniere position joue, bug observe 2026-07-13). On fusionne donc >=2 "shot" en un seul "pattern".
  const shotActions = result.actions.filter((a) => a.action === 'shot');
  if (shotActions.length >= 2) {
    const positions = shotActions.map((s) => ({ shot_type: s.shot_type, zone: s.zone }));
    let merged = false;
    result.actions = result.actions.filter((a) => {
      if (a.action !== 'shot') return true;
      if (merged) return false; // on retire les shots suivants
      Object.assign(a, { action: 'pattern', positions, shot_type: null, zone: null });
      merged = true;
      return true; // le 1er shot devient le pattern (a sa place dans l'ordre)
    });
    addLog(`↪ ${shotActions.length} tirs fusionnes en alternance (pattern)`);
  }

  // Une phrase peut contenir plusieurs demandes ("remets au milieu et ralentis et relance") --
  // on execute chaque action de la liste dans l'ordre (cf. PROTOCOL.md / bug releve avec Charly :
  // avant, une seule action etait executee et les autres silencieusement perdues).
  try {
    for (const a of result.actions) {
      switch (a.action) {
        case 'adjust':
          await applyAdjust(a.parameter, a.direction, a.magnitude, a.target);
          break;
        case 'stop':
          await robot.stopPlay();
          playing = false;
          break;
        case 'resume':
          // (Re)lance le flux continu du programme courant (position(s) + reglages actuels). Le
          // keep-alive demarre avec startPlay (cf. robot.js). Si l'utilisateur demandait aussi un
          // repositionnement, le LLM a mis un "shot" separe AVANT dans la liste (cf. system prompt).
          await playCurrentProgram();
          break;
        case 'shot':
          await sendShot(a.shot_type, a.zone);
          break;
        case 'pattern':
          await sendPattern(a.positions);
          break;
        case 'report':
          await reportSettings(a.parameter);
          return; // la reponse orale EST le report ; pas de "say" en plus

        case 'clarify':
          await voice.speak(result.question);
          return; // pas de "say" supplementaire, la question EST la reponse orale ; clarify est
          // toujours seule dans la liste (cf. system prompt), pas la peine de continuer la boucle
        case 'none':
        default:
          break;
      }
    }
  } catch (err) {
    addLog(`Erreur commande robot: ${err.message}`);
    await voice.speak("Erreur, je n'ai pas pu envoyer la commande au robot.");
    return;
  }

  if (result.say) await voice.speak(result.say);
}

// Cran effectif = pas nominal x facteur de magnitude ("un peu"/"beaucoup"), arrondi et au moins 1.
function scaledStep(nominal, magnitude) {
  const factor = MAGNITUDE_FACTOR[magnitude] ?? MAGNITUDE_FACTOR.normal;
  return Math.max(1, Math.round(nominal * factor));
}

// Aiguille une action "adjust" vers la cadence (commande globale) ou un champ du descripteur de balle,
// en valeur ABSOLUE si `target` est fourni ("mets 40 balles par minute"), sinon en cran relatif.
async function applyAdjust(parameter, direction, magnitude, target) {
  const hasTarget = target != null && Number.isFinite(target);
  if (parameter === 'cadence') {
    if (hasTarget) await setCadence(target);
    else {
      const sign = direction === 'decrease' ? -1 : +1;
      await setCadence((await currentCadence()) + sign * scaledStep(CADENCE_STEP, magnitude));
    }
    return;
  }
  const field = PARAM_TO_APP_FIELD[parameter];
  if (!field) {
    addLog(`⚠️ Parametre adjust inconnu: ${parameter}`);
    return;
  }
  const { min, max } = APP_FIELD_RANGE[field];
  const before = currentShot[field];
  const after = hasTarget
    ? Math.max(min, Math.min(max, Math.round(target)))
    : Math.max(min, Math.min(max, before + (direction === 'decrease' ? -1 : +1) * scaledStep(APP_STEP[parameter], magnitude)));
  currentShot[field] = after;
  addLog(`${parameter}: ${before} → ${after} (app ${min}..${max})`);
  await reapplyIfPlaying();
}

// Lit la cadence courante du robot (repli sur la derniere connue / defaut si la lecture echoue).
async function currentCadence() {
  try {
    return await robot.getBallPerMin();
  } catch {
    return robot.lastKnownBallPerMin ?? DEFAULT_BALL_PER_MIN;
  }
}

// Fixe la cadence a une valeur absolue (clampee), qu'elle vienne d'un "mets 40" ou d'un cran relatif.
async function setCadence(value) {
  const next = Math.max(CADENCE_MIN, Math.min(CADENCE_MAX, Math.round(value)));
  await robot.setBallPerMin(next);
  cadenceInitialized = true; // l'utilisateur a fixe la cadence : le prochain lancer ne l'ecrase pas
  addLog(`Cadence → ${next} balles/min`);
}

// Descripteurs fil du programme courant : chaque position croisee avec les reglages continus courants,
// convertie modele app -> fil via appBallToWire (formules exactes de l'app officielle).
function programBalls() {
  return currentProgram.map((placeApp) => appBallToWire({ state: BALL_STATE.ENABLED, place: placeApp, ...currentShot }));
}

// Charge le programme courant (setAllBalls remplit les slots inutilises en DISABLED -> pas de balles
// fantomes) et lance le flux continu. Le robot boucle nativement tant que le keep-alive tourne (demarre
// par startPlay, cf. robot.js). Remplace l'ancien StartSample (qui envoyait ~4 balles non maitrisees).
async function playCurrentProgram() {
  // Au tout premier lancer d'une session, on impose une cadence connue (sinon on jouerait a la valeur
  // residuelle du robot -- observe : demarrage a 20 herite d'un tir de calibration).
  if (!cadenceInitialized) {
    await robot.setBallPerMin(DEFAULT_BALL_PER_MIN);
    cadenceInitialized = true;
    addLog(`Cadence initiale: ${DEFAULT_BALL_PER_MIN} balles/min`);
  }
  await robot.setAllBalls(programBalls());
  await robot.startPlay(START_PLAY_MODE.NORMAL);
  playing = true;
}

// Un "adjust" pendant un echange re-applique le programme au vol pour que le changement se sente tout
// de suite ; a l'arret on ne relance rien (pas de balle surprise) -- le reglage prend effet au prochain
// lancer. La cadence, elle, est deja live via SetBallPerMin.
async function reapplyIfPlaying() {
  if (playing) await playCurrentProgram();
}

// Decrit l'effet (spin app -5..+7) en langage naturel.
function describeSpin(spin) {
  if (spin > 0) return `topspin ${spin}`;
  if (spin < 0) return `balle coupee ${-spin}`;
  return 'sans effet';
}

// Repond a la voix a une demande de reglages courants ("on est a combien ?"). L'app connait les valeurs
// (cadence cote robot, reste dans currentShot en unites app) -- le LLM, lui, ne les a pas.
async function reportSettings(parameter) {
  let cadence;
  try {
    cadence = await robot.getBallPerMin();
  } catch {
    cadence = robot.lastKnownBallPerMin ?? DEFAULT_BALL_PER_MIN;
  }
  const s = currentShot;
  const parts = {
    cadence: `${cadence} balles par minute`,
    ball_speed: `vitesse ${s.speed} sur 25`,
    spin: describeSpin(s.spin),
    side_spin: s.sideSpin === 0 ? 'pas d\'effet lateral' : `effet lateral ${s.sideSpin} degres`,
    trajectory: `angle de trajectoire ${s.verticalAngle} degres`,
  };
  const text =
    parameter && parts[parameter]
      ? parts[parameter]
      : `Cadence ${cadence} balles par minute, vitesse ${s.speed} sur 25, ${describeSpin(s.spin)}.`;
  addLog(`ℹ️ ${text}`);
  await voice.speak(text);
}

// Resout (shot_type, zone) -> position `place` (-8..+8). `zone` PRIORITAIRE sur `shot_type` (le LLM met
// souvent zone="center" avec un shot_type, cf. bug 2026-07-06 ou "center" retombait sur forehand).
// BUG 2026-07-13 corrige ICI : "right" renvoyait -3 (cote GAUCHE !) -- gauche/droite sont maintenant
// des cotes de table symetriques. Modele droitier (coup droit=droite, revers=gauche), inversion gaucher
// sur la roadmap.
function resolvePlace(shotType, zone) {
  if (zone === 'left') return ZONE_LEFT;
  if (zone === 'right') return ZONE_RIGHT;
  if (zone === 'center') return ZONE_CENTER;
  if (shotType === 'forehand') return ZONE_RIGHT; // coup droit = cote droit (droitier)
  if (shotType === 'backhand') return ZONE_LEFT; // revers = cote gauche (droitier)
  return ZONE_CENTER; // repli le plus sur : centre plutot qu'un tir extreme
}

async function sendShot(shotType, zone) {
  currentProgram = [resolvePlace(shotType, zone)]; // flux continu a cette position
  await playCurrentProgram();
}

// Exercice en alternance (ex. "une balle a gauche, une a droite" en boucle) : le robot boucle
// nativement entre les positions actives tant que le keep-alive tourne (confirme par capture reelle
// 2026-07-06). On charge le programme comme liste de positions, puis playCurrentProgram s'occupe du
// setAllBalls + startPlay (avec les reglages continus courants).
const PATTERN_MAX_POSITIONS = 10; // SetAllBalls n'a que 10 emplacements (cf. PROTOCOL.md)

async function sendPattern(positions) {
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new Error('Pattern: aucune position fournie');
  }
  // 1 seule position = flux continu a cet endroit (ex. "que des coups droits") -- le LLM produit parfois
  // un "pattern" a une entree la ou un "shot" conviendrait ; on l'accepte au lieu de planter.
  if (positions.length > PATTERN_MAX_POSITIONS) {
    throw new Error(`Pattern: ${PATTERN_MAX_POSITIONS} positions maximum`);
  }
  currentProgram = positions.map(({ shot_type, zone }) => resolvePlace(shot_type, zone));
  await playCurrentProgram();
}
