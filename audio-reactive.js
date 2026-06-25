/* ════════════════════════════════════════════════════════════════════
   audio-reactive.js  —  Module réactif au son pour overlays OBS
   ────────────────────────────────────────────────────────────────────
   Fournit une API unifiée pour analyser une source audio en temps réel
   (volume global, bandes basses/médiums/aigus, spectre complet, forme
   d'onde, détection de battement) et brancher des callbacks dessus.

   ┌─ SOURCES DISPONIBLES ────────────────────────────────────────────┐
   │                                                                   │
   │  AudioReactive.fromMic()      → ton micro (getUserMedia)          │
   │  AudioReactive.fromDesktop()  → son du bureau / onglet            │
   │                                 (getDisplayMedia, choisit la      │
   │                                  fenêtre + coche "partager l'audio")│
   │  AudioReactive.fromElement(el)→ une balise <audio>/<video> locale │
   │  AudioReactive.fromStream(s)  → un MediaStream déjà obtenu        │
   │                                                                   │
   └───────────────────────────────────────────────────────────────────┘

   ⚠️  IMPORTANT — limites dans OBS :
   Une source navigateur OBS ne peut PAS lire le mixeur audio d'OBS ni
   capturer le son du bureau de façon autonome : aucune API web ne le
   permet. Concrètement :
     • fromMic()      : fonctionne dans OBS si la page est servie en
                        http://localhost (pas en file://) et que l'accès
                        micro est autorisé.
     • fromDesktop()  : ouvre une boîte de dialogue de partage → ne
                        fonctionne donc QUE dans un vrai navigateur, pas
                        dans une source OBS sans interaction.
     • fromElement()  : pour réagir à un son que TU joues dans la page.

   Pour réagir au "son du jeu" dans OBS, l'approche fiable reste le micro
   (qui capte aussi les enceintes si pertinent) ou un montage matériel.

   ──────────────────────────────────────────────────────────────────────
   EXEMPLE D'UTILISATION
   ──────────────────────────────────────────────────────────────────────
     const audio = await AudioReactive.fromMic({ fftSize: 256, smooth: 0.75 });

     audio.onTick(a => {
       const v = a.volume();          // 0..1  volume global lissé
       const bass = a.band('bass');   // 0..1  énergie des basses
       document.body.style.opacity = 0.5 + v * 0.5;
       if (a.beat()) flashSomething();
     });

   ════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* Bornes de fréquences (Hz) pour les 3 bandes — adaptées à 44.1kHz */
  const BANDS = {
    bass:   [20,   250],
    mid:    [250,  2000],
    treble: [2000, 16000],
  };

  /* Vérifie qu'on est dans un contexte où l'API audio existe.
     mediaDevices est undefined en file:// et hors localhost/https. */
  function assertSecureContext() {
    if (!global.navigator || !global.navigator.mediaDevices) {
      throw new Error(
        'API audio indisponible : ouvre la page en http://localhost (PAS file:// ni une IP). ' +
        'Dans OBS, mets l\'URL de la source sur http://localhost:5500/…'
      );
    }
  }

  class AudioReactive {
    constructor(stream, opts = {}) {
      this.opts = Object.assign({
        fftSize:    256,    // 32..32768, puissance de 2 → fftSize/2 bins
        smooth:     0.75,   // lissage natif de l'AnalyserNode (0..1)
        inertia:    0.6,    // lissage logiciel supplémentaire (0..1)
        beatThreshold: 1.35, // ratio énergie instantanée / moyenne pour un beat
      }, opts);

      this.stream   = stream;
      this.ctx      = new (global.AudioContext || global.webkitAudioContext)();
      this.source   = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.opts.fftSize;
      this.analyser.smoothingTimeConstant = this.opts.smooth;

      // Nombre de canaux réellement fournis par le périphérique
      const track = stream.getAudioTracks()[0];
      this.channelCount = (track && track.getSettings && track.getSettings().channelCount) || 2;

      /* opts.channels : indices DE CANAUX (0 = entrée 1, 1 = entrée 2, …).
         Ex : entrées 2 et 4 → [1, 3]. Si absent → tout le flux. */
      const chans = this.opts.channels;
      if (chans && chans.length) {
        const splitter = this.ctx.createChannelSplitter(this.channelCount);
        const mix      = this.ctx.createGain();   // somme des canaux choisis
        this.source.connect(splitter);
        chans.forEach(idx => {
          if (idx < this.channelCount) splitter.connect(mix, idx, 0);
        });
        mix.connect(this.analyser);
        this._splitter = splitter;
        this._mix = mix;
      } else {
        this.source.connect(this.analyser);
      }

      this.binCount  = this.analyser.frequencyBinCount;
      this.freqData  = new Uint8Array(this.binCount);
      this.timeData  = new Uint8Array(this.binCount);
      this.smoothed  = new Float32Array(this.binCount);

      // Volume lissé + historique pour détection de beat
      this._volume    = 0;
      this._volHistory = [];
      this._beat       = false;

      this._callbacks = [];
      this._running   = false;
      this._raf       = null;

      this._loop = this._loop.bind(this);
      this.start();
    }

    /* ── Hz → index de bin ── */
    _hzToBin(hz) {
      const nyquist = this.ctx.sampleRate / 2;
      return Math.min(this.binCount - 1, Math.round(hz / nyquist * this.binCount));
    }

    /* ── Boucle d'analyse ── */
    _loop() {
      if (!this._running) return;
      this._raf = requestAnimationFrame(this._loop);

      this.analyser.getByteFrequencyData(this.freqData);
      this.analyser.getByteTimeDomainData(this.timeData);

      // Lissage logiciel
      const k = this.opts.inertia;
      let sum = 0;
      for (let i = 0; i < this.binCount; i++) {
        this.smoothed[i] = this.smoothed[i] * k + this.freqData[i] * (1 - k);
        sum += this.smoothed[i];
      }

      // Volume global (0..1)
      this._volume = (sum / this.binCount) / 255;

      // Détection de beat — compare l'énergie instantanée à la moyenne récente
      this._volHistory.push(this._volume);
      if (this._volHistory.length > 43) this._volHistory.shift(); // ~0.7s à 60fps
      const avg = this._volHistory.reduce((a, b) => a + b, 0) / this._volHistory.length;
      this._beat = avg > 0.01 && this._volume > avg * this.opts.beatThreshold;

      // Callbacks
      for (const cb of this._callbacks) cb(this);
    }

    /* ═══════════════ API PUBLIQUE ═══════════════ */

    /** Démarre la boucle (auto-appelée au constructeur) */
    start() {
      if (this._running) return this;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._running = true;
      this._raf = requestAnimationFrame(this._loop);
      return this;
    }

    /** Met en pause la boucle d'analyse */
    stop() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      return this;
    }

    /** Coupe tout et libère le micro / la capture */
    destroy() {
      this.stop();
      this.stream.getTracks().forEach(t => t.stop());
      this.ctx.close();
      this._callbacks = [];
    }

    /** Enregistre un callback appelé à chaque frame avec `this` */
    onTick(cb) {
      if (typeof cb === 'function') this._callbacks.push(cb);
      return this;
    }

    /** Volume global lissé, 0..1 */
    volume() { return this._volume; }

    /** Énergie d'une bande : 'bass' | 'mid' | 'treble', 0..1 */
    band(name) {
      const range = BANDS[name];
      if (!range) return 0;
      const lo = this._hzToBin(range[0]);
      const hi = this._hzToBin(range[1]);
      let sum = 0, count = 0;
      for (let i = lo; i <= hi; i++) { sum += this.smoothed[i]; count++; }
      return count ? (sum / count) / 255 : 0;
    }

    /** true sur la frame où un battement est détecté */
    beat() { return this._beat; }

    /** Spectre complet lissé, Float32Array de valeurs 0..1 */
    spectrum() {
      const out = new Float32Array(this.binCount);
      for (let i = 0; i < this.binCount; i++) out[i] = this.smoothed[i] / 255;
      return out;
    }

    /** N premiers bins du spectre (basses+médiums, plus visuels), 0..1 */
    bars(n = 64) {
      const out = new Float32Array(n);
      for (let i = 0; i < n && i < this.binCount; i++) out[i] = this.smoothed[i] / 255;
      return out;
    }

    /** Forme d'onde brute (time domain), valeurs -1..1 */
    waveform() {
      const out = new Float32Array(this.binCount);
      for (let i = 0; i < this.binCount; i++) out[i] = (this.timeData[i] - 128) / 128;
      return out;
    }

    /* ═══════════════ FABRIQUES (statiques) ═══════════════ */

    /** Micro — getUserMedia. Nécessite http(s)/localhost. */
    static async fromMic(opts = {}) {
      assertSecureContext();
      const audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      };
      if (opts.channelCount) audio.channelCount = { ideal: opts.channelCount };
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      return new AudioReactive(stream, opts);
    }

    /** Son du bureau / onglet — getDisplayMedia. Dialogue de partage requis. */
    static async fromDesktop(opts = {}) {
      assertSecureContext();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,        // obligatoire pour que le partage d'audio soit proposé
        audio: true,
      });
      // On coupe la piste vidéo, on ne garde que l'audio
      stream.getVideoTracks().forEach(t => t.stop());
      if (!stream.getAudioTracks().length) {
        throw new Error('Aucune piste audio partagée — coche "Partager l\'audio" dans la boîte de dialogue.');
      }
      return new AudioReactive(stream, opts);
    }

    /** Une balise <audio> / <video> de la page. */
    static fromElement(mediaEl, opts = {}) {
      const ctx      = new (global.AudioContext || global.webkitAudioContext)();
      const source   = ctx.createMediaElementSource(mediaEl);
      const dest      = ctx.createMediaStreamDestination();
      source.connect(dest);
      source.connect(ctx.destination); // pour continuer à entendre le son
      const inst = new AudioReactive(dest.stream, opts);
      inst._ownCtx = ctx; // garde une réf
      return inst;
    }

    /** Un MediaStream déjà obtenu ailleurs. */
    static fromStream(stream, opts = {}) {
      return new AudioReactive(stream, opts);
    }

    /** Capture une entrée audio précise par son deviceId (ex: UA-101). */
    static async fromDevice(deviceId, opts = {}) {
      assertSecureContext();
      const audio = {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      };
      // Demande explicitement plusieurs canaux (UA-101 = jusqu'à 10)
      audio.channelCount = { ideal: opts.channelCount || 8 };
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      return new AudioReactive(stream, opts);
    }

    /**
     * Liste les périphériques d'entrée audio disponibles.
     * Retourne [{ deviceId, label }]. Les labels ne sont peuplés
     * qu'après une première autorisation micro.
     */
    static async listInputs() {
      assertSecureContext();
      // Déclenche l'autorisation si nécessaire pour obtenir les labels
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach(t => t.stop());
      } catch (e) { /* refusé → on liste quand même, sans labels */ }

      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ deviceId: d.deviceId, label: d.label }));
    }
  }

  global.AudioReactive = AudioReactive;

})(typeof window !== 'undefined' ? window : this);
