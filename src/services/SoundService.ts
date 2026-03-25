/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — Premium Sound Service (TABLE-TIER)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE NOTE — Three-tier sound system:
 *   1. SoundService.ts  (THIS FILE) — Poker table game sounds (deal, fold, all-in, etc.)
 *   2. SoundPackService.ts           — Sound profile/preset manager (wraps SoundService)
 *   3. PremiumSFX.ts                 — UI-tier interaction sounds (card flip, navigate, toggle)
 *
 * These are INTENTIONALLY separate to avoid coupling table game logic with UI sounds.
 * PremiumSFX has its own AudioContext and localStorage flag — independent of this service.
 *
 * Full procedural audio generation for all poker actions using Web Audio API.
 * No external audio files needed — all sounds are synthesized in real-time.
 *
 * Sounds:
 * - playDeal()              Card slide/flip
 * - playCheck()             Double table tap
 * - playChips()             Chip clink (bet/call)
 * - playRaise()             Triple chip cascade
 * - playFold()              Card swoosh to muck
 * - playAllIn()             Dramatic bass thud + chip push
 * - playWin()               Major arpeggio celebration
 * - playBigWin()            Extended celebration + shimmer
 * - playTurnAlert()         Bell ding — your turn
 * - playTimerWarning()      Tick-tock at <5s
 * - playCommunityCard()     Card snap for board cards
 * - playShowdown()          Rising dramatic reveal
 * - playButtonClick()       Soft UI tap
 * - playTimeBankActivated() Hourglass chime
 *
 * Also includes:
 * - Volume controls (master, effects)
 * - Haptic feedback via navigator.vibrate()
 * - Enable/disable toggle
 */

// ═══════════════════════════════════════════════════════════════════════════════
// HAPTIC SERVICE — Mobile vibration patterns
// ═══════════════════════════════════════════════════════════════════════════════

