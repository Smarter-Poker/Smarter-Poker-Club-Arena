/**
 * HORSE VOICE STYLE: every horse types like its own person (Dan 2026-10-22)
 *
 * Dan, verbatim: "there should be like 100+ different short phrases and things
 * said, and every horse should be different and say different things, in
 * different styles, (like text styles) it must be 100% unique for each horse,
 * some use emoji's some don't."
 *
 * A horse's style is a fingerprint read from its own id by hash, so it is the
 * same every hand, every table and every engine restart, and no two horses
 * share one (horseVoiceStyle.test.ts proves it over a thousand ids):
 *
 *   vocabulary   the share of the phrase pool this horse ever uses, and WHICH
 *                lines: two horses with the same voice still say different
 *                things
 *   case         lowercase, Sentence case, as written, or (rarely) ALL CAPS
 *   punctuation  none, a period, !, !!, ...
 *   shorthand    "nh", "ty", "gl", "u", or the opposite: "nice hand",
 *                "thank you", "good luck", or neither
 *   laugh        lol, haha, lmao, hah or hehe
 *   stretch      a habit of stretching short words: "niiice", "wowww"
 *   sign off     a word some horses tag on now and then: bro, man, sir...
 *   emoji        none at all for about half the fleet; the rest use their own
 *                two to four favourites, some rarely and some on most lines
 *   chattiness   some horses never talk; the others speak only occasionally
 *   throwiness   independently, some never gesture; the others do so sparingly
 *
 * Emoji are built from code points (CLAUDE.md 5.3, no emoji in source), drawn
 * only from EMOJI_BY_MOOD, single code points with no joiners, and appended by
 * this file alone. The pool lines themselves stay emoji free; the chat door
 * (HorseTableTalk.sanitizeStyledLine) admits an emoji only if it is in
 * STYLE_EMOJI.
 *
 * No randomness: every choice is personaHash of the horse, the hand and the
 * line, the same rule as the rest of table talk.
 *
 * NEVER refer to the horses as "bots": they are HORSES only.
 */

import { personaHash } from '../engine/HorsePersona.js';

export type Mood = 'lost' | 'won' | 'luck' | 'greet';

const cp = (...points: number[]): string[] => points.map((p) => String.fromCodePoint(p));

/** The only emoji a horse ever types, by the mood of the moment. */
export const EMOJI_BY_MOOD: Readonly<Record<Mood, readonly string[]>> = {
  lost: cp(
    0x1f62d,
    0x1f624,
    0x1f644,
    0x1f926,
    0x1f480,
    0x1f921,
    0x1f633,
    0x1f62c,
    0x1f621,
    0x1f605
  ),
  won: cp(0x1f602, 0x1f923, 0x1f60e, 0x1f525, 0x1f4aa, 0x1f389, 0x1f911, 0x1f60f, 0x1f44d),
  luck: cp(0x1f340, 0x1f91e, 0x1f64f, 0x1f525, 0x1f44f, 0x1f4aa, 0x1f60e),
  greet: cp(0x1f44b, 0x1f44d, 0x1f60e),
};

/** Every emoji the style layer may write. The chat door admits these and no others. */
export const STYLE_EMOJI: ReadonlySet<string> = new Set(Object.values(EMOJI_BY_MOOD).flat());

export type CaseMode = 'lower' | 'sentence' | 'asis' | 'upper';
export type PunctMode = 'none' | 'period' | 'bang' | 'bangbang' | 'dots';
export type ShorthandMode = 'short' | 'long' | 'mixed';
export type EmojiMode = 'never' | 'rare' | 'often';

export interface VoiceStyle {
  /** percent of the pool this horse ever uses, 35..74 */
  vocabularyPct: number;
  caseMode: CaseMode;
  punct: PunctMode;
  shorthand: ShorthandMode;
  laugh: string;
  /** percent of lines on which a short word gets stretched */
  stretchPct: number;
  /** a word tagged on now and then, or null */
  signOff: string | null;
  signOffPct: number;
  emojiMode: EmojiMode;
  /** this horse's favourite emoji per mood (empty when emojiMode is never) */
  emoji: Readonly<Record<Mood, readonly string[]>>;
  /** Independent talking habit: zero means this horse never chats; otherwise 0.15..0.95. */
  chattiness: number;
  /** Independent gesture habit: zero means no throws/reactions; otherwise 0.15..1.0. */
  throwiness: number;
  /** percent of lines with a slip of the thumb: 0 for most horses */
  typoPct: number;
}

const pick = <T>(items: readonly T[], seed: string): T => items[personaHash(seed) % items.length];
const pct = (seed: string): number => personaHash(seed) % 100;

function weighted<T>(seed: string, table: ReadonlyArray<readonly [T, number]>): T {
  const total = table.reduce((n, [, w]) => n + w, 0);
  let roll = personaHash(seed) % total;
  for (const [v, w] of table) {
    if (roll < w) return v;
    roll -= w;
  }
  return table[0][0];
}

