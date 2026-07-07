import { AmicusRobot } from './robot.js';
import { LlmInterpreter } from './llm.js';
import { VoiceIO } from './voice.js';
import { BALL_STATE, placeAppToWire, START_PLAY_MODE } from './protocol.js';

// --- Reglages a ajuster ---
const SPEED_STEP = 5; // balles/minute par cran de "plus vite" / "moins vite"
const SPEED_MIN = 5;
const SPEED_MAX = 60;
const DEFAULT_BALL_PER_MIN = 20;
const SHOT_SLOT = 1; // slot SetBallProperties utilise pour les tirs a la voix (n'affecte pas les autres slots)

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

// Valeurs fil REELLEMENT capturees le 2026-07-06 (cf. PROTOCOL.md) pendant le test de calibration
// de `place` -- c'etaient les reglages de l'exercice de test sur l'app, donc verifiees, pas des
// hypotheses (seul l'octet place variait entre les 3 echantillons captures).
const DEFAULT_SHOT_PARAMS = { trajectoryLow: 92, trajectoryHigh: 0, spin: 5, sideSpin: 6, speed: 12, ballPerMinPreset: 6 };

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
      if (listening) {
        voice.stop();
        listening = false;
        listenButton.textContent = "🎤 Demarrer l'ecoute";
        setStatus('En attente...');
        releaseWakeLock();
      }
    }
    if (evt.kind === 'frame' && evt.type === 'AmicusMode') addLog(`Etat robot: ${evt.name}`);
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
        case 'increase_speed':
          await adjustSpeed(+SPEED_STEP);
          break;
        case 'decrease_speed':
          await adjustSpeed(-SPEED_STEP);
          break;
        case 'stop':
          await robot.stopPlay();
          break;
        case 'resume':
          // StartPlay(NORMAL) boucle nativement sur le robot (confirme par capture reelle), a
          // condition que le keep-alive tourne (cf. robot.js : demarre/arrete automatiquement avec
          // startPlay()/stopPlay()) -- reprend ce qui est deja en memoire du robot. Si l'utilisateur
          // demandait aussi un repositionnement, le LLM doit avoir mis une action "shot" separee
          // AVANT celle-ci dans la liste (cf. system prompt) -- pas de zone/shot_type ici.
          await robot.startPlay(START_PLAY_MODE.NORMAL);
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

async function adjustSpeed(delta) {
  let current;
  try {
    current = await robot.getBallPerMin();
  } catch {
    current = robot.lastKnownBallPerMin ?? DEFAULT_BALL_PER_MIN;
  }
  const next = Math.max(SPEED_MIN, Math.min(SPEED_MAX, current + delta));
  await robot.setBallPerMin(next);
  addLog(`Cadence: ${current} → ${next} balles/min`);
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
  await robot.setBallProperties(SHOT_SLOT, {
    state: BALL_STATE.ENABLED,
    place: placeAppToWire(placeApp),
    sector: placeAppToWire(placeApp), // pas de zone -> point unique (diff=0 dans l'encodage place/sector)
    ...DEFAULT_SHOT_PARAMS,
  });
  await robot.startSample(); // teste cette balle sans lancer/modifier tout l'exercice enregistre
}

// Exercice en alternance (ex. "une balle a gauche, une a droite" en boucle) : contrairement a
// sendShot() (une balle isolee via SetBallProperties+StartSample), on charge un vrai programme
// multi-balles via SetAllBalls puis StartPlay -- confirme par capture reelle (2026-07-06) que le
// robot boucle nativement entre les positions actives tant que le keep-alive tourne (cf. robot.js).
const PATTERN_MIN_POSITIONS = 2;
const PATTERN_MAX_POSITIONS = 10; // SetAllBalls n'a que 10 emplacements (cf. PROTOCOL.md)

async function sendPattern(positions) {
  if (!Array.isArray(positions) || positions.length < PATTERN_MIN_POSITIONS) {
    throw new Error(`Pattern: au moins ${PATTERN_MIN_POSITIONS} positions requises`);
  }
  if (positions.length > PATTERN_MAX_POSITIONS) {
    throw new Error(`Pattern: ${PATTERN_MAX_POSITIONS} positions maximum`);
  }
  const balls = positions.map(({ shot_type, zone }) => {
    const zoneKey = resolveZoneKey(shot_type, zone);
    const placeApp = ZONES[zoneKey];
    if (placeApp === undefined) throw new Error(`Zone inconnue: ${shot_type}/${zone}`);
    return {
      state: BALL_STATE.ENABLED,
      place: placeAppToWire(placeApp),
      sector: placeAppToWire(placeApp),
      ...DEFAULT_SHOT_PARAMS,
    };
  });
  await robot.setAllBalls(balls);
  await robot.startPlay(START_PLAY_MODE.NORMAL);
}
