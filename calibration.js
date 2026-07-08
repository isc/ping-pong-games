// Page de calibration : envoyer une balle avec des valeurs FIL brutes choisies au curseur, pour
// determiner empiriquement le sens (signe) et l'echelle de chaque parametre (cf. app.js WIRE_STEP,
// PROTOCOL.md § "reste a valider"). Une variable a la fois, les autres au neutre/defaut, on tire et
// on regarde ou/comment la balle arrive.
import { AmicusRobot } from './robot.js';
import { BALL_STATE, placeAppToWire, START_PLAY_MODE } from './protocol.js';

// Parametres exposes. `wire:true` = valeur envoyee telle quelle dans le descripteur ; `place` est en
// echelle app (-8..+8) convertie en octet fil a l'envoi. `def` = valeur par defaut (captures 2026-07-06).
const PARAMS = [
  { key: 'place', label: 'place (position G/D, app)', min: -8, max: 8, def: 0, hint: '-8 = extreme gauche · 0 = centre · +8 = extreme droite (CONFIRME)' },
  { key: 'trajectoryLow', label: 'trajectoryLow (hauteur ?)', min: 0, max: 175, def: 92, hint: 'a balayer : est-ce que + = arc plus haut ou plus bas ?' },
  { key: 'trajectoryHigh', label: 'trajectoryHigh (?)', min: 0, max: 255, def: 0, hint: 'role inconnu — tester quelques valeurs' },
  { key: 'speed', label: 'speed (vitesse/puissance)', min: 0, max: 24, def: 12, hint: 'est-ce que + = plus loin/plus fort ?' },
  { key: 'spin', label: 'spin (effet av/ar)', min: 0, max: 12, def: 5, hint: 'neutre attendu = 5 · +=topspin ? −=backspin ?' },
  { key: 'sideSpin', label: 'sideSpin (effet lateral)', min: 0, max: 12, def: 6, hint: 'neutre attendu = 6 · courbe droite/gauche ?' },
];

const state = {};
PARAMS.forEach((p) => (state[p.key] = p.def));

const paramsEl = document.getElementById('params');
const wireEl = document.getElementById('wire');
const stateEl = document.getElementById('state');
const logEl = document.getElementById('log');
const fireBtn = document.getElementById('fire');
const stopBtn = document.getElementById('stoprobot');

// Compteur de balles reellement tirees depuis la derniere pression sur "Tirer" -- pour voir combien de
// balles chaque commande declenche vraiment (notification PlayingBall = une balle partie).
let ballsSinceFire = 0;
// `firing` = on attend la 1ere balle pour couper immediatement (mode "1 balle" via StartPlay).
let firing = false;
const FIRE_CADENCE = 20; // balles/min pendant le tir : ~3s entre balles, le temps de couper a la 2e annonce
const FIRE_TIMEOUT_MS = 6000; // filet de securite si aucune notification PlayingBall n'arrive

function addLog(line) {
  const el = document.createElement('div');
  el.textContent = line;
  logEl.prepend(el);
}

// Descripteur fil courant (8 octets) tel qu'il sera envoye — affiche pour pouvoir noter "tel octet -> tel effet".
function currentBall() {
  return {
    state: BALL_STATE.ENABLED,
    trajectoryLow: state.trajectoryLow,
    trajectoryHigh: state.trajectoryHigh,
    spin: state.spin,
    sideSpin: state.sideSpin,
    speed: state.speed,
    place: placeAppToWire(state.place),
    sector: placeAppToWire(state.place), // pas de zone -> point unique
    ballPerMinPreset: 6,
  };
}

function refreshWire() {
  const b = currentBall();
  wireEl.textContent =
    `fil : trajLow=${b.trajectoryLow} trajHigh=${b.trajectoryHigh} spin=${b.spin} ` +
    `sideSpin=${b.sideSpin} speed=${b.speed} place(fil)=${b.place}`;
}

// Genere une ligne par parametre : curseur + valeur live + presets (min / neutre / max).
for (const p of PARAMS) {
  const row = document.createElement('div');
  row.className = 'row';
  const mid = p.key === 'place' ? 0 : Math.round((p.min + p.max) / 2);
  row.innerHTML = `
    <label><span>${p.label}</span><span class="val" id="val-${p.key}">${state[p.key]}</span></label>
    <input type="range" id="rng-${p.key}" min="${p.min}" max="${p.max}" value="${state[p.key]}" />
    <div class="presets">
      <button data-k="${p.key}" data-v="${p.min}">min ${p.min}</button>
      <button data-k="${p.key}" data-v="${p.def}">déf ${p.def}</button>
      <button data-k="${p.key}" data-v="${mid}">mid ${mid}</button>
      <button data-k="${p.key}" data-v="${p.max}">max ${p.max}</button>
    </div>
    <div class="hint">${p.hint}</div>`;
  paramsEl.appendChild(row);

  const rng = row.querySelector(`#rng-${p.key}`);
  const val = row.querySelector(`#val-${p.key}`);
  rng.addEventListener('input', () => {
    state[p.key] = Number(rng.value);
    val.textContent = state[p.key];
    refreshWire();
  });
  row.querySelectorAll('.presets button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.v);
      state[p.key] = v;
      rng.value = v;
      val.textContent = v;
      refreshWire();
    });
  });
}
refreshWire();

