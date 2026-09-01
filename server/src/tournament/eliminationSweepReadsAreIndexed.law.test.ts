/**
 * LAW: the elimination sweep must not scan every live seat on the platform,
 * and must not page over a non-unique key.
 *
 * MEASURED in production on 2026-09-01 (pg_stat_statements):
 *   68,049 calls, 45ms mean, 3,085 seconds of database time - the single
 *   largest component of the 6% of all DB time spent reading table_seats.
 *
 * The cause was the PostgREST embedded-resource shape:
 *
 *   .select('user_id, stack, joined_at, tables!inner(tournament_id)')
 *   .eq('tables.tournament_id', this.tournamentId)
 *
 * which compiles to a LATERAL join whose OUTER table carries no tournament
 * predicate, so Postgres walks every live seat and probes `tables` once per
 * seat. Under an inner join with a LIMIT it cannot stop early either.
 *
 * Two separate things are pinned here, and the second is a correctness rule
 * rather than a performance one:
 *
 *  1. the sweep reads `tables` by tournament_id and then seats by table_id,
 *     both of which are indexed (idx_tables_tournament_id, idx_table_seats_table);
 *  2. it pages on `id`. user_id is NOT unique in table_seats - the duplicate
 *     seat handling directly above this code exists precisely because one user
 *     can hold several open seats - so paging on user_id can return a seat
 *     twice or not at all across a page boundary. This sweep decides who is
 *     eliminated, so an unstable page is a player busted by accident.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBetween } from '../testHelpers/sourceWindow.js';

const src = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');

describe('LAW: the elimination sweep reads through indexes', () => {
  /**
   * Only the SWEEP is pinned, not the whole file. `tournamentTableForUser` and
   * `lastTournamentTableForUser` further down use the same `tables!inner` embed
   * legitimately: they filter `.eq('user_id', userId)` first, which is selective
   * and indexed (idx_table_seats_live_user). The bug is an inner embed with NO
   * selective predicate on the outer table, which is what the sweep had.
   */
  // Anchored on markers that exist in BOTH the fixed and the broken version, so
  // that reintroducing the bug fails these assertions with their own message
  // rather than throwing "marker not found" from the slicer.
  const sweep = sliceBetween(src, 'const bestSeat = new Map', 'const seats = seatRows;');

  /**
   * Comments stripped, string literals kept. The doc block inside the sweep
   * QUOTES the broken query shape in order to explain it, and a bare substring
   * check matched that quotation - the assertion passed judgement on the
   * documentation rather than on the code. Strings must survive the strip,
   * because the thing being pinned lives inside a string literal
   * (`.select('...tables!inner...')`).
   */
  const code = sweep.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('does not read seats through an unfiltered tables!inner embed', () => {
    expect(
      code.includes('tables!inner'),
      'the sweep must not read table_seats via a `tables!inner(...)` embed: the ' +
        'outer table carries no tournament predicate, so every live seat on the ' +
        'platform is scanned. Read `tables` by tournament_id, then seats by table_id.'
    ).toBe(false);
  });

  it('reads tables by tournament_id and seats by table_id, both indexed', () => {
    expect(sweep).toContain(".from('tables')");
    expect(sweep).toContain(".eq('tournament_id', this.tournamentId)");
    expect(sweep).toContain(".in('table_id', idsForChunk)");
  });

  it('pages the seat read on the primary key, never on user_id', () => {
    expect(sweep).toContain(".order('id', { ascending: true })");
    expect(
      /\.order\('user_id'/.test(code),
      'user_id is not unique in table_seats; paging on it can drop or duplicate a ' +
        'seat across a page boundary, and this sweep decides who busts.'
    ).toBe(false);
  });

  it('bounds the IN list so a 1,076-table field cannot build an unbounded query', () => {
    expect(sweep).toContain('TABLE_ID_CHUNK');
  });
});
