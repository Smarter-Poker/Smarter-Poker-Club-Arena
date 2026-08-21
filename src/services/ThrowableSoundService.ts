/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SOUND SERVICE — Per-Item Procedural SFX (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style audio: every one of the 49 throwables has its own impact
 * sound, synthesized in real time with the Web Audio API — no audio files.
 *
 * Two moments per throw:
 *   playLaunch(weight)   whoosh as the item leaves the thrower's seat
 *   playImpact(soundKey) item-specific landing SFX (splat / boom / quack / …)
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

  private ensureContext(): boolean {
    if (!soundService.isEnabled()) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return true;
    } catch {
      return false;
    }
  }

  private get volume(): number {
    return soundService.getMasterVolume() * soundService.getEffectsVolume();
  }

  // ─── Synth primitives ────────────────────────────────────────────────────────

  /** Single tone with optional pitch glide. */
  private tone(
    freq: number,
    dur: number,
    vol: number,
    type: Wave = 'sine',
    glideTo?: number,
    delay = 0
  ) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t0 + dur);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol * this.volume, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.ctx.destination);
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
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol * this.volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(this.ctx.destination);
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
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = carrier;
    mod.type = 'sine';
    mod.frequency.value = modFreq;
    modGain.gain.value = modDepth;
    mod.connect(modGain).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol * this.volume, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    mod.start(t0);
    mod.stop(t0 + dur + 0.05);
  }

  // ─── Launch (flight start) ───────────────────────────────────────────────────

  /** Whoosh as the throwable leaves the sender — weight scales the heft. */
  playLaunch(weight: ThrowWeight = 'medium') {
    if (!this.ensureContext()) return;
    const base = weight === 'heavy' ? 500 : weight === 'medium' ? 900 : 1400;
    const vol = weight === 'heavy' ? 0.22 : 0.15;
    this.noise(0.22, vol, base, 'bandpass', 0, 0.8);
    this.tone(base * 0.5, 0.2, vol * 0.5, 'sine', base * 0.22);
    haptic.light();
  }

  // ─── Impact recipes (one per sound key) ──────────────────────────────────────

  playImpact(soundKey: string, weight: ThrowWeight = 'medium') {
    if (!this.ensureContext()) return;
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
    pop_up: () => this.run([523, 659, 784], 0.12, 0.2, 'triangle'),
    pop_down: () => this.run([392, 330, 262], 0.12, 0.2, 'triangle'),
    giggle: () => this.run([600, 750, 600, 800, 650], 0.07, 0.16, 'square', 0.07),
    weep: () => {
      this.tone(500, 0.45, 0.16, 'sine', 260);
      this.noise(0.3, 0.05, 2500, 'highpass', 0.1);
    },
    growl: () => {
      this.tone(90, 0.35, 0.28, 'sawtooth', 60);
      this.noise(0.2, 0.12, 300, 'lowpass');
    },
    smooth: () => {
      this.tone(392, 0.3, 0.12, 'sine');
      this.tone(494, 0.3, 0.12, 'sine');
      this.tone(587, 0.35, 0.12, 'sine', undefined, 0.05);
    },
    kiss: () => {
      this.noise(0.08, 0.14, 3000, 'bandpass', 0, 2);
      this.run([880, 1175, 1480], 0.14, 0.14, 'sine', 0.05);
    },
    twinkle: () => this.run([1047, 1319, 1568, 2093], 0.1, 0.14, 'triangle', 0.05),

    // ── Throws ──
    splat_wet: () => {
      this.noise(0.12, 0.3, 800, 'lowpass');
      this.thump(150, 0.12, 0.22);
      this.noise(0.25, 0.1, 400, 'lowpass', 0.08); // dripping goo
    },
    egg_crack: () => {
      this.noise(0.03, 0.3, 4000, 'highpass'); // shell crack
      this.noise(0.15, 0.2, 700, 'lowpass', 0.03); // splat
      this.thump(180, 0.1, 0.15, 0.03);
    },
    slip: () => {
      this.tone(900, 0.25, 0.16, 'sine', 200); // slide-whistle down
      this.thump(120, 0.1, 0.18, 0.22);
    },
    splat_cheese: () => {
      this.noise(0.14, 0.26, 600, 'lowpass');
      this.thump(140, 0.14, 0.2);
    },
    splat_heavy: () => {
      this.thump(100, 0.2, 0.3);
      this.noise(0.2, 0.3, 500, 'lowpass');
      this.noise(0.15, 0.1, 900, 'lowpass', 0.12);
    },
    splat_gross: () => {
      this.noise(0.18, 0.28, 350, 'lowpass');
      this.thump(90, 0.18, 0.22);
      this.warble(400, 28, 60, 0.35, 0.04, 0.15); // fly buzz
    },
    squirt: () => {
      this.noise(0.3, 0.2, 2200, 'bandpass', 0, 1.5);
      this.tone(1200, 0.25, 0.08, 'sine', 500);
    },
    punch: () => {
      this.thump(110, 0.15, 0.35);
      this.noise(0.06, 0.3, 1500, 'lowpass');
      this.tone(65, 0.25, 0.25, 'sine', 45, 0.02);
    },
    anvil_clang: () => {
      this.tone(220, 0.5, 0.3, 'square', 210);
      this.tone(554, 0.4, 0.15, 'square', 540);
      this.thump(70, 0.3, 0.35);
      this.noise(0.08, 0.3, 3000, 'highpass');
    },
    metal_crash: () => {
      this.noise(0.35, 0.3, 2500, 'bandpass', 0, 0.6);
      this.tone(310, 0.3, 0.18, 'square', 290);
      this.thump(90, 0.2, 0.25);
      this.noise(0.2, 0.15, 1800, 'bandpass', 0.18, 0.7); // lid wobble
    },
    snow_poof: () => {
      this.noise(0.25, 0.2, 1200, 'lowpass');
      this.tone(600, 0.2, 0.08, 'sine', 300);
    },
    magnet_clink: () => {
      this.warble(300, 50, 120, 0.25, 0.12); // hum
      this.tone(1800, 0.06, 0.2, 'square', undefined, 0.22); // clink
      this.thump(200, 0.08, 0.15, 0.22);
    },

    // ── Sports ──
    ball_bounce: () => {
      this.thump(180, 0.12, 0.25);
      this.thump(180, 0.09, 0.15, 0.18);
      this.thump(180, 0.06, 0.08, 0.32);
      this.noise(0.04, 0.1, 2000, 'highpass', 0.01); // squeak
    },
    football_hit: () => {
      this.thump(130, 0.15, 0.28);
      this.noise(0.08, 0.2, 1000, 'lowpass');
      this.tone(2400, 0.3, 0.06, 'sine', undefined, 0.2); // ref whistle hint
    },
    tennis_pop: () => {
      this.noise(0.03, 0.25, 2500, 'bandpass', 0, 2);
      this.thump(300, 0.08, 0.2);
      this.thump(300, 0.05, 0.1, 0.15);
    },
    bowling_strike: () => {
      this.thump(80, 0.25, 0.35);
      // pin scatter — staggered woodblock clicks
      [0.08, 0.13, 0.17, 0.22, 0.28, 0.33].forEach((d, i) =>
        this.tone(700 + i * 120, 0.05, 0.12, 'square', undefined, d)
      );
      this.noise(0.3, 0.15, 1200, 'lowpass', 0.06);
    },
    lucky_clang: () => {
      this.tone(660, 0.3, 0.2, 'square', 650);
      this.tone(990, 0.25, 0.12, 'square', undefined, 0.08);
      this.run([1319, 1568, 2093], 0.12, 0.1, 'triangle', 0.06); // lucky chime
    },
    dice_rattle: () => {
      [0, 0.05, 0.09, 0.14, 0.2].forEach((d) =>
        this.tone(900 + Math.random() * 500, 0.03, 0.14, 'square', undefined, d)
      );
      this.thump(250, 0.08, 0.12, 0.24);
    },
    mystic: () => {
      this.warble(440, 6, 30, 0.5, 0.12);
      this.run([523, 622, 740, 880], 0.15, 0.08, 'sine', 0.1);
    },

    // ── Cheers ──
    glass_fizz: () => {
      this.tone(1568, 0.15, 0.18, 'triangle'); // clink
      this.tone(2093, 0.12, 0.12, 'triangle', undefined, 0.03);
      this.noise(0.5, 0.08, 5000, 'highpass', 0.08); // fizz
    },
    cork_pop: () => {
      this.noise(0.03, 0.35, 1200, 'bandpass', 0, 3); // POP
      this.tone(400, 0.08, 0.2, 'sine', 900);
      this.noise(0.6, 0.09, 6000, 'highpass', 0.06); // spray
      this.run([1047, 1319, 1568], 0.12, 0.08, 'triangle', 0.08);
    },
    hot_splash: () => {
      this.noise(0.2, 0.22, 1400, 'bandpass', 0, 1);
      this.tone(500, 0.2, 0.1, 'sine', 250);
      this.noise(0.35, 0.06, 4000, 'highpass', 0.15); // steam hiss
    },
    cash_count: () => {
      // riffling bills
      [0, 0.05, 0.1, 0.15, 0.2, 0.25].forEach((d) =>
        this.noise(0.025, 0.14, 3500, 'bandpass', d, 2.5)
      );
      this.tone(1319, 0.15, 0.12, 'triangle', undefined, 0.3); // cha-ching
      this.tone(2093, 0.2, 0.12, 'triangle', undefined, 0.36);
    },
    crystal_chime: () => {
      this.run([2093, 2637, 3136], 0.2, 0.14, 'sine', 0.07);
      this.noise(0.06, 0.15, 6000, 'highpass'); // glassy tick
    },
    romance: () => {
      this.run([659, 784, 988, 1319], 0.22, 0.1, 'sine', 0.11);
    },
    fanfare: () => {
      this.run([523, 659, 784, 1047], 0.16, 0.16, 'triangle', 0.09);
      this.thump(130, 0.15, 0.12, 0.36);
    },
    firework: () => {
      this.tone(300, 0.35, 0.1, 'sine', 1200); // rising whistle
      this.noise(0.05, 0.35, 1500, 'bandpass', 0.35, 1); // BANG
      this.thump(90, 0.25, 0.3, 0.35);
      // crackle rain
      [0.45, 0.5, 0.56, 0.62, 0.7, 0.78].forEach((d) =>
        this.noise(0.03, 0.1, 4000 + Math.random() * 3000, 'bandpass', d, 3)
      );
    },

    // ── Premium ──
    bomb_boom: () => {
      this.noise(0.25, 0.06, 5000, 'highpass'); // fuse sizzle
      this.thump(55, 0.5, 0.4, 0.22); // sub BOOM
      this.noise(0.4, 0.35, 700, 'lowpass', 0.22);
      this.noise(0.6, 0.12, 250, 'lowpass', 0.4); // rumble tail
    },
    rocket_boom: () => {
      this.noise(0.3, 0.25, 900, 'bandpass', 0, 0.7); // engine roar
      this.tone(180, 0.3, 0.15, 'sawtooth', 500);
      this.thump(60, 0.45, 0.38, 0.28);
      this.noise(0.35, 0.3, 800, 'lowpass', 0.28);
    },
    ufo_warble: () => {
      this.warble(700, 9, 250, 0.55, 0.14);
      this.tone(1400, 0.2, 0.1, 'sine', 300, 0.4); // beam-down
    },
    alien_blip: () => {
      this.run([1200, 800, 1500, 900, 1700], 0.06, 0.14, 'square', 0.06);
      this.warble(500, 15, 150, 0.3, 0.08, 0.3);
    },
    robo_zap: () => {
      this.tone(200, 0.12, 0.2, 'square', 100);
      this.warble(300, 30, 200, 0.3, 0.12, 0.1);
      this.noise(0.08, 0.2, 3000, 'highpass', 0.12); // spark
    },
    ghost_woo: () => {
      this.warble(600, 4, 80, 0.7, 0.13);
      this.tone(900, 0.6, 0.06, 'sine', 400, 0.1);
    },
    doom_rattle: () => {
      this.tone(110, 0.5, 0.22, 'sawtooth', 80);
      [0.1, 0.18, 0.25, 0.34].forEach((d) =>
        this.tone(500 + Math.random() * 200, 0.04, 0.12, 'square', undefined, d)
      );
      this.thump(70, 0.3, 0.2, 0.05);
    },
    thunder: () => {
      this.noise(0.04, 0.4, 4000, 'highpass'); // CRACK
      this.thump(65, 0.5, 0.38, 0.04);
      this.noise(0.7, 0.2, 300, 'lowpass', 0.1); // rolling rumble
    },
    doge_bark: () => {
      this.tone(400, 0.08, 0.22, 'square', 700);
      this.tone(350, 0.08, 0.22, 'square', 600, 0.16);
      this.run([784, 988], 0.1, 0.08, 'triangle', 0.08); // wow
    },
    chomp: () => {
      this.thump(120, 0.12, 0.3);
      this.noise(0.06, 0.28, 1800, 'lowpass');
      this.thump(100, 0.15, 0.25, 0.14); // second bite
      this.noise(0.05, 0.2, 1500, 'lowpass', 0.14);
    },
    bear_roar: () => {
      this.tone(120, 0.55, 0.3, 'sawtooth', 70);
      this.warble(150, 25, 40, 0.5, 0.15);
      this.thump(80, 0.3, 0.25, 0.1);
    },
    cluck: () => {
      this.run([900, 700, 1000, 750], 0.06, 0.16, 'square', 0.09);
      this.noise(0.15, 0.08, 2500, 'bandpass', 0.3, 1.5); // feather flutter
    },
    squeak: () => {
      this.tone(1400, 0.12, 0.22, 'sine', 2000);
      this.tone(1800, 0.15, 0.18, 'sine', 1100, 0.15); // squeak-squeak
    },
    card_flick: () => {
      this.noise(0.03, 0.2, 3000, 'bandpass', 0, 2.5);
      this.noise(0.03, 0.15, 3500, 'bandpass', 0.06, 2.5);
      this.run([1568, 2093], 0.1, 0.1, 'triangle', 0.05);
    },
  };
}

export const throwableSoundService = new ThrowableSoundServiceClass();
export default throwableSoundService;
