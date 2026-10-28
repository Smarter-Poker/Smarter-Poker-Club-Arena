import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (path: string) => readFileSync(path, 'utf8');

describe('leaderboard prize qualification remains connected', () => {
  it('runs both real PostgreSQL qualifications for every migration and fixture change', () => {
    const workflow = parse(read('.github/workflows/weekly-close-hour-guard.yml'));
    const paths = workflow.on.pull_request.paths;
    expect(paths).toContain('supabase/migrations/**');
    for (const name of ['monday', 'union']) {
      expect(paths).toContain(`scripts/ci/fixtures/leaderboard-${name}/**`);
      expect(paths).toContain(`scripts/ci/test-leaderboard-${name}-postgres.py`);
      expect(
        workflow.jobs['weekly-close-hour-guard'].steps.some((step: { run?: string }) =>
          step.run?.includes(`python3 -B scripts/ci/test-leaderboard-${name}-postgres.py`)
        )
      ).toBe(true);
    }
  });

  it('retains the actual ranking, payment and funding owners as native fixtures', () => {
    for (const name of [
      'fn_club_leaderboard_by_dates',
      'fn_payout_leaderboard',
      'fn_leaderboard_complete_round_basis',
      'fn_enforce_leaderboard_program_funding',
    ]) {
      expect(read(`scripts/ci/fixtures/leaderboard-union/${name}.sql`)).toContain(
        `CREATE OR REPLACE FUNCTION public.${name}`
      );
    }
    const migration = read(
      'supabase/migrations/20261028163625_leaderboard_union_complete_basis_and_awards.sql'
    );
    expect(migration).toContain('public.fn_credit_and_log');
    expect(migration).toContain('leaderboard_payout_correction_immutable');
    expect(migration).not.toMatch(
      /(?:UPDATE|DELETE FROM)\s+public\.leaderboard_(?:round_basis_receipts|payout_batches|reward_program_versions)\b/i
    );
    expect(migration).not.toMatch(/(?:NOT\s+.*is_horse|is_horse\s*=\s*false)/i);
  });
});
