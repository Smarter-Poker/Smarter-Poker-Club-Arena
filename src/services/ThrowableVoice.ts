/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE VOICE — spoken taunts for the throwables that need words
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21 asked for voice-overs on a dozen throwables: "KO", "THAT'S
 * GOTTA HURT", "CHEERS", "YOU'RE THE BEST", "GOOD LUCK", "LET'S GAMBLE",
 * "IT'S GOOD", "UH OH", "PEE-YEW".
 *
 * WHY THE BROWSER'S OWN VOICE AND NOT AUDIO FILES
 * Recorded lines would mean ~12 new assets to generate, host, version and
 * cache-bust, on a bundle already carrying 88 MB of media — and a stale copy
 * of any of them is exactly the regression class we spent today fencing off.
 * `speechSynthesis` is built into every browser this app supports, costs zero
 * bytes, and is trivially retunable: a line change is a string edit, not an
 * asset pipeline.
 *
 * TUNING
 * Each line carries its own rate/pitch/volume so a KO barks and a "cheers"
 * lilts. The default voice is left to the platform deliberately — naming
 * specific voices ("Daniel", "Samantha") breaks the moment you cross an OS,
 * and the fallback is silence rather than a wrong-sounding one.
 *
 * SAFETY / ETIQUETTE
 * - Respects the same enable flag and master volume as every other table sound.
 * - Cancels any in-flight utterance before speaking, so rapid throws never
 *   queue into a pile-up of overlapping voices.
 * - Never throws: unsupported browsers, blocked autoplay and missing voices
 *   all degrade to silence. The procedural SFX still carries the moment.
 * - Nothing is spoken unless a throw actually lands, so this can never
 *   become ambient chatter.
 */

import { soundService } from './SoundService';

export interface VoiceLine {
  /** What is said. Keep it under ~1.2s at the given rate. */
  text: string;
  /** 0.1 - 10; speechSynthesis default is 1. */
  rate?: number;
  /** 0 - 2; speechSynthesis default is 1. */
  pitch?: number;
  /** 0 - 1, multiplied by the user's effects volume. */
  volume?: number;
  /** Delay from impact, ms. Lets a line land after its sound effect. */
  delay?: number;
}

/** Per-throwable spoken line. Items absent from this map simply do not talk. */
export const VOICE_LINES: Record<string, VoiceLine> = {
  /* boxing_glove has NO spoken line. Dan 2026-08-29: the throwable plays the
     knockout animation "MINUS THE K.O. AT THE END" — and a voice calling a
     knockout at a player who is still sitting there is exactly the part he
     asked to remove. The punches carry it. */
  anvil: { text: "That's gotta hurt", rate: 1, pitch: 0.8, delay: 420 },
  beer: { text: 'Cheers!', rate: 0.95, pitch: 1.1, delay: 300 },
  trophy: { text: "You're the best", rate: 0.95, pitch: 1.15, delay: 320 },
  horseshoe: { text: 'Good luck', rate: 0.95, pitch: 1.05, delay: 300 },
  dice: { text: "Let's gamble", rate: 1, pitch: 0.95, delay: 260 },
  football: { text: "It's good!", rate: 0.95, pitch: 1.1, delay: 380 },
  pizza_slice: { text: 'Uh oh', rate: 0.9, pitch: 1.2, delay: 200 },
  poop: { text: 'Pee yew!', rate: 0.85, pitch: 1.3, delay: 240 },
  trash_can: { text: 'Stinky!', rate: 0.9, pitch: 1.25, delay: 300 },
  bowling_ball: { text: 'Strike!', rate: 0.9, pitch: 1.05, delay: 620 },
  robot: { text: 'Ha ha ha ha', rate: 0.6, pitch: 0.3, delay: 220 },
  shark: { text: 'Heh heh heh heh heh', rate: 1.35, pitch: 0.55, delay: 200 },
  chicken: { text: 'Bock bock bock bock booook', rate: 1.1, pitch: 1.6, delay: 160 },
  ghost: { text: 'Ooooohhhhuuuuu', rate: 0.5, pitch: 0.45, delay: 120 },
  bear: { text: 'Roooaaar', rate: 0.55, pitch: 0.3, delay: 100 },
  laughing_emoji: { text: 'Ha ha ha ha ha!', rate: 1.15, pitch: 1.35, delay: 140 },
  crying_emoji: { text: 'Boo hoo hoo', rate: 0.8, pitch: 1.4, delay: 180 },
};

let warned = false;

function synth(): SpeechSynthesis | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.speechSynthesis ?? null;
  } catch {
    return null;
  }
}

class ThrowableVoiceClass {
  private pending: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  /** True when the platform can actually speak. */
  isSupported(): boolean {
    return !!synth() && typeof window.SpeechSynthesisUtterance === 'function';
  }

  /**
   * Speak a throwable's line, if it has one. No-op for silent items, for
   * users with sound off, and on any platform that cannot speak.
   */
  speakFor(throwableId: string): (() => void) | undefined {
    const line = VOICE_LINES[throwableId];
    if (!line) return;
    return this.speak(line);
  }

  speak(line: VoiceLine): (() => void) | undefined {
    this.cancel();
    if (!soundService.isEnabled()) return;
    const s = synth();
    if (!s || typeof window.SpeechSynthesisUtterance !== 'function') {
      if (!warned) {
        warned = true;
        // Not an error: the procedural SFX still plays. Log once so it is
        // discoverable why a taunt is silent on this platform.
        console.debug('[ThrowableVoice] speechSynthesis unavailable; taunts are silent.');
      }
      return;
    }

    const generation = this.generation;
    const fire = () => {
      if (generation !== this.generation) return;
      this.pending = undefined;
      if (!soundService.isEnabled()) return;
      try {
        // Rapid throws must not queue into overlapping voices.
        s.cancel();
        const u = new SpeechSynthesisUtterance(line.text);
        u.rate = line.rate ?? 1;
        u.pitch = line.pitch ?? 1;
        u.volume = Math.max(0, Math.min(1, (line.volume ?? 0.9) * soundService.getMasterVolume()));
        s.speak(u);
      } catch {
        /* speech is a garnish, never a dependency */
      }
    };

    if (line.delay && line.delay > 0) this.pending = setTimeout(fire, line.delay);
    else fire();
    // A departing older throw must not cancel a newer throw's voice.
    return () => {
      if (generation === this.generation) this.cancel();
    };
  }

  /** Stop anything currently being said (table teardown, mute). */
  cancel(): void {
    this.generation += 1;
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    try {
      synth()?.cancel();
    } catch {
      /* nothing to cancel */
    }
  }
}

export const throwableVoice = new ThrowableVoiceClass();
export default throwableVoice;
