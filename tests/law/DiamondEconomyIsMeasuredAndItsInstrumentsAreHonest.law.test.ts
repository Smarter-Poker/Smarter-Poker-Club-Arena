/**
 * LAW - the diamond economy is measured, its instruments say what they mean, and every net over
 * it is a net rather than a repair (CLAUDE.md 10.12, 10.84, 10.86;
 * docs/changelog/2026-09-08-the-economy-has-a-report.md).
 *
 * Each pin is something that was true on 2026-09-08 and invisible until someone looked by hand:
 *  - the store had taken $2.00 in its lifetime, one account held 87 percent of all human
 *    diamonds, and real player spending was 2,873 against issuance of 19,865;
 *  - the health number shipped twice wrong - once dividing by every debit (1.15 when the answer
 *    was 6.91) and once excluding by a column that is NULL on the rows in question - and both
 *    times was caught by reading its own output;
 *  - fn_add_diamonds credited a wallet with no payment and was reachable only because a grant
 *    was missing;
 *  - two tables grew without any retention at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.sql'));
const pick = (suffix: string) => {
  const f = files.find((n) => n.endsWith(suffix));
  expect(f, `${suffix} exists`).toBeTruthy();
  return fs.readFileSync(path.join(dir, f as string), 'utf8');
};
const caps = pick('_the_daily_challenge_cap_matches_what_players_complete.sql');
const report = pick('_the_diamond_economy_has_a_report.sql');
const nets = pick('_three_standing_nets_over_the_diamond_economy.sql');
const spend = pick('_player_spend_is_decided_by_the_registers_own_origin_rule.sql');

describe('a cap is derived from a measurement written beside it (CLAUDE.md 10.84)', () => {
  it('the daily challenge cap names its distribution and sits above the maximum', () => {
    expect(caps).toContain('p50 195, p90 762, p99 1,357, max 1,726');
    expect(caps).toContain('max_per_user_per_day = 2000');
    expect(caps).toContain('the daily_challenges cap is %/%, not 2000/2000');
  });
  it('a cap is a limit, not a privilege: VIP gets the same number', () => {
    expect(caps).toContain('max_per_user_per_day_vip = 2000');
    expect(caps).toContain('a limit is not a privilege');
  });
  it('the unclassified line is reset so its rule fires on its own merits', () => {
    expect(caps).toContain("AND engine = 'unclassified'");
    expect(caps).toContain('SET spent_diamonds = 0');
  });
});

describe('the economy reads in one place', () => {
  it('reports supply against the register, concentration, faucets, sinks, liability, breakage, revenue and the arena', () => {
    for (const needle of [
      "'supply'",
      "'concentration'",
      "'faucet'",
      "'sink'",
      "'liability'",
      "'breakage'",
      "'revenue'",
      "'arena'",
    ]) {
      expect(report, `${needle} section`).toContain(needle);
    }
    expect(report).toContain('the report says supply % and register %');
  });
  it('is the house own view and never reachable from a browser', () => {
    expect(report).toContain('the economy report is reachable from a browser');
    expect(report).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_diamond_economy(integer) FROM PUBLIC, anon, authenticated;'
    );
    expect(report).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_diamond_breakage_aging() FROM PUBLIC, anon, authenticated;'
    );
  });
  it('ages purchased lots rather than guessing breakage', () => {
    expect(report).toContain("'age_0_14d'");
    expect(report).toContain("'age_over_365d'");
    expect(report).toContain('breakage in all but name');
  });
});

describe('the health number counts what players spent PLAYING', () => {
  it('uses the register own origin rule, not a column that is NULL on old rows', () => {
    expect(spend).toContain("IN ('spend', 'bridge')");
    expect(spend).toContain('fn_ca_diamond_journal_origin');
    expect(spend).not.toContain("NOT IN ('admin', 'refund')");
  });
  it('asserts the separation on live data instead of trusting it', () => {
    expect(spend).toContain('the separation did not take');
    expect(spend).toContain("= 'adjustment'");
  });
  it('the alarm and the report can never disagree about what it means', () => {
    expect(spend).toContain('the alarm says % and the report says %');
    expect(nets).toContain('fn_ca_diamond_economy_watch');
  });
});

describe('the nets are nets, not repairs (CLAUDE.md 10.12)', () => {
  it('the alarms file and never move a diamond', () => {
    const watch = nets.slice(
      nets.indexOf('FUNCTION public.fn_ca_diamond_economy_watch'),
      nets.indexOf('REVOKE ALL ON FUNCTION public.fn_ca_diamond_economy_watch')
    );
    expect(watch).not.toMatch(
      /UPDATE\s+public\.profiles|fn_ca_mint|fn_ca_burn|add_diamonds_to_balance/
    );
    expect(watch).toContain('c_concentration_pct constant numeric := 60');
    expect(watch).toContain('c_ratio_max constant numeric := 20');
    expect(watch).toContain('Measured 2026-09-08');
  });
  it('retention never removes anything unresolved or owed, and has a floor', () => {
    const prune = nets.slice(
      nets.indexOf('FUNCTION public.fn_ca_diamond_prune_history'),
      nets.indexOf('REVOKE ALL ON FUNCTION public.fn_ca_diamond_prune_history')
    );
    expect(prune).toContain('resolved_at IS NOT NULL');
    expect(prune).toContain("severity IN ('info', 'warning')");
    expect(prune).toContain('(claimed OR expired_at IS NOT NULL)');
    expect(prune).toContain('retention below the floor');
    expect(nets).toContain('retention accepted a value below its floor');
  });
  it('the reachability report names all three shapes of unreachable money', () => {
    expect(nets).toContain("'no_caller_and_no_client_grant'");
    expect(nets).toContain("'client_reachable_but_guard_refuses'");
    expect(nets).toContain("'rule_with_no_consumer'");
    expect(nets).toContain('unreachable money paths remain');
  });
  it('the first thing the detector found was removed in the same migration', () => {
    expect(nets).toContain('DROP FUNCTION IF EXISTS public.fn_add_diamonds(uuid, integer);');
    expect(nets).toContain('a free credit path with no caller is still callable');
  });
});
