import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const RECERTIFICATION = '20260906091511_phase_1_table_management_authority_recertified.sql';
const CANCELLATION = '20260909014444_tournament_cancellation_commits_one_stored_receipt.sql';
const SEAT_EXIT = '20260910042112_stage_b_current_postimage_contraction.sql';
const COMPOSED_CLOSE =
  '20260909192240_managed_close_preserves_cash_occupancy_and_atomic_tournament_cancellation.sql';
const recertification = readFileSync(resolve(MIGRATIONS, RECERTIFICATION), 'utf8');
const cancellation = readFileSync(resolve(MIGRATIONS, CANCELLATION), 'utf8');
const seatExit = readFileSync(resolve(MIGRATIONS, SEAT_EXIT), 'utf8');
const migrationSources = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, source: readFileSync(resolve(MIGRATIONS, file), 'utf8') }));

function latestDefinition(functionName: string): { file: string; source: string } {
  let latest: { file: string; source: string } | null = null;
  const marker = `CREATE OR REPLACE FUNCTION public.${functionName}`;

  for (const { file, source } of migrationSources) {
    const start = source.lastIndexOf(marker);
    if (start >= 0) {
      const tail = source.slice(start);
      const opening = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(tail);
      if (!opening) throw new Error(`${functionName} in ${file} has no body delimiter`);
      const delimiter = opening[1];
      const bodyStart = opening.index + opening[0].length;
      const bodyEnd = tail.indexOf(delimiter, bodyStart);
      if (bodyEnd < 0) throw new Error(`${functionName} in ${file} has no body terminator`);
      latest = { file, source: tail.slice(0, bodyEnd + delimiter.length) };
    }
  }

  if (!latest) throw new Error(`No migration defines ${functionName}`);
  return latest;
}

describe('Table Management Phase 1 remains authoritative after later migrations', () => {
  it('keeps affiliated club staff behind the union-aware cash-game creation door', () => {
    const latest = latestDefinition('fn_cash_game_create(');

    expect(latest.file).toBe(RECERTIFICATION);
    expect(latest.source).toContain('IF NOT public.fn_can_create_games(p_club_id, v_uid)');
    expect(latest.source).not.toContain('OR public.is_club_admin');
    expect(recertification).toContain('RENAME TO fn_cash_game_create_impl_20260905');
    expect(recertification).toContain(
      'FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.fn_cash_game_create_impl_20260905'
    );
  });

  it('removes the private-table insert bypass and the direct delete policy', () => {
    expect(recertification).toContain('DROP POLICY IF EXISTS tables_insert_owner_or_admin');
    expect(recertification).toContain(
      'WITH CHECK (public.fn_can_create_games(club_id, (SELECT auth.uid())))'
    );
    expect(recertification).not.toContain('COALESCE(is_private, false) AND is_club_admin(club_id');
    expect(recertification).toContain('DROP POLICY IF EXISTS tables_delete ON public.tables');
    expect(recertification).not.toContain('CREATE POLICY tables_delete');
  });

  it('counts every active seat when the current close helper decides', () => {
    const latest = latestDefinition('fn_close_managed_game(');

    expect(latest.file).toBe(COMPOSED_CLOSE);
    expect(latest.source).toContain('FROM public.table_seats ts');
    expect(latest.source).toContain('AND ts.left_at IS NULL');
    expect(latest.source).not.toContain('ts.user_id IS NOT NULL');
    expect(latest.source).toContain("'reason', 'players_seated'");
  });

  it('counts every registration in both current tournament helpers', () => {
    const update = latestDefinition('fn_update_managed_game(');
    const close = latestDefinition('fn_close_managed_game(');

    expect(update.file).toBe(SEAT_EXIT);
    expect(close.file).toBe(COMPOSED_CLOSE);
    for (const definition of [update.source, close.source]) {
      expect(definition).toContain('FROM public.tournament_players tp');
      expect(definition).not.toContain('tp.user_id IS NOT NULL');
      expect(definition).toMatch(/'reason'\s*,\s*'players_registered'/);
    }
  });

  it('leaves update and close private behind the durable command gateway', () => {
    expect(recertification).toContain(
      'REVOKE ALL ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)\n  FROM PUBLIC, anon, authenticated;'
    );
    expect(cancellation).toContain(
      'REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)\n  FROM PUBLIC, anon, authenticated;'
    );
    expect(cancellation).not.toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid)\n  TO authenticated'
    );
    expect(seatExit).toContain(
      'REVOKE ALL ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb)\n  FROM PUBLIC,anon,authenticated;'
    );
    expect(seatExit).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text,uuid,jsonb)\n  TO service_role;'
    );
  });
});
