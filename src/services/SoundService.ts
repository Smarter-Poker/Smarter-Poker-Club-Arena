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
 * Premium Event Sounds:
 * - playBombPot()              Dramatic bass swell + chip cascade
 * - playBadBeatJackpot()       Epic ascending fanfare
 * - playInsurancePurchase()    Tense minor resolve
 * - playInsuranceDecline()     Quick dismissive sweep
 * - playStraddle()             Confident chip-drop authority
 * - playChatMessage()          Warm notification ping
 * - playThrowableImpact()      Comedic impact thud
 * - playSpinTick()             Metallic click (per tick)
 * - playSpinResult()           Triumphant reveal sting
 * - playMysteryBountyReveal()  Suspense then dramatic reveal
 * - playTournamentElimination() Somber descending tone
 * - playTournamentFinalTable()  Power chord fanfare
 * - playAchievement()          Bright celebratory sparkle
 * - playChipSplash()           Multi-chip side pot scatter
 * - playBuyInConfirm()         Satisfying confirmation chime
 *
 * Also includes:
 * - Volume controls (master, effects)
 * - Premium haptic patterns (12 context-specific vibration sequences)
 * - Sound priority system (Bible V8 5.14)
 * - Enable/disable toggle
 */

// ═══════════════════════════════════════════════════════════════════════════════
// HAPTIC SERVICE — Mobile vibration patterns
// ═══════════════════════════════════════════════════════════════════════════════

