import { AmicusRobot } from './robot.js';
import { LlmInterpreter } from './llm.js';
import { VoiceIO } from './voice.js';
import { BALL_STATE, START_PLAY_MODE, APP_RANGE, appBallToWire } from './protocol.js';

// --- Cadence (balles/minute), pilotee par la commande globale SetBallPerMin (independante du
//     descripteur de balle). C'est le parametre "cadence" de l'action adjust. ---
const CADENCE_STEP = 5; // balles/minute par cran "normal"
const CADENCE_MIN = 5;
const CADENCE_MAX = 60;
const DEFAULT_BALL_PER_MIN = 20;

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
const ZONES = {
  forehand: 8,
  backhand_left: -8,
  backhand_right: -3,
  backhand_center: -5,
  center: 0, // vrai centre neutre (confirme par le manuel), independant de forehand/backhand
};

// Reglages de balle par defaut, en UNITES APP. C'est la config du vrai drill Butterfly (exercice 79)
// VALIDEE sur le robot le 2026-07-08 : elle tombe au milieu de la table. Le topspin (spin=2) est
// essentiel -- sans lui (spin=0) la balle file tout droit et sort. verticalAngle=0 = arc neutre.
const DEFAULT_SHOT = { speed: 12, spin: 2, sideSpin: 0, verticalAngle: 0 };

// Etat persistant du "tir courant" (unites app) : les reglages continus (vitesse/hauteur/effet) que les
// commandes "adjust" modifient par crans, et que shot/pattern reutilisent comme base.
let currentShot = { ...DEFAULT_SHOT };

// Programme courant = liste des positions (app -8..+8) que le robot alimente en boucle. Une seule
// position = flux continu a cet endroit ; plusieurs = alternance. Sert de base a chaque (re)lancer.
let currentProgram = [ZONES.center];
// `playing` : le robot alimente-t-il un flux en ce moment ? Sert a decider si un "adjust" doit
// re-appliquer le programme au vol (echange en cours) ou juste memoriser le reglage (a plat).
let playing = false;

const log = document.getElementById('log');
const statusEl = document.getElementById('status');
function addLog(line) {
  const el = document.createElement('div');
  el.textContent = line;
  log.prepend(el);
}
function setStatus(text) {
  statusEl.textContent = text;
}

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
    wakeLock.addEventListener('release', () => addLog('⚠️ Wake Lock relache (ecran remis en veille ?)'));
    addLog('🔒 Ecran maintenu actif (wake lock)');
  } catch (err) {
    addLog(`⚠️ Impossible d'obtenir le wake lock: ${err.message}`);
  }
}

function releaseWakeLock() {
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

async function handleTranscript(transcript) {
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

  // Une phrase peut contenir plusieurs demandes ("remets au milieu et ralentis et relance") --
  // on execute chaque action de la liste dans l'ordre (cf. PROTOCOL.md / bug releve avec Charly :
  // avant, une seule action etait executee et les autres silencieusement perdues).
  try {
    for (const a of result.actions) {
      switch (a.action) {
        case 'adjust':
          await applyAdjust(a.parameter, a.direction, a.magnitude);
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

// Aiguille une action "adjust" vers la cadence (commande globale) ou un champ du descripteur de balle.
async function applyAdjust(parameter, direction, magnitude) {
  const sign = direction === 'decrease' ? -1 : +1; // "increase" par defaut
  if (parameter === 'cadence') {
    await adjustCadence(sign * scaledStep(CADENCE_STEP, magnitude));
    return;
  }
  const field = PARAM_TO_APP_FIELD[parameter];
  if (!field) {
    addLog(`⚠️ Parametre adjust inconnu: ${parameter}`);
    return;
  }
  await adjustBallParam(parameter, field, sign * scaledStep(APP_STEP[parameter], magnitude));
}

async function adjustCadence(delta) {
  let current;
  try {
    current = await robot.getBallPerMin();
  } catch {
    current = robot.lastKnownBallPerMin ?? DEFAULT_BALL_PER_MIN;
  }
  const next = Math.max(CADENCE_MIN, Math.min(CADENCE_MAX, current + delta));
  await robot.setBallPerMin(next);
  addLog(`Cadence: ${current} → ${next} balles/min`);
}

// Modifie un champ continu du tir courant (vitesse/hauteur/effet) par un cran relatif EN UNITES APP,
// clampe sur sa plage app. Si un echange est en cours, le changement se fait sentir au vol ; sinon il
// est memorise et s'appliquera au prochain lancer.
async function adjustBallParam(parameter, field, delta) {
  const { min, max } = APP_FIELD_RANGE[field];
  const before = currentShot[field];
  const after = Math.max(min, Math.min(max, before + delta));
  currentShot[field] = after;
  addLog(`${parameter}: ${before} → ${after} (app ${min}..${max})`);
  await reapplyIfPlaying();
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

// BUG corrige (2026-07-06, teste avec Charly) : l'ancienne version ignorait completement `zone`
// des que `shotType` n'etait pas exactement "backhand" -- ex. {shot_type:null, zone:"center"} (que
// le LLM produit couramment) retombait sur 'forehand' (tir extreme cote droit) au lieu du centre,
// ce qui expliquait "c'est pas au centre" / "tu as change de cote" pendant le test. `zone` est
// desormais prioritaire ; `shotType` ne sert que de repli quand `zone` est absent.
function resolveZoneKey(shotType, zone) {
  if (zone === 'left') return 'backhand_left';
  if (zone === 'right') return 'backhand_right';
  if (zone === 'center') return 'center';
  if (shotType === 'forehand') return 'forehand';
  if (shotType === 'backhand') return 'backhand_center';
  return 'center'; // repli le plus sur : centre plutot qu'un tir extreme par defaut
}

async function sendShot(shotType, zone) {
  const zoneKey = resolveZoneKey(shotType, zone);
  const placeApp = ZONES[zoneKey];
  if (placeApp === undefined) throw new Error(`Zone inconnue: ${shotType}/${zone}`);
  currentProgram = [placeApp]; // flux continu a cette position (avec les reglages courants)
  await playCurrentProgram();
}

// Exercice en alternance (ex. "une balle a gauche, une a droite" en boucle) : le robot boucle
// nativement entre les positions actives tant que le keep-alive tourne (confirme par capture reelle
// 2026-07-06). On charge le programme comme liste de positions, puis playCurrentProgram s'occupe du
// setAllBalls + startPlay (avec les reglages continus courants).
const PATTERN_MIN_POSITIONS = 2;
const PATTERN_MAX_POSITIONS = 10; // SetAllBalls n'a que 10 emplacements (cf. PROTOCOL.md)

async function sendPattern(positions) {
  if (!Array.isArray(positions) || positions.length < PATTERN_MIN_POSITIONS) {
    throw new Error(`Pattern: au moins ${PATTERN_MIN_POSITIONS} positions requises`);
  }
  if (positions.length > PATTERN_MAX_POSITIONS) {
    throw new Error(`Pattern: ${PATTERN_MAX_POSITIONS} positions maximum`);
  }
  currentProgram = positions.map(({ shot_type, zone }) => {
    const zoneKey = resolveZoneKey(shot_type, zone);
    const placeApp = ZONES[zoneKey];
    if (placeApp === undefined) throw new Error(`Zone inconnue: ${shot_type}/${zone}`);
    return placeApp;
  });
  await playCurrentProgram();
}
