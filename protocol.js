// Protocole BLE du robot Butterfly Amicus Prime.
// Reverse-engineered dans PROTOCOL.md (capture BLE + decompile de l'app officielle).

export const SERVICE_UUID = 'a7bdef44-a80c-11e7-abc4-cec278b6b50a';
export const CHARACTERISTIC_UUID = 'a7bdf2aa-a80c-11e7-abc4-cec278b6b50a';

export const CMD = {
  AMICUS_MODE: 0x05,
  SELECT_BALL: 0x11,
  SET_BALL_PROPERTIES: 0x12,
  SET_ALL_BALLS: 0x14,
  START_PLAY: 0x20,
  STOP_PLAY: 0x21,
  SET_BALL_PER_MIN: 0x22,
  START_SAMPLE: 0x23,
  SET_GLOBAL_CYCLE: 0x27,
  START_CLUSTER_MEMORY_PLAY: 0x29,
  GET_BALL_PER_MIN: 0x2b,
  PLAYING_BALL: 0x2c,
};

export const AMICUS_MODE = {
  0: 'STEPPER_MOTOR_INITIALIZATION',
  1: 'HEAD_MOTOR_INITIALIZATION',
  2: 'STOPPED',
  3: 'PLAYING',
  4: 'STOPPING',
  7: 'BALL_JAMMED_FIRST',
  8: 'BALL_JAMMED_REVERSE',
  9: 'BALL_JAMMED_FORWARD',
  10: 'BALL_PERMANENTLY_JAMMED',
  11: 'CYCLE_WAIT_MODE',
  15: 'WAITING_FOR_SERVER',
  64: 'BOOTLOADER_MODE',
};

export const START_PLAY_MODE = { NORMAL: 0, CYCLE: 1, WAIT: 2 };
export const BALL_STATE = { DISABLED: 0, ENABLED: 1, SERVE: 2, UNCHANGED: 255 };

/** Construit une trame [0x2a][len][0x00][cmdId][payload...] (len = 4 + payload.length, auto-inclusif). */
export function buildFrame(cmdId, payload = []) {
  const len = 4 + payload.length;
  if (len > 255) throw new Error(`Frame too long: ${len} bytes`);
  return new Uint8Array([0x2a, len, 0x00, cmdId, ...payload]);
}

/** Clamp générique utilisé par le protocole : 255 = "inchangé", sinon doit être dans 0..max. */
function clampOrUnchanged(value, max) {
  if (value === 255) return 255;
  const v = Math.round(value);
  if (v < 0 || v > max) throw new Error(`Value ${v} must be in range 0..${max} (or 255)`);
  return v;
}

/** Encode place+sector sur un seul octet (formule moyenne/ecart deduite du code decompile). */
export function encodePlaceSector(place, sector) {
  const p = Math.max(0, Math.min(16, place));
  const s = Math.max(0, Math.min(16, sector));
  const mean = Math.round((p + s) / 2);
  const diff = Math.round(Math.abs(p - s) / 2);
  return (Math.max(0, Math.min(7, diff)) << 5) | Math.max(0, Math.min(31, mean));
}

/**
 * Convertit un `place` cote app (-8 = revers/extreme gauche .. 0 = milieu .. +8 = coup droit/extreme
 * droite, cf. manuel utilisateur officiel) vers l'octet fil 0..16. Formule confirmee par capture BLE
 * reelle le 2026-07-06 (place_fil = place_app + 8), valable pour un placement ponctuel (sans zone
 * "sector" -- cf. PROTOCOL.md).
 */
export function placeAppToWire(placeApp) {
  return Math.max(0, Math.min(16, Math.round(placeApp) + 8));
}

/**
 * Encode le descripteur d'une balle (8 octets). Valeurs par defaut = 0 (slot inactif si state=DISABLED,
 * pour matcher les slots de remplissage observes dans les captures reelles).
 * NB: place/sector, trajectoryLow/High, spin/sideSpin/speed, ballPerMin-preset ne sont pas encore calibres
 * empiriquement (cf. PROTOCOL.md, section "reste a valider") -- a ajuster une fois testes sur le vrai robot.
 */
export function encodeBall({
  state = BALL_STATE.DISABLED,
  trajectoryLow = 0,
  trajectoryHigh = 0,
  spin = 0,
  sideSpin = 0,
  speed = 0,
  place = 0,
  sector = 0,
  ballPerMinPreset = 0,
} = {}) {
  return [
    state,
    clampOrUnchanged(trajectoryLow, 175),
    clampOrUnchanged(trajectoryHigh, 255),
    clampOrUnchanged(spin, 12),
    clampOrUnchanged(sideSpin, 12),
    clampOrUnchanged(speed, 24),
    encodePlaceSector(place, sector),
    clampOrUnchanged(ballPerMinPreset, 12),
  ];
}

