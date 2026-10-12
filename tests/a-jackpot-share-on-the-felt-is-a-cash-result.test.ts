/**
 * A JACKPOT SHARE CREDITED TO A SEAT IS PART OF THAT PLAYER'S CASH RESULT
 *
 * Midway's week of 2026-09-21 refused to close because 5,025.00 of mini Bad
 * Beat Jackpot shares (eight payouts, 35 players) were credited to seat stacks
 * after their hands committed: in no hand's observed delta, in no original
 * wallet flow, yet cashed out with the player's ordinary cash-out. The union
 * P&L evidence report now adds every share credited to the felt to the hand
 * results. These pins keep the three parts of that fix together.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SQL = readFileSync(
  resolve(__dirname, '..', 'supabase/migrations/20260929110440_a_jackpot_share_on_the_felt_is_a_cash_result.sql'),
  'utf8',
);

describe('jackpot shares on the felt in the union P&L', () => {
  it('reads each share from its recipient row, never the payout total', () => {
    expect(SQL).toContain('FROM public.bbj_payout_recipients r');
    expect(SQL).toContain('JOIN public.bbj_payouts b ON b.id=r.payout_id');
  });

  it('leaves out a share paid to a departed recipient wallet, which never reached the felt', () => {
    expect(SQL).toMatch(/NOT EXISTS\(SELECT 1 FROM public\.wallet_credit_idempotency w\s+WHERE w\.key='bbj:'\|\|r\.payout_id::text\|\|':'\|\|r\.user_id::text\)/);
  });

  it("attributes a share to the recipient's earning club in its own hand's certified evidence", () => {
    expect(SQL).toContain("(pp.p->>'earning_club_id')::uuid");
    expect(SQL).toContain('JOIN public.union_pnl_cash_outcomes o ON o.table_id=b.table_id AND o.hand_number=b.hand_number');
    expect(SQL).toContain("o.game_scope->>'game_union_id'=p_union_id::text");
  });

  it('adds the shares to the hand results the cash reconciliation compares against', () => {
    expect(SQL).toContain(
      'UNION ALL SELECT a.club_id,a.user_id,a.amount FROM public.fn_union_pnl_week_bbj_stack_awards(p_union_id,p_start,p_end) a), opening AS',
    );
  });

  it('is preimage-guarded and carries its live proof', () => {
    expect(SQL).toContain("IF md5(v_def) <> 'e56b7e668d49ae06191cdfeca5933b86'");
    expect(SQL).toMatch(/^-- @live-proof: /m);
  });
});
