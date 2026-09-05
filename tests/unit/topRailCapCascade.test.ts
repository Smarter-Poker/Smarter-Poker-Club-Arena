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

const rank = (a: [number, number, number]) => a[0] * 1e6 + a[1] * 1e3 + a[2];

describe('the short-canvas top cap loses to the rules it must lose to', () => {
  const capSelector = selectorFor('min(var(--seat-avatar-full), 56px)');
  const capAt = CSS.indexOf('min(var(--seat-avatar-full), 56px)');
  const tournamentSelector = '.table-page--tournament .seat-wrapper--top .seat';
  const emptySelector = '.seat-wrapper--top .seat.seat--empty';

  it('the cap rule is 0-3-0, not 0-4-0', () => {
    // A class plus an attribute on one compound is TWO class-level units. This
    // is the arithmetic the original comment got wrong.
    expect(specificity(capSelector)).toEqual([0, 3, 0]);
  });

  it('a tournament top seat is never capped', () => {
    // TablePage puts both classes on the same element, so a Spin matches BOTH
    // rules and the winner is decided here.
    expect(CSS).toContain(tournamentSelector);
    const cap = specificity(capSelector);
    const tour = specificity(tournamentSelector);
    expect(rank(tour), 'the tournament exemption must not be out-specified').toBeGreaterThanOrEqual(
      rank(cap)
    );
    // Equal specificity is decided by source order, so the exemption must come
    // AFTER the cap.
    expect(CSS.indexOf(tournamentSelector)).toBeGreaterThan(capAt);
  });

  it('an empty SIT plate is never capped (Dan 2026-08-31)', () => {
    expect(CSS).toContain(emptySelector);
    expect(rank(specificity(emptySelector))).toBeGreaterThanOrEqual(rank(specificity(capSelector)));
    expect(CSS.indexOf(emptySelector)).toBeGreaterThan(capAt);
  });

  it('the cap still beats the full-canvas 76px rule it replaces', () => {
    const full = selectorFor('min(var(--seat-avatar-full), 76px)');
    expect(rank(specificity(capSelector))).toBeGreaterThan(rank(specificity(full)));
  });
});
