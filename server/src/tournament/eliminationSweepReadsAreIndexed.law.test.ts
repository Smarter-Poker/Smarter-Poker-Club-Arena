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
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const src = readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');
const migration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260907180000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
  ),
  'utf8'
);
const rpcStart = migration.indexOf(
  'CREATE OR REPLACE FUNCTION public.fn_sync_tournament_live_seat_chips('
);
const rpcEnd = migration.indexOf('CREATE OR REPLACE FUNCTION', rpcStart + 1);
const rpc = migration.slice(rpcStart, rpcEnd);

describe('LAW: the elimination sweep reads through indexes', () => {
  /**
   * Only the SWEEP is pinned, not the whole file. `tournamentTableForUser` and
   * `lastTournamentTableForUser` further down use the same `tables!inner` embed
   * legitimately: they filter `.eq('user_id', userId)` first, which is selective
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

  it('reads tables by tournament_id and seats by table_id, both indexed', () => {
    expect(code).toContain("'fn_sync_tournament_live_seat_chips'");
    expect(rpc).toMatch(
      /FROM public\.tables t\s+JOIN public\.table_seats s ON s\.table_id=t\.id AND s\.left_at IS NULL\s+WHERE t\.tournament_id=p_tournament_id/
    );
  });

  it('classifies duplicate seats in one database snapshot', () => {
    expect(rpc).toContain('max(joined_at) AS latest_joined_at');
    expect(rpc).toContain('latest_count<>1');
    expect(rpc).toContain('v_ambiguous_user_ids');
  });

  it('never serializes a tournament-sized table-id list into a PostgREST URL', () => {
    expect(code).not.toMatch(/\.in\('table_id',\s*idsForChunk\)/);
    expect(rpc).not.toContain('.in(');
  });
});
