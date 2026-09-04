/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE AGENT NETWORK'S CONTROLS REACH SOMETHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03, phase 3)
 *
 * Four controls across the agent pages could not do what their labels said,
 * and each failed for a different reason, so no single fix covers them:
 *
 *   Ban Player          `else if (type === 'ban') { toast.success(...) }` -
 *                       no write of any kind, the player id discarded.
 *   Clawback            dead three times over: a list filtered on three
 *                       transaction types that have ZERO rows estate-wide, a
 *                       claim step UPDATEing a table with no UPDATE policy,
 *                       and an RPC that is SECURITY INVOKER with no EXECUTE
 *                       for `authenticated`.
 *   Add Prepaid Balance called fn_admin_update_agent with is_prepaid true AND
 *                       a positive limit, the exact pair that function refuses
 *                       ("a prepaid agent carries no credit line"). It could
 *                       never succeed for any amount.
 *   Revoke Credit       a player-to-player wallet transfer through
 *                       wallet_user_transfer - also invoker, also ungranted -
 *                       which even if run would have left credit_limit and
 *                       credit_used untouched.
 *
 * And "Upcoming Agent Payouts" was weekly_rake_generated * commission_rate
 * with a hardcoded "Pending", understating what this club owes by roughly half
 * (36,657 printed against 65,790 owed on the day it was replaced).
 *
 * These cases pin the replacements from both ends: the migration that adds the
 * two functions the browser could not do without, and the client that must go
 * through the working paths rather than the dead ones.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sliceSqlStatement } from '../helpers/sourceWindow';

const MIGRATION = readFileSync(
  'supabase/migrations/20260903200000_an_agent_payout_is_a_record.sql',
  'utf8'
);
const INDEX_MIGRATION = readFileSync(
  'supabase/migrations/20260903210000_the_payables_read_is_index_only.sql',
  'utf8'
);
const NETWORK = readFileSync('src/pages/AgentManagementPage.tsx', 'utf8');
const DASHBOARD = readFileSync('src/pages/AgentDashboardPage.tsx', 'utf8');
const SUPER = readFileSync('src/pages/SuperAgentDashboard.tsx', 'utf8');
const AGENTS = readFileSync('src/services/AgentService.ts', 'utf8');
const CREDIT = readFileSync('src/services/CreditService.ts', 'utf8');
const INTEGRITY = readFileSync('src/services/IntegrityActionService.ts', 'utf8');

const NEW_FUNCTIONS = ['fn_ca_can_manage_agents', 'fn_ca_agent_payables', 'fn_ca_ban_club_player'];

describe('the two functions the browser cannot do without', () => {
  it.each(NEW_FUNCTIONS)('%s is definer and search-path pinned', (fn) => {
    expect(MIGRATION).toContain(`FUNCTION public.${fn}(`);
    const body = sliceSqlStatement(MIGRATION, `FUNCTION public.${fn}(`);
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public'");
  });

  it.each(NEW_FUNCTIONS)('%s is revoked from anon and granted to authenticated', (fn) => {
    expect(MIGRATION).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM anon`)
    );
    expect(MIGRATION).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO authenticated`)
    );
  });

  it('refuses a caller with no account, in the gate itself', () => {
    const gate = sliceSqlStatement(MIGRATION, 'FUNCTION public.fn_ca_can_manage_agents(');
    expect(gate).toContain('auth.uid() IS NOT NULL');
    expect(gate).not.toMatch(/auth\.uid\(\)\s+IS\s+NULL\s+OR/i);
    expect(gate).toContain("cm.role IN ('owner', 'co_owner', 'admin')");
  });

  it('gates both reads and the write through that one function', () => {
    for (const fn of ['fn_ca_agent_payables', 'fn_ca_ban_club_player']) {
      const body = sliceSqlStatement(MIGRATION, `FUNCTION public.${fn}(`);
      expect(body).toContain('IF NOT fn_ca_can_manage_agents(p_club_id) THEN');
      expect(body).toContain("ERRCODE = '42501'");
    }
  });

  it('sums the commission ledger rather than multiplying a rate by a weekly total', () => {
    const body = sliceSqlStatement(MIGRATION, 'FUNCTION public.fn_ca_agent_payables(');
    expect(body).toContain('FROM agent_commissions ac');
    expect(body).toContain('ac.settled_at IS NULL');
    expect(body).toContain("'rows_behind', r.rows_behind");
  });

  it('kept the old estimate beside the truth for one release, then took it down', () => {
    // The phase 3 migration file is history and still carries the estimate;
    // the live function and the page dropped it on 2026-09-04
    // (20260904200000), one release after phase 3 published.
    const body = sliceSqlStatement(MIGRATION, 'FUNCTION public.fn_ca_agent_payables(');
    expect(body).toContain('AS estimate');
    expect(NETWORK).not.toContain('The Previous Estimate');
    expect(NETWORK).not.toContain('total_estimate');
  });

  it('counts horses like every other player', () => {
    // CLAUDE.md 10.5. An agent's downline is their downline.
    expect(MIGRATION).not.toMatch(/is_horse/);
  });
});

