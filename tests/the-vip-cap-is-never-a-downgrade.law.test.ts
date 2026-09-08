/**
 * THE CAP THAT APPLIES IS THE CAP THAT WAS CERTIFIED.
 *
 * `diamond_engine_daily_caps` has two columns, and `fn_ca_diamond_earn_ledger`
 * does not blend them - it SUBSTITUTES:
 *
 *     IF v_cap_vip IS NOT NULL THEN ... IF v_is_vip THEN v_cap := v_cap_vip; END IF;
 *
 * so for a VIP the VIP column is the entire limit. On 2026-09-08 the standard
 * cap for `daily_challenges` was raised from 2,000 to 4,000 against a measured
 * design ceiling of 2,969, and the VIP column was left at 2,000. **849 of the
 * horse fleet are lifetime VIPs**, so the raise reached almost nobody: of 857
 * VIP user-days in fourteen days, 801 were over 2,000 and none was over 4,000.
 * `DR7:user_over_daily_cap` arms on 2026-09-14 and would have refused 4,547
 * movements on its first day.
 *
 * Two things made that possible, and both are pinned here.
 *
 * **A VIP cap below the standard cap is backwards on its face** - it makes
 * paying for VIP a downgrade - and nothing in the schema said so. A CHECK
 * constraint does now.
 *
 * **The instrument built the same morning to prevent exactly this was blind to
 * it.** `fn_ca_diamond_cap_headroom` read only `max_per_user_per_day` and
 * reported "HEALTHY ... 1.61x headroom" for a cap that would refuse thousands,
 * while the flip forecast - reading incidents rather than columns - said 4,547.
 * A tool whose whole purpose is that nobody arms a rule blind was itself blind,
 * in precisely the way it exists to prevent (CLAUDE.md 10.86). It reads both
 * columns now and names the one that binds.
 *
 * And the fourth pin is the one that had a clock on it. 23 horses held 759
 * completed, unclaimed, in-window challenge rewards worth 51,380 diamonds, 114
 * expiring that afternoon, because **a horse claims only when the engine reports
 * a new event for it, and a horse that stops playing stops claiming** - while a
 * human who stops playing still has a claim button for the full seven days.
 * Same reward, different outcome, decided by the input device: exactly what 10.5
 * forbids. The settlement is a one-time evidence-based correction under 10.9,
 * not a scheduled repair (10.12 forbids that), and the root fix is engine-side
 * and named as owed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('the VIP cap is never a downgrade', () => {
  const sql = read('the_vip_cap_and_the_expiring_claims');
  const body = code(sql);

  it('forbids a VIP cap below the standard cap in the schema, not in a convention', () => {
    expect(body).toContain('ca_vip_cap_is_never_lower');
    expect(body).toContain('max_per_user_per_day_vip >= max_per_user_per_day');
  });

  it('raises the VIP column to the standard one rather than leaving it behind', () => {
    expect(body).toMatch(
      /UPDATE public\.diamond_engine_daily_caps\s+SET max_per_user_per_day_vip = max_per_user_per_day/
    );
  });

  it('does not silently grant VIPs more than Dan decided: the columns are set equal, not higher', () => {
    // What a VIP should ADDITIONALLY earn is a product decision (CLAUDE.md 10.9).
    // Equal is the smallest change that is not absurd.
    expect(body).not.toMatch(/max_per_user_per_day_vip\s*=\s*max_per_user_per_day\s*\*/);
  });

  it('makes the headroom report read the cap that actually applies', () => {
    expect(body).toContain('fn_ca_diamond_cap_headroom');
    expect(body).toContain('cap_vip');
    expect(body).toContain('binding_cap');
    // it must judge each user-day against the column that governs THAT player
    expect(body).toMatch(/CASE WHEN w\.vip[\s\S]{0,160}max_per_user_per_day_vip/);
  });

  it('reports a lower VIP cap in words, so the next reader cannot miss it', () => {
    expect(body).toContain('VIP CAP IS LOWER');
    expect(body).toContain('paying for VIP is a downgrade');
  });

  it('asserts no real user-day in the measured window is refused by the cap that applies', () => {
    expect(body).toContain('user-day(s) would still be refused by the cap that applies to them');
  });

  it('settles the owed claims through the platform path, never a hand-written wallet row', () => {
    expect(body).toContain('claim_daily_challenge_serialized_body(r.user_id, r.id, NULL)');
    expect(body).not.toMatch(/UPDATE\s+public\.profiles\s+SET\s+diamonds/i);
    expect(body).not.toContain('INSERT INTO public.diamond_transactions');
  });

  it('settles once and schedules nothing (CLAUDE.md 10.12)', () => {
    expect(body).not.toMatch(/cron\.schedule/i);
    expect(body).not.toMatch(
      /CREATE\s+(OR REPLACE\s+)?FUNCTION[^;]{0,200}(_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_)/i
    );
  });

  it('refuses to report success if it settled nothing while claims were owed', () => {
    expect(body).toContain('nothing was settled although');
    expect(body).toContain('earned claim(s) are still unpaid inside their window');
  });

  it('names the engine-side root cause rather than presenting the settlement as the fix', () => {
    expect(sql).toContain('THE ROOT FIX IS NOT IN THIS FILE');
    expect(sql).toMatch(/HorseLogic|engine must claim on its own cadence/);
  });

  it('keeps the cap silence precise: the rule name, not any error containing daily_cap', () => {
    expect(body).toContain('DR7:user_over_daily_cap');
    expect(body).toContain('claim loop(s) still silence any error containing daily_cap');
  });

  it('still proves the books balance after paying 23 horses', () => {
    expect(body).toContain('players + float <> register after settling');
  });
});