import { reportError } from '../utils/errorReporter';
export const haptic = {
  /** Check if vibrations are enabled (reads from localStorage) */
  _isEnabled() {
    try {
      return localStorage.getItem('vibrationsEnabled') !== 'false';
    } catch {
      return true;
    }
  },
  /** Internal runner — validates support + preference before firing */
  _fire(pattern: number | number[]) {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && this._isEnabled())
      navigator.vibrate(pattern);
  },

  // ─── Standard Tiers ──────────────────────────────────────────────────
  /** Light tap — button press, card flip, fold */
  light() {
    this._fire(10);
  },
  /** Medium pulse — your turn, raise, pot collect */
  medium() {
    this._fire([15, 30, 15]);
  },
  /** Strong pulse — all-in, timer urgent */
  strong() {
    this._fire([25, 20, 40]);
  },
  /** Double pulse — timer warning tick */
  double() {
    this._fire([20, 35, 20]);
  },
  /** Triple pulse — big win celebration */
  triple() {
    this._fire([25, 25, 35, 25, 45]);
  },

  // ─── Premium Context-Specific Patterns ───────────────────────────────
  /** Bomb pot — dramatic building rumble */
  bombPot() {
    this._fire([15, 15, 25, 15, 40, 15, 60]);
  },
  /** Jackpot hit — cascading celebration burst */
  jackpot() {
    this._fire([20, 20, 30, 20, 40, 20, 50, 20, 70]);
  },
  /** Insurance — tense double-pulse */
  insurance() {
    this._fire([30, 50, 30]);
  },
  /** Straddle posted — confident assertive tap */
  straddle() {
    this._fire([20, 30, 35]);
  },
  /** Spin wheel — rapid escalating pulses */
  spinWheel() {
    this._fire([8, 20, 10, 18, 12, 16, 15, 14, 18, 12, 22, 10, 30]);
  },
  /** Mystery bounty reveal — suspense then burst */
  mysteryReveal() {
    this._fire([10, 60, 10, 60, 50]);
  },
  /** Throwable impact — quick sharp hit */
  throwImpact() {
    this._fire([15, 10, 25]);
  },
  /** Chat message received — subtle notification tap */
  chatReceived() {
    this._fire(6);
  },
  /** Tournament elimination — somber double thud */
  elimination() {
    this._fire([40, 80, 30]);
  },
  /** Achievement unlocked — celebratory cascade */
  achievement() {
    this._fire([15, 15, 15, 15, 30, 15, 45]);
  },
  /** Showdown reveal — dramatic tension pulse */
  showdown() {
    this._fire([12, 25, 12, 25, 35]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SOUND SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SOUND PRIORITY SYSTEM — Bible V8 5.14
// ═══════════════════════════════════════════════════════════════════════════════
// When multiple sounds fire within the same frame (e.g., all-in + fold),
// only the highest-priority sound plays. Prevents audio cacophony.
//
// Priority stack (highest first):
//   all_in > big_win > win > showdown > raise > bet > call > check > fold > deal > community_card > ui

export type SoundPriority =
  | 'all_in'
  | 'big_win'
  | 'win'
  | 'showdown'
  | 'raise'
  | 'bet'
  | 'call'
  | 'check'
  | 'fold'
  | 'deal'
  | 'community_card'
  | 'timer_warning'
  | 'time_bank'
  | 'turn_alert'
  | 'ui';

/**
 * User-facing sound categories — mapped to the sub-toggles in SoundSettings.
 * These gate WHICH sounds play. The master `enabled` flag controls whether
 * any sound plays at all.
 */
export type SoundCategory = 'action' | 'chat' | 'turn_alert' | 'win' | 'event';

const SOUND_PRIORITY_RANK: Record<SoundPriority, number> = {
  all_in: 100,
  big_win: 95,
  win: 90,
  showdown: 85,
  raise: 70,
  bet: 60,
  call: 50,
  check: 40,
  fold: 30,
  deal: 20,
  community_card: 15,
  timer_warning: 80, // Timer warnings are high-priority (affects gameplay)
  time_bank: 75,
  turn_alert: 72,
  ui: 10,
};

class SoundService {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private masterVolume: number = 0.7;
  private effectsVolume: number = 0.5;
  private masterGain: GainNode | null = null;
  private timerWarningInterval: number | null = null;

  // Sound priority system: tracks the highest-priority sound played this frame
  private currentFramePriority: number = -1;
  private priorityResetTimer: ReturnType<typeof setTimeout> | null = null;

  // Category-level gates (driven by SoundSettings sub-toggles)
  private categoryEnabled: Record<SoundCategory, boolean> = {
    action: true,
    chat: true,
    turn_alert: true,
    win: true,
    event: true,
  };

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
      console.warn('[SoundService] Web Audio API not supported');
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

  /** Enable/disable a specific sound category (e.g. 'action', 'chat', 'win'). */
  setCategoryEnabled(category: SoundCategory, enabled: boolean) {
    this.categoryEnabled[category] = enabled;
  }

  /** Bulk-update category gates from the SoundSettings config. */
  setCategoryStates(states: Partial<Record<SoundCategory, boolean>>) {
    for (const key in states) {
      const k = key as SoundCategory;
      if (states[k] !== undefined) {
        this.categoryEnabled[k] = states[k]!;
      }
    }
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

  // ─── Sound Priority Gate (Bible V8 5.14) ─────────────────────────────
  //
  // Within a ~50ms window, only the highest-priority sound plays.
  // Prevents audio clutter when multiple events fire simultaneously
  // (e.g., fold + raise + all-in in quick succession during multi-way pots).

  private shouldPlay(priority: SoundPriority, category?: SoundCategory): boolean {
    if (!this.enabled) return false;
    // Category gate — user can silence a whole category via SoundSettings
    if (category && !this.categoryEnabled[category]) return false;
    const rank = SOUND_PRIORITY_RANK[priority] ?? 0;
    if (rank <= this.currentFramePriority) return false;
    this.currentFramePriority = rank;
    // Reset priority window after 50ms
    if (this.priorityResetTimer) clearTimeout(this.priorityResetTimer);
    this.priorityResetTimer = setTimeout(() => {
      this.currentFramePriority = -1;
    }, 50);
    return true;
  }

  /** Get the priority rank for a sound type (for external callers) */
  getSoundPriority(priority: SoundPriority): number {
    return SOUND_PRIORITY_RANK[priority] ?? 0;
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
    if (!this.shouldPlay('deal', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('check', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('bet', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('raise', 'action') || !this.ensureContext()) return;

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
    if (!this.shouldPlay('fold', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('all_in', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('win', 'win') || !this.ensureContext()) return;
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

    // FIX 180: Bible V8 §5.4 — "you win: heavy celebration haptic" (was medium)
    haptic.strong();
  }

  /**
   * Big Win — Extended celebration with shimmer and double arpeggio
   */
  playBigWin() {
    if (!this.shouldPlay('big_win', 'win') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('turn_alert', 'turn_alert') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('timer_warning', 'turn_alert') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('community_card', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('showdown', 'win') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('ui') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('time_bank', 'turn_alert') || !this.ensureContext()) return;

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
    if (!this.shouldPlay('win', 'win') || !this.ensureContext()) return;

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
    if (!this.shouldPlay('ui') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('deal', 'action') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('ui') || !this.ensureContext()) return;
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
    if (!this.shouldPlay('ui') || !this.ensureContext()) return;
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

  // ═══════════════════════════════════════════════════════════════════════
  // PREMIUM EVENT SOUNDS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Bomb Pot — dramatic bass swell + chip cascade + tension chord
   * Fires when a bomb pot round is announced
   */
  playBombPot() {
    if (!this.shouldPlay('all_in', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Deep sub-bass swell (building tension)
    const bass = this.ctx!.createOscillator();
    const bassGain = this.ctx!.createGain();
    bass.type = 'sine';
    bass.frequency.setValueAtTime(40, t);
    bass.frequency.exponentialRampToValueAtTime(80, t + 0.5);
    bassGain.gain.setValueAtTime(0.0, t);
    bassGain.gain.linearRampToValueAtTime(0.35, t + 0.2);
    bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    bass.connect(bassGain);
    bassGain.connect(this.out);
    bass.start(t);
    bass.stop(t + 0.6);

    // Impact noise burst at peak
    this.createNoiseBurst(t + 0.2, 0.1, 0.25, 400);

    // Rapid 6-chip cascade (everyone's chips in the pot)
    for (let i = 0; i < 6; i++) {
      setTimeout(
        () => {
          if (!this.ctx) return;
          const tc = this.ctx.currentTime;
          const osc = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          osc.frequency.setValueAtTime(1400 + i * 350, tc);
          osc.frequency.exponentialRampToValueAtTime(100, tc + 0.04);
          g.gain.setValueAtTime(0.12, tc);
          g.gain.exponentialRampToValueAtTime(0.001, tc + 0.05);
          osc.connect(g);
          g.connect(this.out);
          osc.start(tc);
          osc.stop(tc + 0.05);
        },
        250 + i * 25
      );
    }

    // Minor tension chord (drama)
    const chord = [261.63, 311.13, 392.0]; // C4, Eb4, G4 (Cm chord)
    chord.forEach((freq, i) => {
      this.playTone(freq, 0.5, 0.08, 'triangle', 0.4 + i * 0.02);
    });

    haptic.bombPot();
  }

  /**
   * Bad Beat Jackpot — epic ascending fanfare with shimmer cascade
   */
  playBadBeatJackpot() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Fanfare: ascending major chord arpeggio
    const fanfare = [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
    fanfare.forEach((freq, i) => {
      this.playTone(freq, 0.8 - i * 0.05, 0.18, 'sine', i * 0.07);
    });

    // Sub-bass foundation
    this.playTone(65.41, 1.0, 0.15, 'sine', 0.1); // C2

    // Shimmer cascades (3 waves)
    for (let wave = 0; wave < 3; wave++) {
      setTimeout(
        () => {
          if (!this.ctx) return;
          this.createNoiseBurst(this.ctx.currentTime, 0.3, 0.06, 7000 + wave * 1000);
        },
        400 + wave * 200
      );
    }

    // Triumphant bass note at end
    this.playTone(130.81, 1.0, 0.12, 'sine', 0.8);

    haptic.jackpot();
  }

  /**
   * Insurance Purchase — tense decision confirmed (descending minor resolve)
   */
  playInsurancePurchase() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Tense two-note resolve: Bb4 -> F4 (minor feel)
    this.playTone(466.16, 0.2, 0.15, 'sine', 0);
    this.playTone(349.23, 0.3, 0.12, 'sine', 0.12);

    // Subtle confirmation noise
    this.createNoiseBurst(t + 0.1, 0.08, 0.06, 2000);

    haptic.insurance();
  }

  /**
   * Insurance Declined — quick dismissive sweep down
   */
  playInsuranceDecline() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.12);
    gain.gain.setValueAtTime(0.1, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.15);

    haptic.light();
  }

  /**
   * Straddle Posted — confident assertive chip-drop with authority
   */
  playStraddle() {
    if (!this.shouldPlay('bet', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Heavy chip drop
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.07);
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.08);

    // Bass authority thud
    this.playTone(80, 0.12, 0.18, 'sine', 0.03);

    // Second confirmatory click
    setTimeout(() => {
      if (!this.ctx) return;
      const tc = this.ctx.currentTime;
      const osc2 = this.ctx.createOscillator();
      const g2 = this.ctx.createGain();
      osc2.frequency.setValueAtTime(2400, tc);
      osc2.frequency.exponentialRampToValueAtTime(200, tc + 0.04);
      g2.gain.setValueAtTime(0.15, tc);
      g2.gain.exponentialRampToValueAtTime(0.001, tc + 0.05);
      osc2.connect(g2);
      g2.connect(this.out);
      osc2.start(tc);
      osc2.stop(tc + 0.05);
    }, 60);

    haptic.straddle();
  }

  /**
   * Chat Message Received — gentle notification ping
   */
  playChatMessage() {
    if (!this.shouldPlay('ui', 'chat') || !this.ensureContext()) return;

    // Warm two-note ascending ping (E5 → A5)
    this.playTone(659.25, 0.12, 0.08, 'sine', 0);
    this.playTone(880, 0.1, 0.06, 'sine', 0.08);

    haptic.chatReceived();
  }

  /**
   * Throwable Impact — sharp comedic impact thud
   */
  playThrowableImpact() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Impact noise burst
    this.createNoiseBurst(t, 0.06, 0.2, 1200);

    // Comedic low thud
    this.playTone(120, 0.08, 0.2, 'sine');

    // Bounce (softer echo)
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.04, 0.08, 800);
      this.playTone(90, 0.05, 0.08, 'sine');
    }, 80);

    haptic.throwImpact();
  }

  /**
   * Spin Wheel — escalating tick pattern that slows down
   * Call repeatedly as wheel spins, with increasing delay between calls
   */
  playSpinTick() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;

    // Quick metallic tick
    this.playTone(2800, 0.025, 0.12, 'sine');
    haptic.light();
  }

  /**
   * Spin Wheel Result — triumphant reveal sting
   */
  playSpinResult() {
    if (!this.shouldPlay('win', 'win') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Ascending 3-note fanfare: G5 → B5 → D6
    this.playTone(783.99, 0.3, 0.18, 'sine', 0);
    this.playTone(987.77, 0.3, 0.15, 'sine', 0.1);
    this.playTone(1174.66, 0.4, 0.2, 'sine', 0.2);

    // Shimmer tail
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.3, 0.06, 7000);
    }, 350);

    // Bass confirmation
    this.playTone(196.0, 0.5, 0.1, 'sine', 0.3); // G3

    haptic.spinWheel();
  }

  /**
   * Mystery Bounty Reveal — suspenseful pause then dramatic reveal
   */
  playMysteryBountyReveal() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Suspense: rising filtered noise
    const noise = this.ctx!.createBufferSource();
    const bufferSize = Math.floor(this.ctx!.sampleRate * 0.5);
    const buffer = this.ctx!.createBuffer(1, bufferSize, this.ctx!.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buffer;
    const filter = this.ctx!.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.exponentialRampToValueAtTime(4000, t + 0.4);
    const nGain = this.ctx!.createGain();
    nGain.gain.setValueAtTime(0.0, t);
    nGain.gain.linearRampToValueAtTime(0.12, t + 0.3);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.out);
    noise.start(t);

    // Reveal: bright major chord burst at peak
    const chord = [1046.5, 1318.51, 1567.98]; // C6, E6, G6
    chord.forEach((freq, i) => {
      this.playTone(freq, 0.5, 0.15, 'sine', 0.4 + i * 0.015);
    });

    // Golden shimmer
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.4, 0.06, 8000);
    }, 500);

    haptic.mysteryReveal();
  }

  /**
   * Tournament Elimination — somber descending tone (you're out)
   */
  playTournamentElimination() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Descending minor 3-note: E4 → C4 → A3
    this.playTone(329.63, 0.3, 0.12, 'triangle', 0);
    this.playTone(261.63, 0.3, 0.1, 'triangle', 0.15);
    this.playTone(220.0, 0.5, 0.08, 'triangle', 0.3);

    // Muted bass note (finality)
    this.playTone(110.0, 0.6, 0.06, 'sine', 0.4);

    haptic.elimination();
  }

  /**
   * Tournament Final Table — epic ascending power chord
   */
  playTournamentFinalTable() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;

    // Power chord: C4 → E4 → G4 → C5 → E5 → G5
    const notes = [261.63, 329.63, 392.0, 523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      this.playTone(freq, 0.8 - i * 0.06, 0.14, 'sine', i * 0.06);
    });

    // Sub-bass foundation
    this.playTone(65.41, 0.8, 0.1, 'sine', 0.15);

    // Shimmer
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.3, 0.05, 6000);
    }, 500);

    haptic.triple();
  }

  /**
   * Achievement Unlocked — bright celebratory arpeggio with sparkle
   */
  playAchievement() {
    if (!this.shouldPlay('win', 'event') || !this.ensureContext()) return;

    // Ascending sparkle: G5 → B5 → D6 → G6
    const notes = [783.99, 987.77, 1174.66, 1567.98];
    notes.forEach((freq, i) => {
      this.playTone(freq, 0.4, 0.12, 'sine', i * 0.06);
    });

    // Sparkle noise
    setTimeout(() => {
      if (!this.ctx) return;
      this.createNoiseBurst(this.ctx.currentTime, 0.2, 0.05, 8000);
    }, 300);

    haptic.achievement();
  }

  /**
   * Chip Splash — multiple chips hitting pot simultaneously (side pot creation)
   */
  playChipSplash() {
    if (!this.shouldPlay('bet', 'event') || !this.ensureContext()) return;

    // Rapid 4-chip scatter at random pitches
    for (let i = 0; i < 4; i++) {
      setTimeout(
        () => {
          if (!this.ctx) return;
          const tc = this.ctx.currentTime;
          const osc = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          const freq = 1600 + Math.random() * 1200;
          osc.frequency.setValueAtTime(freq, tc);
          osc.frequency.exponentialRampToValueAtTime(100, tc + 0.04);
          g.gain.setValueAtTime(0.1, tc);
          g.gain.exponentialRampToValueAtTime(0.001, tc + 0.05);
          osc.connect(g);
          g.connect(this.out);
          osc.start(tc);
          osc.stop(tc + 0.05);
        },
        i * 15 + Math.random() * 10
      );
    }

    // Settling bass
    this.playTone(100, 0.08, 0.08, 'sine', 0.08);
    haptic.medium();
  }

  /**
   * Buy-In Confirmed — satisfying confirmation chime
   */
  playBuyInConfirm() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;

    // Two-note confirmation: C5 → G5 (perfect fifth = satisfying)
    this.playTone(523.25, 0.15, 0.12, 'sine', 0);
    this.playTone(783.99, 0.2, 0.1, 'sine', 0.08);

    haptic.medium();
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
