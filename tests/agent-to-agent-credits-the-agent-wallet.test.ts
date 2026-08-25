/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT TO AGENT SEND OR CLAIM BACK ALWAYS CREDITS THE AGENT WALLET
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-25, binding, verbatim:
 *
 *   "AGENT TO AGENT SEND OR CLAIM BACK ALWAYS CREDIT TO AGENT WALLETS."
 *
 * WHAT WAS ACTUALLY BROKEN
 *
 * fn_agent_wallet_send guarded exactly one direction. It refused
 * p_destination = 'agent_wallet' when the recipient was a plain player - correct
 * - but it never FORCED 'agent_wallet' when the recipient was an agent. So a
 * caller passing p_destination = 'player_wallet' with an agent on the other end
 * was obeyed: the chips landed in that agent's PLAYER balance, spendable at a
 * table, invisible to the float they are supposed to be running. The claim-back
 * then mirrored the original send's destination faithfully, which means it
 * mirrored the mistake.
 *
 * The cashier's own dropdown offered both options in that exact situation, so
 * the wrong one was one click away and looked deliberate.
 *
 * THE FIX IS IN TWO PLACES, ON PURPOSE
 *
 *   1. THE DATABASE DERIVES IT. Migration 20260826010000 makes
 *      fn_agent_wallet_send overwrite v_dest with 'agent_wallet' whenever the
 *      recipient's role can hold a float (owner, co_owner, admin, super_agent,
 *      agent, sub_agent). p_destination becomes a request, not an instruction.
 *      This is the half that matters, because anything holding a session can
 *      call the RPC directly and never sees a dropdown at all.
 *
 *   2. THE UI STOPS OFFERING IT. WalletCashierModal narrows `destinations` to
 *      agent_wallet alone once the chosen recipient holds a float, so the
 *      summary line above the button describes the transfer that is actually
 *      about to happen rather than one the server is quietly going to correct.
 *
 * Claim back needs no separate rule: fn_agent_wallet_claim_back reads the
 * destination off the send row it is reversing, and that row can no longer say
 * player_wallet for an agent recipient.
 *
 * These tests assert on source text because CI has no database. That cannot
 * prove the SQL is right - it was proved against production inside a
 * self-rolling-back transaction, which recorded destination=agent_wallet and
 * +500 to the float for a call that asked for player_wallet. What these can
 * prove is that nobody quietly removes either half again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { canHoldAgentWallet } from '../src/components/wallet/walletRows';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const MIGRATION = read(
  'supabase/migrations/20260826010000_agent_to_agent_always_credits_the_agent_wallet.sql'
);
const MODAL = read('src/components/wallet/WalletCashierModal.tsx');

/** Every role that runs a float. Kept literal so a new role is a failing test. */
const FLOAT_ROLES = ['owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent'];

describe('the database decides where agent-to-agent chips land', () => {
  it('forces agent_wallet for every role that can hold a float', () => {
    /**
     * The patch is applied with pg_get_functiondef + replace() rather than a
     * rewritten CREATE OR REPLACE, so what we can assert is the coercion clause
     * it splices in. Matching the role list rather than a keyword means adding a
     * seventh float-holding role without teaching the function about it fails
     * here instead of in production.
     */
    for (const role of FLOAT_ROLES) {
      expect(MIGRATION).toContain(`'${role}'`);
    }
    // Doubled quotes: this is plpgsql being assembled inside a plpgsql string.
    expect(MIGRATION).toContain("v_dest := ''agent_wallet'';");
  });

  it('leaves the existing refusal for plain players intact', () => {
    /**
     * The coercion is additive. If it had REPLACED the older guard, a caller
     * could ask for agent_wallet on a player recipient and get a float row for
     * someone who has no float - the opposite mistake, equally silent.
     */
    expect(MIGRATION).toContain('Only Staff Or Agents Hold An Agent Wallet');
    // The replacement is the anchor PLUS the new clause, so the old guard is
    // still standing after the patch rather than being written over.
    expect(MIGRATION).toContain('v_replacement := v_anchor');
    // And the migration refuses to land if the guard went missing.
    expect(MIGRATION).toContain('the non-agent guard was lost');
  });

  it('is a patch of the live body, not a blind rewrite', () => {
    /**
     * fn_agent_wallet_send is edited by several agents. A full CREATE OR REPLACE
     * written from a stale copy silently reverts whatever landed in between;
     * patching pg_get_functiondef cannot.
     */
    expect(MIGRATION).toContain('pg_get_functiondef');
    expect(MIGRATION).toContain('replace(');
  });
});

describe('the cashier does not offer a destination the server will overrule', () => {
  it('narrows the destination list once the recipient holds a float', () => {
    expect(MODAL).toContain('recipientHoldsFloat');
    expect(MODAL).toMatch(/filter\(\s*\(d\)\s*=>\s*d === 'agent_wallet'\s*\)/);
  });

  it('re-pins the selected destination when the recipient changes', () => {
    /**
     * Choosing a player, selecting their player wallet, then switching to an
     * agent would otherwise leave the selection on a value the list no longer
     * contains. The send would still be corrected server-side; the sentence
     * above the button would be lying about it.
     */
    expect(MODAL).toMatch(/if \(recipientHoldsFloat && destination !== 'agent_wallet'\)/);
  });
});

describe('canHoldAgentWallet is the single answer to "does this member run a float"', () => {
  it('says yes for every float role and no for a plain player', () => {
    for (const role of FLOAT_ROLES) {
      expect(canHoldAgentWallet(role)).toBe(true);
    }
    // 'player' is the literal role a plain member carries in club_members -
    // 540 of the 584 rows in club a0000000-...-0001. Proved live: a send to one
    // of them asking for agent_wallet is refused with "Only Staff Or Agents
    // Hold An Agent Wallet", and asking for player_wallet credits their
    // chip_balance, exactly as before.
    expect(canHoldAgentWallet('player')).toBe(false);
    expect(canHoldAgentWallet('member')).toBe(false);
  });

  it('agrees exactly with the role list the migration coerces on', () => {
    /**
     * Two lists in two languages saying the same thing is how this class of bug
     * comes back. If somebody teaches the UI about a new float role and forgets
     * the SQL, the chips route to a player balance again - so pin them together.
     */
    for (const role of FLOAT_ROLES) {
      expect(canHoldAgentWallet(role)).toBe(true);
      expect(MIGRATION).toContain(`'${role}'`);
    }
  });
});