const SIGN_OFFS = [
  'bro',
  'man',
  'sir',
  'buddy',
  'my friend',
  'lol',
  'haha',
  'folks',
  'pal',
  'guys',
];
const LAUGHS = ['lol', 'haha', 'lmao', 'hah', 'hehe', 'lolol', 'ha'];

const cache = new Map<string, VoiceStyle>();

/** The horse's fingerprint. Pure and stable: the same id always gives the same style. */
export function voiceStyleFor(horseId: string): VoiceStyle {
  const hit = cache.get(horseId);
  if (hit) return hit;
  const k = (what: string) => `${horseId}|style|${what}`;
  const emojiMode = weighted<EmojiMode>(k('emoji'), [
    ['never', 48],
    ['rare', 30],
    ['often', 22],
  ]);
  const favourites = (mood: Mood): string[] => {
    if (emojiMode === 'never') return [];
    const all = EMOJI_BY_MOOD[mood];
    const n = 2 + (personaHash(k(`emoji-n|${mood}`)) % 3);
    const out: string[] = [];
    for (let i = 0; out.length < Math.min(n, all.length) && i < all.length * 4; i++) {
      const e = all[personaHash(k(`emoji|${mood}|${i}`)) % all.length];
      if (!out.includes(e)) out.push(e);
    }
    return out;
  };
  const style: VoiceStyle = {
    vocabularyPct: 35 + (personaHash(k('vocab')) % 40),
    caseMode: weighted<CaseMode>(k('case'), [
      ['lower', 44],
      ['sentence', 32],
      ['asis', 18],
      ['upper', 6],
    ]),
    punct: weighted<PunctMode>(k('punct'), [
      ['none', 42],
      ['period', 14],
      ['bang', 20],
      ['bangbang', 10],
      ['dots', 14],
    ]),
    shorthand: weighted<ShorthandMode>(k('short'), [
      ['short', 38],
      ['long', 30],
      ['mixed', 32],
    ]),
    laugh: pick(LAUGHS, k('laugh')),
    stretchPct: weighted<number>(k('stretch'), [
      [0, 60],
      [12, 25],
      [30, 15],
    ]),
    signOff: pct(k('signoff?')) < 35 ? pick(SIGN_OFFS, k('signoff')) : null,
    signOffPct: 10 + (personaHash(k('signoff-pct')) % 20),
    emojiMode,
    emoji: {
      lost: favourites('lost'),
      won: favourites('won'),
      luck: favourites('luck'),
      greet: favourites('greet'),
    },
    chattiness: pct(k('talks')) < 25 ? 0 : (15 + (personaHash(k('chatty')) % 81)) / 100,
    throwiness: pct(k('gestures')) < 45 ? 0 : (15 + (personaHash(k('throwy')) % 86)) / 100,
    typoPct: weighted<number>(k('typo'), [
      [0, 60],
      [6, 25],
      [14, 15],
    ]),
  };
  if (cache.size > 5_000) cache.clear();
  cache.set(horseId, style);
  return style;
}

/**
 * Whether a pool line is in this horse's own vocabulary. A horse that would
 * have no line left for an event keeps the whole pool for it (see
 * personalPool), so it is never struck dumb by its own fingerprint.
 */
export function usesLine(horseId: string, template: string): boolean {
  const { vocabularyPct } = voiceStyleFor(horseId);
  return personaHash(`${horseId}|vocab|${template.toLowerCase()}`) % 100 < vocabularyPct;
}

export function personalPool(horseId: string, pool: readonly string[]): readonly string[] {
  const mine = pool.filter((t) => usesLine(horseId, t));
  return mine.length > 0 ? mine : pool;
}

/** Shorthand both ways, whole words only, applied left to right. */
const TO_SHORT: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnice hand\b/g, 'nh'],
  [/\bgood luck\b/g, 'gl'],
  [/\bwell played\b/g, 'wp'],
  [/\bthank you\b/g, 'ty'],
  [/\bthanks\b/g, 'thx'],
  [/\byou\b/g, 'u'],
  [/\byour\b/g, 'ur'],
  [/\bcant\b/g, 'cnt'],
];
const TO_LONG: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnh\b/g, 'nice hand'],
  [/\bgl\b/g, 'good luck'],
  [/\bwp\b/g, 'well played'],
  [/\bty\b/g, 'thank you'],
  [/\bthx\b/g, 'thanks'],
  [/\bcant\b/g, "can't"],
];

function applyShorthand(line: string, mode: ShorthandMode, seed: string): string {
  const table =
    mode === 'short' ? TO_SHORT : mode === 'long' ? TO_LONG : pct(seed) < 50 ? TO_SHORT : TO_LONG;
  let out = line;
  for (const [re, to] of table) out = out.replace(re, to);
  return out;
}

const STRETCHABLE = /\b(nice|wow|ugh|ok|gg|lol|so|no|go|yes|nh|ty|gl|sigh|finally|phew|come)\b/;

