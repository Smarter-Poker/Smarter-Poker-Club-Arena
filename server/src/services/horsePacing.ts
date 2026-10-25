/**
 * HORSE PACING: the beat between something happening at the felt and a horse
 * reacting to it (Dan 2026-10-21: chat and throws must "be random and feel
 * genuine and not like a bot or ai player").
 *
 * A person sees the pot pushed, reads the cards, then types or taps. A
 * reaction on the same frame as the event is the tell. The beat is a hash of
 * the reaction's own key, so it is spread across the range, never one number,
 * and a replay waits the same time.
 *
 * Pacing only: nothing here retries, repeats or schedules work for later.
 */

import { personaHash } from '../engine/HorsePersona.js';

export type BeatKind = 'typed' | 'tap' | 'quick';

/** [min, max) milliseconds for each kind of reaction. */
const RANGES: Record<BeatKind, [number, number]> = {
  /** a typed chat line after a hand: read, think, type */
  typed: [1_400, 5_200],
  /** a throwable after a hand: open the seat menu, pick, send */
  tap: [900, 3_600],
  /** a line or a throw as the horse moves in: already in motion */
  quick: [150, 900],
};

export function humanBeatMs(key: string, kind: BeatKind): number {
  const [lo, hi] = RANGES[kind];
  return lo + (personaHash(`${key}|beat`) % (hi - lo));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPING A LINE (Dan 2026-10-24: "THEY CAN'T FIRE OFF FULL SENTENCES RIGHT
// AFTER A HAND IS OVER")
// ═══════════════════════════════════════════════════════════════════════════════
//
// A flat 1.4 to 5.2 seconds let a 55-character sentence with two emoji land a
// second and a half after the pot was pushed. A person notices the result,
// (for a reply) reads what was said to them, then types every character at
// their own speed and opens the emoji picker. The beat is now built from the
// exact text that will be written.

/** [min, max) ms to take in the result before starting to type. */
const NOTICE_MS: Record<'typed' | 'quick', [number, number]> = {
  typed: [1_500, 4_500],
  /** moving in: already looking at the table */
  quick: [300, 1_000],
};
/** A horse's habitual typing speed, characters per second, [min, max). */
export const TYPING_CPS: [number, number] = [2.6, 5.4];
/** Per-line wobble on that speed, as a factor [min, max). */
const LINE_WOBBLE: [number, number] = [0.85, 1.2];
/** Opening the emoji picker once, then each emoji tapped. */
const EMOJI_PICKER_MS: [number, number] = [800, 1_800];
const EMOJI_EACH_MS = 300;
/** Reading what a player said before answering it, characters per second. */
const READ_CPS = 20;
const READ_MAX_MS = 4_000;
/** No line takes longer than this to arrive. */
export const TYPING_MAX_MS: Record<'typed' | 'quick', number> = { typed: 32_000, quick: 14_000 };

const between = (key: string, [lo, hi]: [number, number]): number =>
  lo + ((personaHash(key) % 10_000) / 10_000) * (hi - lo);

/** This horse's own typing speed: a fixed habit, the same every line. */
export function typingSpeedCps(horseId: string): number {
  return between(`${horseId}|typing-speed`, TYPING_CPS);
}

const PICTOGRAPH = /\p{Extended_Pictographic}/gu;

export interface TypingBeat {
  /** The reaction's own key: the same key waits the same time. */
  key: string;
  horseId: string;
  /** Exactly what will be written, styling and emoji included. */
  text: string;
  kind: 'typed' | 'quick';
  /** For a reply: the length of the line being answered. */
  readChars?: number;
}

/**
 * How long after the moment a typed line arrives: notice, read (a reply),
 * type every character at this horse's speed, pick any emoji. Deterministic.
 */
export function typingBeatMs(b: TypingBeat): number {
  const notice = between(`${b.key}|notice`, NOTICE_MS[b.kind]);
  const read =
    b.readChars && b.readChars > 0 ? Math.min(READ_MAX_MS, (b.readChars / READ_CPS) * 1_000) : 0;
  const emoji = [...b.text.matchAll(PICTOGRAPH)].length;
  const chars = [...b.text.replace(PICTOGRAPH, '').replace(/\uFE0F/g, '')].length;
  // a hurried line as the horse shoves is typed a little faster, never instantly
  const hurry = b.kind === 'quick' ? 1.25 : 1;
  const cps = typingSpeedCps(b.horseId) * between(`${b.key}|wobble`, LINE_WOBBLE) * hurry;
  const typing = (chars / cps) * 1_000;
  const picking =
    emoji > 0 ? between(`${b.key}|picker`, EMOJI_PICKER_MS) + emoji * EMOJI_EACH_MS : 0;
  return Math.round(Math.min(TYPING_MAX_MS[b.kind], notice + read + typing + picking));
}

let pacingOn = true;
/** With pacing off (tests), the beats asked for are recorded instead of waited. */
const recorded: number[] = [];

/** Test hook: a suite on fake timers turns the beat off rather than advancing clocks. */
export function _setHumanPacingForTests(on: boolean): void {
  pacingOn = on;
  recorded.length = 0;
}

/** Test hook: the beats asked for while pacing was off, oldest first. */
export function _recordedBeatsForTests(): readonly number[] {
  return recorded;
}

export function humanBeat(ms: number): Promise<void> {
  if (!pacingOn) {
    recorded.push(ms);
    return Promise.resolve();
  }
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
