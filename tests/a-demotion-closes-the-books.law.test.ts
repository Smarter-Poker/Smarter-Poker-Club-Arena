/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A DEMOTION CLOSES THE BOOKS (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 4 of 7 of the agent credit and promotion lifecycle work.
 *
 * fn_club_set_member_role demoted an agent by setting their agents row to
 * 'suspended' and asking nothing about what the row was holding. Measured on
 * production before the fix: 111 active agents, 67 of them holding float,
 * 6,726,000 chips between them.
 *
 * WHY THAT STRANDS CHIPS. Every role except 'player' may hold an agent wallet -
 * Dan, 2026-08-31: "OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS." A
 * move to co-owner, admin or another agent tier strands nothing; the wallet
 * goes with them. Becoming a PLAYER is the one move that takes it away:
 * fn_club_bank_role then answers 'player', and both fn_agent_wallet_send and
 * fn_agent_wallet_claim_back refuse that role outright. Whatever the row held
 * becomes chips nobody can move, in a pool fn_club_chip_circulation does not
 * even count.
 *
 * The second half was the mirror image: the row was suspended on ANY move out
 * of the agent tiers, including a PROMOTION to co-owner or admin - contradicting
 * the rule that staff hold agent wallets.
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

const MIGRATION = read('supabase/migrations/20260901000008_a_demotion_closes_the_books.sql');
const SQL = codeOnly(MIGRATION);

/**
 * The follow-up. Probing the migration above rather than trusting it found that
 * it missed the very people phase 2 gave wallets to, and that the demotion it
 * did allow RAISED in production. 20260901000009 supersedes its guard, so the
 * pins for the corrected behaviour read that file.
 */
const FOLLOWUP = read(
  'supabase/migrations/20260901000009_a_staff_demotion_neither_strands_nor_raises.sql'
);
const FOLLOWUP_SQL = codeOnly(FOLLOWUP);

describe('a demotion that would strand money is refused', () => {
  it('refuses only when the member can no longer hold a wallet', () => {
    expect(SQL).toMatch(/v_keeps_wallet := p_role <> 'player'/);
    expect(SQL).toMatch(
      /IF NOT v_keeps_wallet AND v_old_role IN \('super_agent','agent','sub_agent'\) THEN/
    );
  });

  it('reads the float and the debt before anything is written', () => {
    const check = SQL.indexOf('v_keeps_wallet := ');
    const write = SQL.indexOf("set_config('app.club_role_change', 'on'");
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(check);
  });

  it('answers needs_settlement so a client can act on it, not parse prose', () => {
    expect(SQL).toMatch(/'needs_settlement', true/);
    expect(SQL).toMatch(/'agent_wallet_balance', COALESCE\(v_float, 0\)/);
    expect(SQL).toMatch(/'credit_used', COALESCE\(v_owed, 0\)/);
  });

  /**
   * No new settle path was invented: fn_club_bank_claim_back already pulls a
   * float back into the club bank, keyed on an op_id and written to the ledger.
   * The refusal has to name a remedy that exists, or it is just a wall.
   */
  it('names the remedy that already exists', () => {
    expect(MIGRATION).toMatch(/fn_club_bank_claim_back/);
    expect(SQL).toMatch(/Claim the chips back into the club bank/);
    expect(SQL).toMatch(/Settle the invoice first/);
  });

  /** "holds 5,000 chips and owes 0.00" sends somebody hunting a debt that is not there. */
  it('names only what is actually outstanding', () => {
    expect(SQL).toMatch(/CASE WHEN COALESCE\(v_float, 0\) > 0 AND COALESCE\(v_owed, 0\) > 0/);
    expect(SQL).toMatch(/WHEN COALESCE\(v_float, 0\) > 0/);
  });
});

describe('a move that keeps the wallet is not blocked', () => {
  it('suspends the agents row only when the member becomes a player', () => {
    expect(SQL).toMatch(
      /status = CASE WHEN v_old_role IN \('super_agent','agent','sub_agent'\)\s*\n\s*AND p_role = 'player'\s*\n\s*THEN 'suspended' ELSE status END/
    );
  });
});

describe('what the club owes the agent does not block the club', () => {
  /**
   * pending_commission is money the CLUB owes the AGENT. The agents row survives
   * a demotion with the figure intact, and there is no payout path to send
   * anyone to yet - phase 6 builds one. Blocking would strand the club behind
   * its own unpaid obligation with no way out. The phase 4 plan said to refuse
   * on all three; this is a deliberate, documented departure.
   */
  it('reports pending_commission rather than refusing on it', () => {
    expect(SQL).toMatch(/'pending_commission', COALESCE\(v_commission, 0\)/);
    const refusal = SQL.slice(
      SQL.indexOf("'needs_settlement', true"),
      SQL.indexOf("'needs_settlement', true") + 1400
    );
    expect(refusal).not.toMatch(/v_commission\s*>\s*0/);
  });
});

describe('the guard covers everyone who can hold a wallet', () => {
  /**
   * 20260901000008 checked the OLD role against the three agent tiers, which
   * missed a co-owner or an admin - and phase 2 exists precisely because those
   * two hold agent wallets. Demoting one straight to player sailed past the
   * guard with the float still in the row.
   */
  it('refuses for any role that is not already a player', () => {
    expect(FOLLOWUP_SQL).toMatch(/IF NOT v_keeps_wallet AND v_old_role <> 'player' THEN/);
  });

  it('suspends the agents row for anyone who becomes a player, staff included', () => {
    expect(FOLLOWUP_SQL).toMatch(
      /status = CASE WHEN p_role = 'player' AND v_old_role <> 'player'\s*\n\s*THEN 'suspended' ELSE status END/
    );
  });

  /**
   * And that demotion RAISED. trg_agents_commission_bounds is BEFORE UPDATE OF
   * commission_rate, which Postgres fires whenever the SET list NAMES the
   * column - identical value or not. So an unrelated write re-validated a rate
   * nobody changed against a union band the row may never have satisfied, and
   * threw P0001 at a caller with no idea why. A band judges a rate being SET.
   */
  it('the union band no longer re-judges a rate that is not changing', () => {
    expect(FOLLOWUP_SQL).toMatch(
      /IF TG_OP = 'UPDATE' AND NEW\.commission_rate IS NOT DISTINCT FROM OLD\.commission_rate THEN\s*\n\s*RETURN NEW;/
    );
  });

  it('but still refuses a rate somebody is actually setting out of band', () => {
    expect(FOLLOWUP_SQL).toMatch(/IF v_rate < v_min OR v_rate > v_max THEN/);
    expect(FOLLOWUP_SQL).toMatch(/is outside the union policy band/);
  });

  it('asserts both fixes, so a bad apply aborts itself', () => {
    expect(FOLLOWUP).toMatch(/still misses staff who hold an agent wallet/);
    expect(FOLLOWUP).toMatch(/still re-judges a rate that is not changing/);
    expect(FOLLOWUP).toMatch(/^-- ROLLBACK$/m);
  });
});

describe('the migration is safe to apply', () => {
  it('keeps the signature, so no DROP and no ACL reset', () => {
    expect(SQL).not.toMatch(/DROP FUNCTION/i);
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_club_set_member_role\(/);
  });

  it('touches no table', () => {
    expect(SQL).not.toMatch(/ALTER TABLE/i);
    expect(SQL).not.toMatch(/ADD COLUMN/i);
  });

  /** 20260901000002's DROP reset this ACL once already. */
  it('asserts the grants it depends on', () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'anon can execute fn_club_set_member_role'/);
    expect(MIGRATION).toMatch(/no longer has exactly one signature/);
  });

  it('carries a rollback', () => {
    expect(MIGRATION).toMatch(/^-- ROLLBACK$/m);
  });
});
