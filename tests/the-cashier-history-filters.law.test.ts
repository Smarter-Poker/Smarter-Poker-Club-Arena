/**
 * THE CASHIER HISTORY FILTERS (Dan 2026-10-24, binding)
 *
 * "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE": the Transaction
 * History gets type filters (Cash-Outs, Transfers, Games), a date range, true
 * totals, and an agent's downline book (his Club Data ruling: agents see their
 * own plus their downlines).
 *
 * Pins the database half (migration 20261024213601):
 *   - the book is decided by the server and can only narrow: the club book for
 *     owner/co-owner/admin, the downline book for agent ranks, otherwise own;
 *   - the transfer kind list is written identically in the partial index and
 *     in both functions, so the index serves the query it was built for;
 *   - a treasury-funded seat is a transfer, presented as a Club Bank send;
 *   - totals are the viewer's own wallet, by the Full Statement's direction
 *     rule, never a club-wide sum (34 s measured on the largest club).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'supabase/migrations/20261024213601_cashier_history_filters_and_totals.sql'
  ),
  'utf8'
);

const TRANSFER =
  "'{agent_wallet_send,agent_wallet_claim_back,agent_wallet_self_stake,club_bank_send,horse_treasury_funding,club_bank_claim,club_bank_reversal,admin_removal,mint,treasury_mint,treasury_burn,treasury_debit,treasury_credit,peer_transfer,promo_wallet_send,club_promo_send,promo_disbursement,club_opening_grant,rakeback,commission_claim,overlay_funding,overlay_rebank,union_transfer,union_transfer_reversal,union_promo_send,union_promo_to_club,union_promo_clawback,union_clawback,leave_club_chip_return,default_mint_correction,promo_closed_on_union_join,tournament_ticket_issue,tournament_ticket_redeem,tournament_ticket_cancel,transfer}'::text[]";
const CASHOUT =
  "'{cashout_request_escrow,cashout_approved,cashout_denied,cashout_cancelled,cashout_expired_refund}'::text[]";

describe('the cashier history filters', () => {
  it('builds the transfers index concurrently, before the one transaction', () => {
    const begin = sql.indexOf('\nBEGIN;');
    const index = sql.indexOf(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_tx_club_transfer_created'
    );
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThan(begin);
    expect(sql.slice(index, begin)).toContain(
      'ON public.chip_transactions (club_id, created_at DESC, id DESC)'
    );
    expect(sql).toContain('$index_guard$');
  });

  it('writes the transfer kind list identically in the index and both functions', () => {
    expect(sql.split(TRANSFER)).toHaveLength(4);
    expect(sql.split(CASHOUT)).toHaveLength(3);
    // A funded seat is filtered where it is presented: with the Club Bank sends.
    expect(TRANSFER).toContain('horse_treasury_funding');
  });

  it('lets the scope narrow a book and never widen it', () => {
    expect(sql).toContain(
      "WHEN v_scope = 'club' AND v_role IN ('owner', 'co_owner', 'admin') THEN 'club'"
    );
    expect(sql).toContain(
      "WHEN v_scope = 'downline' AND v_role IN ('super_agent', 'agent', 'sub_agent') THEN 'downline'"
    );
    expect(sql).toContain("ELSE 'mine' END;");
    expect(sql).toContain('FROM public.fn_club_active_cashier_edges(p_club_id) edge');
    expect(sql).toContain("IF v_book = 'mine' THEN v_people := ARRAY[v_viewer]; END IF;");
  });

  it('reads a person or a downline off the per-person indexes, not a club-wide scan', () => {
    expect(sql).toContain('FROM unnest($3) AS p(uid) CROSS JOIN LATERAL (');
    expect(sql).toContain('ct.club_id = $1 AND ct.from_user_id = p.uid');
    expect(sql).toContain('ct.club_id = $1 AND ct.to_user_id = p.uid');
  });

  it('presents every row as the trade ledger does: arena names, a funded seat as a Club Bank send', () => {
    expect(sql).toContain(
      "CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END"
    );
    expect(sql).toContain(
      'public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name)'
    );
    expect(sql).toContain("ct.notes ~* 'horse'");
  });

  it("totals the viewer's own wallet by the Full Statement's direction rule", () => {
    const totals = sql.slice(sql.indexOf('FUNCTION public.fn_cashier_history_totals('));
    expect(totals).toContain('AND (ct.from_user_id = $2 OR ct.to_user_id = $2)');
    expect(totals).toContain(
      "WHEN ct.transaction_type = 'cashout_request_escrow'\n                 THEN CASE WHEN ct.from_user_id = $2 THEN 'out' ELSE 'managed' END"
    );
    expect(totals).toContain(
      "WHEN ct.transaction_type IN ('union_promo_to_club', 'union_promo_clawback', 'mint', 'treasury_mint', 'treasury_burn') THEN 'managed'"
    );
    expect(totals).toContain(
      "WHEN ct.to_user_id = $2 AND ct.from_user_id IS DISTINCT FROM $2 THEN 'in'"
    );
  });

  it('keeps both doors definer-only, pinned and off anon', () => {
    for (const sig of [
      'fn_cashier_history_page(uuid, text, text, timestamp with time zone, timestamp with time zone, integer, integer)',
      'fn_cashier_history_totals(uuid, text, timestamp with time zone, timestamp with time zone)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
      expect(sql).toContain(
        `GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, service_role;`
      );
    }
    expect(sql.match(/STABLE SECURITY DEFINER/g)).toHaveLength(2);
    expect(sql.match(/SET lock_timeout TO '5s'/g)).toHaveLength(2);
  });
});
