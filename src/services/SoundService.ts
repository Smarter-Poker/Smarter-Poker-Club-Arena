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
 * - playDiscard()           ONE card swept to the muck (Crazy Pineapple)
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
 * - playBombPot()              Three-beat bomb sequence (drop, fuse, boom)
 * - playBombDrop()             Bomb falls + lands (whistle + tick)
 * - playBombFuse()             Burning-fuse crackle
 * - playBombExplosion()        Slow-attack sub boom + rumble
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
 * Diamond games (2026-09-26, called by the scenes on the frame that shows each beat):
 * - driveCrashEngine() / stopCrashEngine()   The jet's engine, following the multiplier
 * - playCrashExplosion() / playCrashMax()     The crash burst; the gold fanfare at the cap
 * - playBonusBooked()                         A win booked (Crash, Donkey Cross, Mines)
 * - playPlinkoPeg() / playPlinkoLanding()     Peg ticks (rate limited); the bucket clink
 * - playCrossingHoof() / driveCrossingCar() / playCrossingBrake() / playCrossingHorn()
 *   / playCrossingHit() / playCrossingLanded()   The walk, the car, and the two outcomes
 * - playMinesGem() / playMinesExplosion()     A gem chime that climbs; a mine going off
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
import { isVibrationAllowed, fireVibration } from '../utils/vibrationGate';
import { isSoundAllowed, persistSoundPreference } from '../utils/soundGate';
import { applyAudioSession } from '../utils/audioSession';
import { spinCelebration } from '../config/spinSpec';
import { trackAudioContext } from '../lib/audioContexts';
export const haptic = {
  /** Check if vibrations are enabled (reads from localStorage) */
  // AUDIT 2026-08-19: the in-table vibration switch writes
  // 'ca_vibration_enabled' while this only read 'vibrationsEnabled'. Honour
  // BOTH — either switch being off silences haptics.
  // AUDIT 2026-08-20: that rule was right but lived only here, while five other
  // haptic implementations each did their own thing. It now lives in
  // src/utils/vibrationGate.ts, which also gives this path one-event-one-buzz.
  _isEnabled() {
    return isVibrationAllowed();
  },
  /** Internal runner — validates support + preference before firing */
  _fire(pattern: number | number[]) {
    fireVibration(pattern);
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
  | 'pot_collect'
  | 'showdown'
  | 'raise'
  | 'bet'
  | 'call'
  | 'check'
  | 'discard'
  | 'fold'
  | 'shuffle'
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
  // AUDIT-2 FIX 2026-08-20: playPotCollect used to be rank 'win' (90) and is
  // played immediately AFTER playWin/playBigWin in the same frame — so
  // `rank <= currentFramePriority` rejected it EVERY time and the hero never
  // heard the pot sweep (nor its haptic) on their own wins. Its own rank sits
  // just under win so it always follows the winner fanfare instead of being
  // eaten by it.
  pot_collect: 88,
  showdown: 85,
  raise: 70,
  bet: 60,
  call: 50,
  check: 40,
  /* CRAZY PINEAPPLE PHASE 3 2026-08-31: the discard is its own decision and
     owes its own cue (CLAUDE.md 10.6). It sits ABOVE fold deliberately: the
     cue it replaced was playFold(), and a discard round resolves several
     seats inside the same 50ms priority window as the flop that follows it
     (deal 20 / community_card 15), so anything at or below fold's 30 would
     have been the next playPotCollect - a cue that is wired, called, and
     never heard. Below call (50) because a discard is not a wager. */
  discard: 45,
  fold: 30,
  shuffle: 25,
  deal: 20,
  community_card: 15,
  timer_warning: 80, // Timer warnings are high-priority (affects gameplay)
  time_bank: 75,
  turn_alert: 72,
  ui: 10,
};

/** The continuous voices of the Diamond games. See driveMotor. */
export type MotorName = 'crash' | 'car';
interface Motor {
  a: OscillatorNode;
  b: OscillatorNode;
  lp: BiquadFilterNode;
  band: BiquadFilterNode;
  gain: GainNode;
  /** Everything that must be stopped when the voice ends. */
  sources: AudioScheduledSourceNode[];
  /** When the sound switch was last consulted, in Date.now() ms. */
  checkedMs: number;
  /** The last target written, so an unchanged frame writes nothing. */
  hz: number;
  level: number;
}
interface MotorSpec {
  /** The second saw, as a ratio of the first. */
  ratio: number;
  /** The lowpass over both saws, from the pitch. */
  cutoff: (hz: number) => number;
  throbHz: number;
  throbDepth: number;
  /** The noise band's centre as a ratio of the pitch, and its level in the voice. */
  airRatio: number;
  air: number;
}
/** A jet: a fifth over the root, a fast flutter, plenty of afterburner air. */
const CRASH_ENGINE: MotorSpec = {
  ratio: 1.5,
  cutoff: (hz) => 420 + hz * 7,
  throbHz: 11,
  throbDepth: 2.5,
  airRatio: 9,
  air: 0.55,
};
/** A car: an octave over the root, a slower lope, a little road noise. */
const CROSSING_CAR: MotorSpec = {
  ratio: 2,
  cutoff: (hz) => 260 + hz * 9,
  throbHz: 6.5,
  throbDepth: 4,
  airRatio: 12,
  air: 0.3,
};
/** At most one Plinko peg tick in this many milliseconds, however many diamonds fall. */
export const PLINKO_PEG_GAP_MS = 30;
/** The player's Animation Speed as a duration multiplier, clamped like playKnockoutFlurry's. */
function gameSpeed(speed: number): number {
  return Math.min(4, Math.max(0.1, Number.isFinite(speed) && speed > 0 ? speed : 1));
}

class SoundService {
  private ctx: AudioContext | null = null;
  private enabled: boolean = true;
  private masterVolume: number = 0.7;
  private categoryEnabled: Record<SoundCategory, boolean> = {
    action: true,
    chat: true,
    turn_alert: true,
    win: true,
    event: true,
  };

  /* SOUND AUDIT 2026-08-27: was 0.5, which meant a player who never opened the
     settings panel ran at half the intended effects gain forever and the
     in-table volume slider (master only) topped out at 0.5. 1.0 is right.

     CORRECTED 2026-08-29: the rest of that note named "the Settings → Sound
     panel" as `setEffectsVolume`'s only caller. There is no such panel and
     never was — `setEffectsVolume` has no production caller at all, and the
     `restoreStoredConfig` it said "applies any saved value" was reading a
     localStorage key nothing has ever written. So this is a CONSTANT, and
     `getEffectsVolume` (consumed by ThrowableSoundService) is multiplying by 1.
     It stays because the gain maths reads better with the term in it and
     because a per-category volume is a plausible future control — but nothing
     varies it today, and no comment here should imply otherwise. */
  private effectsVolume: number = 1.0;
  private masterGain: GainNode | null = null;
  /**
   * The idling engine under the starting tree. Retained because it must be
   * stoppable: a bed that outlived its reveal would idle under the first hand.
   */
  private spinBed: {
    o1: OscillatorNode;
    o2: OscillatorNode;
    lfo: OscillatorNode;
    gain: GainNode;
    lp: BiquadFilterNode;
  } | null = null;
  private timerWarningInterval: number | null = null;

  // Sound priority system: tracks the highest-priority sound played this frame
  private currentFramePriority: number = -1;
  private priorityResetTimer: ReturnType<typeof setTimeout> | null = null;
  // playPotCollect bypasses the rank window (it accompanies the win fanfare
  // rather than competing with it) and dedupes itself with this stamp instead.
  private lastPotCollectMs = 0;
  /** Per-cue clock for the spin reveal. See shouldPlaySpinCue. */
  private lastSpinCueMs: Record<string, number> = {};

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * SOUND IS ONE SWITCH (Dan, 2026-08-28, binding)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Dan, verbatim: "a simple switch, sounds on / off is all thats needed."
   *
   * So the per-category gates are GONE, along with the storage hydrate that
   * fed them. They were never reachable anyway: the panel that wrote
   * `sp_sound_settings` was deleted in #1316 as unreachable UI, and the read
   * for it was added the day after — pointing at a key with no writer, so
   * every category sat at `true` forever, `setCategoryEnabled` and
   * `setCategoryStates` had zero callers, and `setEffectsVolume` was called
   * from nowhere but that dead hydrate. Keeping five gates that can only ever
   * be `true` means five ways for a future change to silence something by
   * accident, for a feature nobody asked for.
   *
   * WHAT REMAINS IS THE WHOLE FEATURE: one master switch, owned by
   * `soundGate` (`club_arena_sounds` + `ca_sound_enabled`, either one off
   * silences everything) and consulted by `shouldPlay` on every call, plus a
   * master volume. `SoundCategory` itself stays: 50 call sites pass it, and
   * it still documents WHAT a cue is even though nothing gates on it now.
   */

  constructor() {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        trackAudioContext(this.ctx);
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.masterVolume * this.effectsVolume;
        this.masterGain.connect(this.ctx.destination);
      }
    } catch (e: unknown) {
      // SOUND AUDIT 2026-08-27: surfaced to telemetry — this used to be the
      // only diagnostic in the whole engine, and it reached nobody.
      reportError(e, 'SoundService.init');
      console.warn('[SoundService] Web Audio API not supported');
    }
    // ANIMATION/SOUND AUDIT 2026-08-19: mobile autoplay unlock. This context
    // is constructed at module import time — on iOS Safari / Chrome mobile it
    // is born 'suspended' and no play* call ever awaited resume(), so the
    // first N table sounds were scheduled against a dead clock and dropped.
    // Resume on the FIRST user gesture (the only place browsers allow it),
    // and again whenever the tab returns to the foreground.
    this.installUnlockListeners();
    // Heard with the iPhone on silent while Sounds is on (utils/audioSession.ts).
    applyAudioSession(this.enabled && isSoundAllowed());
    /* `restoreStoredConfig()` was called here. It is gone with the call: its
       body became empty on 2026-08-29 when the localStorage key it read
       (`sp_sound_settings`) turned out to be written by nothing anywhere in the
       repository, and an empty private method invoked from a constructor reads
       as live boot logic to the next person. The history is kept where the
       method was. */
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * `restoreStoredConfig` DELETED 2026-08-28 — it read a key nobody wrote.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * It hydrated five per-category gates and an effects volume from
   * `sp_sound_settings`. Its own comment named `SoundSettings.tsx` as the
   * writer of that key — a file DELETED THE DAY BEFORE this function was
   * added, in #1316 ("delete the unreachable settings UI"), after the whole
   * `src/components/settings/` folder was verified to be a closed loop
   * nothing imported. So the read was born dead:
   * `localStorage.getItem('sp_sound_settings')` could only ever return null.
   *
   * Dan settled the question it was waiting on: "a simple switch, sounds on
   * / off is all thats needed." There is no category UI coming, so there is
   * nothing for this to restore. Removing it also removes a boot-time
   * localStorage read and the last caller of `setEffectsVolume`, which means
   * the effects gain now simply IS its default (1.0) — the same value the
   * dead hydrate always left it at.
   *
   * The master switch is unaffected and is the whole feature: `soundGate`
   * owns it (`club_arena_sounds` + `ca_sound_enabled`; either one off
   * silences everything) and `shouldPlay` consults it on every call. The
   * master VOLUME is applied by the surfaces that own the slider.
   */
  /* ── `restoreStoredConfig` REMOVED 2026-08-29 ──────────────────────────
     It read `localStorage['sp_sound_settings']`, a key that appeared EXACTLY
     ONCE in the whole repository — in that read. `SoundSettings.tsx`, the
     component its doc-comment named as the shape owner, does not exist. So the
     restore was a no-op that read as working code, and the 2026-08-27 bug it
     claimed to fix ("a player who disabled Chat Message Sounds got it back on
     every reload") was never actually fixed.

     It was also a SECOND owner of master volume: it set it at boot, racing the
     settings store, and whichever ran later won. Master volume now follows
     `useTableSettings.soundVolume` and nothing else.

     Sound categories keep their engine-level API (`setCategoryStates`) for the
     surface that will drive them. Until one exists they are all on, which is
     the state this code was producing anyway — now without pretending
     otherwise. */

  // ─── Context Management ──────────────────────────────────────────────

  private unlockInstalled = false;

  private installUnlockListeners(): void {
    if (this.unlockInstalled || typeof window === 'undefined') return;
    this.unlockInstalled = true;
    const unlock = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {
          /* resume can only succeed inside a gesture — retry on the next one */
        });
      }
      if (this.ctx && this.ctx.state === 'running') {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('touchstart', unlock);
        window.removeEventListener('keydown', unlock);
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      // A continuous voice (the Crash engine, the car coming to a street) is
      // driven from a frame loop that stops while the tab is hidden, so the
      // voice must stop with it rather than drone on under another app.
      if (document.hidden) this.stopAllMotors(0.05);
      if (!document.hidden && this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {
          /* best-effort — the gesture listeners above are the fallback */
        });
      }
    });
  }

  /**
   * Arm the autoplay-unlock listeners as early as possible.
   *
   * The listeners are installed by the constructor, so all this really does is
   * force the module to be evaluated - but that is the entire point, and a
   * named method says so where a bare `import './SoundService'` would look
   * like a stray import somebody could tidy away. Called by ServiceBootstrap
   * at app boot; see the comment there for the spectator-silence bug.
   *
   * Idempotent: installUnlockListeners() guards on unlockInstalled.
   */
  /**
   * Why a cue would be inaudible right now, or null if it would be heard.
   *
   * Dan, 2026-08-30: "ANIMATION STARTED WHEN BOUGHT IN, BUT WITH NO SOUND
   * EFFECTS." Every gate in this service was read line by line that day and
   * each one was individually correct — master on, category on, `muted` false
   * by default, context constructed at import, unlock listeners armed. Which
   * left nothing to fix and nothing to blame, and a silent wheel.
   *
   * That is the failure this accessor exists to end. `ensureContext()`
   * deliberately lets a sound through while `resume()` is still settling (see
   * its comment — the alternative silences the app permanently), so a cue CAN
   * be dropped with no error and no trace. The spin reveal is the one place
   * where losing the first cue is losing the moment, so it asks first and
   * reports rather than guessing again.
   *
   * Returns a short reason string for telemetry, never anything user-facing.
   */
  inaudibleReason(): string | null {
    if (!this.enabled) return 'engine_disabled';
    if (!isSoundAllowed()) return 'preference_off';
    if (!this.ctx) return 'no_audio_context';
    if (this.ctx.state !== 'running') return `context_${this.ctx.state}`;
    if (!this.masterGain) return 'no_master_gain';
    if (this.masterGain.gain.value <= 0) return 'master_gain_zero';
    return null;
  }

  primeAudioUnlock(): void {
    this.installUnlockListeners();
    // A context that is already allowed to run should just run, rather than
    // waiting for a gesture that may never come (desktop, or a tab restored
    // with an existing audio permission).
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {
        /* expected before the first gesture - the listeners handle it */
      });
    }
  }

  private ensureContext(): boolean {
    if (!this.ctx || !this.masterGain) return false;
    if (this.ctx.state === 'suspended') {
      // Kick it, then let this sound through anyway. Returning false here
      // would be more honest about the one tone that gets dropped while
      // resume() settles, and much worse in practice: on a context that never
      // resumes it silences the app permanently instead of degrading.
      this.ctx.resume().catch(() => {
        /* only a real gesture can do it - installUnlockListeners is waiting */
      });
    }
    return true;
  }

  private get out(): GainNode {
    return this.masterGain!;
  }

  // ─── Volume Controls ─────────────────────────────────────────────────

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    // AUDIT 2026-08-20: persist to BOTH sound keys. Previously each caller wrote
    // only its own, so the two switches drifted and whichever was read last on
    // the next mount silently undid the other.
    persistSoundPreference(enabled);
    applyAudioSession(enabled);
  }

  /**
   * Must agree with shouldPlay(), or an
   * `if (soundService.isEnabled()) soundService.playX()` site would report
   * audible while the engine refused to play.
   */
  isEnabled(): boolean {
    return this.enabled && isSoundAllowed();
  }

  /** The audio engine's state, for the device check: 'running', 'suspended', 'closed' or 'unavailable'. */
  audioState(): string {
    return this.ctx ? this.ctx.state : 'unavailable';
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE CATEGORY GATE IS REAL MACHINERY WITH NO CONTROL ATTACHED
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Stated plainly here, 2026-08-29, because the shape is misleading: both
   * setters have ZERO callers in `src/`, so `categoryEnabled` is permanently
   * all-`true`, so `shouldPlay`'s `if (category && !this.categoryEnabled[...])`
   * and the win-sound check further down can never fire. Roughly forty category
   * arguments are threaded through this file to feed a branch that is
   * unreachable.
   *
   * Kept rather than deleted, deliberately: the gate itself is correct and the
   * per-category preference (Chat Message Sounds, Win Sounds, Turn Alert...) is
   * a control this product plausibly wants — deleting it means re-deriving the
   * plumbing later. What was deleted was `restoreStoredConfig`, which read a
   * localStorage key nothing has ever written and made this look wired when it
   * is not.
   *
   * IF YOU ADD THE UI: drive it through `setCategoryStates` and give it an
   * owner in `useTableSettings` like every other preference — not a fifth
   * private localStorage key.
   */
  setCategoryEnabled(category: SoundCategory, enabled: boolean) {
    this.categoryEnabled[category] = enabled;
  }

  /** Bulk-update category gates. See the note above: no caller yet. */
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
    // AUDIT 2026-08-20: `this.enabled` only ever reflected the IN-TABLE toggle,
    // because the Settings switch writes storage and never calls setEnabled().
    // Consult the shared gate so either switch genuinely silences the engine.
    if (!this.enabled || !isSoundAllowed()) return false;
    // No category gate (2026-08-28): sound is one switch. `category` is kept
    // in the signature because it names what the cue IS at 50 call sites.
    void category;
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

  /* THE REVEAL IS A SEQUENCE, NOT A COMPETITOR (2026-09-05) ────────────────
     The four spin cues went through `shouldPlay`, which is a winner-takes-the
     frame gate: `rank <= currentFramePriority` rejects, and the winner holds
     the frame for 50ms. That is right for a felt where a fold and an all in
     land together and only one of them should be heard. It is wrong for a
     reveal, because these four are consecutive movements of ONE animation and
     10.6 owes every one of them, for its full duration, every time.

     Three ways the gate silenced them, all reachable in production:

       1. A CLIENT THAT ARRIVES MID REVEAL. `at()` in SpinWheel clamps every
          beat already in the past to 0, so start, countdown, ticking and
          result are scheduled into the SAME frame. playSpinStart (big_win,
          95) went first and took the frame; the countdown and the ticking
          (ui, 10) were rejected, and playSpinMultiplierResult was rejected
          too, because it is also 95 and the comparison is `<=`. A late joiner
          heard the lever and then nothing at all, including the result.
       2. TWO `ui` CUES IN ONE WINDOW. `ui` is rank 10 and the gate is `<=`,
          so the SECOND ui cue inside any 50ms window is rejected always. Any
          unrelated ui cue landing beside a countdown light took the light.
       3. THE WHEEL SILENCED THE TABLE. playSpinStart parked the frame at 95
          for 50ms, so a deal, a chip or a fold arriving beside the lever was
          eaten by the wheel.

     `playPotCollect` hit exactly this and the answer recorded there is the
     answer here: a companion cue leaves the rank window and dedupes on its
     own clock (`tests/animations-always-play.law.test.ts` pins that it does).
     These four now do the same. They suppress nothing and nothing suppresses
     them; the only guard left is a short per cue throttle, which exists for a
     double fire from a re-render and nothing else. It is keyed per cue, so
     one movement of the reveal can never eat another. */
  private shouldPlaySpinCue(cue: string, minGapMs: number): boolean {
    if (!this.enabled || !isSoundAllowed()) return false;
    const nowMs = Date.now();
    if (nowMs - (this.lastSpinCueMs[cue] ?? 0) < minGapMs) return false;
    this.lastSpinCueMs[cue] = nowMs;
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

  /**
   * A noise burst whose BANDPASS sweeps downward -- the sound of something
   * small passing through air.
   *
   * Dan 2026-08-23: "the sound effect should sound more like a card flying
   * through the air, rather than what is currently in place." The old deal
   * sound was a fixed 3kHz LOWPASS over noise plus a 4kHz-to-1kHz oscillator
   * chirp, which is a click: a static filter cannot read as movement, and the
   * chirp put a plasticky snap on the tail.
   *
   * What makes air read as air is a moving formant. A bandpass sliding down the
   * spectrum is heard as an object going past; a fixed filter is heard as a
   * texture sitting still. Q is kept below ~1.5 so it stays breath rather than
   * becoming a whistle, and everything under 320Hz is cut because eighteen of
   * these fire inside a second on a nine-handed deal and any low content stacks
   * into mud.
   */
  private createSweptNoiseBurst(
    time: number,
    duration: number,
    volume: number,
    fromHz: number,
    toHz: number,
    q = 0.9
  ) {
    if (!this.ctx) return;
    const bufferSize = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = q;
    band.frequency.setValueAtTime(fromHz, time);
    band.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), time + duration);

    const highpass = this.ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 320;

    // Fast attack, exponential tail: the card is loudest as it leaves the deck
    // and thins out as it travels, which is the opposite shape to the
    // percussive click it replaces.
    const gain = this.ctx.createGain();
    const attack = Math.min(0.008, duration * 0.2);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    noise.connect(band);
    band.connect(highpass);
    highpass.connect(gain);
    gain.connect(this.out);
    noise.start(time);
    noise.stop(time + duration);
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

  /**
   * Like playTone, but takes an ABSOLUTE AudioContext time rather than a delay
   * from "now". Needed wherever several hits belong to one gesture — a double
   * tap, a chip stack — because scheduling the later hits with setTimeout puts
   * their spacing at the mercy of the main thread, and at a poker table the
   * main thread is always busy. The audio clock is not.
   */
  private scheduleTone(
    at: number,
    freq: number,
    duration: number,
    volume = 0.2,
    type: OscillatorType = 'sine'
  ) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);

    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + duration);

    osc.connect(gain);
    gain.connect(this.out);

    osc.start(at);
    osc.stop(at + duration);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GAME SOUNDS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * One card flying through the air, dealer to seat.
   *
   * 100ms end to end. That is deliberate and it is a hard constraint, not a
   * taste call: DealAnimation fires this once per card, eighteen times on a
   * nine-handed deal, roughly 63ms apart. Anything longer overlaps its own
   * neighbours and a deal turns into one continuous hiss.
   *
   * Two swept layers, both descending:
   *   - the air the card cuts (5.6kHz -> 900Hz, wide Q, the audible part)
   *   - a quieter, narrower body a beat later (2.4kHz -> 500Hz) so it has some
   *     weight and does not read as pure hiss
   *
   * There is no click at the end any more. The arrival snap belongs to the card
   * LANDING, which SeatSlot's own deal-in already covers; putting one here made
   * every card sound like it hit a table it had not reached yet.
   */
  playDeal() {
    if (!this.shouldPlay('deal', 'action') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    this.createSweptNoiseBurst(t, 0.1, 0.13, 5600, 900, 0.85);
    this.createSweptNoiseBurst(t + 0.012, 0.075, 0.05, 2400, 500, 1.4);

    haptic.light();
  }

  /**
   * SOUND AUDIT 2026-08-27: the whole deal's card slides, scheduled ONCE on
   * the AudioContext clock. DealAnimation used one setTimeout per card, and
   * under main-thread load two timers could bunch inside the 50ms priority
   * window — the second card's slide was silently dropped, so a busy deal
   * played fewer sounds than cards. The audio clock cannot bunch. One gate
   * check covers the sequence (it is one gesture: "the deal").
   */
  playDealSequence(delaysMs: number[]) {
    if (delaysMs.length === 0) return;
    if (!this.shouldPlay('deal', 'action') || !this.ensureContext()) return;
    const t0 = this.ctx!.currentTime;
    for (const d of delaysMs) {
      const t = t0 + Math.max(0, d) / 1000;
      this.createSweptNoiseBurst(t, 0.1, 0.13, 5600, 900, 0.85);
      this.createSweptNoiseBurst(t + 0.012, 0.075, 0.05, 2400, 500, 1.4);
    }
    haptic.light();
  }

  /**
   * Shuffle — riffle of the deck before the deal.
   * COMPETITOR-PARITY 2026-08-19: every major room marks the new hand with a
   * shuffle; we only ever had the deal slide. Three descending filtered
   * noise riffles + a soft square-up tap.
   */
  playShuffle() {
    // AUDIT-2 FIX 2026-08-20: was priority 'deal' — the SAME rank as
    // playDeal, so the shuffle at t=0 claimed the 50ms window and the first
    // flying card's deal sound was swallowed. 'shuffle' sits just above deal
    // so the riffle itself is never suppressed, and because the window is
    // only 50ms it no longer masks the per-card slides that follow.
    if (!this.shouldPlay('shuffle', 'action') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;
    // Three quick riffle bursts, descending brightness
    this.createNoiseBurst(t, 0.09, 0.1, 4200);
    this.createNoiseBurst(t + 0.09, 0.09, 0.12, 3200);
    this.createNoiseBurst(t + 0.18, 0.1, 0.1, 2400);
    // Square-up tap
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, t + 0.3);
    gain.gain.setValueAtTime(0.1, t + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t + 0.3);
    osc.stop(t + 0.38);
  }

  /**
   * Card Squeeze reveal — soft paper bend + flick when the hero peels a
   * face-down hole card open (COMPETITOR-PARITY 2026-08-19).
   */
  playCardSqueeze() {
    if (!this.shouldPlay('deal', 'action') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;
    // Slow paper bend
    this.createNoiseBurst(t, 0.16, 0.08, 1800);
    // Flick as the card snaps open
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.frequency.setValueAtTime(3200, t + 0.14);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.2);
    gain.gain.setValueAtTime(0.09, t + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t + 0.14);
    osc.stop(t + 0.2);
    haptic.light();
  }

  /* ── THE PEEL IS SILENT ─────────────────────────────────────────────────
     Dan 2026-09-05: "REMOVE THE SOUND EFFECT WHEN YOU ACTUALLY PEEL YOUR CARD,
     ITS NOT NEEDED."

     `startPeelFriction` / `updatePeelFriction` / `stopPeelFriction` (a sustained
     looped-noise -> bandpass -> gain voice fed the drag speed on every pointer
     move) and `playPeelLift` (a paper tick as the corner left the felt) lived
     here and are DELETED, not left unreferenced: four public methods on a
     singleton that nothing calls are four things the next agent has to prove
     are dead before touching this file. The peel keeps its haptics.

     `playCardSqueeze` - the card snapping fully open at the end of a committed
     peel - is a different cue and is still here and still fires. */

  /**
   * Dealer button move — one very soft felt 'tock' as the puck lands on the
   * next seat (COMPETITOR-PARITY 2026-08-19). Deliberately quiet: it fires
   * every hand.
   */
  playDealerButtonMove() {
    // AUDIT-2 FIX 2026-08-20: category added — with no category this bypassed
    // every SoundSettings sub-toggle. 'event' is the right bucket for a table
    // state change, and it no longer competes with the deal-card stream.
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;
    this.createNoiseBurst(t, 0.03, 0.08, 900);
    this.playTone(240, 0.05, 0.06, 'sine');
  }

  /**
   * Tournament level up — two rising tones + shimmer under the existing
   * level-up announcement banner (COMPETITOR-PARITY 2026-08-19: the banner
   * animated silently).
   */
  playLevelUp() {
    // AUDIT-2 FIX 2026-08-20: was priority 'showdown' (a semantic misuse that
    // also let it suppress raises/bets landing in the same window).
    if (!this.shouldPlay('time_bank', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;
    this.playTone(523, 0.16, 0.12, 'triangle'); // C5
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(784, t + 0.14); // G5
    gain.gain.setValueAtTime(0.12, t + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t + 0.14);
    osc.stop(t + 0.42);
    // shimmer
    this.createNoiseBurst(t + 0.16, 0.25, 0.04, 6000);
    haptic.medium();
  }

  /**
   * Check — two knuckle raps on the felt.
   *
   * Dan 2026-08-23: "the check sound effect needs to sound like two taps. like
   * you're tapping the table twice." It already tried to be two taps and did
   * not read as two, for two reasons, both fixed here.
   *
   * 1. The second tap was scheduled with `setTimeout(..., 120)` and then read
   *    `ctx.currentTime` fresh inside the callback. setTimeout is a MAIN-THREAD
   *    timer: at a poker table it competes with card animations, chip flights
   *    and React renders, so the gap wobbled with the frame rate and under
   *    load the two taps smeared into one thud. Both taps are now scheduled on
   *    the AudioContext clock, which is sample-accurate and does not care what
   *    the main thread is doing.
   * 2. 120 ms is inside the window where the ear fuses two transients into a
   *    single event. A real double rap on a table is nearer 160 ms apart, and
   *    the second is softer because it is the rebound of the same gesture.
   *
   * Each rap is a knuckle, not a click: a short filtered noise transient for
   * the impact, plus two low sine partials for the hollow of the table under
   * it, which is what makes it read as wood rather than as a UI blip.
   */
  playCheck() {
    if (!this.shouldPlay('check', 'action') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    /** One knuckle rap on the felt at absolute AudioContext time `at`. */
    const rap = (at: number, level: number) => {
      // Impact: brief, heavily lowpassed noise — the knuckle itself.
      this.createNoiseBurst(at, 0.045, 0.28 * level, 700);
      // Body: the table resonating under it. Two partials a fifth apart give
      // it a hollow wooden pitch instead of a bare sine thump.
      this.scheduleTone(at, 172, 0.11, 0.16 * level, 'sine');
      this.scheduleTone(at, 258, 0.07, 0.06 * level, 'sine');
    };

    rap(t, 1);
    rap(t + 0.16, 0.72);

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

    /**
     * Dan 2026-08-21: "CHANGE THE FOLD SOUND EFFECT TO MORE OF A LIGHT SWOOSH
     * SOUND, INSTEAD OF A DING."
     *
     * The old fold ran a SAWTOOTH oscillator swept 900Hz -> 80Hz. A sawtooth
     * has a fundamental, so it carries PITCH — and a short pitched tone is
     * heard as a ding, no matter that the code called it a swoosh. Two cards
     * sliding across felt have no pitch at all: they are broadband noise,
     * brightest at the start, darkening as they slow.
     *
     * So the tone is gone. What is left is air: a noise burst through a
     * bandpass that sweeps DOWN and opens up, with a short second brush a
     * beat later for the two cards. Quieter and lighter than before (0.11
     * peak vs 0.18) so folding never out-shouts the action.
     */
    const bufferSize = Math.floor(this.ctx!.sampleRate * 0.26);
    const buffer = this.ctx!.createBuffer(1, bufferSize, this.ctx!.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = this.ctx!.createBufferSource();
    noise.buffer = buffer;

    // Bandpass sweeping down = the sound of something moving away from you.
    const band = this.ctx!.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.7; // wide: airy, not whistly
    band.frequency.setValueAtTime(2600, t);
    band.frequency.exponentialRampToValueAtTime(420, t + 0.24);

    const gain = this.ctx!.createGain();
    // Soft attack (no click), gentle fall — a brush, not a hit.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.11, t + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

    noise.connect(band);
    band.connect(gain);
    gain.connect(this.out);
    noise.start(t);
    noise.stop(t + 0.26);

    // The second card, a beat behind the first.
    this.createNoiseBurst(t + 0.06, 0.12, 0.045, 1600);

    haptic.light();
  }

  /**
   * Discard - ONE card swept away, then landing on the muck.
   *
   * CRAZY PINEAPPLE PHASE 3 2026-08-31. Until today the discard played
   * `playFold()`: the wrong action's cue, and a two-card brush for a
   * one-card decision. A player who threw a card heard the sound the table
   * makes when a hand DIES, in the one variant where throwing a card is how
   * you stay in - which is exactly the confusion Dan reported as "auto folded
   * my hand, even though it didn't".
   *
   * Built out of the same air the deal is built from (`createSweptNoiseBurst`,
   * Dan 2026-08-23: a moving formant is heard as an object going past, a
   * fixed filter is heard as a texture sitting still), so a card leaving the
   * hand and a card arriving in it are audibly the same object. Three things
   * separate it from the fold:
   *
   *   - ONE brush, not two. The fold sends the whole hand; this sends a card.
   *   - It sweeps from higher and lands SHORTER (0.19s vs 0.26s) - a flick
   *     across the felt rather than a hand sliding away.
   *   - It ends on a soft felt tap, because the card stops. The fold has no
   *     tap: those cards are gone.
   *
   * Peak gain 0.10, just under the fold's 0.11 - this fires on every seat in
   * a round where every seat acts at once, so it has to sit under the action
   * rather than over it.
   */
  playDiscard() {
    if (!this.shouldPlay('discard', 'action') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // The card through the air: bandpass sliding down = moving away from you.
    this.createSweptNoiseBurst(t, 0.19, 0.1, 3000, 520, 0.85);

    // The card arriving on the felt. Heavily lowpassed and quiet - this is
    // the stop at the end of the flick, not a second card.
    this.createNoiseBurst(t + 0.14, 0.055, 0.05, 900);

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
    // SOUND AUDIT 2026-08-27: category added (see playSeatTaken).
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
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
    // AUDIT-2 FIX 2026-08-20 gave this its own rank (88) — but that moved it
    // in the WRONG direction: the gate is `rank <= currentFramePriority`, and
    // playWin (90) / playBigWin (95) always precede it in the same frame, so
    // 88 was rejected 100% of the time. The hero STILL never heard the pot
    // sweep on their own wins.
    // SOUND AUDIT 2026-08-27: the sweep is a companion to the fanfare, not a
    // competitor — bypass the rank window entirely and dedupe with its own
    // short throttle instead, so it plays every time the pot ships.
    if (!this.enabled || !isSoundAllowed()) return;
    const nowMs = Date.now();
    if (nowMs - this.lastPotCollectMs < 250) return;
    this.lastPotCollectMs = nowMs;
    if (!this.ensureContext()) return;

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
    // SOUND AUDIT 2026-08-27: category added — bypassed the Event Sounds
    // sub-toggle before (same fix playPlayerLeft got on 2026-08-20).
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
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
   * Player Left — descending two-note chime, the mirror of playSeatTaken.
   * ANIMATION/SOUND AUDIT 2026-08-19: the PLAYER_LEFT room event had an
   * empty case in TablePage — a seat emptied with zero feedback.
   */
  playPlayerLeft() {
    // AUDIT-2 FIX 2026-08-20: category added (bypassed SoundSettings before).
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    const now = this.ctx!.currentTime;
    const gain = this.createGain(0.1);
    const osc = this.ctx!.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1100, now);
    osc.frequency.setValueAtTime(820, now + 0.08);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.15);
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
    // SOUND AUDIT 2026-08-27: category added (see playSeatTaken).
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
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
    // SOUND AUDIT 2026-08-27: category added (see playSeatTaken).
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  THE PER-VOICE AMOUNT ONLY. MASTER IS APPLIED ONCE, BY masterGain.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This read `volume * this.masterVolume * this.effectsVolume` and then
     * connected to `this.out`, which IS `masterGain` — whose own gain is
     * already `masterVolume * effectsVolume`. So every voice built through this
     * helper was attenuated by masterVolume SQUARED:
     *
     *     slider 100  ->  1.00   (the only value that looked right)
     *     slider  70  ->  0.49   the default: 30% quieter than it says
     *     slider  50  ->  0.25   half the slider, a quarter of the sound
     *     slider  20  ->  0.04
     *
     * The volume control was quadratic, the whole app was quieter than every
     * number it displayed, and — because the other forty gain nodes in this
     * file are hand-rolled and connect to `out` with a raw value — sounds made
     * through this helper were quieter than sounds that were not, which is why
     * it never read as a simple "everything is too quiet" bug.
     *
     * `setMasterVolume` writes `masterGain.gain.value`, so master and effects
     * still take effect live, in the one place they belong.
     */
    gain.gain.value = volume;
    gain.connect(this.out);
    return gain;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PREMIUM EVENT SOUNDS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Bomb Pot — REBUILT 2026-08-20 against Dan's reference capture of the
   * competitor's double-board PLO bomb pot. The reference plays a three-beat
   * sequence, not one swell: (1) the bomb lands on the felt with a short
   * mid-band tick (measured ~1-3kHz, no bass at all), (2) the fuse crackles
   * as a broadband sizzle while antes post, (3) the explosion is almost pure
   * sub + low energy (52%/40% under 400Hz, spectral centroid 2.5kHz only
   * because of the initial crack) with a SLOW attack — the rumble builds for
   * ~450ms before peaking, then decays for ~1s. All three are synthesized
   * here from oscillators/noise (original audio — nothing sampled from the
   * capture). BombPotOverlay drives each beat at its animation phase; the
   * legacy playBombPot() below now just runs the full sequence for any
   * caller that doesn't manage phases itself.
   */

  /** Beat 1 — bomb falls in and lands: descending whistle + mid-band tick. */
  playBombDrop() {
    if (!this.shouldPlay('all_in', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // ART UPGRADE 2026-08-21 (Dan: "it needs to sound like a bomb incoming...
    // like that whistle... followed by the BOOOOOM"): the classic falling
    // bomb whistle, spanning the overlay's full 1.5s drop.
    //
    // Two detuned sine partials (a single one reads as a test tone), swept
    // 2.3kHz -> 240Hz, with a slow vibrato from an LFO on the frequency —
    // that wobble is what makes the ear hear "falling object" rather than
    // "descending beep". Held near full level until the last quarter so the
    // impact lands on top of it rather than after a fade-out.
    const DROP = 1.5;
    for (let k = 0; k < 2; k++) {
      const detune = k === 0 ? 1 : 1.011;
      const whistle = this.ctx!.createOscillator();
      const wGain = this.ctx!.createGain();
      whistle.type = 'sine';
      whistle.frequency.setValueAtTime(2300 * detune, t);
      whistle.frequency.exponentialRampToValueAtTime(240 * detune, t + DROP);

      const lfo = this.ctx!.createOscillator();
      const lfoGain = this.ctx!.createGain();
      lfo.frequency.value = 9;
      lfoGain.gain.value = 28;
      lfo.connect(lfoGain);
      lfoGain.connect(whistle.frequency);
      lfo.start(t);
      lfo.stop(t + DROP);

      wGain.gain.setValueAtTime(0.0001, t);
      wGain.gain.exponentialRampToValueAtTime(0.07, t + 0.15);
      wGain.gain.setValueAtTime(0.07, t + DROP * 0.75);
      wGain.gain.exponentialRampToValueAtTime(0.001, t + DROP);
      whistle.connect(wGain);
      wGain.connect(this.out);
      whistle.start(t);
      whistle.stop(t + DROP);
    }

    // Landing: short 1-3kHz tick (matches the measured landing transient)
    // plus a felt thump underneath, both on the beat the bomb touches down.
    this.createNoiseBurst(t + DROP, 0.07, 0.26, 2600);
    const thump = this.ctx!.createOscillator();
    const thGain = this.ctx!.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(170, t + DROP);
    thump.frequency.exponentialRampToValueAtTime(65, t + DROP + 0.16);
    thGain.gain.setValueAtTime(0.2, t + DROP);
    thGain.gain.exponentialRampToValueAtTime(0.001, t + DROP + 0.18);
    thump.connect(thGain);
    thGain.connect(this.out);
    thump.start(t + DROP);
    thump.stop(t + DROP + 0.18);

    haptic.light();
  }

  /** Beat 2 — the fuse burns: irregular broadband crackle for ~1.2s. */
  playBombFuse(durationSec = 1.2) {
    if (!this.shouldPlay('all_in', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;
    // ~12 crackles/second with random spacing, level and brightness —
    // regular spacing reads as a machine, irregular reads as a burning fuse.
    const crackles = Math.max(4, Math.floor(durationSec * 12));
    for (let i = 0; i < crackles; i++) {
      const at = t + (i / crackles) * durationSec + Math.random() * 0.04;
      const bright = 3000 + Math.random() * 3500; // 3-6.5kHz band
      const vol = 0.04 + Math.random() * 0.06;
      this.createNoiseBurst(at, 0.03 + Math.random() * 0.04, vol, bright);
    }
  }

  /** Beat 3 — the explosion: slow-attack sub boom + low rumble + crack. */
  playBombExplosion() {
    if (!this.shouldPlay('all_in', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Initial crack — the only non-bass content in the reference explosion
    this.createNoiseBurst(t, 0.1, 0.34, 1400);

    // ART UPGRADE 2026-08-21: a delayed second rumble ~300ms behind the first.
    // Real blasts in an enclosed space return an echo, and it is what turns a
    // "thud" into a "BOOOOOM" — Dan's word for what this should sound like.
    this.createNoiseBurst(t + 0.3, 1.0, 0.16, 120);

    // Sub boom: builds for ~0.4s, then ~1s decay (measured envelope shape)
    const sub = this.ctx!.createOscillator();
    const subGain = this.ctx!.createGain();
    sub.type = 'sine';
    // Deeper and longer than the original: 80 -> 22Hz over 1.7s.
    sub.frequency.setValueAtTime(80, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + 1.7);
    subGain.gain.setValueAtTime(0.06, t);
    subGain.gain.linearRampToValueAtTime(0.6, t + 0.4);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    sub.connect(subGain);
    subGain.connect(this.out);
    sub.start(t);
    sub.stop(t + 1.8);

    // Low rumble bed (filtered noise under 200Hz, same slow attack)
    const dur = 1.6;
    const bufferSize = Math.floor(this.ctx!.sampleRate * dur);
    const buffer = this.ctx!.createBuffer(1, bufferSize, this.ctx!.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.ctx!.createBufferSource();
    noise.buffer = buffer;
    const lp = this.ctx!.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 190;
    const nGain = this.ctx!.createGain();
    nGain.gain.setValueAtTime(0.02, t);
    nGain.gain.linearRampToValueAtTime(0.32, t + 0.42);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(lp);
    lp.connect(nGain);
    nGain.connect(this.out);
    noise.start(t);

    haptic.bombPot();
  }

  /**
   * Bomb Pot — full three-beat sequence (drop → fuse → explosion) for
   * callers that don't run the overlay's phase machine. The overlay itself
   * calls the three beats individually so audio stays locked to the visuals.
   */
  playBombPot() {
    this.playBombDrop();
    setTimeout(() => this.playBombFuse(1.7), 1500);
    setTimeout(() => this.playBombExplosion(), 3200);
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
   * Throwable Launch — the whoosh of the object leaving the hand.
   *
   * ANIMATION/SOUND AUDIT 2026-08-20: the picker used to play the IMPACT thud
   * at the moment you chose an emoji — a full 1200ms flight before the thing
   * actually hit anything, so the sound described an event that had not
   * happened yet. The impact moved to the end of the flight (and to every
   * viewer, not just the sender); this is what the launch moment gets instead.
   *
   * Rising, short, and quieter than the impact, so the pair reads as
   * throw-then-land rather than as two thuds.
   */
  playThrowableLaunch() {
    if (!this.shouldPlay('ui', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Upward whoosh — filtered noise sweeping up as the object accelerates.
    const noise = this.createNoiseBurst(t, 0.14, 0.09, 900);
    void noise;

    // Faint rising tone under it for the sense of travel.
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.14);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(t);
    osc.stop(t + 0.17);

    haptic.light();
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
   * Bounty Collected — knockout "cha-ching". Fired when a player claims a
   * bounty head (regular KO, or the cash half of a PKO). Deliberately shorter
   * and punchier than the mystery reveal, which keeps its own suspense build.
   */
  playBountyCollected() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;

    // SOUND AUDIT 2026-08-27: this whole block (and every cue below written in
    // the same 2026-08-20 pass) called playTone with volume and delay SWAPPED —
    // the author was thinking in ThrowableSoundService's (freq,dur,vol,type,
    // glide,delay) order. Six cues were fully silent (volume 0), three were
    // 3-7x too loud. Args restored to (freq, duration, VOLUME, type, DELAY).
    // Metallic strike — the "ching"
    [1567.98, 2093.0].forEach((freq, i) => {
      this.playTone(freq, 0.28, 0.32, 'triangle', 0.06 + i * 0.02);
    });
    // Coin shimmer tail
    [2637.02, 3135.96].forEach((freq, i) => {
      this.playTone(freq, 0.22, 0.18, 'sine', 0.14 + i * 0.05);
    });
    // Low confirmation thump so it lands on small speakers too
    this.playTone(220.0, 0.24, 0.26, 'sine', 0.0);

    haptic.mysteryReveal();
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE KNOCKOUT — a two-glove FLURRY, in ONE cue (2026-08-29)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Replaces playKnockoutSwing / playKnockoutImpact, which were built for a
   * single glove that crept in and struck once. Dan supplied a second capture
   * showing two gloves alternating, so the visual is a flurry now and the
   * audio has to be one.
   *
   * EVERYTHING BELOW IS MEASURED, not guessed. I cannot hear Dan's capture,
   * but the audio track can be analysed, and it was: onset detection plus a
   * short-time Fourier transform over KO KNOCKOUT.MOV gave
   *
   *   - SEVEN onsets between 2.87s and 3.77s — gaps of 64, 180, 215, 99 and
   *     75ms. That is a flurry, and it is why the visual lands three punches
   *     inside 280ms rather than one after a long creep.
   *   - decays of 46-186ms per landing, so every hit is SHORT;
   *   - two flavours of hit: a body thump whose strongest partials sit at 86,
   *     129 and 172Hz, and a brighter crack peaking at 1.4kHz or 3.7kHz;
   *   - band energy: 26% in 120-400Hz, 22% in 400Hz-1.2kHz, 35% in 1.2-4kHz
   *     and only 8% above 4kHz. Leather and body, not cymbal.
   *
   * ONE CUE, SCHEDULED ON THE AUDIO CLOCK. Not four setTimeouts. A main thread
   * busy re-laying-out a table that just lost a seat drifts a timer by tens of
   * milliseconds, and the 50ms priority window then eats the late arrival
   * outright — the same reasoning playDealSequence is built on.
   *
   * `speed` is the player's Animation Speed. Every offset multiplies by it, so
   * the audio and the CSS stretch together; the retired overlay scaled only
   * its JS half and drifted apart from its own visuals at 0.5x.
   */
  playKnockoutFlurry(
    opts: {
      isHero?: boolean;
      /** The player's animation-speed multiplier (a DURATION multiplier). */
      speed?: number;
      /** When each glove lands, ms from t0. The last one is the finisher. */
      punchesAtMs?: readonly number[];
      /** When the KO stamp slams on, ms from t0. */
      stampAtMs?: number;
      /**
       * The called "K.O." and the stamp's tick. TRUE for a real knockout;
       * FALSE for the `boxing_glove` throwable, which is the same punches
       * thrown at somebody who has not been eliminated — Dan 2026-08-29:
       * "SAME ANIMATION, SAME SOUND EFFECTS (MINUS THE K.O. AT THE END)".
       * Calling a knockout that did not happen would be worse than silence.
       */
      withCall?: boolean;
    } = {}
  ) {
    const {
      isHero = false,
      speed = 1,
      punchesAtMs = [180, 320, 460],
      stampAtMs = 930,
      withCall = true,
    } = opts;
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;
    const t0 = this.ctx!.currentTime;
    // A speed of 0 would collapse the whole cue onto one instant and stack
    // every oscillator on the same sample. Clamp rather than trust the caller.
    const s = Math.min(4, Math.max(0.1, speed));
    const punches = punchesAtMs.length ? punchesAtMs : [0];

    // THE WIND-UP — air moving past the first glove before it connects. A
    // whoosh is a filter sweep, and the first landing is only ~180ms away, so
    // this is short and it opens rather than closes.
    const lead = Math.max(0.05, (punches[0] ?? 180) / 1000) * s;
    this.createSweptNoiseBurst(t0, lead * 0.95, 0.07, 800, 2600, 0.9);

    punches.forEach((ms, i) => {
      const at = t0 + (ms / 1000) * s;
      const last = i === punches.length - 1;
      // The two jabs sit UNDER the finish. Three hits at equal weight is a
      // drum roll; two and a full stop is a combination.
      const g = last ? (isHero ? 1 : 0.85) : 0.5;

      // BODY — 86Hz and 129Hz were the strongest partials under every landing
      // in the capture, and they are low enough to be FELT on a phone speaker
      // that cannot actually reproduce them.
      this.scheduleTone(at, 86, 0.13 * s, 0.34 * g, 'sine');
      this.scheduleTone(at, 129, 0.1 * s, 0.2 * g, 'sine');
      // LEATHER — the crack. Measured decays ran 46-186ms; the jabs are at the
      // short end of that and the finish at the long end.
      this.createNoiseBurst(at, (last ? 0.12 : 0.055) * s, 0.24 * g, last ? 2600 : 1500);
      if (last) {
        // Only the two-fisted finish gets the bright 3.7kHz snap — in the
        // capture the brightest onsets are the ones that end a flurry.
        this.createSweptNoiseBurst(at, 0.07 * s, 0.2 * g, 3800, 1500, 1.2);
      }
    });

    // THE CALL. In the capture a human voice says "K.O." and it lands ON THE
    // IMPACT, not on the stamp: the voiced segment runs t0+420ms to t0+650ms
    // (and identically, to the millisecond, on the hero knockout 47 seconds
    // later — it is one recorded asset played twice).
    if (withCall) {
      const impactMs = punches[punches.length - 1] ?? 460;
      this.scheduleKnockoutCall(t0 + ((impactMs - 40) / 1000) * s, 0.3 * s, isHero ? 0.3 : 0.24);

      // THE STAMP slamming on. Same clock, so it cannot drift away from the
      // skoStampLife delay in SeatKnockout.css. It goes with the call: a
      // throwable has no stamp, so a tick for one would be a sound with
      // nothing on screen making it.
      const stampAt = t0 + (stampAtMs / 1000) * s;
      this.scheduleTone(stampAt, 880, 0.14 * s, 0.22, 'square');
      this.scheduleTone(stampAt + 0.01, 440, 0.2 * s, 0.16, 'triangle');
    }

    if (isHero) {
      haptic.strong();
    } else {
      haptic.medium();
    }
  }

  /**
   * A synthesised "K.O." call.
   *
   * HONEST LABEL: this is NOT a human voice and it is not pretending to be
   * one. It is a source-and-formant approximation of the one in Dan's
   * capture, built from measurements of it:
   *
   *   F0 falls 342Hz -> 157Hz across ~300ms (about 1.1 octaves — that FALL is
   *   the shape the ear reads as a called knockout); periodicity 0.75-0.82,
   *   so strongly voiced and close-mic'd; spectral centroid 1.7-2.0kHz, so
   *   warm with no sibilance; first formant ~640Hz drifting to ~215Hz and
   *   second ~1000Hz drifting to ~640Hz, which is the vowel moving from the
   *   "ay" of K to the "oh" of O.
   *
   * WHY IT IS SYNTHESISED RATHER THAN SAMPLED. The recording in the capture
   * is PokerBros' audio asset. Lifting it into this product would be copying
   * someone else's sound recording, so it is not on the table however good it
   * sounds. Replace this with a REAL voice by recording one to the numbers
   * above — 300ms, falling, close-mic'd, no reverb — dropping it in as
   * `public/images/knockout/ko-call.webm` and pointing KO_VOICE_URL at it.
   * The synth stays as the fallback for browsers that cannot decode it.
   */
  private scheduleKnockoutCall(at: number, duration: number, volume: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const end = at + duration;

    // The plosive: the hard "K". Very short, quite bright, and it is what
    // stops the call sounding like a slide whistle.
    this.createNoiseBurst(at, 0.035, volume * 0.5, 3200);

    // A voiced source — sawtooth for harmonic richness — gliding down.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(342, at);
    osc.frequency.exponentialRampToValueAtTime(157, end);

    // Two bandpass "formants" in parallel. One filter is a buzz; two is a
    // vowel, and moving them is what turns "K" into "O".
    const mk = (f0: number, f1: number, q: number, gain: number) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(f0, at);
      bp.frequency.exponentialRampToValueAtTime(f1, end);
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(bp);
      bp.connect(g);
      return g;
    };
    const f1 = mk(640, 230, 6, 1);
    const f2 = mk(1000, 650, 8, 0.7);

    // The envelope: a fast attack, a held shout, then a tail. Measured rms
    // climbs to peak inside 60ms and holds for ~150ms before falling away.
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(volume, at + 0.055);
    amp.gain.setValueAtTime(volume, at + duration * 0.55);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);

    f1.connect(amp);
    f2.connect(amp);
    amp.connect(this.out);

    osc.start(at);
    osc.stop(end + 0.02);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  SPIN WHEEL — the multiplier draw (2026-08-20)
   * ═══════════════════════════════════════════════════════════════════════
   * In a Spin the draw IS the product, and the ticking is most of the drama.
   * Three cues: the wheel is released, the wheel runs down, the wheel lands.
   */

  /** Release — a mechanical clunk and a rising sweep as the wheel is let go. */
  /**
   * THE STARTING GRID. Dan 2026-08-21: "THE 3, 2, 1 SHOULD FEEL LIKE A NASCAR
   * COUNT DOWN" — so the reveal opens on an idling engine, not a fanfare.
   *
   * The bed is deliberately a LOOP with no pitch envelope. The previous
   * version swept a sawtooth from 90Hz to 300Hz as the wheel launched, and
   * Dan's note on it was exact: "REMOVE THE SPRING SOUND BEFORE THE WHEEL
   * SPINS." A rising pitch glide IS a boing; nothing in this sequence changes
   * pitch any more. The engine only ever opens and closes a filter.
   *
   * It runs until `playSpinTicking` fades it out, so it must be stoppable —
   * hence the retained nodes. A bed that outlived its reveal would idle under
   * the whole first hand.
   */
  playSpinStart() {
    if (!this.shouldPlaySpinCue('start', 250) || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // The lever: a dry mechanical thunk, no tail.
    this.createNoiseBurst(t, 0.06, 0.22, 2600);
    this.playTone(160, 0.1, 0.16, 'square', 0.0);

    this.stopSpinBed(0);

    // Two detuned saws under a closed lowpass = an engine at idle. The slow
    // LFO on the fundamental is the lope; without it this is just a drone.
    const o1 = this.ctx!.createOscillator();
    const o2 = this.ctx!.createOscillator();
    const lfo = this.ctx!.createOscillator();
    const lfoGain = this.ctx!.createGain();
    const lp = this.ctx!.createBiquadFilter();
    const gain = this.ctx!.createGain();

    o1.type = 'sawtooth';
    o1.frequency.setValueAtTime(52, t);
    o2.type = 'sawtooth';
    o2.frequency.setValueAtTime(78, t);
    o2.detune.setValueAtTime(-14, t);
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(7.5, t);
    lfoGain.gain.setValueAtTime(9, t);
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(240, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.085, t + 0.5);

    lfo.connect(lfoGain);
    lfoGain.connect(o1.frequency);
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(gain);
    gain.connect(this.out);
    o1.start(t);
    o2.start(t);
    lfo.start(t);

    this.spinBed = { o1, o2, lfo, gain, lp };
    haptic.medium();
  }

  /**
   * One light on the tree: red, then yellow, then green. Rising by a fifth and
   * then an octave, so the ear knows which lamp lit without looking, and the
   * engine blips underneath each one.
   */
  playSpinCountdownLight(step: number) {
    // Keyed by step: three lights are three cues, never each other's duplicate.
    if (!this.shouldPlaySpinCue(`countdown:${step}`, 250) || !this.ensureContext()) return;
    const f = [330, 392, 784][Math.max(0, Math.min(2, Math.floor(step)))];
    this.playTone(f, 0.22, 0.13, 'square', 0);
    this.playTone(f * 1.5, 0.16, 0.06, 'triangle', 0.01);
    this.createNoiseBurst(this.ctx!.currentTime, 0.04, 0.09, 1800);

    // Throttle blip. Filter and gain only — see playSpinStart on why nothing
    // here is allowed to change pitch.
    const bed = this.spinBed;
    if (bed) {
      const t = this.ctx!.currentTime;
      bed.lp.frequency.cancelScheduledValues(t);
      bed.lp.frequency.setValueAtTime(240, t);
      bed.lp.frequency.linearRampToValueAtTime(900, t + 0.16);
      bed.lp.frequency.linearRampToValueAtTime(260, t + 0.5);
      bed.gain.gain.cancelScheduledValues(t);
      bed.gain.gain.setValueAtTime(bed.gain.gain.value, t);
      bed.gain.gain.linearRampToValueAtTime(0.17, t + 0.14);
      bed.gain.gain.linearRampToValueAtTime(0.085, t + 0.5);
    }
    haptic.light();
  }

  /** Fade the idle bed out and free its oscillators. */
  private stopSpinBed(fadeSec = 0.4) {
    const bed = this.spinBed;
    this.spinBed = null;
    if (!bed || !this.ctx) return;
    const t = this.ctx.currentTime;
    try {
      bed.gain.gain.cancelScheduledValues(t);
      bed.gain.gain.setValueAtTime(Math.max(0.0001, bed.gain.gain.value), t);
      bed.gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.01, fadeSec));
      bed.o1.stop(t + fadeSec + 0.05);
      bed.o2.stop(t + fadeSec + 0.05);
      bed.lfo.stop(t + fadeSec + 0.05);
    } catch {
      /* already stopped */
    }
  }

  /**
   * THE FLAPPER. Dan 2026-08-21: "I WANT THE SOUND EFFECT WHILE ITS SPINNING
   * TO SOUND LIKE A REAL WHEEL SPIN WITH CLICKING SOUNDS AS IT PASSES."
   *
   * "As it passes" is the whole specification, and it is why this takes the
   * chase's OWN schedule. The previous version invented 46 evenly-inverted
   * ticks and hoped they tracked the light; pass `stepOffsetsMs` and every
   * click lands on the exact millisecond the light crosses a peg, because it
   * is literally the same array the component animates from.
   *
   * A real flapper is a bandpass noise transient plus a short ring, both
   * randomised — identical clicks read as a machine gun. Velocity RISES with
   * progress: a peg struck by a slowing wheel is a heavier, louder knock.
   */
  playSpinTicking(durationMs: number, stepOffsetsMs?: number[]) {
    if (!this.shouldPlaySpinCue('tick', 400) || !this.ensureContext()) return;
    const t0 = this.ctx!.currentTime;
    const dur = Math.max(0.4, durationMs / 1000);

    // The launch is the bed LEAVING, not a pitch sweep. See playSpinStart.
    this.stopSpinBed(0.4);

    // Air under the whole chase: broadband, closing from bright to dark as the
    // wheel loses speed.
    const noise = this.ctx!.createBufferSource();
    noise.buffer = this.noiseBuffer(dur + 0.4);
    const lp = this.ctx!.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, t0);
    lp.frequency.exponentialRampToValueAtTime(160, t0 + dur);
    const ng = this.ctx!.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.075, t0 + 0.18);
    ng.gain.setValueAtTime(0.075, t0 + dur * 0.55);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.25);
    noise.connect(lp);
    lp.connect(ng);
    ng.connect(this.out);
    noise.start(t0);
    noise.stop(t0 + dur + 0.4);

    /* One click per peg the light actually crosses.

       AN EMPTY SCHEDULE IS AN ANSWER, NOT A MISSING ARGUMENT (2026-09-05).
       This read `stepOffsetsMs && stepOffsetsMs.length > 0`, so an empty ARRAY
       fell through to the 46-click fallback. SpinWheel hands over the
       CAUGHT-UP schedule, and a client that arrives after the chase has ended -
       during the multi-second result hold, a common window - has no pegs left
       to cross, so it passes `[]` with a duration of 0. Every fallback offset
       then computed `0 * anything = 0` and all 46 clicks fired on the same
       millisecond at velocities ramping to 1.0: one loud crack instead of a
       chase.

       It was unreachable until today only because playSpinTicking was rank
       `ui` (10) and always lost the frame to playSpinStart's 95. Taking the
       cues off that gate unmasked it, which is the honest cost of that change
       and why it is fixed here rather than noted.

       `undefined` still means "caller has no schedule, improvise one"; `[]`
       means "nothing left to strike", and the two are no longer the same
       sentence. */
    const offsets =
      stepOffsetsMs === undefined
        ? Array.from(
            { length: 46 },
            (_, i) => Math.max(0, durationMs) * Math.pow((i + 1) / 46, 2.35)
          )
        : stepOffsetsMs;

    if (offsets.length > 0) {
      const last = Math.max(1, offsets.length - 1);
      offsets.forEach((ms, i) => {
        this.spinPegClick(t0 + Math.max(0, ms) / 1000, 0.5 + 0.5 * (i / last));
      });
    }
  }

  /** A visible Diamond Wheel peg strike, driven by its presentation clock.
   * Unlike a prescheduled chase, it cannot finish while that tab is hidden. */
  playSpinPeg(velocity: number) {
    if (!this.shouldPlaySpinCue('visible-peg', 0) || !this.ensureContext()) return;
    this.spinPegClick(this.ctx!.currentTime, Math.max(0.5, Math.min(1, velocity)));
  }

  /** A single peg strike: noise transient + a short randomised ring. */
  private spinPegClick(at: number, velocity: number) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.03);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2100 + Math.random() * 1500, at);
    bp.Q.value = 3.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.26 * velocity, at + 0.0016);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.026);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.out);
    src.start(at);
    src.stop(at + 0.04);

    const ring = this.ctx.createOscillator();
    const rg = this.ctx.createGain();
    ring.type = 'triangle';
    ring.frequency.setValueAtTime(1750 + Math.random() * 550, at);
    rg.gain.setValueAtTime(0.085 * velocity, at);
    rg.gain.exponentialRampToValueAtTime(0.0001, at + 0.033);
    ring.connect(rg);
    rg.connect(this.out);
    ring.start(at);
    ring.stop(at + 0.05);
  }

  /** White noise of a given length. */
  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * THE LANDING. Dan 2026-08-21: "THE WINNING SQUARE SHOULD HAVE AN ANGELIC
   * LIKE SOUND EFFECT", and then, of the first attempt at it: "THE WINNING
   * SOUND AT THE END NEEDS TO SOUND LIKE AN ANGELIC AHHHH TYPE OF SOUND, WHAT
   * IS THERE NOW IS ANNOYING."
   *
   * What was there was a bell arpeggio and a coin shower — bright, metallic,
   * and on a 100x it fired twelve randomised pings on top of a sustained
   * chord. Loud is not the same as triumphant.
   *
   * A vowel is not a chord. It is a buzzy source shaped by the resonances of a
   * throat, so this is built the way a voice is: sawtooth voices on a C-E-G-C,
   * each doubled at plus and minus nine cents, fed through three parallel
   * bandpass filters tuned to the formants of "ah" (730 / 1090 / 2440 Hz).
   * That filter trio is the entire difference between a synth pad and a choir.
   *
   * Two details do most of the work. The vibrato fades IN over the first
   * second rather than starting on it, which is what makes it read as breath
   * instead of an LFO. And the swell is slow — three quarters of a second up,
   * three and a half down — which is why SPIN_REVEAL.RESULT_HOLD_MS is 3200:
   * a shorter hold would cut the voices off mid-word.
   *
   * The tier only scales LOUDNESS and haptics. Every spin gets the same
   * sound, because ~87% of them are 2x or 3x and giving the common case a
   * lesser noise teaches players that most of the format is a disappointment.
   */
  playSpinMultiplierResult(multiplier: number) {
    if (!this.shouldPlaySpinCue('result', 400) || !this.ensureContext()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    // The stop: the wheel seating against its last peg.
    this.createNoiseBurst(t, 0.08, 0.26, 2200);
    this.playTone(150, 0.16, 0.26, 'sine', 0.0);

    /* ROUND 15: the level comes from spinCelebration, the one place that
       decides how loudly a draw celebrates, so the wheel's burst and this
       chord can never disagree about how rare the moment was. The ladder it
       replaces was hand-written here and had already drifted from the wheel's
       own bands (it stepped at 5x; the wheel steps at 10x). */
    const level = spinCelebration(multiplier).soundLevel;

    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.85 * level, t + 0.75);
    bus.gain.linearRampToValueAtTime(0.72 * level, t + 1.9);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    bus.connect(this.out);

    /** F1, F2, F3 of "ah": centre frequency, relative gain, Q. */
    const FORMANTS: Array<[number, number, number]> = [
      [730, 1.0, 9],
      [1090, 0.55, 11],
      [2440, 0.22, 13],
    ];
    const CHORD = [261.63, 329.63, 392.0, 523.25];

    CHORD.forEach((f, vi) => {
      [-9, 9].forEach((cents, di) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, t);
        osc.detune.setValueAtTime(cents, t);

        // Vibrato that ARRIVES rather than starts. This is the breath.
        const vib = ctx.createOscillator();
        const vibGain = ctx.createGain();
        vib.type = 'sine';
        vib.frequency.setValueAtTime(4.3 + vi * 0.35 + di * 0.2, t);
        vibGain.gain.setValueAtTime(0, t);
        vibGain.gain.linearRampToValueAtTime(5.5, t + 0.9);
        vib.connect(vibGain);
        vibGain.connect(osc.detune);
        vib.start(t);
        vib.stop(t + 3.8);

        // Higher voices sit back, or the top C dominates the vowel.
        const voice = ctx.createGain();
        voice.gain.value = 0.055 / (1 + vi * 0.35);
        osc.connect(voice);

        FORMANTS.forEach(([freq, amp, q]) => {
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(freq, t);
          bp.Q.value = q;
          const fg = ctx.createGain();
          fg.gain.value = amp;
          voice.connect(bp);
          bp.connect(fg);
          fg.connect(bus);
        });

        // A trace of unfiltered source keeps it from sounding hollow.
        const dry = ctx.createGain();
        dry.gain.value = 0.05;
        voice.connect(dry);
        dry.connect(bus);

        osc.start(t);
        osc.stop(t + 3.8);
      });
    });

    // The intake before the note.
    this.createNoiseBurst(t, 0.08, 0.14, 1200);

    if (multiplier >= 100) haptic.jackpot();
    else if (multiplier >= 25) haptic.strong();
    else haptic.medium();
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  MYSTERY BOUNTY CHEST — the three beats of the reveal (2026-08-20)
   * ═══════════════════════════════════════════════════════════════════════
   * Dan: "a suspense filled in screen with a treasure chest that needs to be
   * CLICKED TO OPEN, then some animation followed by an EXPLOSION with the
   * amount revealed."
   *
   * Three cues for three beats, deliberately distinct so the ear can follow
   * the story even if the player looks away: the chest LANDS, the lid CREAKS,
   * the thing BLOWS. playMysteryBountyReveal then carries the reveal itself.
   */

  /** Chest lands — heavy wooden thud with an iron rattle, then a suspense drone. */
  playMysteryChestLand() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Weight: low thud
    this.playTone(70, 0.34, 0.4, 'sine', 0.0);
    this.playTone(105, 0.22, 0.22, 'triangle', 0.01);
    // Timber: broadband knock
    this.createNoiseBurst(t, 0.1, 0.24, 600);
    // Iron fittings rattling from the drop
    this.createNoiseBurst(t + 0.09, 0.07, 0.1, 4200);
    this.createNoiseBurst(t + 0.17, 0.05, 0.06, 5200);

    // Suspense drone underneath — slow rise, unresolved on purpose. This is
    // the bed the "tap to open" prompt sits on.
    const osc = this.ctx!.createOscillator();
    const gain = this.ctx!.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(48, t + 0.1);
    osc.frequency.linearRampToValueAtTime(66, t + 1.9);
    const lp = this.ctx!.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(300, t + 0.1);
    lp.frequency.linearRampToValueAtTime(700, t + 1.9);
    gain.gain.setValueAtTime(0.0001, t + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.075, t + 1.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    osc.connect(lp);
    lp.connect(gain);
    gain.connect(this.out);
    osc.start(t + 0.1);
    osc.stop(t + 2.15);

    haptic.medium();
  }

  /** Lid creaks open — hinge groan rising as the seam splits. */
  playMysteryChestOpen() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // Latch pops first — you hear the lock give before the hinge moves.
    this.createNoiseBurst(t, 0.04, 0.26, 3600);
    this.playTone(880, 0.07, 0.12, 'square', 0.0);

    // Hinge groan: detuned saw pair sliding up, band-passed so it reads as
    // wood-and-iron rather than as a synth sweep.
    [0, 3].forEach((detune, i) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      const bp = this.ctx!.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 5;
      bp.frequency.setValueAtTime(320, t + 0.05);
      bp.frequency.exponentialRampToValueAtTime(1500, t + 0.75);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(105 + detune, t + 0.05);
      osc.frequency.exponentialRampToValueAtTime(240 + detune, t + 0.75);
      gain.gain.setValueAtTime(0.0001, t + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.1 - i * 0.03, t + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      osc.connect(bp);
      bp.connect(gain);
      gain.connect(this.out);
      osc.start(t + 0.05);
      osc.stop(t + 0.9);
    });

    // Light escaping the seam — a shimmer that promises the payoff.
    [1975.53, 2637.02, 3520.0].forEach((f, i) => {
      this.playTone(f, 0.5, 0.07, 'sine', 0.35 + i * 0.07);
    });

    haptic.strong();
  }

  /** The explosion — flash, shockwave, and a shower of coins. */
  playMysteryChestExplosion() {
    if (!this.shouldPlay('big_win', 'event') || !this.ensureContext()) return;
    const t = this.ctx!.currentTime;

    // The crack: full-band burst.
    this.createNoiseBurst(t, 0.16, 0.42, 9000);
    this.createNoiseBurst(t + 0.02, 0.3, 0.3, 1800);

    // Sub-bass drop you feel more than hear.
    const sub = this.ctx!.createOscillator();
    const subGain = this.ctx!.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(150, t);
    sub.frequency.exponentialRampToValueAtTime(32, t + 0.55);
    subGain.gain.setValueAtTime(0.55, t);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    sub.connect(subGain);
    subGain.connect(this.out);
    sub.start(t);
    sub.stop(t + 0.7);

    // Coin shower — a scatter of metallic pings over ~700ms. Randomised
    // spacing so it reads as coins falling, not as an arpeggio.
    const coins = [2093.0, 2637.02, 3135.96, 3520.0, 4186.01];
    for (let i = 0; i < 14; i++) {
      const f = coins[i % coins.length] * (0.94 + Math.random() * 0.12);
      this.playTone(f, 0.16, 0.055, 'triangle', 0.12 + Math.random() * 0.6);
    }

    // Triumphant major chord landing under the shower.
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.playTone(f, 0.9, 0.13, 'sine', 0.18 + i * 0.03);
    });

    haptic.jackpot();
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

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  THE DIAMOND GAMES CAN BE HEARD AND FELT (2026-09-26)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The Diamond Spins wheel has had a full score since August: a lever, a
   * peg click on every seam that crosses the pointer, a landing. Crash,
   * Plinko, Donkey Cross and Diamond Mines were nearly silent. These cues
   * give each of them sound that follows the action and a pulse on the key
   * beats, so the games feel physical on a phone.
   *
   * THE SCENES CALL THESE, NOT THE PAGES. Every cue here is called from the
   * frame that shows its moment (the Crash, Plinko and crossing frame loops,
   * the Mines board's render), so a sound can never run ahead of the picture
   * that makes it. Anything tied to motion takes the player's Animation Speed
   * and stretches with it.
   *
   * THE GATES. `gameBeat` is the one door:
   *   - a hidden tab plays nothing and buzzes nothing;
   *   - a per cue throttle absorbs a double fire from a re-render (and, for
   *     the Plinko peg tick, is the rate limit that stops a batch of a hundred
   *     drops machine-gunning);
   *   - the BUZZ goes through vibrationGate before the sound gate is asked,
   *     because vibration has its own switch: a player who plays muted still
   *     feels the beats, and a player who turns vibration off feels nothing;
   *   - the SOUND then needs the master switch (soundGate) and a context.
   * These cues leave the 50 ms rank window alone, like the spin cues above:
   * they are movements of one scene, not competitors for a felt's frame.
   * Every voice connects to `this.out`, so master and effects volume apply.
   *
   * CONTINUOUS VOICES ARE REUSED. The Crash engine and the car coming to a
   * street are ONE voice each (`motors`), built once and then only steered:
   * the frame loop calls drive*() every frame and that writes two or three
   * AudioParam targets, never a node. They stop on every terminal beat, on
   * unmount, when sound is switched off mid flight and when the tab is hidden.
   *
   * Short hits share one cached noise grain (`grainBuffer`) instead of
   * filling a fresh buffer each time, so a board of falling diamonds does not
   * allocate a buffer per peg.
   */

  private gameCueMs: Record<string, number> = {};
  private motors: Partial<Record<MotorName, Motor>> = {};
  private grain: AudioBuffer | null = null;

  private tabHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden === true;
  }

  /** The one door for the Diamond game cues. See the note above. */
  private gameBeat(cue: string, minGapMs: number, buzz?: () => void): boolean {
    if (this.tabHidden()) return false;
    const nowMs = Date.now();
    if (nowMs - (this.gameCueMs[cue] ?? Number.NEGATIVE_INFINITY) < minGapMs) return false;
    this.gameCueMs[cue] = nowMs;
    buzz?.();
    if (!this.enabled || !isSoundAllowed()) return false;
    return this.ensureContext();
  }

  /** 1.2 s of white noise, filled once and shared by every short hit. */
  private grainBuffer(): AudioBuffer {
    if (!this.grain) this.grain = this.noiseBuffer(1.2);
    return this.grain;
  }

  /** A filtered slice of the shared grain: a click, a clop, a crack or a rumble. */
  private grainBurst(
    at: number,
    duration: number,
    volume: number,
    type: BiquadFilterType,
    hz: number,
    q = 0.9
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    const dur = Math.max(0.01, Math.min(1.15, duration));
    const src = ctx.createBufferSource();
    src.buffer = this.grainBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(hz, at);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(Math.max(0.0002, volume), at + Math.min(0.004, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.out);
    // A different slice of the grain each time, so repeated hits are not clones.
    src.start(at, Math.random() * (1.2 - dur), dur + 0.02);
  }

  /** A falling sine: the weight under an impact. */
  private thump(at: number, fromHz: number, toHz: number, duration: number, volume: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fromHz, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), at + duration);
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(gain);
    gain.connect(this.out);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** An explosion: a bright crack, a falling thump and a rumble under it. */
  private blast(at: number, s: number, crackHz: number, weight: number) {
    this.grainBurst(at, 0.22 * s, 0.34 * weight, 'lowpass', crackHz, 0.7);
    this.grainBurst(at + 0.01, 0.07, 0.2 * weight, 'highpass', 3200, 0.7);
    this.thump(at, 120, 34, 0.55 * s, 0.46 * weight);
    this.grainBurst(at + 0.02, Math.min(1.1, 0.95 * s), 0.2 * weight, 'lowpass', 170, 0.7);
  }

  /** Build a continuous voice: two detuned saws and a looped noise band, one gain. */
  private buildMotor(name: MotorName, hz: number, spec: MotorSpec): Motor | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(spec.cutoff(hz), t);
    lp.Q.value = 0.8;
    const a = ctx.createOscillator();
    const b = ctx.createOscillator();
    a.type = 'sawtooth';
    b.type = 'sawtooth';
    a.frequency.setValueAtTime(hz, t);
    b.frequency.setValueAtTime(hz * spec.ratio, t);
    b.detune.setValueAtTime(-9, t);
    // The throb: a slow wobble on the fundamental, or it is a test tone.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(spec.throbHz, t);
    lfoGain.gain.setValueAtTime(spec.throbDepth, t);
    lfo.connect(lfoGain);
    lfoGain.connect(a.frequency);
    // The air: a looped band of the shared grain that follows the pitch.
    const air = ctx.createBufferSource();
    air.buffer = this.grainBuffer();
    air.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(hz * spec.airRatio, t);
    band.Q.value = 0.7;
    const airGain = ctx.createGain();
    airGain.gain.setValueAtTime(spec.air, t);
    air.connect(band);
    band.connect(airGain);
    airGain.connect(gain);
    a.connect(lp);
    b.connect(lp);
    lp.connect(gain);
    gain.connect(this.out);
    a.start(t);
    b.start(t);
    lfo.start(t);
    air.start(t);
    const motor: Motor = {
      a,
      b,
      lp,
      band,
      gain,
      sources: [a, b, lfo, air],
      checkedMs: Date.now(),
      hz: 0,
      level: 0,
    };
    this.motors[name] = motor;
    return motor;
  }

  /**
   * Steer a continuous voice to a pitch and level, building it the first time.
   * Called every frame; it writes AudioParam targets only when the target has
   * actually moved, and asks the sound switch at most four times a second.
   */
  private driveMotor(name: MotorName, hz: number, level: number, spec: MotorSpec) {
    if (this.tabHidden()) {
      this.stopMotor(name, 0.05);
      return;
    }
    let motor = this.motors[name];
    const nowMs = Date.now();
    if (!motor || nowMs - motor.checkedMs >= 250) {
      if (!this.enabled || !isSoundAllowed()) {
        this.stopMotor(name, 0.08);
        return;
      }
      if (motor) motor.checkedMs = nowMs;
    }
    if (!motor) {
      if (!this.ensureContext()) return;
      motor = this.buildMotor(name, hz, spec) ?? undefined;
      if (!motor) return;
    }
    if (Math.abs(hz - motor.hz) < motor.hz * 0.002 && Math.abs(level - motor.level) < 0.001) return;
    const t = this.ctx!.currentTime;
    motor.a.frequency.setTargetAtTime(hz, t, 0.05);
    motor.b.frequency.setTargetAtTime(hz * spec.ratio, t, 0.05);
    motor.lp.frequency.setTargetAtTime(spec.cutoff(hz), t, 0.06);
    motor.band.frequency.setTargetAtTime(hz * spec.airRatio, t, 0.06);
    motor.gain.gain.setTargetAtTime(Math.max(0.0001, level), t, motor.hz === 0 ? 0.08 : 0.12);
    motor.hz = hz;
    motor.level = level;
  }

  /** Fade a continuous voice out and release its nodes. Safe to call when none is running. */
  private stopMotor(name: MotorName, fadeSec: number) {
    const motor = this.motors[name];
    if (!motor) return;
    delete this.motors[name];
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const fade = Math.max(0.02, fadeSec);
    try {
      motor.gain.gain.cancelScheduledValues(t);
      motor.gain.gain.setValueAtTime(Math.max(0.0001, motor.gain.gain.value), t);
      motor.gain.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      for (const source of motor.sources) source.stop(t + fade + 0.05);
    } catch {
      /* already stopped */
    }
  }

  private stopAllMotors(fadeSec: number) {
    for (const name of Object.keys(this.motors) as MotorName[]) this.stopMotor(name, fadeSec);
  }

  /** True while a continuous voice is sounding. For tests and diagnostics. */
  isMotorRunning(name: MotorName): boolean {
    return Boolean(this.motors[name]);
  }

  // ─── Crash ───────────────────────────────────────────────────────────

  /**
   * The jet's engine, following the live multiplier. One voice for the whole
   * flight: the first call builds it, every later call steers it. Pitch climbs
   * about a musical ninth by 5x and two octaves by 25x (log scale, because
   * 1x to 2x must be heard as clearly as 10x to 20x), and the level rises a
   * little with it. Stopped by stopCrashEngine on every terminal state.
   */
  driveCrashEngine(cents: number) {
    const climb = Math.log2(Math.max(100, Number.isFinite(cents) ? cents : 100) / 100);
    const octaves = Math.min(2.2, climb * 0.47);
    const hz = 68 * Math.pow(2, octaves);
    const level = 0.05 + 0.04 * Math.min(1, octaves / 2.2);
    this.driveMotor('crash', hz, level, CRASH_ENGINE);
  }

  stopCrashEngine(fadeSec = 0.12) {
    this.stopMotor('crash', fadeSec);
  }

  /** The flight ends in a burst: crack, falling thump and rumble. Strong buzz. */
  playCrashExplosion(speed = 1) {
    if (!this.gameBeat('crash-explosion', 400, () => haptic.strong())) return;
    this.blast(this.ctx!.currentTime, gameSpeed(speed), 1900, 1);
  }

  /**
   * A win is booked: a dry latch, then two gold bell notes a fourth apart,
   * with a low confirmation under them so it lands on a phone speaker. The
   * multiplier lifts the pitch a little and brightens the upper partial;
   * every booking gets the same shape. Medium buzz. Shared by Crash, Donkey
   * Cross and Diamond Mines, so "booked" is one sound on the platform.
   */
  playBonusBooked(multiplier: number) {
    if (!this.gameBeat('booked', 400, () => haptic.medium())) return;
    const t = this.ctx!.currentTime;
    const lift = Math.min(
      1,
      Math.log2(Math.max(1, Number.isFinite(multiplier) ? multiplier : 1)) / 4.6
    );
    const root = 880 * Math.pow(2, (lift * 5) / 12);
    this.grainBurst(t, 0.03, 0.18, 'bandpass', 3200, 2);
    this.scheduleTone(t, 196, 0.24, 0.14, 'sine');
    this.scheduleTone(t + 0.02, root, 0.34, 0.15, 'triangle');
    this.scheduleTone(t + 0.02, root * 2.01, 0.22, 0.045, 'sine');
    this.scheduleTone(t + 0.11, root * 1.335, 0.55, 0.16, 'triangle');
    this.scheduleTone(t + 0.11, root * 2.67, 0.38, 0.04 + 0.05 * lift, 'sine');
  }

  /**
   * A round booked AT the cap: a gold brass fanfare over the crown burst,
   * C-E-G-C rising, the last three held as a chord, and a shimmer on top.
   * Timed against the crown burst, so it stretches with Animation Speed.
   * The jackpot buzz.
   */
  playCrashMax(speed = 1) {
    if (!this.gameBeat('crash-max', 800, () => haptic.jackpot())) return;
    const ctx = this.ctx!;
    const s = gameSpeed(speed);
    const t = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.value = 0.9;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.setValueAtTime(900, t);
    tone.frequency.linearRampToValueAtTime(3400, t + 0.3 * s);
    tone.Q.value = 0.6;
    bus.connect(tone);
    tone.connect(this.out);
    const NOTES = [523.25, 659.25, 783.99, 1046.5];
    const hold = 1.1 * s;
    NOTES.forEach((f, i) => {
      const at = t + i * 0.09 * s;
      const end = i === 0 ? at + 0.22 * s : t + hold;
      [-7, 7].forEach((cents) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, at);
        osc.detune.setValueAtTime(cents, at);
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(0.05, at + 0.03);
        g.gain.setValueAtTime(0.05, Math.max(at + 0.03, end - 0.35 * s));
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(g);
        g.connect(bus);
        osc.start(at);
        osc.stop(end + 0.05);
      });
    });
    this.thump(t, 150, 60, 0.4 * s, 0.24);
    this.grainBurst(t + 0.27 * s, Math.min(1.1, 0.8 * s), 0.07, 'highpass', 6500, 0.7);
    [2093, 2637, 3136].forEach((f, i) => {
      this.scheduleTone(t + (0.3 + i * 0.08) * s, f, 0.3, 0.05, 'sine');
    });
  }

  // ─── Plinko ──────────────────────────────────────────────────────────

  /**
   * A diamond strikes a peg: a soft chrome tick. Rate limited to one every
   * 30 ms however many diamonds are falling, so a batch of a hundred is a
   * patter, not a machine gun. Pitch falls down the board, row by row;
   * `hits` (pegs struck in the same frame) adds a little weight.
   */
  playPlinkoPeg(row: number, hits = 1) {
    if (!this.gameBeat('plinko-peg', PLINKO_PEG_GAP_MS)) return;
    const t = this.ctx!.currentTime;
    const r = Math.max(0, Math.min(15, Number.isFinite(row) ? row : 0));
    const hz = 2600 * Math.pow(2, -r / 22);
    const weight = Math.min(1, 0.6 + 0.12 * (Math.max(1, hits) - 1));
    this.scheduleTone(t, hz, 0.05, 0.05 * weight, 'triangle');
    this.grainBurst(t, 0.018, 0.06 * weight, 'bandpass', hz * 1.4, 3);
  }

  /**
   * A diamond lands in a bucket: the glass plate clinks, brighter the more
   * the bucket pays (the same log scale the bucket colours use, 0.05x cold to
   * 25x hot). A big win (5x or better) adds a gold sparkle and the jackpot
   * buzz; any other landing is a light tap.
   */
  playPlinkoLanding(cents: number, big: boolean) {
    const buzz = () => (big ? haptic.jackpot() : haptic.light());
    if (!this.gameBeat('plinko-landing', 25, buzz)) return;
    const t = this.ctx!.currentTime;
    const c = Number.isFinite(cents) ? cents : 0;
    const heat = c <= 5 ? 0 : c >= 2500 ? 1 : Math.log(c / 5) / Math.log(500);
    const hz = 620 * Math.pow(2, heat * 1.6);
    this.scheduleTone(t, hz, 0.24, 0.12, 'triangle');
    this.scheduleTone(t, hz * 2.76, 0.14, 0.035 + 0.05 * heat, 'sine');
    this.grainBurst(t, 0.025, 0.09, 'highpass', 2600, 0.8);
    if (big) {
      this.thump(t, 180, 70, 0.3, 0.2);
      [1567.98, 1975.53, 2349.32, 3135.96].forEach((f, i) => {
        this.scheduleTone(t + 0.06 + i * 0.07, f, 0.32, 0.07, 'sine');
      });
      this.grainBurst(t + 0.1, 0.5, 0.05, 'highpass', 7000, 0.7);
    }
  }

  // ─── Donkey Cross ────────────────────────────────────────────────────

  /** One hoof on the asphalt: a clop, alternating a little in pitch by foot. */
  playCrossingHoof(step: number) {
    if (!this.gameBeat('hoof', 40)) return;
    const t = this.ctx!.currentTime;
    const high = Math.abs(Math.round(step)) % 2 === 0;
    this.grainBurst(t, 0.05, 0.15, 'bandpass', high ? 1150 : 920, 2.2);
    this.scheduleTone(t, high ? 210 : 180, 0.06, 0.12, 'sine');
    this.scheduleTone(t + 0.01, high ? 1500 : 1320, 0.022, 0.035, 'triangle');
  }

  /**
   * The car coming to the street: one engine voice, louder, brighter and a
   * little higher the nearer it is (`closeness`, 0 far to 1 at the donkey).
   * Driven by the crossing's frame loop; stopped when it brakes or strikes.
   */
  driveCrossingCar(closeness: number) {
    const near = Math.max(0, Math.min(1, Number.isFinite(closeness) ? closeness : 0));
    this.driveMotor('car', 58 + 42 * near, 0.02 + 0.075 * near * near, CROSSING_CAR);
  }

  stopCrossingCar(fadeSec = 0.1) {
    this.stopMotor('car', fadeSec);
  }

  /** The car brakes on a safe street: a tyre squeal over the braking time. */
  playCrossingBrake(speed = 1) {
    if (!this.gameBeat('brake', 300)) return;
    const ctx = this.ctx!;
    const s = gameSpeed(speed);
    const t = ctx.currentTime;
    const dur = 0.34 * s;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1500, t);
    band.Q.value = 2.5;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.11, t + 0.03);
    bus.gain.setValueAtTime(0.11, t + dur * 0.6);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    band.connect(bus);
    bus.connect(this.out);
    const wobble = ctx.createOscillator();
    const wobbleGain = ctx.createGain();
    wobble.frequency.setValueAtTime(26, t);
    wobbleGain.gain.setValueAtTime(38, t);
    wobble.connect(wobbleGain);
    [1240, 1335].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.linearRampToValueAtTime(f * 0.9, t + dur);
      wobbleGain.connect(osc.frequency);
      osc.connect(band);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
    wobble.start(t);
    wobble.stop(t + dur + 0.05);
    this.grainBurst(t, dur, 0.06, 'bandpass', 2400, 1.2);
  }

  /** The car's horn: two notes a third apart, one blast. */
  playCrossingHorn() {
    if (!this.gameBeat('horn', 400)) return;
    this.hornAt(this.ctx!.currentTime);
  }

  private hornAt(t: number) {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1900, t);
    lp.Q.value = 0.7;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.09, t + 0.02);
    bus.gain.setValueAtTime(0.09, t + 0.26);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    lp.connect(bus);
    bus.connect(this.out);
    [392, 493.88].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(f, t);
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 0.38);
    });
  }

  /**
   * The car strikes: a crunch, a clank of metal and a heavy thump. Strong
   * buzz. `withHorn` layers the horn under it for a scene that had no
   * approach to sound it in (reduced motion, or no scene at all).
   */
  playCrossingHit(options: { withHorn?: boolean; speed?: number } = {}) {
    if (!this.gameBeat('crossing-hit', 400, () => haptic.strong())) return;
    const t = this.ctx!.currentTime;
    const s = gameSpeed(options.speed ?? 1);
    if (options.withHorn) this.hornAt(t);
    this.grainBurst(t, 0.2 * s, 0.3, 'lowpass', 2300, 0.8);
    this.thump(t, 140, 42, 0.4 * s, 0.42);
    this.scheduleTone(t + 0.01, 620, 0.12, 0.07, 'triangle');
    this.scheduleTone(t + 0.02, 913, 0.09, 0.05, 'triangle');
  }

  /**
   * The donkey reaches the far side of a street: a soft two note step up,
   * climbing a little with each street crossed. Light buzz.
   */
  playCrossingLanded(street: number) {
    if (!this.gameBeat('crossing-landed', 150, () => haptic.light())) return;
    const t = this.ctx!.currentTime;
    const n = Math.max(0, Math.min(16, Number.isFinite(street) ? street : 0));
    const hz = 587.33 * Math.pow(2, n / 24);
    this.scheduleTone(t, hz, 0.12, 0.09, 'triangle');
    this.scheduleTone(t + 0.06, hz * 1.5, 0.18, 0.08, 'triangle');
  }

  // ─── Diamond Mines ───────────────────────────────────────────────────

  /**
   * A gem turns over: a crystalline chime that climbs a pentatonic ladder
   * with each consecutive gem (`streak`, 1 for the first). Light buzz.
   */
  playMinesGem(streak: number) {
    if (!this.gameBeat('mines-gem', 60, () => haptic.light())) return;
    const t = this.ctx!.currentTime;
    const LADDER = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const i = Math.max(0, Math.min(LADDER.length - 1, Math.floor(streak) - 1));
    const hz = 1046.5 * Math.pow(2, LADDER[i] / 12);
    this.scheduleTone(t, hz, 0.55, 0.1, 'sine');
    this.scheduleTone(t, hz * 2.005, 0.32, 0.04, 'sine');
    this.scheduleTone(t + 0.005, hz * 3.01, 0.2, 0.025, 'triangle');
    this.grainBurst(t, 0.12, 0.035, 'highpass', 7200, 0.7);
  }

  /** A mine goes off under the tile. Strong buzz. Stretches with the blast animation. */
  playMinesExplosion(speed = 1) {
    if (!this.gameBeat('mines-explosion', 400, () => haptic.strong())) return;
    this.blast(this.ctx!.currentTime, gameSpeed(speed), 2400, 0.9);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  destroy() {
    this.stopAllMotors(0.02);
    this.stopTimerWarning();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }
  }
}

export const soundService = new SoundService();
