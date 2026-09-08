/**
 * THE OTHER CURRENCIES GET THEIR GUARDS AND A METER (phase 8, roadmap 9.7).
 *
 * VIP points and agent commissions had journals whose identities held by
 * luck: no guard on the ledger, no guard on the balance, an award writer that
 * rewrote its own leg after inserting it, and no meter to say the morning it
 * stopped holding. Rakeback had three sources with three totals. What this
 * pins:
 *
 *   1. vip_points_ledger, agent_commissions and rakeback_period_payouts carry
 *      the same append-only guard chip_ledger has, with each table's one
 *      legitimate movement stated (none / settled_at once / bookkeeping);
 *   2. vip_points moves only through a writer that declares itself in the
 *      same transaction, never negative, lifetime never shrinking;
 *   3. fn_award_vip_credit writes the leg once, final, and stays idempotent;
 *   4. ca_currency_meter and fn_ca_currency_meter exist, name what is and is
 *      not enforced, and ride the nightly replay job - no new trigger;
 *   5. every one of those is PROVED in the migration by a rolled-back probe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
/** Phase 8 shipped in TWO migrations, and the split is itself a law: the
 *  meter's proof scans 5.75M legs, and holding a trigger's ACCESS EXCLUSIVE
 *  for that long would have failed live VIP awards (the engine's role carries
 *  an 8 s statement timeout). Part one has no table lock; part two holds one
 *  for the length of five refusals. */
const meterFile = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('the_other_currencies_get_a_meter'));
const file = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .find((f) => f.includes('the_other_currencies_get_their_guards'));
const meterSql = meterFile ? readFileSync(join(MIGRATIONS, meterFile), 'utf8') : '';
const guardSql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
const sql = meterSql + '\n' + guardSql;
const guard = guardSql.slice(
  guardSql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()'),
  guardSql.indexOf('DROP TRIGGER IF EXISTS trg_ca_append_only ON public.vip_points_ledger')
);
const award = meterSql.slice(
  meterSql.indexOf('CREATE OR REPLACE FUNCTION public.fn_award_vip_credit('),
  meterSql.indexOf('CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(')
);

describe('the other currencies get their guards and a meter', () => {
  it('both migrations exist, and the split is deliberate', () => {
    expect(meterFile, 'the phase 8 meter migration must not be deleted').toBeTruthy();
    expect(file, 'the phase 8 guard migration must not be deleted').toBeTruthy();
    // part one carries no table lock: its proof is a 10-second scan
    expect(meterSql).not.toMatch(/LOCK TABLE/);
    // part two takes every lock up front, with a timeout, and holds it briefly
    expect(guardSql).toMatch(/SET LOCAL lock_timeout/);
    expect(guardSql).toMatch(
      /LOCK TABLE public\.vip_points_ledger, public\.agent_commissions, public\.rakeback_period_payouts, public\.vip_points\s+IN ACCESS EXCLUSIVE MODE/
    );
    expect(guardSql).not.toMatch(/fn_ca_currency_meter\(\)\s*;/); // no 10 s scan under the lock
  });

  it('three more journals are append-only, each with its one legitimate movement stated', () => {
    expect(guard).toMatch(
      /ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN[\s\S]*?v_allowed_update := false;/
    );
    expect(guard).toMatch(
      /ELSIF TG_TABLE_NAME = 'agent_commissions' THEN[\s\S]*?\(OLD\.settled_at IS NULL OR NEW\.settled_at IS NOT DISTINCT FROM OLD\.settled_at\)/
    );
    expect(guard).toMatch(
      /ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN[\s\S]*?NEW\.payout_amount IS NOT DISTINCT FROM OLD\.payout_amount/
    );
    // the compensating delete on a payout is allowed and RECORDED, never silent
    expect(guard).toMatch(
      /IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN[\s\S]*?INSERT INTO public\.ca_ledger_mutation_log/
    );
    for (const t of ['vip_points_ledger', 'agent_commissions', 'rakeback_period_payouts']) {
      expect(sql).toMatch(
        new RegExp(`CREATE TRIGGER trg_ca_append_only BEFORE DELETE OR UPDATE ON public\\.${t}`)
      );
    }
    // the chip journals' own rules are untouched
    expect(guard).toMatch(
      /ELSIF TG_TABLE_NAME = 'chip_ledger' THEN[\s\S]*?NEW\.row_hash IS NOT DISTINCT FROM OLD\.row_hash/
    );
    expect(guard).toMatch(/TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE'/);
  });

  it('the VIP balance moves only with a leg, never negative, lifetime never shrinking', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_vip_points_move_only_with_a_leg()');
    expect(sql).toMatch(/current_setting\('app\.vip_points_writer', true\)/);
    expect(sql).toMatch(/NEW\.current_points < 0/);
    expect(sql).toMatch(/NEW\.lifetime_points < OLD\.lifetime_points/);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE ON public\.vip_points/);
    // both writers declare themselves, and close the declaration
    expect(award).toMatch(/set_config\('app\.vip_points_writer', 'fn_award_vip_credit', true\)/);
    expect(award).toMatch(/set_config\('app\.vip_points_writer', '', true\)/);
    expect(sql).toMatch(/set_config\('app\.vip_points_writer', 'fn_redeem_vip_points', true\)/);
  });

  it('the award writer inserts the leg final and stays idempotent', () => {
    expect(award).toMatch(
      /INSERT INTO public\.vip_points_ledger \(user_id, points, reason, source_type, source_id, credit\)\s+VALUES \(p_user_id, v_pts,/
    );
    expect(award).toMatch(/ON CONFLICT \(user_id, source_type, source_id\) DO NOTHING/);
    expect(award).not.toMatch(/UPDATE public\.vip_points_ledger/);
    expect(award).toMatch(/IF NOT public\.fn_caller_is_engine\(\)/);
    expect(sql).toMatch(/VERIFY FAILED: the probe leg was not written once, final/);
    expect(sql).toMatch(/VERIFY FAILED: a duplicate award was not idempotent/);
  });

  it('the meter exists, says what it does not enforce, and rides the job that already ran', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.ca_currency_meter/);
    expect(sql).toMatch(/enforced\s+boolean\s+NOT NULL,/);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_ca_currency_meter()');
    expect(sql).toMatch(/'currency-drift:vip_points'/);
    expect(sql).toMatch(/'currency-drift:agent_commissions'/);
    expect(sql).toMatch(/'currency-drift:rakeback'/);
    expect(sql).toMatch(/'not_enforced_because'/);
    expect(sql).toContain("VALUES ('rakeback', v_rb_pending, v_rb_payout_rows, 0,");
    expect(meterSql).toMatch(/cron\.alter_job\(\s*286,/);
    expect(sql).not.toMatch(/cron\.schedule\s*\(/);
    expect(sql).toMatch(/VERIFY FAILED: the nightly job lost the replay or did not gain the meter/);
  });

  it('every guard is proved by a rolled-back probe, on a cold row', () => {
    for (const m of [
      'a VIP leg was edited and nothing refused it',
      'a VIP leg was deleted and nothing refused it',
      'a VIP balance moved with no leg and nothing refused it',
      'a VIP balance went negative and nothing refused it',
      'the probe leg survived the rollback',
      'a commission amount was edited and nothing refused it',
      'a settled commission was un-settled and nothing refused it',
      'a payout amount was edited and nothing refused it',
      'a payout delete was not recorded',
    ])
      expect(sql).toContain(m);
    expect(sql).toMatch(/ORDER BY updated_at ASC LIMIT 1/);
  });

  it('nothing here filters horses', () => {
    expect(sql).not.toMatch(/is_horse/i);
  });
});
