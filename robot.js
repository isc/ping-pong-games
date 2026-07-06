import {
  SERVICE_UUID,
  CHARACTERISTIC_UUID,
  FrameReassembler,
  parseFrame,
  buildStartPlayFrame,
  buildStopPlayFrame,
  buildSetBallPerMinFrame,
  buildGetBallPerMinFrame,
  buildGetAmicusModeFrame,
  buildSetAllBallsFrame,
  buildSelectBallFrame,
  buildSetBallPropertiesFrame,
  buildStartSampleFrame,
  START_PLAY_MODE,
} from './protocol.js';

// Confirme empiriquement le 2026-07-06 : le robot exige un "heartbeat" pendant la lecture continue
// (StartPlay mode NORMAL) -- sans polling regulier, il arrete le lanceur de lui-meme apres ~3 balles
// (mesure de securite probable, coherent avec le fait qu'un iPhone verrouille coupe aussi le robot,
// l'app arretant son activite BLE en arriere-plan). L'app officielle envoie GetAmicusMode (0x05) en
// continu toutes les ~1.6s (valeur mimee au depart, 1500ms). Teste par dichotomie le 2026-07-06 :
// 5000ms OK, 6000ms ECHEC, 10000ms ECHEC -- le vrai seuil est donc entre 5000 et 6000ms, bien plus
// serre qu'on ne le pensait au depart (on avait teste 3000ms en supposant que son "ecart si un appel
// est rate" de 6000ms passerait -- FAUX, invalide par le test direct de 6000ms).
// Et le keep-alive ne fait que MAINTENIR une lecture en cours : si le robot s'est deja arrete (parce
// qu'un beat a ete rate), renvoyer GetAmicusMode ne le relance pas -- il faudrait un vrai StartPlay.
// D'ou **2500ms** : un appel rate a cet intervalle donne un ecart de 5000ms jusqu'au suivant, valeur
// CONFIRMEE fonctionnelle par test direct (contrairement au 3000ms precedent, dont la marge reposait
// sur une hypothese non verifiee).
const KEEP_ALIVE_INTERVAL_MS = 2500;

/** Pilote le robot Amicus via Web Bluetooth. */
export class AmicusRobot {
  constructor({ onEvent } = {}) {
    this.device = null;
    this.characteristic = null;
    this.reassembler = new FrameReassembler();
    this.onEvent = onEvent || (() => {});
    this.lastKnownBallPerMin = null;
    this.lastKnownMode = null;
    this._keepAliveTimer = null;
    this._writeQueue = Promise.resolve();
  }

  get connected() {
    return !!this.characteristic;
  }

  /** Doit etre appele depuis un gestionnaire d'evenement utilisateur (clic/tap), exigence du navigateur. */
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.characteristic = null;
      this._stopKeepAlive();
      this.onEvent({ kind: 'disconnected' });
    });
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
    await this.characteristic.startNotifications();
    this.characteristic.addEventListener('characteristicvaluechanged', (e) => {
      this._handleChunk(new Uint8Array(e.target.value.buffer));
    });
    this.onEvent({ kind: 'connected', name: this.device.name });
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }

  _handleChunk(chunk) {
    for (const frame of this.reassembler.push(chunk)) {
      const parsed = parseFrame(frame);
      if (parsed.type === 'AmicusMode') this.lastKnownMode = parsed.name;
      if (parsed.type === 'BallPerMin') this.lastKnownBallPerMin = parsed.value;
      this.onEvent({ kind: 'frame', ...parsed });
    }
  }

  /**
   * Serialise toutes les ecritures BLE (une seule operation GATT a la fois). Sans ca, le keep-alive
   * (setInterval independant) peut tomber pile pendant l'ecriture d'une commande vocale et l'une des
   * deux echoue avec "GATT operation already in progress" (observe en test reel le 2026-07-06).
   */
  async _write(frame) {
    if (!this.characteristic) throw new Error('Robot not connected');
    const previous = this._writeQueue.catch(() => {});
    const current = previous.then(() => this.characteristic.writeValue(frame));
    this._writeQueue = current.catch(() => {});
    return current;
  }

  async startPlay(mode = START_PLAY_MODE.NORMAL) {
    await this._write(buildStartPlayFrame(mode));
    this._startKeepAlive();
  }

  async stopPlay() {
    this._stopKeepAlive();
    await this._write(buildStopPlayFrame());
  }

  /** Sans ce heartbeat, le robot arrete le lanceur de lui-meme apres ~3 balles (cf. note plus haut). */
  _startKeepAlive() {
    if (this._keepAliveTimer) return;
    this._keepAliveTimer = setInterval(() => {
      this.getAmicusMode().catch((err) => console.log('[Robot] echec keep-alive:', err));
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  async setBallPerMin(ballsPerMinute) {
    await this._write(buildSetBallPerMinFrame(ballsPerMinute));
  }

  /** Lit la cadence courante (attend la reponse via evenement 'frame' de type BallPerMin, avec timeout). */
  async getBallPerMin({ timeoutMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onEvent = prevHandler;
        reject(new Error('GetBallPerMin timeout'));
      }, timeoutMs);
      const prevHandler = this.onEvent;
      this.onEvent = (evt) => {
        prevHandler(evt);
        if (evt.kind === 'frame' && evt.cmdId === 0x2b) {
          clearTimeout(timer);
          this.onEvent = prevHandler;
          resolve(evt.value);
        }
      };
      this._write(buildGetBallPerMinFrame()).catch(reject);
    });
  }

  async getAmicusMode() {
    await this._write(buildGetAmicusModeFrame());
  }

  async setAllBalls(balls) {
    await this._write(buildSetAllBallsFrame(balls));
  }

  async selectBall(ballNumber) {
    await this._write(buildSelectBallFrame(ballNumber));
  }

  async setBallProperties(slotIndex, ball) {
    await this._write(buildSetBallPropertiesFrame(slotIndex, ball));
  }

  /** Teste une balle avec les reglages courants sans lancer tout l'exercice ni le modifier. */
  async startSample() {
    await this._write(buildStartSampleFrame());
  }
}
