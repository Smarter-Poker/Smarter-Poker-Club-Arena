/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PREMIUM SFX ENGINE — Web Audio API Synthesizer (UI-TIER)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE NOTE — This is the UI-tier sound layer, separate from:
 *   1. SoundService.ts     — Poker table game sounds (deal, fold, all-in, etc.)
 *   2. SoundPackService.ts — Sound profile/preset manager (wraps SoundService)
 *   3. PremiumSFX.ts (THIS) — UI interaction sounds (card flip, navigate, toggle)
 *
 * Intentionally INDEPENDENT of SoundService — has its own AudioContext and
 * localStorage flag to avoid coupling home/UI sounds with table game logic.
 *
 * Zero-dependency sound engine that generates pleasant, premium UI sounds
 * using the Web Audio API. No external .mp3/.wav files needed.
 *
 * All sounds are designed to be:
 *  - Subtle and non-intrusive (master volume 0.15)
 *  - Pleasant and warm (no harsh frequencies)
 *  - Fast-attacking (instant feedback, no latency)
 *  - Short-decaying (never overstays its welcome)
 *
 * Respects the user's sound preference via localStorage.
 */

import { STORAGE_KEYS } from '../lib/storage';
import { reportError } from '../utils/errorReporter';
import { isSoundAllowed } from '../utils/soundGate';
import { soundService } from './SoundService';

// Musical note frequencies (Hz) — equal temperament tuning
const NOTE = {
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.0,
  A4: 440.0,
  B4: 493.88,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  F5: 698.46,
  G5: 783.99,
  A5: 880.0,
  B5: 987.77,
  C6: 1046.5,
  E6: 1318.51,
  G6: 1567.98,
} as const;

let _ctx: AudioContext | null = null;

// A phone call or a backgrounded app leaves the context suspended (iOS says
// 'interrupted'); resume when the page is visible again, as SoundService
// already does, so the first cue after a call is not silent. (2026-09-08)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _ctx && _ctx.state !== 'running') {
      _ctx.resume().catch(() => {
        /* will resume on next user gesture */
      });
    }
  });
}

/** Lazily create or resume the AudioContext (requires user gesture) */
function getCtx(): AudioContext | null {
  try {
    if (!_ctx) {
      _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (_ctx.state === 'suspended') {
      _ctx.resume().catch(() => {
        /* will resume on next user gesture */
      });
    }
    return _ctx;
  } catch (err) {
    reportError(err, 'PremiumSFX.init');
    return null; // Web Audio API not supported
  }
}

/**
 * SOUND AUDIT 2026-08-27: the master volume slider had NO effect on any
 * UI-tier sound — every primitive here connected straight to ctx.destination
 * at a hardcoded level, so a player who turned the table down (or nearly off)
 * still got full-strength card flips and toggles. Scale every primitive by
 * the shared master volume, NORMALISED to its 0.7 default so today's tuned
 * loudness is unchanged for a player who never touched the slider. Clamped
 * so a maxed slider cannot push the subtle UI tier into harshness.
 */
function uiGainFactor(): number {
  try {
    return Math.min(1.5, Math.max(0, soundService.getMasterVolume() / 0.7));
  } catch {
    return 1;
  }
}

/** Check if sounds are enabled */
function isEnabled(): boolean {
  try {
    // AUDIT 2026-08-20: this read only the SETTINGS key, so the in-table Sounds
    // toggle never silenced premium cues. Both switches now go through one gate.
    return isSoundAllowed();
  } catch (err) {
    reportError(err, 'PremiumSFX.play');
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOUND PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════════

/** Play a sine tone with envelope */
function playTone(
  freq: number,
  duration: number,
  volume: number = 0.15,
  type: OscillatorType = 'sine',
  delay: number = 0
): void {
  const ctx = getCtx();
  if (!ctx) return;

  const now = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);

  // Smooth envelope: fast attack, natural decay
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume * uiGainFactor(), now + 0.008); // 8ms attack
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration); // smooth decay

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + duration + 0.01);
}

/** Play a filtered noise burst */
function playNoise(
  duration: number,
  volume: number = 0.08,
  filterFreq: number = 4000,
  delay: number = 0
): void {
  const ctx = getCtx();
  if (!ctx) return;

  const now = ctx.currentTime + delay;

  // Create noise buffer
  const bufferSize = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Bandpass filter for warmth
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(filterFreq, now);
  filter.Q.setValueAtTime(1.5, now);

  // Envelope
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume * uiGainFactor(), now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  source.start(now);
  source.stop(now + duration + 0.01);
}

