/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VIP POINTS ARE AWARDED ON THE RAKE, ON EVERY PATH (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_award_vip_points_from_rake forked on rake_method and only one fork awarded
 * a share of the rake. WEIGHTED_CONTRIBUTED went through
 * fn_allocate_rake_credits and got the player's slice of the RAKE; every other
 * value -- including DEALT_EQUAL, which is the default and 96% of all rake rows
 * -- iterated player_contributions and awarded `v::numeric`, the player's
 * CONTRIBUTION TO THE POT.
 *
 * Measured on production 2026-09-01: 1,544,385 DEALT_EQUAL rows against 56,401
 * WEIGHTED_CONTRIBUTED, and over the last nine days an awarded basis of
 * 32,615,366.54 where the rake basis was 973,765.11. Lifetime, 135,761,739
 * points to 589 players, of which a recompute on the correct basis leaves
 * 3,589,721.
 *
 * The second half of the defect was that the trigger ended every award in
 * `EXCEPTION WHEN others THEN CONTINUE`, so no VIP award has ever failed
 * visibly on this platform.
 *
 * These are source-text pins on the migration. The behaviour is a Postgres
 * trigger and a unit test cannot run it; what it CAN do is refuse to let the
 * fork, or the swallow, come back.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/** Strips comments, so a "must not appear" pin cannot match its own explanation. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MIGRATION = read('supabase/migrations/20260901090200_vip_points_are_awarded_on_the_rake.sql');
const SQL = codeOnly(MIGRATION);

const VOCAB = read(
  'supabase/migrations/20260901090000_the_reconcile_log_admits_a_vip_and_a_rollup_finding.sql'
);
const VOCAB_SQL = codeOnly(VOCAB);

describe('there is one basis and it is the rake', () => {
  it('allocates through the helper, passing the row own method', () => {
    expect(SQL).toMatch(
      /FROM public\.fn_allocate_rake_credits\(\s*NEW\.rake_amount,\s*NEW\.player_contributions,\s*v_method\s*\)/
    );
  });

  /**
   * The exact shape of the bug: a branch that reads player_contributions
   * itself and awards the value it finds there. If either of these comes back,
   * the pot is the basis again.
   */
  it('never iterates player_contributions to award a credit', () => {
    expect(SQL).not.toMatch(/jsonb_each_text\(NEW\.player_contributions\)/);
    expect(SQL).not.toMatch(/fn_award_vip_credit\(\s*uid\s*,\s*COALESCE\(v::numeric/);
  });

  it('does not branch the allocation on rake_method', () => {
    expect(SQL).not.toMatch(/IF NEW\.rake_method = 'WEIGHTED_CONTRIBUTED' THEN/);
  });

  /**
   * fn_allocate_rake_credits returns ZERO ROWS for a method it does not know,
   * so an unrecognised method must not simply be handed to it: that awards
   * nobody anything and looks exactly like a quiet game.
   */
  it('files an unknown method and falls back to the published default', () => {
    expect(SQL).toMatch(/NOT IN \('WEIGHTED_CONTRIBUTED', 'DEALT_EQUAL'\)/);
    expect(SQL).toMatch(/'unknown_rake_method'/);
    expect(SQL).toMatch(/v_method := 'WEIGHTED_CONTRIBUTED';/);
  });
});

describe('a failed award is filed, not swallowed', () => {
  it('the trigger no longer answers a failure with CONTINUE', () => {
    expect(SQL).not.toMatch(/EXCEPTION WHEN others THEN\s*\n\s*CONTINUE;/i);
    expect(SQL).not.toMatch(/WHEN OTHERS THEN\s+CONTINUE/i);
  });

  it('files the failure where the house alarms live', () => {
    expect(SQL).toMatch(
      /PERFORM public\.fn_file_vip_award_finding\(\s*\n?\s*NEW\.id, rec\.uid, 'award_failed', SQLERRM, rec\.credit\)/
    );
    expect(SQL).toMatch(/INSERT INTO public\.ledger_reconcile_log/);
    expect(SQL).toMatch(/'vip_award_failed'/);
  });

  /**
   * The trigger hangs off the rake write. It must stay non-fatal -- a VIP
   * point may not cost a club its rake row -- so the filer itself may never
   * raise.
   */
  it('the filer cannot itself take down the rake write', () => {
    const filer = SQL.slice(
      SQL.indexOf('FUNCTION public.fn_file_vip_award_finding'),
      SQL.indexOf('FUNCTION public.fn_award_vip_points_from_rake')
    );
    expect(filer).toMatch(/EXCEPTION WHEN OTHERS THEN\s*\n\s*RAISE WARNING/);
  });

  /**
   * If every award starts failing, per-contributor filing is tens of thousands
   * of rows and notification storms an hour. Loud, not deafening.
   */
  it('throttles to one finding per kind per hour', () => {
    expect(SQL).toMatch(/l\.run_ts > now\(\) - interval '1 hour'/);
    expect(SQL).toMatch(/IF v_recent > 0 THEN\s*\n\s*RETURN;/);
  });
});

describe('the alarm compares credit against rake', () => {
  it('groups by rake_method, because the defect was one method differing', () => {
    expect(SQL).toMatch(/FUNCTION public\.fn_vip_points_basis_violations/);
    expect(SQL).toMatch(/COALESCE\(rr\.rake_method, 'WEIGHTED_CONTRIBUTED'\) AS m/);
  });

  it('reports both directions: too much credit and too little', () => {
    expect(SQL).toMatch(/'credit_exceeds_rake'/);
    expect(SQL).toMatch(/'credit_below_rake'/);
    expect(SQL).toMatch(/j\.ratio > 1\.01/);
    expect(SQL).toMatch(/j\.ratio < 0\.99/);
  });

  /**
   * The severity vocabulary is ('ok','warn','critical'). 20260831141042 shipped
   * 'warning' and had to be corrected; this pin is that lesson.
   */
  it('uses a severity the log accepts', () => {
    const severities = [...SQL.matchAll(/'(warning|warn|critical|ok)'/g)].map((m) => m[1]);
    expect(severities).not.toContain('warning');
    expect(severities).toContain('critical');
  });

  it('is not reachable from a browser', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_vip_points_basis_check\(interval\)\s+FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_vip_points_basis_check\(interval\)\s+TO service_role;/
    );
  });

  it('is scheduled, on a window it cannot double-file', () => {
    expect(SQL).toMatch(/cron\.schedule\('vip-points-basis-6h', '15 \*\/6 \* \* \*'/);
    expect(SQL).toMatch(/l\.run_ts > now\(\) - p_window/);
  });
});

