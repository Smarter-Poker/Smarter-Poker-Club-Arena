/**
 * THE ROSTER-FULL DEADLOCK — a seat-first game that can never admit anybody.
 *
 * Measured on production 2026-08-25 08:0xZ, with this query:
 *
 *   with sf as (
 *     select t.id, t.max_players, public.fn_tournament_primary_table(t.id) as tbl
 *       from public.tournaments t
 *      where t.status in ('REGISTERING','ANNOUNCED')
 *        and (t.variant='spin' or (t.variant='sng' and t.max_players<=2))
 *   ), s2 as (
 *     select sf.*,
 *       (select count(*) from public.table_seats s
 *         where s.table_id=sf.tbl and s.left_at is null) as paid,
 *       (select count(*) from public.tournament_players tp
 *         where tp.tournament_id=sf.id
 *           and tp.status in ('registered','playing')) as roster
 *     from sf
 *   )
 *   select count(*) filter (where roster >= max_players and paid < max_players)
 *     from s2;
 *
 *     33 open seat-first games
 *      7 with a FULL roster and SHORT seats   <- deadlocked, all past start
 *     16 unseated registrants inside those 7
 *   1995 minutes stuck, worst case
 *
 * Attempting to seat a new horse in one of them raises, verified live in a
 * rolled-back transaction:
 *
 *   ERROR 23514: tournament_full: 10 Chip Spin PLO4 already has 3 of 3 entrants
 *   CONTEXT: PL/pgSQL function fn_enforce_tournament_capacity() line 20
 *            fn_register_horse_for_tournament(uuid,uuid) line 98
 *            fn_seat_horse_in_seat_first_game(uuid,uuid) line 49
 *
 * The way out is the game's OWN unseated registrants: they take the
 * `v_already` branch of fn_seat_horse_in_seat_first_game and never touch the
 * trigger that is refusing everybody else.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seatFirstFillOrder } from './TournamentRecurringService.js';

const SRC = readFileSync(join(__dirname, 'TournamentRecurringService.ts'), 'utf8');

function topUpBody(): string {
  const start = SRC.indexOf('async topUpWithHorses(');
  expect(start, 'topUpWithHorses must still exist').toBeGreaterThan(-1);
  const next = SRC.indexOf('\n  private async ', start);
  return SRC.slice(start, next > -1 ? next : SRC.length);
}

describe('seatFirstFillOrder - home before the fleet', () => {
  it('offers the game its own unseated registrants first', () => {
    // The seven stuck spins in the numbers above: the free pool cannot help
    // them at all, and their own roster can fill them completely.
    expect(seatFirstFillOrder(2, ['own1', 'own2'], ['pool1', 'pool2'])).toEqual(['own1', 'own2']);
  });

  it('still draws on the free pool for the remainder', () => {
    // A genuinely short roster needs new entrants, and registration works
    // fine there. Order, not exclusion.
    expect(seatFirstFillOrder(3, ['own1'], ['pool1', 'pool2', 'pool3'])).toEqual([
      'own1',
      'pool1',
      'pool2',
    ]);
  });

  it('never asks for more horses than the shortfall', () => {
    expect(seatFirstFillOrder(1, ['own1', 'own2'], ['pool1'])).toEqual(['own1']);
    expect(seatFirstFillOrder(0, ['own1'], ['pool1'])).toEqual([]);
  });

  it('never offers the same horse twice, in either direction', () => {
    // A horse on the roster is also in the fleet, so the two lists overlap
    // routinely. Seating one twice wastes the pass on a guaranteed refusal.
    expect(seatFirstFillOrder(3, ['h1'], ['h1', 'h2'])).toEqual(['h1', 'h2']);
    expect(seatFirstFillOrder(3, ['h1', 'h1'], ['h2'])).toEqual(['h1', 'h2']);
  });

  it('drops empty and non-string ids rather than sending them to the RPC', () => {
    expect(seatFirstFillOrder(3, ['', null, undefined, '  '], ['h1'])).toEqual(['h1']);
  });

  it('treats a nonsense shortfall as nothing to do', () => {
    expect(seatFirstFillOrder(Number.NaN, ['h1'], ['h2'])).toEqual([]);
    expect(seatFirstFillOrder(-4, ['h1'], ['h2'])).toEqual([]);
  });

  it('works when either side is missing entirely', () => {
    expect(seatFirstFillOrder(2, [], ['p1', 'p2'])).toEqual(['p1', 'p2']);
    expect(seatFirstFillOrder(2, ['o1', 'o2'], [])).toEqual(['o1', 'o2']);
  });
});

describe('topUpWithHorses - the seat-first fill wiring', () => {
  it('asks the roster before it asks the fleet', () => {
    const body = topUpBody();
    const own = body.indexOf('unseatedRegistrantHorses');
    const pool = body.indexOf('pickFreeHorses');
    expect(own, 'the roster path must be wired in').toBeGreaterThan(-1);
    expect(pool, 'the free pool is still the fallback').toBeGreaterThan(-1);
    expect(own, 'own registrants must be gathered before the fleet is drawn on').toBeLessThan(pool);
  });

  it('orders the candidates through the pinned rule rather than by hand', () => {
    expect(topUpBody()).toContain('seatFirstFillOrder(');
  });

  it('does not discard the refusal from the seating RPC', () => {
    // fn_enforce_tournament_capacity RAISES, it does not return {ok:false}.
    // The one signal naming this deadlock arrived in `error` and was thrown
    // away for a day and a half.
    const body = topUpBody();
    expect(body).toMatch(/error:\s*seatRpcErr/);
    expect(body).toContain('TournamentRecurring.seat_first_seat_rpc_failed');
  });

  it('keeps filling after a single refusal', () => {
    // 2026-08-24 P2-4. One rejected horse must not halt the whole game.
    const seatingLoop = topUpBody();
    const loopStart = seatingLoop.indexOf('for (const horse of candidates)');
    expect(loopStart).toBeGreaterThan(-1);
    const loop = seatingLoop.slice(loopStart, seatingLoop.indexOf('} else {', loopStart));
    // A statement, not the word in the comment explaining why it is gone.
    expect(loop, 'a break here stops the fill for the whole game').not.toMatch(/\bbreak\s*;/);
  });
});

describe('horse load - unreadable is UNKNOWN, never idle', () => {
  it('horseLoadMap returns null rather than an empty map when a read fails', () => {
    const start = SRC.indexOf('private async horseLoadMap(');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\n  /** Horses already at', start));
    expect(body).toContain('Promise<Map<string, number> | null>');
    // Both reads, not just the first.
    expect(body.match(/return null;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('an unreadable tournament row never gets to pick the format', () => {
    // isSeatFirstFormat('', 0) is TRUE, because 0 <= 2. A discarded error here
    // sent a 500-seat MTT down the seat-seating path, where it seats nobody
    // and is never topped up.
    const body = topUpBody();
    expect(body).toMatch(/error:\s*tErr/);
    expect(body).toContain('if (tErr || !tRow)');
    expect(body).toContain('TournamentRecurring.topup_tournament_read_failed');
    // The CALL, not the mention of it in the comment above the guard.
    expect(body.indexOf('if (tErr || !tRow)')).toBeLessThan(
      body.indexOf('const seatFirst = isSeatFirstFormat(')
    );
  });

  it('both callers decline the pass instead of treating the fleet as idle', () => {
    // An empty load map says every horse is free, so both callers hand out
    // horses that are at four tables and the trigger refuses each one.
    const pick = SRC.slice(SRC.indexOf('private async pickFreeHorses('));
    expect(pick.slice(0, pick.indexOf('const busy'))).toContain('if (!load) return [];');
    const reg = SRC.slice(SRC.indexOf('private async registerHorses('));
    expect(reg.slice(0, reg.indexOf('const busyIds'))).toContain('if (!load) return 0;');
  });
});
