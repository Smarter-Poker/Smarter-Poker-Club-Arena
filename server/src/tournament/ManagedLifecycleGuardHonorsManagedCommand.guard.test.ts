/**
 * fn_guard_managed_game_lifecycle has two doors for a protected lifecycle
 * change: the engine itself (auth.role()='service_role') and an authorised
 * managed operation (current_setting('app.managed_game_lifecycle')='on',
 * set only inside fn_close_managed_game and its settlement wrappers, whose
 * EXECUTE grant excludes anon/authenticated). Both doors are checked in the
 * function's other two lifecycle guards. The "cannot be cancelled after a
 * player has registered" clause checked only the engine door, which is why
 * PR #5139 (13 stuck Spins) and a further 17-tournament SNG/SATELLITE
 * settlement from the same 2026-09-08 window could not call
 * atomic_cancel_tournament without impersonating the service_role JWT claim -
 * a pattern already merged six times in this repo's history for exactly this
 * reason. Board incidents: operational_alert_events id=5 (SpinUnfilledBacklog)
 * and id=16 (TournamentNeverStarted).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../../supabase/migrations/20260924005150_managed_lifecycle_guard_honors_managed_command_for_tournament_cancellation.sql'
  ),
  'utf8'
);

function executable(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
}

const SQL = executable(MIGRATION);
const GUARD = SQL.slice(
  SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle'),
  SQL.indexOf(
    '$function$;',
    SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_lifecycle')
  )
);

describe('fn_guard_managed_game_lifecycle honors app.managed_game_lifecycle for tournament cancellation', () => {
  it('now accepts either door on the cancel-after-registered clause, matching its two sibling guards', () => {
    const cancelClause = GUARD.slice(
      GUARD.indexOf("This tournament cannot be cancelled after a player has registered") - 400,
      GUARD.indexOf("This tournament cannot be cancelled after a player has registered")
    );
    expect(cancelClause).toMatch(/NOT v_is_engine\s*\n\s*AND NOT v_managed_command\s*\n\s*AND upper\(COALESCE\(NEW\.status/);
  });

  it('leaves the tables close/delete door pair unchanged', () => {
    expect(GUARD).toMatch(
      /NOT v_is_engine\s*\n\s*AND NOT v_managed_command\s*\n\s*AND \(\s*\n\s*lower\(COALESCE\(NEW\.status/
    );
  });

  it('leaves the generic fn_close_managed_game door pair unchanged', () => {
    expect(GUARD).toMatch(
      /NOT v_is_engine\s*\n\s*AND NOT v_managed_command\s*\n\s*AND upper\(COALESCE\(NEW\.status, ''\)\) IN \('CANCELLED', 'CANCELED'\)\s*\n\s*AND upper\(COALESCE\(OLD\.status, ''\)\) NOT IN \('CANCELLED', 'CANCELED'\) THEN\s*\n\s*RAISE EXCEPTION 'Tournament lifecycle changes must use fn_close_managed_game'/
    );
  });

  it('never touches the protected-column guard, which stays engine-only (no managed_command escape)', () => {
    expect(GUARD).toMatch(
      /IF NOT v_is_engine THEN\s*\n\s*v_new_document := to_jsonb\(NEW\);/
    );
  });

  it('is guarded against drift from the function this was read against', () => {
    expect(MIGRATION).toMatch(
      /oid = 'public\.fn_guard_managed_game_lifecycle\(\)'::regprocedure\)\s*\n\s*<> '2f9ec1b3624945c0c6ff3421dbc17980'/
    );
  });

  it('is one migration transaction', () => {
    expect(MIGRATION.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIGRATION.trim().endsWith('COMMIT;')).toBe(true);
  });
});
