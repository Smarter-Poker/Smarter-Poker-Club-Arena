/**
 * NO CEILING ON PEOPLE, AND NO READ THAT LIES ABOUT BEING COMPLETE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27: "there should never be a cap on the amount of players in
 * the club, union or anywhere else."
 *
 * To be precise about what was found: none of these were caps on PLAYERS -
 * nobody was ever stopped from joining, sitting or playing. They were page
 * sizes on background reads. But a read that silently returns part of the
 * room caps what the code can SEE, and every one of these then treated its
 * slice as the whole:
 *
 *   HorseSessionRotator.rotate   .limit(400), unordered. The room held 348
 *                                live seats when this was measured - 87% of
 *                                it. Past 400 Postgres returns an ARBITRARY
 *                                400: tables stop rotating, no error, no log.
 *   horseLoadMap (x2)            .limit(20000) on both halves. Its own
 *                                docstring says a truncated set understates
 *                                load and hands a horse a fifth table, and
 *                                that "Unknown is UNKNOWN" - but nothing
 *                                checked for a full page.
 *   entrant guard                .limit(20000) on "who is already in this
 *                                tournament". A missing id there is a horse
 *                                registered into the SAME tournament twice -
 *                                the bug that block exists to prevent.
 *
 * All four now PAGE. There is no number left to outgrow, which is the point:
 * raising a ceiling only moves the day it is hit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
/** Strip comments so prose describing the old ceilings cannot satisfy a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('HorseSessionRotator sees the whole room', () => {
  const src = code(read('services/HorseSessionRotator.ts'));

  it('has no row ceiling at all', () => {
    expect(src).not.toMatch(/\.limit\(\s*\d+\s*\)/);
  });

  it('pages until a short page says the room is exhausted', () => {
    expect(src).toMatch(/\.range\(page \* PAGE/);
    expect(src).toMatch(/if \(chunk\.length < PAGE\) break;/);
  });

  it('orders the scan, so paging cannot serve a seat twice or skip one', () => {
    expect(src).toMatch(/\.order\('table_id'/);
    expect(src).toMatch(/\.order\('seat_number'/);
  });

  it('declines the pass on a failed page rather than rotating half a room', () => {
    expect(src).toMatch(/if \(error \|\| !chunk\) return;/);
  });
});

describe('horseLoadMap counts every horse, or admits it cannot', () => {
  const src = code(read('services/TournamentRecurringService.ts'));

  it('neither half carries a 20000-row ceiling any more', () => {
    expect(src).not.toMatch(/\.limit\(20000\)/);
  });

  it('pages the live-seat half and the registration half alike', () => {
    const pages = src.match(/\.range\(page \* PAGE/g) ?? [];
    expect(pages.length, 'both halves should page').toBeGreaterThanOrEqual(2);
  });

  it('a failed read is still UNKNOWN - the contract that stops double-booking', () => {
    expect(src).toMatch(/horse_load_seats_failed/);
    expect(src).toMatch(/horse_load_registrations_failed/);
  });

  it('the same-tournament entrant guard cannot be defeated by a big field', () => {
    expect(src).toMatch(/ENTRANT_PAGE/);
    expect(src).toMatch(/if \(alreadyIn\.length < ENTRANT_PAGE\) break;/);
  });
});

describe('the waitlist offer walks the queue instead of peeking at ten', () => {
  const src = code(read('services/supabase/seats.ts'));

  it('no longer takes only the oldest ten and hopes a human is among them', () => {
    expect(src).toMatch(/QUEUE_PAGE/);
    expect(src).toMatch(/\.range\(page \* QUEUE_PAGE/);
  });

  it('keeps the two-query form - an ambiguous embed could silence offers entirely', () => {
    // table_waitlist.user_id has FKs to BOTH profiles and auth.users, so
    // `profiles!inner(...)` is ambiguous; a 400 there would return null data
    // and stop every seat offer silently.
    expect(src).not.toMatch(/profiles!inner/);
  });
});