const robot = new AmicusRobot({
  onEvent: (evt) => {
    if (evt.kind === 'connected') {
      addLog(`🔵 Connecte: ${evt.name}`);
      fireBtn.disabled = false;
      stopBtn.disabled = false;
      fireBtn.title = '';
    }
    if (evt.kind === 'disconnected') {
      addLog('⚪ Deconnecte');
      fireBtn.disabled = true;
      stopBtn.disabled = true;
    }
    // Etat du robot en direct (STOPPED/PLAYING/...) : si on voit PLAYING sans avoir tire, c'est qu'un
    // exercice tourne deja (balles fantomes).
    if (evt.kind === 'frame' && evt.type === 'AmicusMode') {
      stateEl.textContent = `état robot : ${evt.name}`;
    }
    // Chaque balle physiquement tiree -> une notification PlayingBall. On compte pour savoir combien de
    // balles part reellement chaque commande.
    if (evt.kind === 'frame' && evt.type === 'PlayingBall') {
      ballsSinceFire++;
      addLog(`  ● balle tiree (#${ballsSinceFire} depuis le dernier "Tirer")`);
      // La notification est ANNONCEE avant le lancer reel : couper dessus avorte la balle (roue qui
      // tourne, rien qui sort). Donc on laisse passer l'annonce de la balle 1 (elle part pour de vrai)
      // et on coupe a l'annonce de la balle 2 (avortee avant de sortir) -> exactement 1 balle lancee.
      if (firing && ballsSinceFire >= 2) {
        firing = false;
        robot.stopPlay().catch(() => {});
        addLog('  ⏹ coupe a la 2e annonce -> 1 seule balle lancee');
      }
    }
  },
});
window.robot = robot; // pour tirer des combinaisons a la main depuis la console si besoin

document.getElementById('connect').addEventListener('click', async () => {
  try {
    await robot.connect();
  } catch (err) {
    addLog(`Erreur connexion: ${err.message}`);
  }
});

// Tire UNE balle avec la combinaison courante. On REPROGRAMME d'abord tout le lot (SetAllBalls) avec
// une seule balle active -- sinon StartSample joue une passe du programme et tire une balle par slot
// encore active (slots laisses par l'app officielle ou un exercice precedent), d'ou "3 balles par tir"
// a des reglages differents = resultats incoherents. buildSetAllBallsFrame remplit les slots 2..10 en
// DISABLED, donc seule notre balle (slot 1) part.
fireBtn.addEventListener('click', async () => {
  const b = currentBall();
  ballsSinceFire = 0; // on veut compter uniquement les balles de CE tir
  try {
    await robot.stopPlay(); // coupe tout exercice residuel qui tournerait encore
    await robot.setAllBalls([b]); // slot 1 = notre balle, slots 2..10 desactives
    await robot.setBallPerMin(FIRE_CADENCE); // lent -> le temps de couper apres la 1ere balle
    firing = true;
    await robot.startPlay(START_PLAY_MODE.NORMAL); // pousse une PlayingBall par balle -> on coupe sur la 1ere
    addLog(
      `🏓 tir demande : trajLow=${b.trajectoryLow} trajHigh=${b.trajectoryHigh} ` +
        `speed=${b.speed} spin=${b.spin} sideSpin=${b.sideSpin} place=${state.place}`
    );
    // Filet de securite : si aucune notification PlayingBall n'arrive, on coupe quand meme.
    setTimeout(() => {
      if (firing) {
        firing = false;
        robot.stopPlay().catch(() => {});
        addLog('  ⏹ (timeout) stopPlay force -- aucune notification PlayingBall recue');
      }
    }, FIRE_TIMEOUT_MS);
  } catch (err) {
    firing = false;
    addLog(`Erreur tir: ${err.message}`);
  }
});

// Coupe le lanceur (utile si le robot s'est mis a jouer un exercice en boucle -> balles en continu).
stopBtn.addEventListener('click', async () => {
  try {
    await robot.stopPlay();
    addLog('⏹ stopPlay envoye');
  } catch (err) {
    addLog(`Erreur stop: ${err.message}`);
  }
});

document.getElementById('reset').addEventListener('click', () => {
  for (const p of PARAMS) {
    state[p.key] = p.def;
    document.getElementById(`rng-${p.key}`).value = p.def;
    document.getElementById(`val-${p.key}`).textContent = p.def;
  }
  refreshWire();
  addLog('↺ valeurs remises aux defauts');
});