describe('the log admits the new findings before anything writes them', () => {
  it('widens the entity_type allowlist rather than dropping it', () => {
    expect(VOCAB_SQL).toMatch(/'vip_points_basis','vip_award_failed','club_tournament_fee_parity'/);
    expect(VOCAB_SQL).toMatch(/ADD CONSTRAINT ledger_reconcile_log_entity_type_check/);
    expect(VOCAB_SQL).not.toMatch(/DROP CONSTRAINT ledger_reconcile_log_entity_type_check;\s*$/);
  });

  it('keeps every kind the log already knew', () => {
    for (const kind of [
      'player_wallet',
      'club_treasury',
      'agent_wallet',
      'frozen_wallets_pool',
      'chip_circulation',
      'seat_stack_exit',
      'cashout_escrow_stuck',
      'negative_balance',
      'over_claimed_send',
      'insurance_bank',
      'insurance_offer_unresolved',
      'bomb_award_ledger_gap',
      'rake_law',
    ]) {
      expect(VOCAB_SQL).toContain(`'${kind}'`);
    }
  });

  it('classifies the new kinds instead of leaving them unknown', () => {
    expect(VOCAB_SQL).toMatch(/WHEN 'vip_points_basis'\s+THEN 'incorrect_rake'/);
    expect(VOCAB_SQL).toMatch(/WHEN 'vip_award_failed'\s+THEN 'missing_payment'/);
    expect(VOCAB_SQL).toMatch(/WHEN 'club_tournament_fee_parity' THEN 'reporting_mismatch'/);
  });
});
