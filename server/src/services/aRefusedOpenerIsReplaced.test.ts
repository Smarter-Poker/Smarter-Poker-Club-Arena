/**
 * A REFUSED OPENING HORSE IS REPLACED, NOT LEFT AS AN EMPTY SEAT (2026-10-09).
 *
 * seedOpenSeatTable asked pickFreeHorses for exactly as many openers as the
 * board opens with. The busy set is never atomic with the claim, so a horse
 * another tick had just taken to four games was refused with FOUR TABLE LIMIT
 * (17 reports in six hours on 2026-10-09) and its seat opened empty. The cap
 * is a rule working, so it is not an error report, and the seat is offered to
 * fresh candidates once, sized the way the seat-first fill sizes them, never
 * past the opening count (a Spin must never open with its third seat sold).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('./TournamentRecurringService.ts', import.meta.url)),
  'utf8'
);
const start = src.indexOf('private async seedOpenSeatTable(');
const body = src.slice(start, src.indexOf('\n  /**', start));

describe('a refused opener is replaced', () => {
  it('offers a refused seat to fresh candidates once', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('for (let round = 0; round < 2; round++)');
    expect(body).toContain('seatFirstCandidateCount(opening - seated) + tried.size');
  });

  it('never seats past the opening count and never asks the same horse twice', () => {
    expect(body).toContain('if (seated >= opening || tried.has(horse)) continue;');
  });

  it('reports only a refusal that is not the cap working', () => {
    expect(body).toMatch(
      /if \(!isExpectedSeatRefusal\(seatRpcErr\.message\)\) \{\s*reportError\([\s\S]*?'TournamentRecurring\.opening_seat_rpc_failed'/
    );
  });

  it('keeps the freeze total and the loop break-free', () => {
    expect(body).toContain('if (isMaintenanceFrozen()) continue;');
    expect(body).not.toMatch(/\bbreak;/);
  });
});
