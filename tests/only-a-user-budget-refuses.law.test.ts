/**
 * ONLY A USER BUDGET REFUSES A PLAYER. A PLATFORM POT NEVER DOES.
 *
 * Dan, 2026-09-08, ruling 21: "THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS
 * LIKE THIS, ONLY A USER BUDGET."
 *
 * A per-user cap is a rule about one player and their own earning. A
 * platform-wide monthly pot is a rule about everybody else's - a shared pool, so
 * whoever arrives early spends it and whoever arrives late is refused for
 * something they did nothing to deserve. A race, with no visible clock.
 *
 * Two pots could refuse, and both were live:
 *
 *   1. `diamond_reward_budgets` per engine per month, with
 *      `DR7:engine_over_budget` scheduled to flip to refuse on 2026-09-14. With
 *      the spend counter repaired that morning, daily_missions read 127,305
 *      against a 30,000 line - so the flip would have refused every
 *      daily-mission award for the rest of September.
 *   2. `diamond_platform_budget`, which refused with `budget_exhausted` AND
 *      silently truncated an award to whatever the shared pot had left:
 *      `v_award := LEAST(v_award::bigint, v_budget_left)::int`. A player owed
 *      100 who arrived when the pot held 7 was paid 7.
 *
 * What must survive is the user budget: the per-user daily caps, their
 * still-scheduled flip, and the per-user monthly allowance.
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
/** A mention is not a call: the bodies explain by name what they no longer do. */
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('a platform pot never refuses a player', () => {
  const sql = read('only_a_user_budget_refuses');
  const body = code(sql);

  it('retires the per-engine rule rather than deferring it', () => {
    expect(body).toContain(
      "DELETE FROM public.ca_diamond_rule_modes WHERE rule = 'DR7:engine_over_budget'"
    );
  });

  it('removes the engine pot from the award path, refusal and per-award incident alike', () => {
    const to = (body.match(/\$ca_to\$[\s\S]*?\$ca_to\$/g) ?? []).join('\n');
    expect(to).not.toContain("v_refuse := 'DR7:engine_over_budget'");
    expect(to).not.toContain("fn_ca_diamond_incident('DR7:engine_over_budget'");
  });

  it('removes the shared-pot refusal and the silent truncation together', () => {
    const to = (body.match(/\$ca_to\$[\s\S]*?\$ca_to\$/g) ?? []).join('\n');
    expect(to).not.toContain('budget_exhausted');
    expect(to).not.toContain('LEAST(v_award::bigint, v_budget_left)');
    expect(to).not.toContain('UPDATE public.diamond_platform_budget');
  });

  it('asserts all of that against the live bodies before it commits', () => {
    expect(body).toContain('the earn ledger still consults the per-engine pot');
    expect(body).toContain('award_diamonds_v2 can still refuse for a shared pot');
    expect(body).toContain(
      'award_diamonds_v2 can still silently shrink an award to the shared pot'
    );
    expect(body).toContain('the retired rule is still in the mode table');
  });

  it('strips comments before asserting, because the bodies name what they removed', () => {
    // read the RAW sql here: the expression itself contains a '--' literal, which the
    // comment stripper above would eat. The stripper being right is why this reads raw.
    expect(sql).toContain("regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g')");
  });
});

describe('the user budget survives intact', () => {
  const body = code(read('only_a_user_budget_refuses'));

  it('keeps the per-user daily cap being evaluated', () => {
    expect(body).toContain('the per-user cap stopped being evaluated');
  });

  it('keeps the per-user cap scheduled to become a refusal', () => {
    expect(body).toContain("rule = 'DR7:user_over_daily_cap' AND flip_after IS NOT NULL");
    expect(body).toContain('the per-user cap is no longer scheduled to become a refusal');
  });

  it('keeps the per-user monthly allowance', () => {
    expect(body).toContain('v_monthly_cap := CASE WHEN v_is_vip THEN 4500 ELSE 3300 END');
    expect(body).toContain('the per-user monthly allowance was lost');
  });

  it('keeps every per-user daily cap row', () => {
    expect(body).toContain(
      'FROM public.diamond_engine_daily_caps WHERE max_per_user_per_day IS NOT NULL'
    );
    expect(body).toContain('per-user daily cap(s) remain');
  });

  it('leaves the append-only spend recording alone', () => {
    expect(body).toContain('the append-only spend recording was lost');
  });

  it('labels both budget columns as a forecast so nobody re-arms them', () => {
    expect(body).toContain('COMMENT ON COLUMN public.diamond_reward_budgets.budget_diamonds');
    expect(body).toContain('COMMENT ON COLUMN public.diamond_platform_budget.budget_diamonds');
    expect(sqlHasForecast(body)).toBe(true);
  });
});

function sqlHasForecast(body: string): boolean {
  return (body.match(/A FORECAST, NOT A GATE \(ruling 21/g) ?? []).length === 2;
}