describe('a ban is a write, and it is not a deletion', () => {
  const BAN = sliceSqlStatement(MIGRATION, 'FUNCTION public.fn_ca_ban_club_player(');

  it('writes the exclusion the buy-in path actually reads', () => {
    expect(BAN).toContain('INSERT INTO blacklists');
    expect(NETWORK).toContain("supabase.rpc('fn_ca_ban_club_player'");
    expect(NETWORK).not.toContain("=== 'ban') {\n      toast.success");
  });

  it('never deletes the membership row, because that row holds chips', () => {
    // club_members carries chip_balance, held_chips, locked_chips,
    // promo_balance and credit_used. The first draft of this function deleted
    // it; the probe that caught that picked a member holding 10,067.64 chips.
    expect(BAN).not.toContain('DELETE FROM club_members');
    expect(BAN).toContain("'chips_held'");
    expect(BAN).toContain("'credit_used'");
  });

  it('never closes a seat, and reports the ones that are open', () => {
    // CLAUDE.md 11.5: a seat closed outside a cash-out destroys the stack.
    expect(BAN).not.toContain('UPDATE table_seats');
    expect(BAN).toContain("'live_seats'");
    expect(NETWORK).toContain('adminRemovePlayerFromClubTables');
  });

  it('refuses the three people a club must not lose this way', () => {
    expect(BAN).toContain("'cannot_ban_the_owner'");
    expect(BAN).toContain("'cannot_ban_club_staff'");
    expect(BAN).toContain("'not_a_member_of_this_club'");
    for (const reason of [
      'cannot_ban_the_owner',
      'cannot_ban_club_staff',
      'not_a_member_of_this_club',
    ]) {
      expect(NETWORK).toContain(`${reason}:`);
    }
  });

  it('re-banning is the same ban rather than a second row', () => {
    expect(BAN).toContain("'was_already_excluded', v_re_ban");
  });
});

describe('the payables read is index-only', () => {
  it('carries the two columns the aggregate needs into the index', () => {
    expect(INDEX_MIGRATION).toContain('INCLUDE (amount, created_at)');
    expect(INDEX_MIGRATION).toContain('WHERE settled_at IS NULL');
  });

  it('drops the narrower index it supersedes rather than paying for both', () => {
    expect(INDEX_MIGRATION).toContain(
      'DROP INDEX IF EXISTS public.agent_commissions_unsettled_idx'
    );
  });
});

