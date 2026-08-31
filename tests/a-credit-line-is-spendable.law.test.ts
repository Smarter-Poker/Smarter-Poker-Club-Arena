/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A CREDIT LINE IS SPENDABLE, AND STAFF HOLD AGENT WALLETS (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 of 7 of the agent credit and promotion lifecycle work.
 *
 * Dan, verbatim: "WHEN A AGENT IS PROMOTED ... THEY ALSO NEED TO BE ASSIGNED
 * 'PRE PAID' OR CREDIT LINE, (AND IF SO, THEN HOW MUCH) AND BALANCES BE TRACKED
 * AND PAYABLE ACCORDINGLY... OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT
 * WALLETS, THAT WAS A MISTAKE. CHIPS MUST FLOW FROM THE MAIN BANK TO THE AGENT
 * WALLET TO SEND OUT TO AGENTS AND PLAYERS."
 *
 * And on what the limit means: "NO, IF THEY GO BELOW THE CREDIT LIMIT, THEY MUST
 * 'SQUARE UP' OR PRE PAY FOR CHIPS FOR THE REST OF THE WEEK."
 *
 * Every pin below is a defect that was live in production before this migration,
 * each one proved against the real database inside a transaction that was rolled
 * back (CLAUDE.md section 11.5):
 *
 *   1. agents.credit_used was 0.00 across the whole estate and always had been.
 *      111 active agents held 7,674,633 chips of line that could not be drawn,
 *      because fn_agent_wallet_send_core_20260830 refused outright when the
 *      wallet was short and had never heard of credit_used or is_prepaid.
 *   2. A claim back returned the chips and left the debt, so an agent who sent
 *      on credit and undid it held both.
 *   3. fn_club_set_member_role hardcoded credit_limit 0 and never touched
 *      is_prepaid, so every promoted agent landed on the one combination that
 *      can send nothing at all. Three agents were in that state.
 *   4. fn_create_agent refused to mint an agent wallet for an owner or a
 *      co-owner. That is the refusal Dan called a mistake, by name.
 *   5. And the reason removing it was not enough on its own: two triggers on
 *      public.agents contradicted each other. trg_agents_commission_bounds
 *      raises when a rate is outside the union policy band, and fires BEFORE
 *      trg_agents_staff_earn_no_rakeback sets a staff rate to zero. In a club
 *      under a union with a non-zero minimum, promoting anyone who held an
 *      agents row to co_owner FAILED OUTRIGHT.
 *
 * These are source-text pins, deliberately. The behaviour spans a browser, an
 * RPC and two triggers, and a unit test cannot run all four; what it CAN do is
 * refuse to let the wiring quietly go back to what it was. Each pin is anchored
 * on the smallest durable thing - an RPC name, an argument name, a column - and
 * never on phrasing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * A "must not appear" pin has to look at CODE, not at prose. This migration and
 * these components carry long comments naming the bugs they used to have, and a
 * naive pin matches its own explanation. Borrowed from
 * promotion-assigns-the-rate.law.test.ts, which learned it the hard way.
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MIGRATION_PATH =
  'supabase/migrations/20260901000002_a_credit_line_is_spendable_and_staff_hold_agent_wallets.sql';

const MIGRATION = read(MIGRATION_PATH);
const SQL = codeOnly(MIGRATION);
const PANEL_MIGRATION = codeOnly(
  read('supabase/migrations/20260901000003_the_agent_panel_cannot_strand_an_agent.sql')
);
const MEMBER_MANAGEMENT = read('src/pages/MemberManagementPage.tsx');
const MEMBER_MANAGEMENT_CODE = codeOnly(MEMBER_MANAGEMENT);
const MEMBERSHIP_SERVICE = read('src/services/MembershipService.ts');
const MEMBER_CSS = read('src/pages/MemberManagementPage.css');

describe('the promotion assigns the funding', () => {
  it('fn_club_set_member_role takes a prepaid flag and a credit limit', () => {
    expect(SQL).toMatch(/p_is_prepaid\s+boolean\s+DEFAULT NULL/i);
    expect(SQL).toMatch(/p_credit_limit\s+numeric\s+DEFAULT NULL/i);
  });

  it('drops the 6-argument overload, because two signatures make the RPC ambiguous', () => {
    expect(SQL).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_club_set_member_role\(uuid, uuid, text, uuid, numeric, numeric\)/i
    );
  });

  it('re-grants EXECUTE, because a DROP takes the grant with it', () => {
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_club_set_member_role\([^)]*boolean, numeric\)[\s\S]{0,60}authenticated/i
    );
  });

  /**
   * A DROP takes the ACL with it and CREATE restores the PUBLIC default, so a
   * grant to two roles is not the same as closing the function. The estate's
   * autorevoke trigger does not fire on drop-and-create. Caught by the Supabase
   * security advisor during the phase 2 audit pass.
   */
  it('revokes PUBLIC and anon that the DROP handed back', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_club_set_member_role\([^)]*boolean, numeric\)\s*\n?\s*FROM PUBLIC, anon/
    );
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'anon can still execute fn_club_set_member_role/);
  });

  it('refuses an agent role that arrives with no funding choice', () => {
    expect(SQL).toMatch(/needs_funding/);
  });

  it('refuses the pair that can send nothing: not prepaid, and no line', () => {
    expect(SQL).toMatch(/a credit line must be greater than 0/i);
  });

  it('refuses a prepaid agent who also carries a line', () => {
    expect(SQL).toMatch(/a prepaid agent carries no credit line/i);
  });

  it('caps a credit limit at the upline limit, as it already caps the rates', () => {
    expect(SQL).toMatch(/credit limit cannot exceed the upline limit/i);
  });

  /**
   * Dan's ruling on re-promotion, 2026-08-31: FORCE A FRESH CHOICE. A demoted
   * agent's row still holds the deal they had before; re-promoting must not
   * restore a commercial term nobody has re-agreed.
   */
  it('does not inherit a demoted agent’s old deal on re-promotion', () => {
    expect(SQL).toMatch(/v_fresh\s*:=\s*v_old_role NOT IN \('super_agent','agent','sub_agent'\)/);
    expect(SQL).toMatch(/IF v_fresh THEN[\s\S]{0,400}v_prepaid\s*:=\s*p_is_prepaid/);
  });
});