/** Play a pitch sweep (ascending or descending) */
function playSweep(
  startFreq: number,
  endFreq: number,
  duration: number,
  volume: number = 0.1,
  type: OscillatorType = 'sine'
): void {
  const ctx = getCtx();
  if (!ctx) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(startFreq, now);
  osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume * uiGainFactor(), now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + duration + 0.01);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREMIUM SOUND EFFECTS
// ═══════════════════════════════════════════════════════════════════════════════

export const PremiumSFX = {
  /**
   * Card Flip — Quick ascending chime (C5 → E5)
   * Used during staggered card entrance animation
   */
  cardFlip: () => {
    if (!isEnabled()) return;
    playTone(NOTE.C5, 0.12, 0.1, 'sine');
    playTone(NOTE.E5, 0.1, 0.08, 'sine', 0.04);
  },

  /**
   * Tap Flip — Soft filtered click
   * Used when single-tapping to toggle quick stats view
   */
  tapFlip: () => {
    if (!isEnabled()) return;
    playNoise(0.035, 0.06, 5000);
    playTone(NOTE.A5, 0.06, 0.05, 'sine');
  },

  /**
   * Double Tap — Warm major chord confirmation (C4-E4-G4)
   * Used when double-tapping to navigate into a club
   */
  doubleTap: () => {
    if (!isEnabled()) return;
    playTone(NOTE.C4, 0.25, 0.08, 'sine');
    playTone(NOTE.E4, 0.22, 0.07, 'sine', 0.02);
    playTone(NOTE.G4, 0.2, 0.06, 'sine', 0.04);
  },

  /**
   * Scroll Snap — Ultra-soft high ping
   * Used when carousel snaps to a card
   */
  scrollSnap: () => {
    if (!isEnabled()) return;
    playTone(NOTE.E6, 0.05, 0.04, 'sine');
  },

  /**
   * Drag Start — Subtle ascending pitch sweep
   * Used when beginning to drag a card
   */
  dragStart: () => {
    if (!isEnabled()) return;
    playSweep(NOTE.C4, NOTE.G4, 0.08, 0.06, 'sine');
  },

  /**
   * Drag Drop — Satisfying low thud + confirmation
   * Used when dropping a card into a new position
   */
  dragDrop: () => {
    if (!isEnabled()) return;
    playTone(NOTE.C4, 0.15, 0.1, 'sine');
    playNoise(0.06, 0.05, 800);
    playTone(NOTE.G4, 0.1, 0.06, 'sine', 0.05);
  },

  /**
   * CTA Click — Bright sparkle arpeggio (G5 → E5 → C5)
   * Used when clicking Join/Create CTA cards
   */
  ctaClick: () => {
    if (!isEnabled()) return;
    playTone(NOTE.G5, 0.1, 0.08, 'sine');
    playTone(NOTE.E5, 0.1, 0.07, 'sine', 0.06);
    playTone(NOTE.C5, 0.15, 0.09, 'sine', 0.12);
  },

  /**
   * Toggle On — Rising two-tone chime
   * Used when enabling sounds
   */
  toggleOn: () => {
    // Always play this one (user is enabling sounds)
    playTone(NOTE.C5, 0.12, 0.1, 'sine');
    playTone(NOTE.G5, 0.15, 0.1, 'sine', 0.08);
  },

  /**
   * Toggle Off — Soft descending tone
   * Used when disabling sounds
   */
  toggleOff: () => {
    // Play even when disabling (farewell sound)
    playTone(NOTE.G4, 0.12, 0.06, 'sine');
    playTone(NOTE.C4, 0.15, 0.05, 'sine', 0.08);
  },

  /**
   * Navigate — Filtered whoosh with warmth
   * Used when navigating to a club or tile page
   */
  navigate: () => {
    if (!isEnabled()) return;
    playSweep(NOTE.C5, NOTE.C6, 0.18, 0.06, 'sine');
    playNoise(0.15, 0.04, 3000);
  },

  /**
   * Notification — Gentle ascending two-note chime (E5 → A5)
   * Used when receiving in-app notifications
   */
  notification: () => {
    if (!isEnabled()) return;
    playTone(NOTE.E5, 0.15, 0.08, 'sine');
    playTone(NOTE.A5, 0.12, 0.07, 'sine', 0.1);
  },
};

export default PremiumSFX;