describe('the client stopped calling functions it may not execute', () => {
  it('undoes a send through the path the wallet cashier already uses', () => {
    expect(AGENTS).toContain("supabase.rpc('fn_agent_wallet_reversible'");
    expect(AGENTS).toContain("supabase.rpc('fn_agent_wallet_claim_back'");
    // The dead RPC and the method that called it are gone as CODE; both are
    // still named in the comment that records why, which is the point of it.
    expect(AGENTS).not.toContain("supabase.rpc('fn_clawback_chips_atomic'");
    expect(AGENTS).not.toContain('async clawbackDistribution(');
  });

  it('stops listing three transaction types that have no rows', () => {
    expect(AGENTS).not.toContain("['agent_to_player', 'promo_agent_to_player', 'send']");
    expect(AGENTS).not.toContain('CLAWBACK_WINDOW_MS =');
  });

  it('never stakes a claim by updating a table it cannot write', () => {
    expect(AGENTS).not.toContain('clawed_back: true');
    expect(AGENTS).not.toContain('clawed_back: false');
  });

  it('sends chips through the agent wallet, not a bare player transfer', () => {
    expect(DASHBOARD).toContain("supabase.rpc('fn_agent_wallet_send'");
    expect(DASHBOARD).not.toContain('await WalletService.transferToUser(');
  });

  it('reduces a credit line when it says it is reducing a credit line', () => {
    expect(CREDIT).toContain('async lowerCreditLine(');
    expect(CREDIT).toContain("supabase.rpc('fn_admin_update_agent'");
    expect(DASHBOARD).toContain('CreditService.lowerCreditLine');
  });

  it('funds a prepaid agent with chips rather than a limit it cannot hold', () => {
    expect(DASHBOARD).toContain("p_destination: 'agent_wallet'");
    expect(DASHBOARD).not.toContain("creditAction === 'add_prepaid'\n                        );");
  });

  it('says what each action does on the control itself', () => {
    expect(DASHBOARD).toContain('Set Credit Line To');
    expect(DASHBOARD).toContain('Send Prepaid Chips');
    expect(DASHBOARD).toContain('Reduce Credit Line By');
  });

  it('passes the note the operator typed instead of discarding it', () => {
    expect(CREDIT).toContain('p_credit_reason: reason ||');
    expect(DASHBOARD).toContain('p_reason: transferNotes.trim()');
  });
});

describe('the identifiers and the labels', () => {
  it('sends a transfer to the recipient user, not the agents primary key', () => {
    expect(NETWORK).toContain('setTransferAgentId(agent.userId)');
    expect(NETWORK).not.toContain('setTransferAgentId(agent.id)');
  });

  it('names all three roles rather than two', () => {
    for (const source of [NETWORK, SUPER]) {
      expect(source).toContain('AGENT_ROLE_LABELS');
      expect(source).toContain("super_agent: 'Super Agent'");
    }
    expect(NETWORK).not.toContain("agent.role === 'agent' ? 'Agent' : 'Sub-Agent'");
  });

  it('reads a downline the way every write path writes it', () => {
    // club_members.agent_id, not invited_by: 1,575 memberships carry the first
    // and 417 the second, so the two describe different people.
    expect(DASHBOARD).toContain('m.agent_id === user.id');
    expect(DASHBOARD).toContain("'user_id, role, chip_balance, status, created_at, agent_id");
  });

  it('scopes an agent player list to one club', () => {
    expect(AGENTS).toContain('async getAgentPlayers(agentId: string, clubId?: string)');
    expect(AGENTS).toContain(".eq('club_id', scopedClubId)");
    expect(SUPER).toContain('AgentService.getAgentPlayers(myAgent.id, clubId!)');
  });

  it('resolves the club before it reaches a uuid argument', () => {
    expect(AGENTS).toContain('const resolvedCreateClubId = await resolveClubUUID(input.clubId)');
    expect(AGENTS).toContain('p_club_id: resolvedCreateClubId');
    expect(DASHBOARD).toContain('const resolvedCreditClub = await resolveClubUUID(');
  });

  it('shares one seat lookup rather than two copies of the same three lines', () => {
    expect(INTEGRITY).toContain('export async function liveSeatTableIds(');
    expect(NETWORK).toContain('liveSeatTableIds');
  });
});
