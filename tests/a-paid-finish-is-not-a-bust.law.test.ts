/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PAID FINISH IS NOT A BUST — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Only `position === 1` reached the celebration. Everyone else went out through
 * the busted door: a 2.5 second elimination beat and the lobby. At 10x and
 * above a Spin pays 2nd and 3rd — 80/12/8 or 80/20 — so a 100x runner-up took
 * a fifth of the pool and was shown the animation for losing everything, then
 * hurried off the table faster than the winner.
 *
 * `elimData.prize` was already in hand two lines away and simply never
 * consulted.
 *
 * THE RULE. A place that PAID is celebrated and held like a win. A place that
 * paid nothing keeps the bust beat, which is correct for it.
 *
 * The second half — the hold — matters as much as the overlay. Being shown the
 * door faster because you came second is the same bug wearing a stopwatch.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a paid finish is not a bust', () => {
  const table = read('src/pages/TablePage.tsx');
  const overlay = read('src/components/table/TournamentWinnerOverlay.tsx');

  it('treats a paid non-first place as cashed, from the prize already in hand', () => {
    expect(table).toContain('const cashed = finishPrize > 0 && finishPosition > 1;');
    expect(table).toContain('const finishPrize = Number(elimData.prize) || 0;');
  });

  it('gives a cashed finish the celebration overlay, carrying its place', () => {
    const block = table.slice(
      table.indexOf('const cashed = finishPrize > 0'),
      table.indexOf('const exit = {')
    );
    expect(block).toContain('setTournamentWinner({');
    expect(block).toContain('position: finishPosition,');
  });

  it('holds a cashed finish as long as a win, not for the bust beat', () => {
    expect(table).toContain('delayMs: cashed ? 7000 : 2500,');
  });

  it('still busts the places that paid nothing', () => {
    // 2500 remains the unpaid path. If this disappears, everyone is being
    // celebrated, which is its own lie.
    expect(table).toMatch(/cashed \? 7000 : 2500/);
  });

  it('the overlay names the place instead of calling everyone champion', () => {
    expect(overlay).toContain('position = 1');
    expect(overlay).toContain("position === 1 ? 'WINNER' : 'IN THE MONEY'");
    expect(overlay).toContain('ordinalPlace(position)');
    // First place is untouched.
    expect(overlay).toContain("position === 1 ? 'CHAMPION!'");
  });

  it('ordinals are not naive', () => {
    // 11th/12th/13th are the ones a naive n % 10 gets wrong.
    const fn = overlay.slice(
      overlay.indexOf('function ordinalPlace'),
      overlay.indexOf('const TournamentWinnerOverlay')
    );
    expect(fn).toContain('tens >= 11 && tens <= 13');
  });
});
