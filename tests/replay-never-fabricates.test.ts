import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A hand history is the evidentiary record of a poker game.
 *
 * `HandReplay` is reachable from two live surfaces — "replay last hand" at a
 * real table (`TableModalsLayer`) and the routed hand-history page
 * (`/hand-history`, `/history`, `/hands`). Until 2026-08-23 all three of its
 * failure paths — not found, no handId, and any thrown error — called
 * `getFallbackHandData()`, which returned a fully-formed fictional hand:
 * invented players ('-KingFish-', 'monkey88', 'Wizurd'), invented hole cards,
 * an invented 2,265 pot and an invented winner.
 *
 * A player who opened a hand that failed to load was shown that fiction,
 * presented exactly as their own history, with nothing to distinguish it. The
 * only signal anywhere was a `console.warn`.
 *
 * This test is deliberately a source-level assertion rather than a render
 * test: the property being protected is "this component has no capacity to
 * invent a hand at all", which is stronger than "it did not invent one in the
 * case I happened to exercise".
 */

const SRC = resolve(__dirname, '../src/components/replay/HandReplay.tsx');
const raw = readFileSync(SRC, 'utf8');

/* Assert on CODE, not on prose. The first version of this test failed on the
   comment that explains the bug, which would have pushed the next person to
   delete the explanation in order to go green. */
const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('HandReplay never fabricates a hand', () => {
  it('has no fallback-hand factory', () => {
    expect(source).not.toMatch(/function\s+getFallbackHandData/);
    expect(source).not.toMatch(/getFallbackHandData\s*\(\s*\)/);
  });

  it('carries none of the invented player names', () => {
    for (const ghost of ['-KingFish-', 'soul king', 'cubby2426', 'Wizurd', 'monkey88']) {
      expect(raw).not.toContain(ghost);
    }
  });

  it('sets no hand rather than a stand-in when the load fails', () => {
    // Every failure path must land on null. If a future edit reintroduces a
    // synthetic HandData object, this is the line that should stop it.
    expect(source).toMatch(/catch[\s\S]{0,240}setHandData\(null\)/);
    expect(source).toMatch(/setLoadFailed\(true\)/);
  });

  it('still distinguishes "could not load" from "no such hand"', () => {
    expect(source).toContain('Could Not Load This Hand');
    expect(source).toContain('Hand Not Found');
  });
});
