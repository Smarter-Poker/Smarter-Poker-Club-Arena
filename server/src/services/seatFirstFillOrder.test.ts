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

/** The seat-first seating loop alone, which several pins below read. */
function seatingLoopBody(): string {
  const body = topUpBody();
  const start = body.indexOf('for (const horse of candidates)');
  expect(start, 'the seating loop must still exist').toBeGreaterThan(-1);
  const end = body.indexOf('} else {', start);
  return body.slice(start, end > -1 ? end : body.length);
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
    //
    // 2026-09-03: this used to forbid the WORD `break` anywhere in the loop,
    // which was a fine proxy while the candidate list was exactly the
    // shortfall - every exit was an exit on a refusal. The list now carries
    // spares (seatFirstCandidateCount), so the loop needs one exit that is not
    // a refusal at all: the seats are full, and a 3-handed spin must not take a
    // fourth. Pin the RULE instead of the keyword - the only break may be the
    // one guarded by the shortfall, and a refusal must still be a `continue`.
    const loop = seatingLoopBody();
    const breaks = loop.match(/\bbreak\s*;/g) ?? [];
    expect(breaks.length, 'the loop needs at most the one full-seats exit').toBeLessThanOrEqual(1);
    if (breaks.length === 1) {
      expect(loop, 'the only break must be the seats-are-full guard, never a refusal').toMatch(
        /if\s*\(added\s*>=\s*shortfall\)\s*break\s*;/
      );
    }
    // The refusal branch itself: still a continue, on both halves.
    const refusal = loop.slice(loop.indexOf('if (seatRpcErr)'));
    expect(refusal, 'a refused horse yields to the next candidate').toMatch(
      /if\s*\(seatRpcErr\)[\s\S]*?continue;/
    );
  });

  it('stops once the seats are covered - the spares are for refusals only', () => {
    // seatFirstCandidateCount hands the loop more candidates than seats. Without
    // this guard a lucky pass would seat a fourth player into a 3-handed spin.
    expect(seatingLoopBody()).toMatch(/if\s*\(added\s*>=\s*shortfall\)\s*break\s*;/);
  });

  it('asks for more candidates than there are seats', () => {
    // One candidate per seat is a bet that no other caller is picking the same
    // horse. Production 2026-09-03: 247 boards an hour lost that bet.
    const body = topUpBody();
    expect(body).toContain('seatFirstCandidateCount(shortfall)');
    expect(body).toMatch(/seatFirstFillOrder\(\s*wantCandidates/);
    expect(body, 'the pool must be sized from the padded count, not the shortfall').toMatch(
      /poolWanted\s*=\s*Math\.max\(0,\s*wantCandidates\s*-\s*own\.length\)/
    );
  });

  it('an ordinary cap refusal is not reported, and everything else still is', () => {
    // 89 of 98 reports in an hour were FOUR TABLE LIMIT - the rule working -
    // and they buried the refusals that needed reading.
    const loop = seatingLoopBody();
    expect(loop).toContain('isExpectedSeatRefusal(seatRpcErr.message)');
    expect(loop, 'the report must survive for every other refusal').toContain(
      'TournamentRecurring.seat_first_seat_rpc_failed'
    );
    expect(
      loop.indexOf('isExpectedSeatRefusal'),
      'the filter guards the report; it must not replace it'
    ).toBeLessThan(loop.indexOf('TournamentRecurring.seat_first_seat_rpc_failed'));
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