describe('the credit line is spendable', () => {
  it('the send draws the shortfall against the line', () => {
    expect(SQL).toMatch(/credit_used\s*=\s*coalesce\(credit_used, 0\) \+ v_shortfall/i);
  });

  it('the wallet pays what it can, so it lands on zero and never goes negative', () => {
    expect(SQL).toMatch(
      /agent_wallet_balance = coalesce\(agent_wallet_balance, 0\) - \(p_amount - v_shortfall\)/i
    );
  });

  it('a prepaid agent is still refused when short', () => {
    expect(SQL).toMatch(/if v_is_prepaid or v_credit_limit <= 0 then/i);
  });

  it('the limit caps the debt outstanding, not the amount ever borrowed', () => {
    expect(SQL).toMatch(/v_headroom\s*:=\s*v_credit_limit - v_credit_used/i);
  });

  it('says what to do when the line is exhausted, in Dan’s own words', () => {
    expect(SQL).toMatch(/Square Up Your Invoice/);
  });

  it('records what was borrowed, so the claim back can repay it', () => {
    expect(SQL).toMatch(/'credit_drawn', v_shortfall/);
    expect(SQL).toMatch(/'credit_repaid', 0/);
  });

  /**
   * A caller cannot tell a retry from a first attempt, so the two must not
   * answer differently. Three replay branches exist: the core's early read, the
   * core's unique_violation handler, and the outer wrapper, which answers from
   * the ledger row and never reaches the core at all.
   */
  it('answers a replayed send with the credit fields too, in all three branches', () => {
    const branches = SQL.match(/'credit_drawn', coalesce\(\(v_prior\.metadata/g) ?? [];
    expect(branches.length).toBeGreaterThanOrEqual(2);
    expect(SQL).toMatch(
      /'credit_drawn',coalesce\(\(v_prior\.metadata->>'credit_drawn'\)::numeric,0\)/
    );
  });
});

describe('claiming chips back pays the borrowing back', () => {
  it('repays credit_used rather than handing back float alone', () => {
    expect(SQL).toMatch(/credit_used\s*=\s*greatest\(coalesce\(credit_used, 0\) - v_repay, 0\)/i);
  });

  it('repays in proportion to the fraction claimed', () => {
    expect(SQL).toMatch(/trunc\(v_drawn \* v_take \/ v_src\.amount, 2\)/);
  });

  it('the final claim clears the remainder, so truncation strands no debt', () => {
    expect(SQL).toMatch(
      /if v_complete then[\s\S]{0,120}v_repay\s*:=\s*greatest\(v_drawn - v_repaid, 0\)/i
    );
  });

  it('never repays a debt that has already been settled another way', () => {
    expect(SQL).toMatch(/v_repay\s*:=\s*greatest\(least\(v_repay, v_my_used\), 0\)/i);
  });

  it('every chip returns: what is not repaying a debt becomes float', () => {
    expect(SQL).toMatch(
      /agent_wallet_balance = coalesce\(agent_wallet_balance, 0\) \+ \(v_take - v_repay\)/i
    );
  });
});

describe('staff hold agent wallets', () => {
  it('fn_create_agent no longer refuses a staff member outright', () => {
    const createAgent = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_create_agent'));
    expect(createAgent).not.toMatch(
      /earns no rakeback\. Change their role on the members screen first/
    );
  });

  it('minting a staff wallet does not rewrite their club role', () => {
    expect(SQL).toMatch(/IF NOT v_is_staff AND v_membership_user IS NOT NULL/);
  });

  it('a co-owner and an admin are minted at a rate of zero, an owner is not', () => {
    expect(SQL).toMatch(/IF v_member_role IN \('co_owner','admin'\) THEN[\s\S]{0,80}v_comm := 0/);
  });

  /**
   * Dan, B-02, 2026-08-31: owners keep earning. The refusal used to name
   * 'owner', which no other rule does - trg_agents_staff_earn_no_rakeback covers
   * co_owner and admin only, and one live owner already holds an active agents
   * row at 0.30 / 0.20 that this branch would have refused to edit.
   */
  it('fn_admin_update_agent no longer bars an owner from earning', () => {
    expect(SQL).not.toMatch(
      /v_member_role IN \('owner','co_owner','admin'\)\s*\n\s*AND \(COALESCE\(p_commission_rate/
    );
    expect(SQL).toMatch(
      /v_member_role IN \('co_owner','admin'\)\s*\n\s*AND \(COALESCE\(p_commission_rate/
    );
  });

  /**
   * The collision that made the whole thing impossible. Proved on production,
   * rolled back: "agent commission 0.0000 is outside the union policy band
   * (0.20 .. 0.70)" on both an update and an insert.
   */
  it('the union commission band stands aside for a staff rate of zero', () => {
    expect(SQL).toMatch(
      /IF NEW\.commission_rate = 0 AND EXISTS \([\s\S]{0,220}cm\.role IN \('co_owner', 'admin'\)/
    );
  });

  /**
   * A SECURITY DEFINER writer a browser can reach, that never asks who is
   * calling, is a writer with no caller. fn_ensure_agent_row takes no actor by
   * design - the cashier has already decided - so the answer is to close it
   * rather than to add a check. PUBLIC is named as well as the roles, because
   * revoking one role while PUBLIC still holds it reads as a fix and does not
   * work. Caught by scripts/ci/check-definer-authorization at pre-push.
   */
  it('closes fn_ensure_agent_row to the browser roles', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ensure_agent_row\(uuid, uuid, text\)\s*\n?\s*FROM PUBLIC, anon, authenticated/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_ensure_agent_row\(uuid, uuid, text\)\s*\n?\s*TO service_role/
    );
  });

  it('a minted wallet arrives prepaid with no line, so it cannot borrow by accident', () => {
    const ensure = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.fn_ensure_agent_row'));
    expect(ensure).toMatch(/credit_limit, credit_used, is_prepaid/);
    expect(ensure).toMatch(/v_min := case when v_staff then 0/i);
  });
});

/**
 * Found by auditing every caller of the functions phase 2 changed, and proved
 * against production inside a rolled-back transaction. Two of these are the
 * agent panel's, one of them introduced by 20260901000002 itself.
 */
describe('the agent panel cannot strand an agent', () => {
  it('granting a limit moves a prepaid agent to credit instead of dead-ending', () => {
    expect(PANEL_MIGRATION).toMatch(
      /IF p_is_prepaid IS NULL AND COALESCE\(p_credit_limit, 0\) > 0 THEN\s*\n\s*v_prepaid_after := false/
    );
  });

  it('refuses the pair that can send nothing', () => {
    expect(PANEL_MIGRATION).toMatch(/an agent on credit needs a limit greater than 0/);
  });

  it('refuses to move an agent to prepaid while a debt still stands', () => {
    expect(PANEL_MIGRATION).toMatch(/IF v_prepaid_after AND v_used_now > 0 THEN/);
  });

  it('refuses a limit below what has already been drawn, instead of a raw 23514', () => {
    expect(PANEL_MIGRATION).toMatch(/IF NOT v_prepaid_after AND v_limit_after < v_used_now THEN/);
  });

  it('still refuses a stated contradiction', () => {
    expect(PANEL_MIGRATION).toMatch(
      /a prepaid agent carries no credit line\. Send prepaid on its own/
    );
  });

  /**
   * The regression hiding inside the fix. One active agent is already in the
   * send-nothing state; validating the funding pair on every call would have
   * made them impossible to suspend, reinstate or re-grade.
   */
  it('validates funding ONLY on a call that touches funding', () => {
    expect(PANEL_MIGRATION).toMatch(
      /v_touches_funding := \(p_is_prepaid IS NOT NULL OR p_credit_limit IS NOT NULL\)/
    );
    expect(PANEL_MIGRATION).toMatch(/IF v_touches_funding THEN/);
    expect(PANEL_MIGRATION).toMatch(
      /is_prepaid = CASE WHEN v_touches_funding THEN v_prepaid_after ELSE is_prepaid END/
    );
  });

  it('forwards the resolved pair to the one write path, not the raw arguments', () => {
    expect(PANEL_MIGRATION).toMatch(
      /CASE WHEN v_touches_funding THEN v_prepaid_after ELSE NULL END/
    );
  });

  it('alters no table and adds no column either', () => {
    expect(PANEL_MIGRATION).not.toMatch(/ALTER TABLE/i);
    expect(PANEL_MIGRATION).not.toMatch(/ADD COLUMN/i);
  });
});

describe('the migration is safe to apply', () => {
  /**
   * club_members is realtime published and DDL on it deadlocks against
   * realtime.subscription; this programme hit that twice on 2026-08-27. Every
   * new fact here travels in chip_transactions.metadata, which is already jsonb,
   * so no table is altered and no lock is taken. A future edit that adds a
   * column here must also add it to supabase-columns-manifest.json or CI CHECK
   * 17 fails, which is the other half of why this pin exists.
   */
  it('alters no table and adds no column', () => {
    expect(SQL).not.toMatch(/ALTER TABLE/i);
    expect(SQL).not.toMatch(/ADD COLUMN/i);
  });

  it('asserts its own assumptions, so a wrong apply aborts itself', () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'fn_club_set_member_role has % signatures/);
    expect(MIGRATION).toMatch(
      /RAISE EXCEPTION 'the promote screen cannot call fn_club_set_member_role/
    );
  });

  it('carries the rollback the DROP obliges', () => {
    expect(MIGRATION).toMatch(/^-- ROLLBACK$/m);
  });
});

describe('the promote screen collects the funding', () => {
  it('sends both new arguments', () => {
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/p_is_prepaid:\s*funding === 'prepaid'/);
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/p_credit_limit:\s*limit/);
  });

  it('offers prepaid and a credit line, and a limit only for the line', () => {
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/mm-roles__funding-option/);
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/funding === 'credit' && \(/);
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/Credit Limit In Chips/);
  });

  /**
   * Nothing pre-filled. A rate that arrives already in the box is a rate nobody
   * chose, which is the bug phase 0 removed from the rates; the funding arrived
   * in the same instruction and gets the same treatment.
   */
  it('pre-fills nothing, and clears itself when another role is picked', () => {
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/useState<'' \| 'prepaid' \| 'credit'>\(''\)/);
    expect(MEMBER_MANAGEMENT_CODE).toMatch(
      /const \[creditLimit, setCreditLimit\] = useState\(''\)/
    );
    expect(MEMBER_MANAGEMENT_CODE).toMatch(
      /setFunding\(''\);\s*\n\s*setCreditLimit\(''\);\s*\n\s*setConfirmRole\(role\)/
    );
  });

  it('refuses to submit without a funding choice, before the server has to', () => {
    expect(MEMBER_MANAGEMENT_CODE).toMatch(/Choose Prepaid Or A Credit Line\./);
  });

  it('keeps every touch target at 44px, mobile first', () => {
    expect(MEMBER_CSS).toMatch(/\.mm-roles__funding-option \{[\s\S]{0,200}min-height: 44px/);
  });

  /** CLAUDE.md section 5.7: popup and page copy is Title Case, em dashes forbidden. */
  it('adds no em dash to the copy', () => {
    const added = (
      MEMBER_MANAGEMENT.match(/^.*(Prepaid|Credit Line|Credit Limit).*$/gm) ?? []
    ).join('\n');
    expect(added).not.toMatch(/—/);
  });
});

describe('the service layer forwards it', () => {
  it('MembershipService.updateRole takes and forwards the funding', () => {
    expect(MEMBERSHIP_SERVICE).toMatch(/funding\?: \{ isPrepaid: boolean; creditLimit: number \}/);
    expect(codeOnly(MEMBERSHIP_SERVICE)).toMatch(/p_is_prepaid: funding\.isPrepaid/);
    expect(codeOnly(MEMBERSHIP_SERVICE)).toMatch(/p_credit_limit: funding\.creditLimit/);
  });

  it('still writes through the one door', () => {
    expect(codeOnly(MEMBERSHIP_SERVICE)).toMatch(/supabase\.rpc\('fn_club_set_member_role'/);
    expect(codeOnly(MEMBERSHIP_SERVICE)).not.toMatch(
      /from\('club_members'\)\s*\n?\s*\.update\(\{ role/
    );
  });
});