function stretch(line: string, seed: string): string {
  const m = line.match(STRETCHABLE);
  if (!m || m.index === undefined) return line;
  const word = m[0];
  // stretch the last vowel, or repeat the last letter: "niiice", "gggg", "wowww"
  const vowelAt = Math.max(...['a', 'e', 'i', 'o', 'u', 'y'].map((v) => word.lastIndexOf(v)));
  const at = vowelAt >= 0 ? vowelAt : word.length - 1;
  const times = 2 + (personaHash(seed) % 3);
  const stretched = word.slice(0, at + 1) + word[at].repeat(times) + word.slice(at + 1);
  return line.slice(0, m.index) + stretched + line.slice(m.index + word.length);
}

function applyCase(line: string, mode: CaseMode): string {
  switch (mode) {
    case 'lower':
      return line.toLowerCase();
    case 'upper':
      return line.toUpperCase();
    case 'sentence':
      return line.charAt(0).toUpperCase() + line.slice(1);
    default:
      return line;
  }
}

function applyPunct(line: string, mode: PunctMode): string {
  if (/[?!.]$/.test(line)) return line;
  switch (mode) {
    case 'period':
      return `${line}.`;
    case 'bang':
      return `${line}!`;
    case 'bangbang':
      return `${line}!!`;
    case 'dots':
      return `${line}...`;
    default:
      return line;
  }
}

/**
 * Dan 2026-10-22: "never always use 3 emoji's it should be 1-5 and always
 * randomly choses, never ever always 3". How many: 1 to 5, weighted toward
 * fewer (40/25/17/11/7 percent) and rolled per line. Which: sometimes the
 * same favourite repeated, sometimes a mix of the horse's favourites.
 */
export const EMOJI_COUNT_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [1, 40],
  [2, 25],
  [3, 17],
  [4, 11],
  [5, 7],
];

export function emojiRun(favourites: readonly string[], seed: (what: string) => string): string {
  const count = weighted<number>(seed('emoji-count'), EMOJI_COUNT_WEIGHTS);
  const mixed = favourites.length > 1 && pct(seed('emoji-mix')) < 45;
  const first = favourites[personaHash(seed('emoji')) % favourites.length];
  let run = '';
  for (let i = 0; i < count; i++) {
    run += mixed ? favourites[personaHash(seed(`emoji-${i}`)) % favourites.length] : first;
  }
  return run;
}

/** A slip of the thumb: two neighbouring letters swapped in one longer word. */
function typo(line: string, seed: string): string {
  const re = /[a-z]{4,}/gi;
  const words: Array<{ word: string; index: number }> = [];
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    words.push({ word: m[0], index: m.index });
  }
  if (words.length === 0) return line;
  const { word, index } = words[personaHash(seed) % words.length];
  const at = 1 + (personaHash(`${seed}|at`) % (word.length - 2));
  const swapped = word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
  return line.slice(0, index) + swapped + line.slice(index + word.length);
}

/**
 * The line as this horse types it. `key` makes the per-line choices (stretch,
 * sign off, emoji count) vary from line to line while the habits stay fixed.
 */
export function styleLine(line: string, horseId: string, mood: Mood, key: string): string {
  const s = voiceStyleFor(horseId);
  const seed = (what: string) => `${horseId}|${key}|${what}`;
  let out = line.replace(/\blol\b/g, s.laugh);
  out = applyShorthand(out, s.shorthand, seed('short'));
  if (s.stretchPct > 0 && pct(seed('stretch?')) < s.stretchPct) out = stretch(out, seed('stretch'));
  if (s.signOff && pct(seed('signoff')) < s.signOffPct && !out.includes(s.signOff)) {
    out = `${out} ${s.signOff}`;
  }
  if (s.typoPct > 0 && pct(seed('typo?')) < s.typoPct) out = typo(out, seed('typo'));
  out = applyPunct(applyCase(out, s.caseMode), s.punct);
  const favourites = s.emoji[mood];
  const emojiChance = s.emojiMode === 'often' ? 65 : s.emojiMode === 'rare' ? 22 : 0;
  if (favourites.length > 0 && pct(seed('emoji?')) < emojiChance) {
    out = `${out} ${emojiRun(favourites, seed)}`;
  }
  return out;
}

/** Even an expressive horse leaves most opportunities alone. Zero is a durable habit. */
export function personalChance(horseId: string, basePct: number): number {
  return Math.max(0, Math.min(35, Math.round(basePct * voiceStyleFor(horseId).chattiness)));
}

/** Gesture habits are independent of talking and emoji preferences. */
export function personalThrowChance(horseId: string, basePct: number): number {
  return Math.max(0, Math.min(25, Math.round(basePct * voiceStyleFor(horseId).throwiness)));
}

/** One string naming every habit, for the uniqueness proof. */
export function styleFingerprint(horseId: string, pool: readonly string[]): string {
  const s = voiceStyleFor(horseId);
  const vocab = pool.map((t) => (usesLine(horseId, t) ? '1' : '0')).join('');
  return [
    vocab,
    s.caseMode,
    s.punct,
    s.shorthand,
    s.laugh,
    s.stretchPct,
    s.signOff,
    s.emojiMode,
    Object.values(s.emoji)
      .map((e) => e.join(''))
      .join('/'),
    s.chattiness,
    s.throwiness,
    s.typoPct,
  ].join('|');
}

/** Test hook. */
export function _resetVoiceStylesForTests(): void {
  cache.clear();
}
