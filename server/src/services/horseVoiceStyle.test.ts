/**
 * EVERY HORSE TYPES LIKE ITS OWN PERSON (Dan 2026-10-22)
 *
 * "there should be like 100+ different short phrases and things said, and
 * every horse should be different and say different things, in different
 * styles, (like text styles) it must be 100% unique for each horse, some use
 * emoji's some don't."
 */
import { describe, expect, it } from 'vitest';
import { LINES, TALK_EVENTS, TALK_VOICES } from './horseTableTalkLines.js';
import { chooseLine, fillLine, moodOf, sanitizeStyledLine } from './HorseTableTalk.js';
import {
  EMOJI_BY_MOOD,
  STYLE_EMOJI,
  personalPool,
  styleFingerprint,
  styleLine,
  voiceStyleFor,
} from './horseVoiceStyle.js';

/** A thousand horse ids, shaped like the real ones. */
const HORSES = Array.from({ length: 1000 }, (_, i) => {
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  return `${hex(i * 2654435761, 8).slice(-8)}-${hex(i, 4)}-4${hex(i * 7, 3).slice(-3)}-8${hex(i * 13, 3).slice(-3)}-${hex(i * 977, 12).slice(-12)}`;
});

const ALL_LINES = [
  ...new Set(
    TALK_EVENTS.flatMap((e) => TALK_VOICES.flatMap((v) => LINES[e][v].lines.map((l) => l)))
  ),
];
const FILL = { potBB: 52, street: 'river' as const, hand: 'full house', seat: 7 };
const EMOJI_RANGE = /[\u{1F000}-\u{1FAFF}]/u;

describe('the pool', () => {
  it('holds well over 100 different phrases', () => {
    const distinct = new Set(ALL_LINES.map((l) => l.toLowerCase()));
    expect(distinct.size).toBeGreaterThanOrEqual(120);
  });

  it('the emoji the style may write are single code points, built from numbers', () => {
    for (const e of STYLE_EMOJI) expect([...e]).toHaveLength(1);
    for (const mood of Object.keys(EMOJI_BY_MOOD)) {
      expect(EMOJI_BY_MOOD[mood as keyof typeof EMOJI_BY_MOOD].length).toBeGreaterThan(2);
    }
  });
});

describe('every horse is its own person', () => {
  it('no two of a thousand horses share a style fingerprint', () => {
    const prints = new Set(HORSES.map((h) => styleFingerprint(h, ALL_LINES)));
    expect(prints.size).toBe(HORSES.length);
  });

  it('the style is stable: the same horse is the same person every time', () => {
    for (const h of HORSES.slice(0, 50)) {
      expect(voiceStyleFor(h)).toEqual(voiceStyleFor(h));
      expect(styleLine('nice hand', h, 'lost', '42|pot_lost')).toBe(
        styleLine('nice hand', h, 'lost', '42|pot_lost')
      );
    }
  });

  it('some horses never use emoji and some do, and every habit has more than one setting', () => {
    const styles = HORSES.map(voiceStyleFor);
    const never = styles.filter((s) => s.emojiMode === 'never').length;
    expect(never).toBeGreaterThan(300);
    expect(never).toBeLessThan(700);
    for (const key of ['caseMode', 'punct', 'shorthand', 'laugh', 'emojiMode'] as const) {
      expect(new Set(styles.map((s) => s[key])).size, key).toBeGreaterThan(2);
    }
    const chatty = styles.map((s) => s.chattiness);
    expect(Math.min(...chatty)).toBeGreaterThanOrEqual(0.35);
    expect(Math.max(...chatty)).toBeLessThanOrEqual(1.6);
  });

  it('two horses with the same voice say different things', () => {
    const pool = LINES.pot_lost.needler.lines;
    const a = personalPool(HORSES[1], pool);
    const b = personalPool(HORSES[2], pool);
    expect(a).not.toEqual(b);
    // and nobody is left with nothing to say
    for (const h of HORSES) {
      for (const e of TALK_EVENTS) {
        for (const v of TALK_VOICES) expect(personalPool(h, LINES[e][v].lines).length).toBeGreaterThan(0);
      }
    }
  });

  it('the same moment reads differently across the fleet', () => {
    const typed = new Set(HORSES.slice(0, 200).map((h) => styleLine('nice hand', h, 'lost', '7|pot_lost')));
    expect(typed.size).toBeGreaterThan(40);
  });
});

describe('what a styled line may carry', () => {
  it('every line in the pool, typed by 150 horses, passes the styled door', () => {
    const names = ['danny', 'plate4', 'gg_master', 'seat7'];
    let withEmoji = 0;
    for (const h of HORSES.slice(0, 150)) {
      for (const e of TALK_EVENTS) {
        for (const v of TALK_VOICES) {
          for (const template of LINES[e][v].lines) {
            const filled = fillLine(template, FILL);
            if (filled === null) continue;
            const typed = styleLine(filled, h, moodOf(e), `${template}|1`);
            const verdict = sanitizeStyledLine(typed, names);
            expect(verdict, `"${typed}" refused`).toEqual({ ok: true, line: typed.trim() });
            if (EMOJI_RANGE.test(typed)) {
              withEmoji++;
              for (const ch of [...typed].filter((c) => EMOJI_RANGE.test(c))) {
                expect(STYLE_EMOJI.has(ch), `${ch} is not a style emoji`).toBe(true);
              }
            }
          }
        }
      }
    }
    expect(withEmoji).toBeGreaterThan(0);
  });

  it('the styled door still refuses an emoji the style never writes', () => {
    expect(sanitizeStyledLine(`gg ${String.fromCodePoint(0x1f600)}`, []).ok).toBe(false);
    const allowed = [...STYLE_EMOJI][0];
    expect(sanitizeStyledLine(`gg ${allowed}`, [])).toEqual({ ok: true, line: `gg ${allowed}` });
    expect(sanitizeStyledLine(`gg danny ${allowed}`, ['danny']).ok).toBe(false);
  });

  it('chooseLine draws from the horse own share of the pool', () => {
    const counts = new Map<string, number>();
    for (let hand = 1; hand <= 400; hand++) {
      const c = chooseLine('pot_lost', 'friendly', HORSES[3], hand, FILL);
      if (c) counts.set(c.template, (counts.get(c.template) ?? 0) + 1);
    }
    const mine = personalPool(HORSES[3], LINES.pot_lost.friendly.lines);
    for (const t of counts.keys()) expect(mine).toContain(t);
  });
});
