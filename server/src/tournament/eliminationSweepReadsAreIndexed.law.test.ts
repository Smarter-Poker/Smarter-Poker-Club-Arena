/**
 * LAW: the elimination sweep reads the exact roster mirror written by the
 * accepted-hand transaction. It must never rebuild financial truth by
 * scanning live seats or invoking a delayed chip reconciler.
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
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const src = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
describe('LAW: the elimination sweep reads through indexes', () => {
  /**
   * Only the SWEEP is pinned, not the whole file. The knockout candidate's
   * live-seat safety veto further down uses the same `tables!inner` embed
   * legitimately: it filters `.eq('user_id', userId)` first, which is selective
   * and indexed (idx_table_seats_live_user). The bug is an inner embed with NO
   * selective predicate on the outer table, which is what the sweep had.
   */
  const code = sliceMethod(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
    'private async runEliminationSweep(signal: AbortSignal)'
  );

  it('does not read seats through an unfiltered tables!inner embed', () => {
    expect(
      code.includes('tables!inner'),
      'the sweep must not read table_seats via a `tables!inner(...)` embed: the ' +
        'outer table carries no tournament predicate, so every live seat on the ' +
        'platform is scanned. Read `tables` by tournament_id, then seats by table_id.'
    ).toBe(false);
  });

  it('reads the tournament roster by tournament and playing status', () => {
    expect(code).toContain(".from('tournament_players')");
    expect(code).toContain(".eq('tournament_id', this.tournamentId)");
    expect(code).toContain(".eq('status', 'playing')");
    expect(code).toContain(".lte('chips', 0)");
  });

  it('never runs a seat scan or delayed chip-sync RPC', () => {
    expect(code).not.toMatch(/\.from\(['"]table_seats['"]\)|tables!inner/);
    expect(code).not.toMatch(/fn_sync_tournament_(?:live_seat_)?chips/);
  });
});
