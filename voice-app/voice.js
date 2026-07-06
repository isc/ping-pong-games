// Reconnaissance vocale continue (Web Speech API) + synthese pour le retour oral.
// Necessite Chrome/Edge (webkitSpeechRecognition) sur un contexte securise (https ou localhost).

/** La liste des voix se charge de facon asynchrone (evenement 'voiceschanged') la premiere fois. */
function loadVoices() {
  return new Promise((resolve) => {
    const voices = speechSynthesis.getVoices();
    if (voices.length) return resolve(voices);
    speechSynthesis.onvoiceschanged = () => resolve(speechSynthesis.getVoices());
  });
}

/** Choisit une voix francaise ; privilegie une voix cloud "Google" (meilleure qualite) si disponible. */
function pickFrenchVoice(voices) {
  const frVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('fr'));
  console.log('[TTS] voix francaises disponibles:', frVoices.map((v) => `${v.name} (${v.lang})`));
  return frVoices.find((v) => v.name.includes('Google')) || frVoices[0] || null;
}

export class VoiceIO {
  /**
   * @param {object} opts
   * @param {(transcript: string) => void} opts.onTranscript - appele avec chaque phrase finale reconnue
   * @param {(error: string) => void} [opts.onError]
   * @param {string} [opts.lang]
   */
  constructor({ onTranscript, onError, lang = 'fr-FR' }) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) throw new Error('SpeechRecognition non supporte par ce navigateur (utilise Chrome).');
    this.recognition = new SpeechRecognition();
    this.recognition.lang = lang;
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this._onTranscript = onTranscript;
    this._onError = onError || (() => {});
    this._shouldBeListening = false;
    this._speaking = false;
    this._pausedForSpeech = false;

    this.recognition.onresult = (event) => {
      console.log('[STT] onresult', event.results);
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        console.log('[STT] segment', i, 'isFinal=', result.isFinal, 'transcript=', result[0].transcript);
        if (result.isFinal) {
          const transcript = result[0].transcript.trim();
          if (transcript && !this._speaking) this._onTranscript(transcript);
          else if (this._speaking) console.log('[STT] transcript ignore (app en train de parler):', transcript);
        }
      }
    };
    this.recognition.onstart = () => console.log('[STT] onstart (ecoute active)');
    this.recognition.onaudiostart = () => console.log('[STT] onaudiostart (micro recoit du signal)');
    this.recognition.onspeechstart = () => console.log('[STT] onspeechstart (parole detectee)');
    this.recognition.onspeechend = () => console.log('[STT] onspeechend');
    this.recognition.onnomatch = () => console.log('[STT] onnomatch (son detecte mais pas reconnu comme parole)');
    this.recognition.onerror = (event) => {
      console.log('[STT] onerror', event.error);
      // 'no-speech' est benin (silence) : on ne le remonte pas comme une vraie erreur a l'UI
      if (event.error !== 'no-speech') this._onError(event.error);
    };
    // Chrome coupe la reconnaissance "continuous" au bout d'un moment : on la relance automatiquement,
    // SAUF si c'est nous qui l'avons arretee expres pendant que l'app parle (cf. speak()) -- sinon on
    // relance l'ecoute en pleine synthese vocale et elle s'entend elle-meme (effet Larsen / boucle).
    this.recognition.onend = () => {
      const shouldRestart = this._shouldBeListening && !this._pausedForSpeech;
      console.log('[STT] onend, relance =', shouldRestart);
      if (shouldRestart) this.recognition.start();
    };

    this._voice = null;
    loadVoices().then((voices) => {
      this._voice = pickFrenchVoice(voices);
      console.log('[TTS] voix choisie:', this._voice ? `${this._voice.name} (${this._voice.lang})` : '(aucune, fallback lang seul)');
    });
  }

  /** Doit etre appele depuis un geste utilisateur (clic/tap) la premiere fois, exigence navigateur. */
  start() {
    this._shouldBeListening = true;
    this.recognition.start();
  }

  stop() {
    this._shouldBeListening = false;
    this.recognition.stop();
  }

  /**
   * Coupe REELLEMENT la reconnaissance pendant que l'app parle (pas juste un flag ignore), pour
   * eviter qu'elle s'entende elle-meme et reparte en boucle (effet Larsen). La relance explicitement
   * une fois la synthese terminee.
   */
  speak(text) {
    return new Promise((resolve) => {
      if (!text) return resolve();
      this._speaking = true;
      this._pausedForSpeech = true;
      try {
        this.recognition.stop();
      } catch (err) {
        console.log('[TTS] recognition.stop() a echoue (probablement deja arretee):', err);
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.recognition.lang;
      if (this._voice) utterance.voice = this._voice;

      const resume = () => {
        this._speaking = false;
        this._pausedForSpeech = false;
        if (this._shouldBeListening) {
          try {
            this.recognition.start();
          } catch (err) {
            console.log('[STT] echec de la relance apres synthese vocale:', err);
          }
        }
        resolve();
      };
      utterance.onend = resume;
      utterance.onerror = resume;
      speechSynthesis.speak(utterance);
    });
  }
}
