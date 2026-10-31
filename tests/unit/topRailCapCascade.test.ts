/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TOP-RAIL CAP IS DECIDED BY SPECIFICITY, SO SPECIFICITY IS WHAT IS PINNED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-05. The short-canvas cap shipped as five selectors of the form
 * `.table-page[data-seats='3'] .seat-wrapper--top .seat`, with a comment
 * asserting they were 0-3-0. A class and an attribute on the same compound is
 * 0-4-0, so the rule beat BOTH of the rules it was written to lose to:
 *
 *   .table-page--tournament .seat-wrapper--top .seat   0-3-0  (tournaments uncapped)
 *   .seat-wrapper--top .seat.seat--empty               0-3-0  (SIT plates uncapped)
 *
 * TablePage puts `table-page--tournament` and `data-seats` on the SAME element,
 * and a Spin is a tournament with three seats - so the 56px cap applied to
 * every Spin, undoing the fix this session existed to make, and shrank empty
 * SIT plates against Dan 2026-08-31.
 *
 * The two tests that should have caught it could not, by construction:
 * spinsSitSoundPrizeAndFelt pins CSS TEXT and source order, and the e2e spec
 * renders neither `table-page--tournament` nor `seat--empty`. A cascade is not
 * text and it is not order - it is arithmetic, so this test does the
 * arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(__dirname, '..', '..', 'src/components/table/SeatSlot.css'), 'utf8');

/* Comments are prose. The rule this file guards is EXPLAINED in a comment that
   quotes all three selectors, so an indexOf over the raw file finds the
   explanation rather than the rule and compares the wrong positions. Blanked to
   spaces, not deleted, so every offset still indexes the original. */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

/**
 * CSS specificity of one complex selector, as [ids, classes, types].
 * `:where()` contributes nothing (that is the whole point of using it);
 * `:not()` and `:is()` contribute their most specific argument.
 */
function specificity(selector: string): [number, number, number] {
  let s = selector;
  // :where(...) is specificity-free - strip it and its contents entirely.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/:where\([^()]*\)/g, '');
  } while (s !== prev);
  // :is()/:not() take the specificity of their argument; approximate by
  // unwrapping them, which is exact for the single-compound arguments used here.
  do {
    prev = s;
    s = s.replace(/:(?:is|not)\(([^()]*)\)/g, ' $1 ');
  } while (s !== prev);

  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (s.match(/\.[\w-]+/g) ?? []).length +
    (s.match(/\[[^\]]*\]/g) ?? []).length +
    (s.match(/:[\w-]+(?:\([^()]*\))?/g) ?? []).length;
  const types = (s.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
  return [ids, classes, types];
}

/** The first selector list introducing a rule whose body contains `needle`. */
function selectorFor(needle: string): string {
  const at = CSS.indexOf(needle);
  expect(at, `no rule body contains ${needle}`).toBeGreaterThan(-1);
  const open = CSS.lastIndexOf('{', at);
  // Back up to the end of the previous rule or comment.
  const prevEnd = Math.max(CSS.lastIndexOf('}', open), CSS.lastIndexOf('*/', open));
  return CSS.slice(prevEnd + 1, open).trim();
}

/**
 * Dan 2026-10-24: "IN 6 HANDED GAMES, THE AVATAR OR VILLIAN IN THE 'DONKQUEEN'
 * POSITION CAN BE FULL SCREEN NOW THAT THE BBJ IS REMOVED FROM ABOVE THEM...
 * MAKE THAT CHANGE GLOBALLY". The short-canvas rule no longer caps; it RESTORES
 * the full slot and the full bust, so the arithmetic now checks that it WINS
 * against both top-row caps it has to undo - and that the tournament and
 * empty-seat rules, which also ask for the full slot, cannot fight it.
 */
describe('the short-canvas top seat is full size, and the cascade says so', () => {
  const FULL = '--seat-avatar-base: var(--seat-avatar-full)';
  /** The short-ring rule is the first `.table-page:where(` rule whose body restores the slot. */
  const shortSlot = (() => {
    const re =
      /(\.table-page:where\(\s*\[data-seats='2'\][^{]*\.seat-wrapper--top\s+\.seat)\s*\{([^}]*)\}/;
    const m = re.exec(CSS);
    expect(m, 'the 2-6 top-seat rule is missing').not.toBeNull();
    return { selector: m![1].trim(), body: m![2], at: m!.index };
  })();
  const shortWrapper = (() => {
    const re = /(\.table-page:where\(\s*\[data-seats='2'\][^{]*\.seat-wrapper--top)\s*\{([^}]*)\}/;
    const m = re.exec(CSS);
    expect(m, 'the 2-6 top-wrapper rule is missing').not.toBeNull();
    return { selector: m![1].trim(), body: m![2], at: m!.index };
  })();

  it('restores the full slot and the full bust for rings of 2-6', () => {
    expect(shortSlot.body).toContain(FULL);
    expect(shortWrapper.body).toContain('--sp-bust-scale: 1.45');
    for (const n of [2, 3, 4, 5, 6]) expect(shortSlot.selector).toContain(`[data-seats='${n}']`);
    for (const n of [7, 8, 9]) expect(shortSlot.selector).not.toContain(`[data-seats='${n}']`);
  });

  it('every top row uses the full slot without a smaller cap', () => {
    expect(specificity(shortSlot.selector)).toEqual([0, 3, 0]);
    expect(selectorFor('--seat-avatar-base: var(--seat-avatar-full)')).toBe('.seat');
    expect(CSS).not.toMatch(/--seat-avatar-base:\s*min\(/);
  });

  it('top artwork uses the same full bust scale', () => {
    expect(CSS).not.toContain('--sp-bust-scale: 1.05');
    expect(CSS).not.toMatch(
      /seat-wrapper:not\(\.seat-wrapper--hero\)[^{]*\{[^}]*--sp-bust-scale: 1\.3;/
    );
  });

  it('no 56px cap survives anywhere', () => {
    expect(CSS).not.toContain('min(var(--seat-avatar-full), 56px)');
  });

  it('a tournament top seat and an empty SIT plate still ask for the full slot', () => {
    for (const sel of [
      '.table-page--tournament .seat-wrapper--top .seat',
      '.seat-wrapper--top .seat.seat--empty',
    ]) {
      const at = CSS.indexOf(sel);
      expect(at, sel).toBeGreaterThan(-1);
      const body = CSS.slice(CSS.indexOf('{', at), CSS.indexOf('}', at));
      expect(body).toContain(FULL);
    }
  });
});
