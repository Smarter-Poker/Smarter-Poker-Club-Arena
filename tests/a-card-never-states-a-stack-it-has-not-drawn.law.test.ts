/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CARD NEVER STATES A STACK IT HAS NOT DRAWN — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `tournaments.starting_chips` is SEEDED at 300 by the recycler and rewritten
 * to the drawn tier's stack at draw time. Every lobby surface read the raw
 * column, so every Spin card said "300 chips" and derived "Turbo" from it —
 * while 12.6% of games actually deal 1,000 or 5,000. A 100x is 5,000 chips at
 * 250 big blinds, the OPPOSITE of Turbo, and a seated player then watched the
 * stack jump from 300 to 5,000 with nothing explaining it.
 *
 * THE RULE. Before the wheel turns, the honest answer is the RANGE, taken from
 * the same tier table the draw itself uses. After it, the column is the truth.
 * A depth label derived from a placeholder is worse than no label — the card
 * falls back to the speed label it already has.
 *
 * The reveal test is `spinMultiplierRevealed`, the one convention this repo
 * already uses for "is a Spin's outcome known yet".
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinStartingStackRange, SPIN_TIERS } from '../src/config/spinSpec';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a card never states a stack it has not drawn', () => {
  it('the range comes from the tier table, not from a hardcoded pair', () => {
    const { min, max } = spinStartingStackRange();
    const stacks = SPIN_TIERS.map((t) => t.startingStack);
    expect(min).toBe(Math.min(...stacks));
    expect(max).toBe(Math.max(...stacks));
    // The seed is the floor and it is not the whole story.
    expect(min).toBe(300);
    expect(max).toBeGreaterThan(min);
  });

  it('the card prints the range while the draw is pending', () => {
    const adapter = read('src/components/lobby/game-cards/arenaGameCardAdapter.ts');
    expect(adapter).toContain('spinStartingStackRange');
    expect(adapter).toContain('spinMultiplierRevealed');
    expect(adapter).toContain('startingStack: startingStackLabel,');
    // And the raw column still wins once the draw has happened.
    expect(adapter).toContain("startingStack.toLocaleString('en-US')");
  });

  it('no depth label is derived from an undrawn stack', () => {
    const entries = read('src/components/lobby/lobbyEntries.ts');
    const fn = entries.slice(
      entries.indexOf('export function stackDepthLabel'),
      entries.indexOf('export function stackFormatRank')
    );
    expect(fn).toContain('if (isSpinTournament(t) && !spinMultiplierRevealed(t)) return null;');
    // The guard must come BEFORE the column is read, or it guards nothing.
    expect(fn.indexOf('spinMultiplierRevealed')).toBeLessThan(fn.indexOf('t.starting_chips'));
  });
});