export const haptic = {
  /** Check if vibrations are enabled (reads from localStorage) */
  _isEnabled() {
    try {
      return localStorage.getItem('vibrationsEnabled') !== 'false';
    } catch {
      return true;
    }
  },
  /** Light tap — button press */
  light() {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && this._isEnabled()) navigator.vibrate(8);
  },
  /** Medium pulse — your turn, win */
  medium() {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && this._isEnabled()) navigator.vibrate(40);
  },
  /** Strong pulse — all-in, timer urgent */
  strong() {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && this._isEnabled()) navigator.vibrate(80);
  },
  /** Double pulse — timer warning */
  double() {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && this._isEnabled()) navigator.vibrate([25, 40, 25]);
  },
  /** Triple pulse — big win */
  triple() {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && this._isEnabled())
      navigator.vibrate([30, 30, 30, 30, 30]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SOUND SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class SoundService {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private masterVolume: number = 0.7;
  private effectsVolume: number = 0.5;
  private masterGain: GainNode | null = null;
  private timerWarningInterval: number | null = null;

  constructor() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.masterVolume * this.effectsVolume;
        this.masterGain.connect(this.ctx.destination);
      }
    } catch (e: unknown) {
      console.error('[SoundService] Web Audio API not supported');
    }
  }

  // ─── Context Management ──────────────────────────────────────────────

  private ensureContext(): boolean {
    if (!this.ctx || !this.masterGain) return false;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return true;
  }

  private get out(): GainNode {
    return this.masterGain!;
  }

  // ─── Volume Controls ─────────────────────────────────────────────────

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setMasterVolume(vol: number) {
    this.masterVolume = Math.max(0, Math.min(1, vol));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume * this.effectsVolume;
    }
  }

  setEffectsVolume(vol: number) {
    this.effectsVolume = Math.max(0, Math.min(1, vol));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume * this.effectsVolume;
    }
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }
  getEffectsVolume(): number {
    return this.effectsVolume;
  }

  // ─── Internal Helpers ────────────────────────────────────────────────

  private createNoiseBurst(time: number, duration: number, volume = 0.2, filterFreq = 1000) {
    if (!this.ctx) return;
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.out);
    noise.start(time);
  }

  private playTone(
    freq: number,
    duration: number,
    volume = 0.2,
    type: OscillatorType = 'sine',
    delay = 0
  ) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    osc.connect(gain);
    gain.connect(this.out);

    osc.start(t);
    osc.stop(t + duration);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GAME SOUNDS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Card deal/slide — soft paper shuffle sound
   */
  playDeal() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Filtered noise burst simulating paper slide
    this.createNoiseBurst(t, 0.12, 0.15, 3000);

    // Subtle high-frequency click at end
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.frequency.setValueAtTime(4000, t + 0.08);
    osc.frequency.exponentialRampToValueAtTime(1000, t + 0.12);
    gain.gain.setValueAtTime(0.08, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t + 0.08);
    osc.stop(t + 0.12);

    haptic.light();
  }

  /**
   * Check — double table tap (wood-like thud)
   */
  playCheck() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // First tap
    this.createNoiseBurst(t, 0.04, 0.25, 800);
    this.playTone(200, 0.04, 0.15, 'sine');

    // Second tap (slightly softer)
    setTimeout(() => {
      if (!this.ctx) return;
      const t2 = this.ctx.currentTime;
      this.createNoiseBurst(t2, 0.04, 0.18, 800);
      this.playTone(180, 0.04, 0.1, 'sine');
    }, 120);

    haptic.light();
  }

  /**
   * Chips — bet/call chip clink (two-click stack)
   */
  playChips() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // First ceramic click
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.frequency.setValueAtTime(2200, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.05);
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.06);

    // Second click (stacking)
    setTimeout(() => {
      if (!this.ctx) return;
      const t2 = this.ctx.currentTime;
      const osc2 = this.ctx.createOscillator();
      const gain2 = this.ctx.createGain();
      osc2.frequency.setValueAtTime(2600, t2);
      osc2.frequency.exponentialRampToValueAtTime(200, t2 + 0.04);
      gain2.gain.setValueAtTime(0.18, t2);
      gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.05);
      osc2.connect(gain2);
      gain2.connect(this.out);
      osc2.start(t2);
      osc2.stop(t2 + 0.05);
    }, 35);

    haptic.light();
  }

  /**
   * Raise — triple chip cascade (larger bet sound)
   * Bible V8 §5.3: "chip stack sound (louder for larger amounts)"
   * @param betAmount optional bet amount — larger amounts produce louder, more dramatic sound
   * @param bigBlind optional BB for scaling reference
   */
  playRaise(betAmount?: number, bigBlind?: number) {
    if (!this.enabled || !this.ensureContext()) return;

    // Scale volume based on bet size relative to BB (Bible V8 §5.3: louder for larger amounts)
    let volumeScale = 1.0;
    if (betAmount != null && bigBlind && bigBlind > 0) {
      const bbMultiple = betAmount / bigBlind;
      // 2-3 BB = normal (1.0), 10 BB = louder (1.3), 50+ BB = max (1.6)
      volumeScale = Math.min(1.6, 0.8 + Math.log2(Math.max(1, bbMultiple)) * 0.15);
    }

    // Three staggered chip clinks with increasing pitch
    const freqs = [1800, 2200, 2800];
    freqs.forEach((freq, i) => {
      setTimeout(() => {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(100, t + 0.06);
        gain.gain.setValueAtTime(0.22 * volumeScale, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        osc.connect(gain);
        gain.connect(this.out);
        osc.start(t);
        osc.stop(t + 0.07);
      }, i * 45);
    });

    // Subtle bass thud on final chip — also scaled
    setTimeout(() => {
      this.playTone(80, 0.1 * volumeScale, 0.15, 'sine');
    }, 100);

    haptic.medium();
  }

  /**
   * Fold — card swoosh to muck
   */
  playFold() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Swoosh: filtered sawtooth sweep down
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    const filter = this.ctx!.createBiquadFilter();

    osc.type = 'sawtooth';
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.linearRampToValueAtTime(80, t + 0.18);

    gain.gain.setValueAtTime(0.18, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.2);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.2);

    // Noise tail (paper slide)
    this.createNoiseBurst(t, 0.15, 0.08, 2000);

    haptic.light();
  }

  /**
   * All-In — dramatic bass thud + chip cascade + tension build
   */
  playAllIn() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Deep bass impact
    const bass = this.ctx!.createOscillator();
    const bassGain = this.ctx!.createGain();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(60, t);
    bass.frequency.exponentialRampToValueAtTime(30, t + 0.3);
    bassGain.gain.setValueAtTime(0.4, t);
    bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    bass.connect(bassGain);
    bassGain.connect(this.out);
    bass.start(t);
    bass.stop(t + 0.4);

    // Noise burst (impact thud)
    this.createNoiseBurst(t, 0.08, 0.3, 500);

    // Chip cascade (5 rapid clicks, ascending pitch)
    for (let i = 0; i < 5; i++) {
      setTimeout(
        () => {
          if (!this.ctx) return;
          const tc = this.ctx.currentTime;
          const osc = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          osc.frequency.setValueAtTime(1500 + i * 400, tc);
          osc.frequency.exponentialRampToValueAtTime(100, tc + 0.04);
          g.gain.setValueAtTime(0.15, tc);
          g.gain.exponentialRampToValueAtTime(0.001, tc + 0.05);
          osc.connect(g);
          g.connect(this.out);
          osc.start(tc);
          osc.stop(tc + 0.05);
        },
        80 + i * 30
      );
    }

    // Rising tension tone
    const tension = this.ctx!.createOscillator();
    const tensionGain = this.ctx!.createGain();
    tension.type = 'triangle';
    tension.frequency.setValueAtTime(220, t + 0.15);
    tension.frequency.linearRampToValueAtTime(440, t + 0.45);
    tensionGain.gain.setValueAtTime(0.08, t + 0.15);
    tensionGain.gain.linearRampToValueAtTime(0.001, t + 0.5);
    tension.connect(tensionGain);
    tensionGain.connect(this.out);
    tension.start(t + 0.15);
    tension.stop(t + 0.5);

    haptic.strong();
  }

  /**
   * Win — C major arpeggio (satisfying victory sound)
   */
  playWin() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6

    notes.forEach((freq, i) => {
      const startTime = t + i * 0.1;
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.2, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.5);

      osc.connect(gain);
      gain.connect(this.out);
      osc.start(startTime);
      osc.stop(startTime + 0.5);
    });

    haptic.medium();
  }

  /**
   * Big Win — Extended celebration with shimmer and double arpeggio
   */
  playBigWin() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // First arpeggio (C major)
    const notes1 = [523.25, 659.25, 783.99, 1046.5];
    notes1.forEach((freq, i) => {
      this.playTone(freq, 0.6, 0.2, 'sine', i * 0.08);
    });

    // Second arpeggio (octave higher, delayed)
    const notes2 = [1046.5, 1318.51, 1567.98, 2093.0];
    notes2.forEach((freq, i) => {
      this.playTone(freq, 0.8, 0.15, 'sine', 0.35 + i * 0.08);
    });

    // Shimmer (high-frequency noise burst)
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.4, 0.08, 8000);
    }, 600);

    // Victory bass note
    this.playTone(130.81, 0.8, 0.12, 'sine', 0.7); // C3

    haptic.triple();
  }

  /**
   * Turn Alert — bell ding (your turn notification)
   */
  playTurnAlert() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Primary bell tone
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t); // A5

    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.6);

    // Harmonic overtone (octave + fifth)
    const osc2 = this.ctx!.createOscillator();
    const gain2 = this.ctx!.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1320, t); // E6

    gain2.gain.setValueAtTime(0.08, t);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    osc2.connect(gain2);
    gain2.connect(this.out);
    osc2.start(t);
    osc2.stop(t + 0.4);

    haptic.medium();
  }

  /**
   * Timer Warning — tick-tock pulse (call repeatedly for <5s countdown)
   */
  playTimerWarning() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Sharp tick
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.03);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.05);

    haptic.double();
  }

  /**
   * Start continuous timer warning ticks (call once, auto-stops)
   */
  startTimerWarning() {
    this.stopTimerWarning();
    this.playTimerWarning();
    this.timerWarningInterval = window.setInterval(() => {
      this.playTimerWarning();
    }, 1000);
  }

  /**
   * Stop continuous timer warning
   */
  stopTimerWarning() {
    if (this.timerWarningInterval !== null) {
      clearInterval(this.timerWarningInterval);
      this.timerWarningInterval = null;
    }
  }

  /**
   * Community Card — card snap/flip for board reveal
   */
  playCommunityCard() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Quick snap (higher energy than deal)
    this.createNoiseBurst(t, 0.06, 0.2, 4000);

    // Card flip accent
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.frequency.setValueAtTime(3000, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.08);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.1);

    haptic.light();
  }

  /**
   * Showdown — dramatic rising reveal (string swell effect)
   */
  playShowdown() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Rising 4-note sequence: C4→E4→G4→C5 (80ms each)
    const notes = [261.63, 329.63, 392.0, 523.25];
    notes.forEach((freq, i) => {
      const start = t + i * 0.08;
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.15, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);

      osc.connect(gain);
      gain.connect(this.out);
      osc.start(start);
      osc.stop(start + 0.3);
    });

    // Tension noise swell
    this.createNoiseBurst(t, 0.35, 0.06, 3000);

    haptic.medium();
  }

  /**
   * Button Click — soft UI tap
   */
  playButtonClick() {
    if (!this.enabled || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1500, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.03);

    gain.gain.setValueAtTime(0.1, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.04);

    haptic.light();
  }

  /**
   * Time Bank Activated — hourglass two-tone chime
   */
  playTimeBankActivated() {
    if (!this.enabled || !this.ensureContext()) return;

    // G5 then C6 (pleasant two-note chime)
    this.playTone(783.99, 0.3, 0.18, 'sine', 0);
    this.playTone(1046.5, 0.4, 0.15, 'sine', 0.12);

    // Subtle shimmer
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.15, 0.04, 6000);
    }, 200);

    haptic.medium();
  }

  /**
   * Pot Collect — chips sweep to winner (satisfying collection sound)
   */
  playPotCollect() {
    if (!this.enabled || !this.ensureContext()) return;

    // Rapid ascending chip clicks (collecting chips)
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        if (!this.ctx) return;
        const tc = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.frequency.setValueAtTime(1200 + i * 250, tc);
        osc.frequency.exponentialRampToValueAtTime(100, tc + 0.03);
        g.gain.setValueAtTime(0.12, tc);
        g.gain.exponentialRampToValueAtTime(0.001, tc + 0.04);
        osc.connect(g);
        g.connect(this.out);
        osc.start(tc);
        osc.stop(tc + 0.04);
      }, i * 25);
    }

    // Satisfying bass thud at end
    setTimeout(() => {
      this.playTone(100, 0.1, 0.12, 'sine');
    }, 180);

    haptic.medium();
  }

  /**
   * Seat Taken — short chime when a new player sits down
   */
  playSeatTaken() {
    if (!this.enabled || !this.ensureContext()) return;
    const now = this.ctx!.currentTime;
    const gain = this.createGain(0.12);

    // Short ascending two-note chime
    const osc = this.ctx!.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1100, now + 0.08);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.15);
    haptic.light();
  }

  /**
   * New Hand — subtle "new hand starting" indicator
   */
  playNewHand() {
    if (!this.enabled || !this.ensureContext()) return;
    const now = this.ctx!.currentTime;
    const gain = this.createGain(0.08);

    // Soft double-tap
    for (let i = 0; i < 2; i++) {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 600;
      const env = this.ctx!.createGain();
      env.gain.setValueAtTime(0.6, now + i * 0.07);
      env.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.04);
      osc.connect(env);
      env.connect(gain);
      osc.start(now + i * 0.07);
      osc.stop(now + i * 0.07 + 0.05);
    }

    haptic.light();
  }

  /**
   * Disconnect — subtle offline indicator sound (Bible V8 §5.3)
   * Descending tone sequence to indicate connection lost
   */
  playDisconnect() {
    if (!this.enabled || !this.ensureContext()) return;
    const now = this.ctx!.currentTime;
    const gain = this.createGain(0.1);

    // Descending two-note drop (opposite of reconnect's rising chime)
    [440, 330].forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      const env = this.ctx!.createGain();
      env.gain.setValueAtTime(0.4, now + i * 0.12);
      env.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.25);
      osc.frequency.value = freq;
      osc.connect(env);
      env.connect(gain);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.3);
    });

    // Subtle filtered noise tail (fading static)
    this.createNoiseBurst(now + 0.15, 0.3, 0.08, 600);
    haptic.light();
  }

  /**
   * Reconnect — connection restored sound
   */
  playReconnect() {
    if (!this.enabled || !this.ensureContext()) return;
    const now = this.ctx!.currentTime;
    const gain = this.createGain(0.15);

    // Rising three-note chime (connection restored)
    [523, 659, 784].forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      const env = this.ctx!.createGain();
      env.gain.setValueAtTime(0.5, now + i * 0.1);
      env.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.2);
      osc.frequency.value = freq;
      osc.connect(env);
      env.connect(gain);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.25);
    });
    haptic.medium();
  }

  /**
   * Create a gain node with automatic volume scaling.
   * Caller MUST call ensureContext() before invoking this helper.
   */
  private createGain(volume: number): GainNode {
    if (!this.ctx) throw new Error('[SoundService] createGain called without audio context');
    const gain = this.ctx.createGain();
    gain.gain.value = volume * this.masterVolume * this.effectsVolume;
    gain.connect(this.out);
    return gain;
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  destroy() {
    this.stopTimerWarning();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }
  }
}

export const soundService = new SoundService();
