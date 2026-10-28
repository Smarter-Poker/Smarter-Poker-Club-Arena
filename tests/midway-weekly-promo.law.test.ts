import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = readFileSync(
  'supabase/migrations/20261016132743_midway_weekly_horse_promo_distribution.sql',
  'utf8'
);
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
describe('Midway weekly promo is an atomic step in the existing due weekly tick', () => {
  it('keeps the native money and ledger regression in the required CI workflow', () => {
    expect(workflow).toContain('scripts/qualification/midway-weekly-promo/run-native.py');
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF status,result ON public.union_accounting_runs'
    );
    expect(migration).toContain('v_promo:=public.fn_midway_weekly_horse_promo_due();');
    expect(migration).toContain("v_promo->>'owns_tick'='true' THEN RETURN v_promo");
    expect(migration).not.toMatch(/cron\.(schedule|alter_job)/i);
  });
  it('restricts financial receipts and preserves the existing disbursement door', () => {
    expect(migration).toContain('public.fn_promo_disburse(');
    expect(migration).toContain('UNIQUE(union_id,period_start,period_end)');
    expect(migration).toContain('PRIMARY KEY(run_id,club_id,user_id)');
    expect(migration).toContain('FROM PUBLIC,anon,authenticated,service_role');
    expect(migration).not.toMatch(/UPDATE public\.(club_members|union_wallets)\b/);
  });
});

describe('Midway promo shares the existing player-stats lock protocol', () => {
  const repair = readFileSync(
    'supabase/migrations/20261028012516_midway_promo_takes_its_existing_player_keys_before_wallet_rows.sql',
    'utf8'
  );
  const native = readFileSync('scripts/qualification/midway-weekly-promo/run-native.py', 'utf8');
  const races = readFileSync(
    'scripts/qualification/midway-weekly-promo/lock-order/cohort-concurrency.py',
    'utf8'
  );
  it('enforces the actual old-fail/new-pass lock scenarios through required native CI', () => {
    expect(native).toContain('locks.qualify(lock_sql,lock_q,O,ENV,L)');
    expect(native).toContain("'lock-installer-rollback'");
    expect(native).toContain("'lock-metadata-drift-refused'");
    expect(native).toContain("'lock-authority-drift-refused'");
    for (const scenario of [
      'actual-club-disburser-cycle',
      'actual-current-projector-profile-trigger',
      'actual-current-multi-hand-batch-page-order',
      'newly-eligible-horse-profile-waits-known-key',
      'covered-user-overlap',
      'disjoint-users-same-clubs-B-then-A-current-batch',
    ])
      expect(races).toContain(scenario);
  });
  it('refuses an uncovered fresh cohort before receipts and preserves payout order', () => {
    expect(repair).toContain("'player-stats-user:'||v_user::text");
    expect(repair).toContain('eligible AS MATERIALIZED');
    expect(repair).toContain('coverage AS MATERIALIZED');
    expect(repair).toContain('WHERE b.covered AND b.locked_clubs>=0');
    expect(repair).toContain("ERRCODE='40001'");
    expect(repair.indexOf('IF NOT v_covered')).toBeLessThan(
      repair.indexOf('INSERT INTO public.union_weekly_horse_promo_runs')
    );
    expect(repair).toContain('jsonb_agg(to_jsonb(w) ORDER BY w.club_id,w.user_id)');
    expect(repair).not.toMatch(
      /cron\.(schedule|alter_job)|SKIP LOCKED|UPDATE public\.(club_members|union_wallets)\b/i
    );
  });
});
