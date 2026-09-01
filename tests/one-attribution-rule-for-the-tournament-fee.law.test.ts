/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE ATTRIBUTION RULE FOR ca_club_tournament_daily.fee (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The column had two writers -- trg_ca_reporting_rake_insert and
 * ca_refresh_reporting_rollups_base -- and each of them carried its own copy of
 * the same two-way fork on `metadata ? 'user_id'`. Nothing anywhere stated what
 * the rule was, so nobody could tell the deliberate multi-union attribution
 * (+140,206.19 chips over raw rake, a factor of 1.603, and correct) from real
 * drift (144 of 108,507 club/tournament/day rows, +193.21 chips, and not
 * correct). Both writers also ended in `EXCEPTION WHEN OTHERS THEN RAISE
 * WARNING`, and rake_records is append-only, so a fee that failed to roll up
 * was gone permanently and silently.
 *
 * The rule now lives once, in ca_reporting_tournament_fee_split, and both
 * writers call it. These pins exist so it cannot quietly become two again.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MIGRATION = read(
  'supabase/migrations/20260901090300_one_attribution_rule_for_the_tournament_fee.sql'
);
const SQL = codeOnly(MIGRATION);

/** The body of one CREATE OR REPLACE FUNCTION, so a pin cannot match a
 *  neighbouring function that happens to contain the same words. */
function bodyOf(name: string): string {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} is not declared in the migration`).toBeGreaterThan(-1);
  const rest = SQL.slice(start + 1);
  const next = rest.indexOf('CREATE OR REPLACE FUNCTION');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the rule exists once and is named', () => {
  it('is a function, not a comment', () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.ca_reporting_tournament_fee_split\(/);
  });

  it('attributes a payer fee through the member mapping, in full, per club', () => {
    const split = bodyOf('ca_reporting_tournament_fee_split');
    expect(split).toMatch(
      /SELECT c\.club_id, p_rake_amount\s*\n\s*FROM public\.ca_reporting_tournament_clubs_for_user\(p_user_id\) c/
    );
    expect(split).toMatch(/WHERE p_user_id IS NOT NULL/);
  });

  /**
   * A spin_rake row is ONE row for the WHOLE FIELD. Splitting it equally among
   * entrants and then applying the member rule is, per club,
   * rake * club_players / total_players -- because SUM(club_players) over clubs
   * IS SUM(clubs) over entrants. This is the arithmetic that makes the two old
   * branches one rule rather than two.
   */
  it('splits a field-wide fee across entrants before applying the same rule', () => {
    const split = bodyOf('ca_reporting_tournament_fee_split');
    expect(split).toMatch(/p_rake_amount \* ec\.club_players \/ NULLIF\(t\.total_players, 0\)/);
    expect(split).toMatch(/WHERE p_user_id IS NULL/);
  });

  it('carries the rule in a COMMENT so it is discoverable from the database', () => {
    expect(MIGRATION).toMatch(
      /COMMENT ON FUNCTION public\.ca_reporting_tournament_fee_split\(uuid, numeric, uuid\)/
    );
  });
});

describe('both writers call the one rule', () => {
  it('the insert trigger derives every club and fee from it', () => {
    const trg = bodyOf('trg_ca_reporting_rake_insert');
    expect(trg).toMatch(/FROM public\.ca_reporting_tournament_fee_split\(/);
  });

  it('the rebuild derives every club and fee from it', () => {
    const rebuild = bodyOf('ca_refresh_reporting_rollups_base');
    expect(rebuild).toMatch(/CROSS JOIN LATERAL public\.ca_reporting_tournament_fee_split\(/);
  });

  /**
   * The fork is the defect. Neither writer may re-derive the attribution for
   * itself -- that is how one rule became two copies in the first place.
   */
  it('neither writer keeps a private copy of the fork', () => {
    for (const name of ['trg_ca_reporting_rake_insert', 'ca_refresh_reporting_rollups_base']) {
      const body = bodyOf(name);
      expect(body, name).not.toMatch(/CASE WHEN r\.metadata \? 'user_id' THEN/);
      expect(body, name).not.toMatch(/IF NEW\.metadata \? 'user_id' THEN\s*\n\s*FOR r IN/);
      expect(body, name).not.toMatch(/club_players\s*\/\s*NULLIF\(\s*(r\.)?total_players/);
    }
  });

  it('the rebuild keeps the winnings half and the range guard it already had', () => {
    const rebuild = bodyOf('ca_refresh_reporting_rollups_base');
    expect(rebuild).toMatch(/reporting refresh requires a 0-400 day range/);
    expect(rebuild).toMatch(/pg_advisory_xact_lock\(918273645\)/);
    expect(rebuild).toMatch(/INSERT INTO public\.ca_club_tournament_player_daily/);
    expect(rebuild).toMatch(/INSERT INTO public\.ca_club_player_daily/);
  });
});

describe('a lost fee is filed, not warned about', () => {
  it('the insert trigger no longer answers a failure with RAISE WARNING', () => {
    const trg = bodyOf('trg_ca_reporting_rake_insert');
    expect(trg).not.toMatch(/RAISE WARNING/);
    expect(trg).toMatch(/PERFORM public\.fn_file_reporting_fee_finding\(/);
  });

  it('says so when a fee resolves to no club at all', () => {
    const trg = bodyOf('trg_ca_reporting_rake_insert');
    expect(trg).toMatch(/IF v_rows = 0 THEN/);
    expect(trg).toMatch(/'unattributable_fee'/);
  });

  /**
   * A payer whose id cannot be parsed must not fall through to the field-wide
   * branch: that would spread one player's fee across everyone at the event.
   */
  it('refuses to demote an unparseable payer to the field-wide branch', () => {
    const trg = bodyOf('trg_ca_reporting_rake_insert');
    expect(trg).toMatch(/'unparseable_payer'/);
  });

  it('the filer cannot itself take down the rake write', () => {
    const filer = bodyOf('fn_file_reporting_fee_finding');
    expect(filer).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE WARNING/);
    expect(filer).toMatch(/l\.run_ts > now\(\) - interval '1 hour'/);
  });
});

describe('the parity alarm compares the rollup to the rule', () => {
  /**
   * NOT to raw rake_records. That comparison shows the deliberate 1.603
   * multi-union factor on every club every day, and an alarm that fires on
   * correct behaviour is an alarm everybody learns to ignore.
   */
  it('recomputes through the rule rather than summing rake_records', () => {
    const v = bodyOf('fn_club_tournament_fee_parity_violations');
    expect(v).toMatch(/CROSS JOIN LATERAL public\.ca_reporting_tournament_fee_split\(/);
    expect(v).toMatch(/FULL OUTER JOIN stored/);
  });

  it('reports both directions and names the repair', () => {
    expect(SQL).toMatch(/'rollup_overstates'/);
    expect(SQL).toMatch(/'rollup_understates'/);
    expect(SQL).toMatch(/repair with ca_refresh_reporting_rollups on that day/);
  });

  it('uses a severity the log accepts', () => {
    const severities = [...SQL.matchAll(/'(warning|warn|critical|ok)'/g)].map((m) => m[1]);
    expect(severities).not.toContain('warning');
    expect(severities).toContain('warn');
    expect(severities).toContain('critical');
  });

  it('is not reachable from a browser', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_club_tournament_fee_parity_check\(integer\)\s+FROM PUBLIC, anon, authenticated;/
    );
  });

  it('is scheduled, and a repaired day stops reappearing on its own', () => {
    expect(SQL).toMatch(/cron\.schedule\('club-tournament-fee-parity-daily', '25 3 \* \* \*'/);
    expect(SQL).toMatch(/l\.metadata->>'parity_key' = v\.club_id::text/);
    expect(SQL).toMatch(/l\.metadata->>'drift' = v\.drift::text/);
  });
});

describe('nothing here moves a chip', () => {
  /**
   * The rule written down is the rule both branches already computed, so
   * applying the migration changes no stored row. The 144 drifted rows are
   * repaired by a rebuild that this migration proposes and does not run.
   */
  it('does not backfill, delete or rebuild anything itself', () => {
    expect(SQL).not.toMatch(/SELECT public\.ca_refresh_reporting_rollups\(/);
    expect(SQL).not.toMatch(/UPDATE public\.ca_club_tournament_daily/);
    expect(SQL).not.toMatch(/DELETE FROM public\.ca_club_tournament_daily WHERE stat_date >=/);
  });
});
