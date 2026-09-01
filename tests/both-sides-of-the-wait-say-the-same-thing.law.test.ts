/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOTH SIDES OF THE WAIT SAY THE SAME THING — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A seat-first game shows two different footers while it fills, and they did
 * not agree. A spectator read
 *
 *     "Spectating, Tap An Open Seat To Join · 2 Of 3 Seats Taken"
 *
 * while the player who had already PAID read
 *
 *     "Seat Reserved, Waiting For 1 More Player"
 *
 * Same fact, two shapes, and the one with money in the game got the vaguer of
 * them. Neither showed the fill at a glance.
 *
 * `SeatFillDots` is that fact in a form you take in without reading, and both
 * sides render it from the same two numbers.
 *
 * NO ETA, deliberately, and this is the part most likely to be "fixed" later
 * by someone who did not measure: fill time is a median of 188 seconds against
 * a p95 of 74 MINUTES. An average across that spread is not information, and a
 * number promising "about three minutes" to somebody who then waits an hour is
 * worse than saying nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const table = read('src/pages/TablePage.tsx');
const dots = read('src/components/table/SeatFillDots.tsx');

describe('both sides of the wait say the same thing', () => {
  it('renders the fill indicator on both footers', () => {
    const uses = table.split('<SeatFillDots').length - 1;
    expect(uses).toBe(2);
  });

  it('feeds both from the same two numbers', () => {
    const occurrences = table.split('taken={tableState.players.filter(Boolean).length}').length - 1;
    expect(occurrences).toBe(2);
    expect(table.split('seats={seatFirstBuyIn.seats}').length - 1).toBe(2);
  });

  it('the spectator label no longer carries its own private count', () => {
    expect(table).not.toContain('Of ${seatFirstBuyIn.seats} Seats Taken');
  });

  it('reads as one thing to a screen reader, not as N unlabelled dots', () => {
    expect(dots).toContain('role="img"');
    expect(dots).toContain('Seats Taken');
    expect(dots).toContain('aria-hidden="true"');
  });

  it('cannot render a negative or over-full row from a stale roster', () => {
    expect(dots).toContain('Math.min(total, Math.max(0, Math.trunc(Number(taken) || 0)))');
    expect(dots).toContain('if (total <= 0) return null;');
  });

  it('does not promise an ETA the measured spread cannot support', () => {
    /* Scoped to the fill indicator itself. The page legitimately counts down
       elsewhere ("Break Starts In"), and a whole-file regex would either fail
       on that or teach the next reader to delete this test. What matters is
       that the thing which reports the WAIT does not invent a duration:
       median 188s against a p95 of 74 MINUTES. */
    const code = dots.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\bStarts In\b|\bEstimated Wait\b|\bETA\b|\bMinutes\b/i);
    // And the reason is written down where the next person will find it.
    expect(dots).toContain('p95 of 74 MINUTES');
  });
});
