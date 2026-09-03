/**
 * THE UNION SETS A RAKEBACK RATE PER GAME TYPE, AND R3 REFUSES.
 *
 * 2026-09-03, Dan (binding): "GO AHEAD AND DO THIS: the one thing they have
 * that we don't: per-game-type percentages (e.g. 90% on cash, 60% on MTTs)."
 * And: "THERE IS NOTHING THAT'S MY CALL... the R3 flip from log to refuse."
 *
 * Two rules, both landed the same hour.
 *
 * The rate: a member club's basis is now priced per game type, resolved
 * union_clubs.rate_<type> -> club_commission_rate -> 0.90, and truncated to the
 * cent per (club, game type) so a remainder stays with the union. Rolled-back
 * probes on the real last 24 hours: defaults paid 125,001.48 of a 140,600.03
 * period (unchanged behaviour); cash 90 / mtt 60 / sng 50 / spin 40 / satellite
 * 30 paid 96,919.58; a single club's cash rate at 50% moved only that club.
 * Conservation asserted by the function in all three.
 *
 * R3: the money-path guard on tournament-category wallet credits stops logging
 * and starts refusing. Zero violations in 25 hours against 18,017 in-scope
 * credits, every one of them through fn_settle_tournament_obligation. The mode
 * is a table row, so the way back is one UPDATE and not a deploy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
function read(fragment: string): string {
  const f = readdirSync(DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(DIR, f as string), 'utf8');
}
const RATES = read('the_union_sets_a_rakeback_rate_per_game_type');
const R3 = read('r3_goes_from_log_to_refuse');

function body(sql: string, name: string): string {
  const open = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(open, `${name} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('the union sets a rakeback rate per game type', () => {
  it('gives every game type its own nullable rate column, bounded to a fraction', () => {
    for (const col of ['rate_cash', 'rate_mtt', 'rate_sng', 'rate_spin', 'rate_satellite']) {
      expect(RATES).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      expect(RATES).toMatch(new RegExp(`${col}\\s+IS NULL OR`));
    }
    expect(RATES).toContain('union_clubs_game_rates_are_fractions');
  });

  it('reads the game type from the credit, cash when it names no tournament', () => {
    const b = body(RATES, 'fn_union_weekly_rakeback_close');
    expect(b).toContain("CASE WHEN r.tournament_id IS NULL THEN 'cash'");
    expect(b).toContain("COALESCE(lower(tr.tournament_type), 'other')");
    expect(b).toContain('LEFT JOIN tournaments tr ON tr.id = r.tournament_id');
  });

  it('resolves the rate per game type and falls back to the club rate then 0.90', () => {
    const b = body(RATES, 'fn_union_weekly_rakeback_close');
    expect(b).toMatch(/WHEN 'cash'\s+THEN uc\.rate_cash/);
    expect(b).toMatch(/WHEN 'mtt'\s+THEN uc\.rate_mtt/);
    expect(b).toMatch(/WHEN 'sng'\s+THEN uc\.rate_sng/);
    expect(b).toMatch(/WHEN 'spin'\s+THEN uc\.rate_spin/);
    expect(b).toMatch(/WHEN 'satellite' THEN uc\.rate_satellite/);
    expect(b).toContain('uc.club_commission_rate,\n           0.90) AS rate');
  });

  it('truncates the payout per club and game type so a remainder stays with the union', () => {
    const b = body(RATES, 'fn_union_weekly_rakeback_close');
    expect(b).toContain('trunc(round(b.rake_in, 2)');
    expect(b).toContain('GROUP BY club_id, game_type');
    expect(b).toContain('FROM _uwrb_by_type');
  });

  it('carries the whole close forward: one pot, op keys, the conservation assert', () => {
    const b = body(RATES, 'fn_union_weekly_rakeback_close');
    expect(b).toMatch(/rake_wallet\s*=\s*rake_wallet\s*-\s*v_period_total/);
    expect(b).toMatch(/chip_balance\s*=\s*chip_balance\s*\+\s*v_retained/);
    expect(b).toContain('conservation violation in the weekly union close');
    expect(b).toMatch(/'union_close:' \|\| v_sid::text \|\| ':' \|\| v_club\.club_id::text/);
    expect(b).toContain('FROM ca_union_rake_attribution a');
    expect(b).toContain('FROM tournament_players tp');
  });

  it('records the per-type basis and the rates it used on the settlement', () => {
    const b = body(RATES, 'fn_union_weekly_rakeback_close');
    expect(b).toContain("'rate_model', 'per_game_type'");
    expect(b).toContain("'basis_by_game_type'");
    expect(b).toContain("'rates'");
  });
});

describe('R3 refuses instead of logging', () => {
  it('keeps the mode in a table so the way back is one UPDATE', () => {
    expect(R3).toContain('CREATE TABLE IF NOT EXISTS public.ca_money_path_enforcement');
    expect(R3).toMatch(
      /mode\s+text\s+NOT NULL DEFAULT 'log' CHECK \(mode IN \('log', 'refuse'\)\)/
    );
    expect(R3).toContain("UPDATE public.ca_money_path_enforcement SET mode = ''log'';");
    expect(R3).toMatch(/VALUES \(true, 'refuse'/);
  });

  it('refuses in refuse mode, and a missing row never means stricter', () => {
    const b = body(R3, 'fn_ca_money_path_log');
    expect(b).toContain("IF v_mode = 'refuse' THEN");
    expect(b).toContain("v_mode := COALESCE(v_mode, 'log');");
    expect(b).toMatch(
      /RAISE EXCEPTION\s+'R3: a % credit of % was written outside fn_settle_tournament_obligation/
    );
  });

  it('still lets the one sanctioned payer through untouched', () => {
    const b = body(R3, 'fn_ca_money_path_log');
    expect(b).toContain("IF v_path = 'fn_settle_tournament_obligation' THEN");
    expect(b).toContain('RETURN NEW;');
  });

  it('is not a browser door and proves both directions before it commits', () => {
    expect(R3).toMatch(
      /REVOKE ALL ON TABLE public\.ca_money_path_enforcement FROM PUBLIC, anon, authenticated;/
    );
    expect(R3).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_money_path_log\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(R3).toContain(
      'R3_SELFCHECK: refuse mode did NOT refuse an unsanctioned tournament credit'
    );
    expect(R3).toContain('R3_SELFCHECK: the sanctioned path was refused');
  });
});