/** SetAllBalls attend toujours un tableau fixe de 10 balles (cf. PROTOCOL.md). Complete avec des slots DISABLED. */
export function buildSetAllBallsFrame(balls) {
  if (balls.length > 10) throw new Error('SetAllBalls: max 10 balls');
  const slots = [...balls];
  while (slots.length < 10) slots.push(encodeBall({ state: BALL_STATE.DISABLED }));
  const payload = [0x00, ...slots.flatMap((b) => (Array.isArray(b) ? b : encodeBall(b)))];
  return buildFrame(CMD.SET_ALL_BALLS, payload);
}

export function buildStartPlayFrame(mode = START_PLAY_MODE.NORMAL) {
  return buildFrame(CMD.START_PLAY, [mode]);
}

export function buildStopPlayFrame() {
  return buildFrame(CMD.STOP_PLAY);
}

export function buildSetBallPerMinFrame(ballsPerMinute) {
  const v = Math.max(0, Math.min(255, Math.round(ballsPerMinute)));
  return buildFrame(CMD.SET_BALL_PER_MIN, [v]);
}

export function buildGetBallPerMinFrame() {
  return buildFrame(CMD.GET_BALL_PER_MIN);
}

export function buildGetAmicusModeFrame() {
  return buildFrame(CMD.AMICUS_MODE);
}

export function buildSetGlobalCycleFrame(cycleState, playOrRepeat, pause) {
  return buildFrame(CMD.SET_GLOBAL_CYCLE, [cycleState, playOrRepeat & 0xff, pause & 0xff]);
}

/** SelectBall : synchronise l'UI/le robot sur le slot edite (1..10). Pas indispensable avant SetBallProperties
 * (qui porte deja son propre index), mais observe dans les captures reelles avant chaque edition. */
export function buildSelectBallFrame(ballNumber) {
  if (ballNumber < 1 || ballNumber > 10) throw new Error('SelectBall: ballNumber must be in 1..10');
  return buildFrame(CMD.SELECT_BALL, [ballNumber]);
}

/**
 * Met a jour une seule balle du programme (slot 1..10) sans re-uploader les 10 (contrairement a
 * SetAllBalls). C'est la commande la plus adaptee pour "tire une balle a tel endroit" a la voix :
 * combinee a StartSample, elle ne modifie pas l'exercice enregistre en memoire.
 */
export function buildSetBallPropertiesFrame(slotIndex, ball) {
  if (slotIndex < 1 || slotIndex > 10) throw new Error('SetBallProperties: slotIndex must be in 1..10');
  const descriptor = Array.isArray(ball) ? ball : encodeBall(ball);
  return buildFrame(CMD.SET_BALL_PROPERTIES, [slotIndex, ...descriptor]);
}

/** StartSample : teste une balle avec les reglages courants (bouton "Sample" du manuel), sans lancer
 * tout l'exercice ni modifier le programme enregistre. */
export function buildStartSampleFrame() {
  return buildFrame(CMD.START_SAMPLE);
}

/**
 * Reassemble un flux d'indications BLE fragmentees en trames logiques completes.
 * Le firmware du robot fragmente systematiquement (meme les petites trames) en decoupant
 * le premier octet (0x2a) puis le reste ; on gere aussi le cas non fragmente par securite.
 * Utilise le prefixe [0x2a][len] pour savoir ou une trame se termine.
 */
export class FrameReassembler {
  constructor() {
    this.buffer = [];
  }

  /** @param {Uint8Array|number[]} chunk - un fragment recu (characteristicvaluechanged) */
  push(chunk) {
    this.buffer.push(...chunk);
    const frames = [];
    while (this.buffer.length >= 2 && this.buffer[0] === 0x2a) {
      const len = this.buffer[1];
      if (this.buffer.length < len) break; // trame pas encore complete
      frames.push(new Uint8Array(this.buffer.slice(0, len)));
      this.buffer = this.buffer.slice(len);
    }
    // si le buffer ne commence pas par 0x2a (desync), on le vide pour eviter de bloquer indefiniment
    if (this.buffer.length && this.buffer[0] !== 0x2a) this.buffer = [];
    return frames;
  }
}

/** Parse une trame complete en objet {cmdId, ...}. */
export function parseFrame(frame) {
  if (frame.length < 4) return { cmdId: null, raw: frame };
  const cmdId = frame[3];
  if (cmdId === CMD.AMICUS_MODE && frame.length >= 5) {
    const value = frame[4];
    return { cmdId, type: 'AmicusMode', value, name: AMICUS_MODE[value] ?? `UNKNOWN(${value})` };
  }
  if (cmdId === CMD.PLAYING_BALL && frame.length >= 8) {
    return {
      cmdId,
      type: 'PlayingBall',
      ballNumber: frame[4],
      remainingTimeMs: frame[5] + (frame[6] << 8),
      baseMemory: frame[7],
    };
  }
  if (cmdId === CMD.GET_BALL_PER_MIN && frame.length >= 5) {
    return { cmdId, type: 'BallPerMin', value: frame[4] };
  }
  return { cmdId, type: 'Generic', raw: frame };
}
