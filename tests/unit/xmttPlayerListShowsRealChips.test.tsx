/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE XMTT PLAYER LIST SHOWED EVERY PLAYER ZERO CHIPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `XMTTPage` rendered each registered player's stack as
 *
 *     fmtChips(r.chip_count || r.starting_chips || 0)   (fmtChips is retired; the
 *     stack now reads through formatTableChips - a tournament chip is whole)
 *
 * and that expression could only ever evaluate to 0.
 *
 *   - `tournament_players.chip_count` exists, and nothing writes it. It was 0
 *     on all 13,623 rows registered in the 24 hours before this fix, against
 *     `chips` holding the real stack on every one of them.
 *   - `starting_chips` is not a column of `tournament_players` at all. It is a
 *     column of `tournaments`. So `r.starting_chips` was `undefined`.
 *
 * `0 || undefined || 0` is 0. The `||` chain is what hid it: a fallback that
 * looks like defensive coding reads as plausible right up until you notice
 * every branch is empty. Nothing threw, nothing logged, the column just said
 * zero for every player forever.
 *
 * The stack was already being fetched - the page issues `select('*')` - so the
 * fix is to read `chips`, the column the engine writes.
 *
 * This test reads the page as TEXT. It is not testing that React renders a
 * number; it is pinning the three names, which is where the bug lived.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../src/pages/XMTTPage.tsx'), 'utf8');

/** The file with block and line comments stripped, so prose is not code. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the XMTT player list reads the column the engine writes', () => {
  it('renders each player stack from `chips`', () => {
    expect(code).toMatch(/formatTableChips\(\s*r\.chips\s*\?\?\s*0\s*\)/);
  });

  it('never reads chip_count, which nothing in the estate writes', () => {
    expect(code).not.toMatch(/chip_count/);
  });

  it('never reads starting_chips off a tournament_players row', () => {
    // starting_chips is a column of `tournaments`, not `tournament_players`.
    expect(code).not.toMatch(/r\.starting_chips/);
    expect(code).not.toMatch(/starting_chips\s*\?:/);
  });

  it('does not reintroduce an || fallback chain on the stack', () => {
    // `0 || undefined || 0` is how this shipped zeroes for months.
    expect(code).not.toMatch(/formatTableChips\([^)]*\|\|[^)]*\)/);
  });
});
