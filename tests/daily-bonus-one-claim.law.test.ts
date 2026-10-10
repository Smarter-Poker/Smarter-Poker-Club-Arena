import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (p: string) => readFileSync(p, 'utf8');
it('daily bonus has one claim action and no cash equivalent copy', () => {
  const sheet = read('src/components/daily-bonus/DailyBonusSheet.tsx');
  expect(sheet).not.toContain('diamondsToCentsLabel');
  expect(sheet).not.toContain('Claim Next');
  expect(sheet).not.toContain('onClaim(tile)');
  expect(sheet).toContain('claimAll()');
  expect(sheet).toContain('blue-diamond-v1.webp');
});
it('daily selection excludes yesterday type and the original claim owns every award', () => {
  const sql = read(
    'supabase/migrations/20261010062545_daily_bonus_varies_each_day_and_claims_all_rewards.sql'
  );
  expect(sql).toContain('pool.kind IS DISTINCT FROM previous_kind');
  expect(sql).toContain('public.fn_ca_daily_bonus_claim((v_tile');
  expect(sql).toContain("pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:'");
  expect(read('scripts/dev/test-accounting-delivery.sh')).toContain(
    'run_game_probe daily-bonus-one-claim'
  );
  expect(read('.github/workflows/ci.yml')).toContain(
    'bash scripts/dev/test-accounting-delivery.sh'
  );
});
