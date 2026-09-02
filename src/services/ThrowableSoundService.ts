/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SOUND SERVICE — Per-Item Procedural SFX (2026-08-20, v2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style audio: every one of the 49 throwables has its own impact
 * sound, synthesized in real time with the Web Audio API — no audio files.
 *
 * Three moments per throw:
 *   playLaunch(weight, pan)         whoosh as the item leaves the thrower
 *   playFlight(id, durationMs, pan) optional per-item travel sound
 *                                   (bomb fuse, rocket engine, ufo hover,
 *                                   chicken flap, ghost moan, firework whistle)
 *   playImpact(soundKey, weight, pan) item-specific landing SFX
 *
 * v2 upgrades:
 *   - MASTER BUS: every voice routes through a shared GainNode into a
 *     DynamicsCompressor, so simultaneous throws sum without clipping.
 *   - STEREO POSITIONING: callers pass the impact's normalized screen X
 *     (-1..1); a StereoPanner places each SFX where it lands.
 *   - HUMANIZATION: every oscillator gets ±14 cents of random detune and
 *     every voice ±8% gain variance, so repeated throws never sound
 *     machine-identical. (Cents-scale detune keeps chords in tune.)
 *
 * ARCHITECTURE NOTE — this deliberately does NOT live inside SoundService.ts
 * (the table-tier engine). It follows the same three-tier separation as
 * PremiumSFX: its own AudioContext, but it DEFERS to SoundService for the
 * enable flag and volume levels so the user's existing sound settings govern
 * throwables too. Haptics reuse the shared `haptic` patterns.
 */

import { soundService, haptic } from './SoundService';
import type { ThrowWeight } from './ThrowableService';

type Wave = OscillatorType;

class ThrowableSoundServiceClass {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  /** Per-voice output set at the start of each play*() call (panner → bus). */
  private out: AudioNode | null = null;
  private unlockInstalled = false;

  /**
   * SOUND AUDIT 2026-08-27: this context is created lazily at the FIRST throw
   * — which, for a spectator, is an INCOMING broadcast, not a gesture. On
   * mobile the context is then born 'suspended', the fire-and-forget resume()
   * in ensureContext is rejected, and nothing retried: every subsequent throw
   * landed silently. Mirror SoundService's unlock pattern — resume on the
   * next user gesture and whenever the tab returns to the foreground.
   */
  private installUnlockListeners() {
    if (this.unlockInstalled || typeof window === 'undefined') return;
    this.unlockInstalled = true;
    const tryResume = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
    };
    window.addEventListener('pointerdown', tryResume, { passive: true });
    window.addEventListener('touchstart', tryResume, { passive: true });
    window.addEventListener('keydown', tryResume);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tryResume();
    });
  }

  private ensureContext(): boolean {
    if (!soundService.isEnabled()) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        // Master chain: bus → compressor → speakers. The compressor is a
        // safety limiter: three bombs landing together squash gracefully
        // instead of hard-clipping the DAC.
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 12;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.12;
        comp.connect(this.ctx.destination);
        this.bus = this.ctx.createGain();
        this.bus.gain.value = 1;
        this.bus.connect(comp);
      }
      this.installUnlockListeners();
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return !!this.bus;
    } catch {
      return false;
    }
  }

  private get volume(): number {
    return soundService.getMasterVolume() * soundService.getEffectsVolume();
  }

  /**
   * Route the next voice through a stereo panner at `pan` (-1 left … 1 right).
   * Every primitive connects to `this.out`.
   */
  private setVoice(pan: number) {
    if (!this.ctx || !this.bus) return;
    const clamped = Math.max(-0.8, Math.min(0.8, pan || 0));
    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = clamped;
      panner.connect(this.bus);
      this.out = panner;
    } else {
      this.out = this.bus; // Older WebKit: mono fallback
    }
  }

  /** ±8% per-voice gain variance so repeats never sound stamped-out. */
  private humanGain(vol: number): number {
    return vol * (0.92 + Math.random() * 0.16) * this.volume;
  }

  /** ±14 cents detune — organic, never sour. */
  private humanDetune(osc: OscillatorNode) {
    try {
      osc.detune.value = (Math.random() - 0.5) * 28;
    } catch {
      /* detune unsupported — fine */
    }
  }

  // ─── Synth primitives (all route through this.out) ──────────────────────────

  /** Single tone with optional pitch glide. */
  private tone(
    freq: number,
    dur: number,
    vol: number,
    type: Wave = 'sine',
    glideTo?: number,
    delay = 0
  ) {
    if (!this.ctx || !this.out) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    this.humanDetune(osc);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t0 + dur);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(this.humanGain(vol), t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Filtered noise burst (splats, crashes, fizz). */
  private noise(
    dur: number,
    vol: number,
    filterFreq = 1000,
    filterType: BiquadFilterType = 'lowpass',
    delay = 0,
    q = 1
  ) {
    if (!this.ctx || !this.out) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq * (0.94 + Math.random() * 0.12);
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(this.humanGain(vol), t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.out);
    src.start(t0);
  }

  /** Filtered noise with a moving filter — risers, engines, gusts. */
  private noiseSweep(
    dur: number,
    vol: number,
    fromFreq: number,
    toFreq: number,
    filterType: BiquadFilterType = 'bandpass',
    delay = 0,
    q = 1
  ) {
    if (!this.ctx || !this.out) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(Math.max(40, fromFreq), t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, toFreq), t0 + dur);
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(this.humanGain(vol), t0 + Math.min(0.05, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.out);
    src.start(t0);
  }

  /** Low sine thump with pitch drop (impacts, booms). */
  private thump(freq: number, dur: number, vol: number, delay = 0) {
    this.tone(freq, dur, vol, 'sine', freq * 0.3, delay);
  }

  /** Quick ascending/descending note run. */
  private run(freqs: number[], noteDur: number, vol: number, type: Wave = 'sine', gap = 0.06) {
    freqs.forEach((f, i) => this.tone(f, noteDur, vol, type, undefined, i * gap));
  }

  /** FM warble (ufo/alien/robot). */
  private warble(
    carrier: number,
    modFreq: number,
    modDepth: number,
    dur: number,
    vol: number,
    delay = 0
  ) {
    if (!this.ctx || !this.out) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = carrier;
    this.humanDetune(osc);
    mod.type = 'sine';
    mod.frequency.value = modFreq;
    modGain.gain.value = modDepth;
    mod.connect(modGain).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(this.humanGain(vol), t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    mod.start(t0);
    mod.stop(t0 + dur + 0.05);
  }

  // ─── Launch (flight start) ───────────────────────────────────────────────────

  /** Whoosh as the throwable leaves the sender — weight scales the heft. */
  playLaunch(weight: ThrowWeight = 'medium', pan = 0) {
    if (!this.ensureContext()) return;
    this.setVoice(pan);
    const base = weight === 'heavy' ? 500 : weight === 'medium' ? 900 : 1400;
    const vol = weight === 'heavy' ? 0.22 : 0.15;
    // Doppler-ish falling gust
    this.noiseSweep(0.24, vol, base * 1.4, base * 0.5, 'bandpass', 0, 0.8);
    this.tone(base * 0.5, 0.2, vol * 0.5, 'sine', base * 0.22);
    haptic.light();
  }

  // ─── Flight (travel loop for the drama items) ────────────────────────────────

  /**
   * Per-item travel sound, scheduled to span the flight. Only items where a
   * travel sound reads clearly get one — everything else keeps the whoosh.
   */
  playFlight(throwableId: string, durationMs: number, pan = 0) {
    if (!this.ensureContext()) return;
    const dur = Math.min(1.4, Math.max(0.25, durationMs / 1000));
    this.setVoice(pan);
    try {
      switch (throwableId) {
        case 'bomb': // burning fuse all the way down
          this.noiseSweep(dur, 0.07, 5200, 6800, 'highpass', 0, 0.5);
          break;
        case 'rocket': // engine roar rising
          this.noiseSweep(dur, 0.16, 300, 950, 'bandpass', 0, 0.8);
          this.tone(120, dur, 0.1, 'sawtooth', 260);
          break;
        case 'ufo': // hover throb
          this.warble(650, 8, 220, dur, 0.1);
          break;
        case 'ghost': // rising moan
          this.warble(420, 4, 60, dur, 0.08);
          break;
        case 'chicken': // panicked wing flutter
          for (let d = 0; d < dur - 0.05; d += 0.09) {
            this.noise(0.04, 0.08, 2400, 'bandpass', d, 1.8);
          }
          break;
        case 'fireworks': // classic rising whistle
          this.tone(400, dur, 0.09, 'sine', 1400);
          break;
        case 'lightning_bolt': // crackling static approach
          this.noiseSweep(dur, 0.08, 2000, 6000, 'highpass', 0, 0.6);
          break;
        default:
          break;
      }
    } catch {
      /* audio is best-effort */
    }
  }

  // ─── Impact recipes (one per sound key) ──────────────────────────────────────

  playImpact(soundKey: string, weight: ThrowWeight = 'medium', pan = 0) {
    if (!this.ensureContext()) return;
    this.setVoice(pan);
    const recipe = this.recipes[soundKey] || this.recipes.splat_wet;
    try {
      recipe();
    } catch {
      /* audio is best-effort */
    }
    if (weight === 'heavy') haptic.throwImpact();
    else haptic.light();
  }

  private recipes: Record<string, () => void> = {
    // ── Reactions ──
    pop_up: () => {
      this.noise(0.02, 0.18, 2800, 'bandpass', 0, 2.5); // bright pop
      this.run([523, 659, 784], 0.12, 0.2, 'triangle');
      this.tone(2093, 0.18, 0.08, 'sine', undefined, 0.24); // sparkle on top
    },
    pop_down: () => {
      this.run([392, 330, 262], 0.12, 0.2, 'triangle');
      this.tone(240, 0.22, 0.1, 'sine', 110, 0.2); // deflating slide
      this.thump(90, 0.12, 0.14, 0.4); // ...flump
    },
    giggle: () => {
      // Dan: LOL uses a laughing voice-over; this is just the breath under it.
      this.run([620, 540, 620, 540], 0.05, 0.12, 'square', 0.075);
      this.run([700, 590, 700], 0.05, 0.1, 'square', 0.075);
    },
    weep: () => {
      // Dan: real tears + crying sound (the sob itself is spoken).
      this.tone(500, 0.5, 0.13, 'sine', 250);
      this.noise(0.35, 0.05, 2500, 'highpass', 0.1);
      this.noise(0.06, 0.1, 1800, 'bandpass', 0.55, 2);
      // tears running down
      [0.4, 0.62, 0.85, 1.05].forEach((d) => this.tone(900, 0.1, 0.05, 'sine', 380, d));
    },
    growl: () => {
      // Dan: angry explosion when it hits.
      // Dan: EXPLODE with rage.
      this.tone(88, 0.45, 0.3, 'sawtooth', 55);
      this.tone(94, 0.45, 0.2, 'sawtooth', 58);
      this.noise(0.05, 0.34, 1200, 'lowpass');
      this.thump(60, 0.4, 0.32, 0.04);
      this.noise(0.02, 0.26, 4800, 'highpass', 0.3);
      this.noise(0.5, 0.1, 300, 'lowpass', 0.1);
    },
    smooth: () => {
      // Dan: dance around with an upbeat sound.
      // Dan: upbeat, danceable.
      this.noiseSweep(0.16, 0.08, 3200, 900, 'bandpass', 0, 1.4);
      const groove = [523, 659, 784, 659, 880, 784];
      groove.forEach((f, i) => this.tone(f, 0.13, 0.13, 'triangle', undefined, 0.12 + i * 0.14));
      [0, 0.28, 0.56, 0.84].forEach((d) => this.thump(70, 0.12, 0.18, d + 0.12));
      [0.19, 0.47, 0.75].forEach((d) => this.noise(0.025, 0.08, 7000, 'highpass', d + 0.12));
    },
    kiss: () => {
      // Dan: loving sound effect, bursting.
      // Dan: EXPLODE with love.
      this.noise(0.07, 0.16, 3000, 'bandpass', 0, 2);
      this.run([523, 659, 784, 1047], 0.22, 0.13, 'sine', 0.07);
      this.tone(1319, 0.5, 0.09, 'sine', undefined, 0.3);
      this.tone(1568, 0.5, 0.07, 'sine', undefined, 0.34);
      [0.3, 0.42, 0.55].forEach((d, i) =>
        this.tone(2093 + i * 400, 0.18, 0.07, 'triangle', undefined, d)
      );
    },
    twinkle: () => {
      // Dan: star should explode and dance.
      // Dan asked for "the Nintendo star sound". Deliberately NOT a copy of
      // that jingle - reproducing a recognisable brand asset is not ours to
      // ship. This is an original rising power-up arpeggio in the same spirit:
      // fast ascending triangle runs with a shimmer tail.
      const run1 = [523, 659, 784, 1047, 1319, 1568];
      run1.forEach((f, i) => this.tone(f, 0.09, 0.15, 'triangle', undefined, i * 0.055));
      const run2 = [659, 784, 1047, 1319, 1568, 2093];
      run2.forEach((f, i) => this.tone(f, 0.09, 0.13, 'triangle', undefined, 0.34 + i * 0.055));
      this.tone(2637, 0.35, 0.12, 'triangle', undefined, 0.68);
      this.noiseSweep(0.5, 0.05, 6000, 11000, 'highpass', 0.1, 0.5);
    },

    // ── Throws ──
    splat_wet: () => {
      // Dan: a real SPLAT. Sharp burst, wet body, then juice running off.
      this.noise(0.02, 0.34, 3000, 'highpass');
      this.noise(0.2, 0.34, 700, 'lowpass');
      this.thump(140, 0.16, 0.24);
      this.noise(0.4, 0.12, 380, 'lowpass', 0.1);
      [0.18, 0.24, 0.31, 0.4].forEach((d) => this.noise(0.03, 0.08, 1800, 'bandpass', d, 2));
    },
    egg_crack: () => {
      // Dan: hear a CRACK when it lands, then it runs down them.
      this.noise(0.025, 0.36, 5200, 'highpass');
      this.noise(0.02, 0.24, 4200, 'highpass', 0.05);
      this.noise(0.16, 0.22, 700, 'lowpass', 0.07);
      this.thump(170, 0.12, 0.16, 0.07);
      // the white running down the villain
      this.tone(300, 0.9, 0.07, 'sine', 90, 0.16);
      this.noise(0.7, 0.05, 420, 'lowpass', 0.2);
    },
    slip: () => {
      this.tone(900, 0.25, 0.16, 'sine', 200); // slide-whistle down
      this.thump(120, 0.1, 0.18, 0.22); // pratfall
      this.tone(260, 0.28, 0.14, 'sine', 520, 0.3); // cartoon boi-oing up
      this.tone(520, 0.18, 0.08, 'sine', 380, 0.5); // ...and settle
    },
    splat_cheese: () => {
      // Dan: it should SMEAR over them (the 'uh oh' is spoken separately).
      this.noise(0.16, 0.3, 620, 'lowpass');
      this.thump(130, 0.16, 0.22);
      // the smear: a long low drag across them
      this.noiseSweep(0.75, 0.12, 900, 260, 'lowpass', 0.08, 0.6);
      this.tone(260, 0.6, 0.07, 'sine', 80, 0.1);
    },
    splat_heavy: () => {
      this.thump(100, 0.2, 0.3);
      this.noise(0.2, 0.3, 500, 'lowpass');
      this.noise(0.15, 0.1, 900, 'lowpass', 0.12);
      // frosting shlop: a second, wetter splat sliding off
      this.noise(0.18, 0.14, 350, 'lowpass', 0.26);
      this.tone(180, 0.2, 0.07, 'sine', 70, 0.26);
    },
    splat_gross: () => {
      // Dan: PEE-YEW. Wet landing, then a lingering waft under the spoken line.
      this.noise(0.2, 0.3, 340, 'lowpass');
      this.thump(85, 0.2, 0.24);
      // the stink itself: a slow wobbling waft
      this.warble(220, 5, 90, 1.1, 0.06, 0.15);
      this.warble(380, 26, 55, 0.5, 0.05, 0.2);
    },
    squirt: () => {
      // Dan: sprays water and SOAKS them.
      this.tone(900, 0.02, 0.14, 'square');
      this.tone(700, 0.02, 0.12, 'square', undefined, 0.045);
      // the spray itself, sustained
      this.noiseSweep(0.75, 0.2, 2800, 900, 'bandpass', 0.07, 1.2);
      // soaking: heavy water hitting and running off
      this.noise(0.3, 0.18, 900, 'lowpass', 0.5);
      this.noiseSweep(0.9, 0.1, 700, 220, 'lowpass', 0.6, 0.7);
      [0.7, 0.82, 0.95, 1.08].forEach((d) => this.noise(0.04, 0.07, 1500, 'bandpass', d, 2));
    },
    punch: () => {
      // Dan: TWO gloves beating them up, then 'K O' spoken over the top.
      this.noise(0.015, 0.34, 5000, 'highpass');
      this.thump(115, 0.14, 0.36);
      this.noise(0.06, 0.3, 1500, 'lowpass');
      // second glove
      this.noise(0.015, 0.3, 4600, 'highpass', 0.19);
      this.thump(100, 0.15, 0.34, 0.19);
      this.noise(0.06, 0.26, 1400, 'lowpass', 0.19);
      this.tone(150, 0.22, 0.1, 'sawtooth', 70, 0.3);
    },
    anvil_clang: () => {
      // Dan: it SQUISHES them. Clang on top, compression underneath.
      this.tone(220, 0.55, 0.3, 'square', 208);
      this.tone(554, 0.45, 0.15, 'square', 540);
      this.thump(62, 0.4, 0.4);
      this.noise(0.08, 0.3, 3000, 'highpass');
      // the squish underneath it
      this.noiseSweep(0.5, 0.14, 700, 180, 'lowpass', 0.06, 0.7);
      this.noise(0.6, 0.12, 150, 'lowpass', 0.14);
    },
    metal_crash: () => {
      // Dan: lid off, then SLAMS closed ('stinky' is spoken separately).
      this.noise(0.3, 0.3, 2600, 'bandpass', 0, 0.6);
      this.thump(85, 0.22, 0.26);
      // the lid coming down and slamming shut
      this.tone(330, 0.18, 0.2, 'square', 300, 0.22);
      this.noise(0.05, 0.34, 2200, 'bandpass', 0.34, 1.2);
      this.tone(210, 0.3, 0.16, 'square', 195, 0.34);
      this.warble(300, 30, 120, 0.4, 0.07, 0.4);
    },
    snow_poof: () => {
      // Dan: 5 snowballs, 5 different impacts.
      // Dan: morphs into 5 snowballs, 5 DIFFERENT impact sounds.
      const hits = [
        { d: 0.0, f: 1400, t: 620 },
        { d: 0.13, f: 1000, t: 380 },
        { d: 0.27, f: 1800, t: 800 },
        { d: 0.42, f: 820, t: 300 },
        { d: 0.58, f: 1250, t: 500 },
      ];
      hits.forEach((h, i) => {
        this.noise(0.09 + i * 0.01, 0.2, h.f, 'lowpass', h.d);
        this.thump(h.t, 0.09, 0.16, h.d);
      });
      this.run([2637, 3136, 3951], 0.16, 0.06, 'sine', 0.09);
    },
    magnet_clink: () => {
      // Dan: extracting chips, clinking as they hit the magnet.
      // Dan: pulls imaginary chips out of them; each chip CLINKS on the magnet.
      this.warble(280, 45, 130, 0.5, 0.11);
      const chips = [0.12, 0.22, 0.3, 0.4, 0.52, 0.63, 0.75];
      chips.forEach((d, i) => {
        this.tone(1500 + (i % 4) * 260, 0.05, 0.16, 'square', undefined, d);
        this.tone(2600 + (i % 3) * 300, 0.03, 0.08, 'triangle', undefined, d + 0.01);
      });
      this.thump(190, 0.1, 0.12, 0.8);
    },

    // ── Sports ──
    ball_bounce: () => {
      // Dan: swoosh when it lands.
      // Dan: a SWOOSH, like a clean net.
      this.noiseSweep(0.26, 0.17, 5200, 1600, 'bandpass', 0, 0.8);
      this.thump(170, 0.12, 0.22, 0.16);
      this.thump(170, 0.08, 0.13, 0.32);
      this.thump(170, 0.05, 0.07, 0.45);
    },
    football_hit: () => {
      // Dan: through the posts, roaring crowd.
      this.noiseSweep(0.14, 0.11, 1700, 700, 'bandpass', 0, 1.2);
      this.thump(125, 0.16, 0.28);
      this.noise(0.08, 0.2, 1000, 'lowpass');
      this.tone(2600, 0.32, 0.08, 'sine', undefined, 0.18);
      // roaring crowd swelling behind "IT'S GOOD"
      this.noiseSweep(1.5, 0.16, 400, 1400, 'bandpass', 0.22, 0.35);
      this.noiseSweep(1.2, 0.1, 1600, 500, 'bandpass', 0.5, 0.4);
    },
    tennis_pop: () => {
      // Dan: should whack them like a racket.
      // Dan: a racket WHACK, not a pop.
      this.noise(0.012, 0.4, 3400, 'bandpass', 0, 2.4);
      this.tone(680, 0.09, 0.22, 'triangle', 240);
      this.thump(240, 0.09, 0.2);
      this.noise(0.05, 0.1, 1800, 'bandpass', 0.02, 1.5);
      this.thump(280, 0.06, 0.1, 0.22);
    },
    bowling_strike: () => {
      // Dan: classic bowling, pins, then the STRIKE caption.
      // Dan: rolls across, knocks the pins down, then STRIKE.
      this.noiseSweep(0.5, 0.16, 150, 420, 'lowpass', 0, 0.7);
      this.thump(78, 0.26, 0.36, 0.46);
      [0.5, 0.54, 0.575, 0.61, 0.645, 0.685, 0.73, 0.78, 0.84].forEach((d, i) =>
        this.tone(620 + (i % 5) * 140, 0.05, 0.14, 'square', undefined, d)
      );
      this.noise(0.45, 0.16, 1100, 'lowpass', 0.48);
    },
    lucky_clang: () => {
      // Dan: flies straight and GLOWS on impact.
      this.tone(660, 0.35, 0.22, 'square', 650);
      this.tone(990, 0.3, 0.13, 'square', undefined, 0.07);
      this.run([1319, 1568, 2093, 2637], 0.16, 0.1, 'triangle', 0.07);
      // the glow: a shimmering sustain
      this.noiseSweep(0.9, 0.05, 5000, 9000, 'highpass', 0.15, 0.5);
      this.tone(1568, 0.7, 0.06, 'sine', undefined, 0.3);
    },
    dice_rattle: () => {
      // Dan: dice roll across the table.
      // Dan: rolls across the table.
      const rolls = [0, 0.06, 0.11, 0.17, 0.24, 0.3, 0.38, 0.46, 0.55];
      rolls.forEach((d, i) =>
        this.tone(880 + ((i * 137) % 520), 0.028, 0.13 - i * 0.008, 'square', undefined, d)
      );
      this.thump(240, 0.09, 0.12, 0.62);
      this.tone(1050, 0.025, 0.09, 'square', undefined, 0.7);
    },
    mystic: () => {
      // Dan: shake, then show 'ask again later'.
      // Dan: shakes, then the answer surfaces.
      const shakes = [0, 0.09, 0.18, 0.27, 0.36];
      shakes.forEach((d) => {
        this.noise(0.05, 0.12, 700, 'lowpass', d);
        this.tone(200 + Math.random() * 90, 0.05, 0.09, 'sine', undefined, d);
      });
      this.warble(440, 6, 34, 0.6, 0.12, 0.45);
      this.run([523, 622, 740, 880], 0.16, 0.08, 'sine', 0.1);
      this.thump(70, 0.45, 0.2, 0.75);
    },

    // ── Cheers ──
    glass_fizz: () => {
      // Dan: flies straight in, GLASS CLINK, then 'cheers' spoken.
      this.tone(1568, 0.16, 0.2, 'triangle');
      this.tone(2093, 0.13, 0.14, 'triangle', undefined, 0.03);
      this.tone(1760, 0.12, 0.11, 'triangle', undefined, 0.11);
      this.noise(0.6, 0.08, 5200, 'highpass', 0.1);
      this.tone(180, 0.09, 0.1, 'sine', 320, 0.3);
    },
    cork_pop: () => {
      // Dan: top explodes off, classic pop and fizzle.
      this.noise(0.025, 0.42, 1300, 'bandpass', 0, 3.2);
      this.tone(380, 0.09, 0.24, 'sine', 1000);
      this.tone(1900, 0.16, 0.08, 'sine', 2700, 0.03);
      // fizz pouring out
      this.noise(1.1, 0.11, 6200, 'highpass', 0.06);
      this.noiseSweep(0.8, 0.07, 7000, 3000, 'highpass', 0.2, 0.5);
      this.run([1047, 1319, 1568], 0.13, 0.08, 'triangle', 0.08);
    },
    hot_splash: () => {
      this.noise(0.2, 0.22, 1400, 'bandpass', 0, 1);
      this.tone(500, 0.2, 0.1, 'sine', 250);
      this.noise(0.35, 0.06, 4000, 'highpass', 0.15); // steam hiss
      this.tone(1150, 0.05, 0.1, 'square', undefined, 0.08); // cup clatter
      this.tone(1350, 0.04, 0.07, 'square', undefined, 0.14);
      this.noise(0.3, 0.05, 5200, 'highpass', 0.3); // sizzle on the felt
    },
    cash_count: () => {
      // Dan: raining cash with a hip-hop feel.
      // Dan: it should RAIN on them, over a hip-hop style beat.
      [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3].forEach((d) =>
        this.noise(0.025, 0.13, 3500, 'bandpass', d, 2.5)
      );
      // four-on-the-floor kick + hat under the fluttering bills
      [0, 0.28, 0.56, 0.84].forEach((d) => this.thump(58, 0.16, 0.26, d));
      [0.14, 0.42, 0.7, 0.98].forEach((d) => this.noise(0.03, 0.1, 7000, 'highpass', d));
      [0.28, 0.84].forEach((d) => this.noise(0.06, 0.14, 1900, 'bandpass', d, 1.1));
      this.tone(1319, 0.16, 0.1, 'triangle', undefined, 0.45);
    },
    crystal_chime: () => {
      this.run([2093, 2637, 3136], 0.2, 0.14, 'sine', 0.07);
      this.noise(0.06, 0.15, 6000, 'highpass'); // glassy tick
      this.tone(1047, 0.55, 0.05, 'sine', undefined, 0.1); // deep resonance
      this.tone(4186, 0.3, 0.05, 'sine', undefined, 0.28); // far harmonic ping
    },
    romance: () => {
      // harp glissando up, then a held soft third
      this.run([523, 659, 784, 988, 1319, 1568], 0.2, 0.09, 'sine', 0.07);
      this.tone(988, 0.5, 0.06, 'sine', undefined, 0.45);
      this.tone(1245, 0.5, 0.06, 'sine', undefined, 0.45);
    },
    fanfare: () => {
      // Dan: triumphant winning sound under 'you're the best'.
      this.run([523, 659, 784, 1047], 0.18, 0.17, 'triangle', 0.09);
      [0, 0.18, 0.27].forEach((d) => this.noise(0.04, 0.09, 1800, 'bandpass', d, 1.2));
      this.thump(130, 0.16, 0.13, 0.36);
      this.run([1047, 1319, 1568], 0.24, 0.13, 'triangle', 0.1);
      this.tone(2093, 0.6, 0.09, 'triangle', undefined, 0.62);
      this.noiseSweep(0.7, 0.05, 5000, 9000, 'highpass', 0.4, 0.5);
    },
    firework: () => {
      // Dan: fireworks effects and sounds when it lands.
      // Dan: a proper display, not one bang.
      this.tone(380, 0.4, 0.09, 'sine', 1500);
      this.noise(0.05, 0.36, 1500, 'bandpass', 0.4, 1);
      this.thump(85, 0.28, 0.32, 0.4);
      [0.5, 0.58, 0.67, 0.78, 0.9, 1.02].forEach((d) =>
        this.noise(0.03, 0.11, 4000 + Math.random() * 3500, 'bandpass', d, 3)
      );
      this.noise(0.06, 0.2, 900, 'bandpass', 0.95, 1);
      this.thump(80, 0.24, 0.2, 0.95);
      [1.05, 1.14, 1.24, 1.36].forEach((d) =>
        this.noise(0.03, 0.09, 5000 + Math.random() * 3000, 'bandpass', d, 3)
      );
    },

    // ── Premium ──
    bomb_boom: () => {
      this.thump(55, 0.5, 0.4); // sub BOOM (fuse already burned during flight)
      this.noise(0.4, 0.35, 700, 'lowpass');
      this.noise(0.6, 0.12, 250, 'lowpass', 0.18); // rumble tail
      // debris pattering back down
      [0.45, 0.53, 0.6, 0.68, 0.77].forEach((d) =>
        this.noise(0.025, 0.08, 1200 + Math.random() * 800, 'bandpass', d, 2)
      );
    },
    rocket_boom: () => {
      this.thump(60, 0.45, 0.38);
      this.noise(0.35, 0.3, 800, 'lowpass');
      this.noiseSweep(0.3, 0.12, 1200, 300, 'bandpass', 0.1, 0.8); // debris fall
      this.tone(1500, 0.35, 0.06, 'sine', 500, 0.25); // falling-debris whistle
      this.tone(2800, 0.4, 0.05, 'sine', 2750, 0.45); // hot metal ping
    },
    ufo_warble: () => {
      this.warble(700, 9, 250, 0.55, 0.14);
      this.warble(65, 9, 12, 0.55, 0.16); // sub-bass engine throb underneath
      this.tone(1400, 0.2, 0.1, 'sine', 300, 0.4); // beam-down
    },
    alien_blip: () => {
      this.run([1200, 800, 1500, 900, 1700], 0.06, 0.14, 'square', 0.06);
      this.warble(500, 15, 150, 0.3, 0.08, 0.3);
      this.run([1200, 800, 1500], 0.05, 0.05, 'square', 0.06); // mothership answers, far off
    },
    robo_zap: () => {
      this.tone(200, 0.12, 0.2, 'square', 100);
      this.warble(300, 30, 200, 0.3, 0.12, 0.1);
      this.noise(0.08, 0.2, 3000, 'highpass', 0.12); // spark
      this.tone(880, 0.4, 0.09, 'sawtooth', 110, 0.4); // servo powering down
    },
    ghost_woo: () => {
      this.warble(600, 4, 80, 0.7, 0.13);
      this.tone(900, 0.6, 0.06, 'sine', 400, 0.1);
      this.noiseSweep(0.6, 0.05, 3000, 1200, 'bandpass', 0.05, 0.5); // breathy whisper
    },
    doom_rattle: () => {
      // Dan: eyes flash red when it lands.
      this.tone(108, 0.6, 0.22, 'sawtooth', 76);
      this.tone(115, 0.6, 0.15, 'sawtooth', 80);
      this.thump(64, 0.4, 0.24, 0.04);
      // two red flashes: a stab per flash
      [0.18, 0.46].forEach((d) => {
        this.noise(0.03, 0.2, 3400, 'highpass', d);
        this.tone(1400, 0.12, 0.1, 'square', 900, d);
      });
    },
    thunder: () => {
      // Dan: extra bolts electrocuting them.
      this.noise(0.035, 0.42, 4200, 'highpass');
      this.thump(62, 0.55, 0.4, 0.03);
      this.noise(0.8, 0.2, 300, 'lowpass', 0.1);
      // extra bolts arcing over them
      [0.22, 0.38, 0.55, 0.72].forEach((d, i) => {
        this.noise(0.025, 0.26 - i * 0.04, 5200, 'highpass', d);
        this.tone(2400 - i * 300, 0.06, 0.12, 'square', 700, d);
      });
      // the electrocution buzz
      this.warble(90, 55, 40, 0.9, 0.1, 0.2);
    },
    doge_bark: () => {
      this.tone(400, 0.08, 0.22, 'square', 700);
      this.tone(350, 0.08, 0.22, 'square', 600, 0.16);
      [0.28, 0.36, 0.44].forEach((d) => this.noise(0.05, 0.05, 900, 'bandpass', d, 0.8)); // panting
      this.run([784, 988], 0.1, 0.08, 'triangle', 0.3); // wow
    },
    chomp: () => {
      this.thump(120, 0.12, 0.3);
      this.noise(0.06, 0.28, 1800, 'lowpass');
      this.thump(100, 0.15, 0.25, 0.14); // second bite
      this.noise(0.05, 0.2, 1500, 'lowpass', 0.14);
      this.noise(0.07, 0.1, 900, 'bandpass', 0.24, 0.6); // crunch grit
      this.tone(180, 0.14, 0.09, 'sine', 90, 0.34); // satisfied gulp
    },
    bear_roar: () => {
      this.tone(120, 0.55, 0.3, 'sawtooth', 70);
      this.warble(150, 25, 40, 0.5, 0.15);
      this.thump(80, 0.3, 0.25, 0.1);
      this.thump(95, 0.14, 0.2, 0.42); // chest-beat...
      this.thump(95, 0.14, 0.2, 0.56); // ...chest-beat
    },
    cluck: () => {
      this.run([900, 700, 1000, 750], 0.06, 0.16, 'square', 0.09);
      this.tone(750, 0.16, 0.14, 'square', 1350, 0.36); // indignant SQUAWK
      this.noise(0.15, 0.08, 2500, 'bandpass', 0.42, 1.5); // feather flutter
    },
    squeak: () => {
      this.tone(1400, 0.12, 0.22, 'sine', 2000);
      this.tone(1800, 0.15, 0.18, 'sine', 1100, 0.15); // squeak-squeak
      this.tone(2100, 0.08, 0.1, 'sine', 1600, 0.34); // ...squeak
      this.noise(0.12, 0.1, 900, 'lowpass', 0.42); // sploosh
    },
  };
}

export const throwableSoundService = new ThrowableSoundServiceClass();
export default throwableSoundService;
