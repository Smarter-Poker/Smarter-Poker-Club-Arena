/**
 * THE CASHIER TRANSACTION HISTORY (Dan 2026-10-24, binding)
 *
 * 1. "WHO EVER APPROVES THE CASH OUT, THOSE CHIPS ARE CREDITED TO THAT PERSONS
 *    AGENT WALLET. WHO EVER IS THE PERSON WHO 'APPROVES IT'. AND IT SHOULD BE
 *    APART OF THE CASHIER TRANSACTION REPORT."
 * 2. "INSIDE THE CASHIER, INSTEAD OF IT SAYING 575 AVAILABLE - 0 SELECTED. THAT
 *    SHOULD BE THE 'TRANSACTION HISTORY' WHERE AGENTS AND PLAYERS CAN SEE ALL
 *    OF THERE TRANSACTION HISTORY. BUT OWNERS, CO OWNERS AND ADMINS CAN FILTER
 *    BETWEEN 'ALL CLUB TRANSACTIONS' AND THERE OWN CLUB TRANSACTIONS."
 *
 * The money half of (1) was already true on the server: the acceptance leg of
 * fn_cashier_cashout_transition releases the hold into the ACCEPTER's agent
 * wallet and books chip_transactions.to_user_id = accepter (read back on
 * production 2026-10-24: KingFish accepted Golddigger's 20.00, assigned to
 * DarthBayter, and KingFish's agent wallet went 240,740.00 -> 240,760.00).
 * What was wrong was the report: read by the row's two sides, the request leg
 * credited the ASSIGNED agent, the player was counted out twice and a
 * canceller paid a refund out of their own wallet. These pins hold the report
 * to the wallet that actually moved, and the history to who may read what.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cashoutRowTitle,
  describeChipTransaction,
  ledgerDirection,
  walletRoute,
} from '../src/components/wallet/describeChipTransaction';
import { chipKindWord } from '../src/utils/chipKindWord';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const PLAYER = 'golddigger';
const ASSIGNED = 'darth';
const ACCEPTER = 'kingfish';
const names = new Map([
  [PLAYER, 'Golddigger'],
  [ASSIGNED, 'DarthBayter'],
  [ACCEPTER, 'KingFish'],
]);
// The three legs exactly as fn_cashier_cashout_transition writes them.
const hold = {
  transaction_type: 'cashout_request_escrow',
  amount: 20,
  from_user_id: PLAYER,
  to_user_id: ASSIGNED,
};
const accepted = {
  transaction_type: 'cashout_approved',
  amount: 20,
  from_user_id: PLAYER,
  to_user_id: ACCEPTER,
};
const declined = {
  transaction_type: 'cashout_denied',
  amount: 20,
  from_user_id: ASSIGNED,
  to_user_id: PLAYER,
};

describe('the cashier transaction history', () => {
  it('credits the accepted cash-out to whoever accepted it, in the report', () => {
    expect(ledgerDirection(accepted, ACCEPTER)).toBe('in');
    expect(describeChipTransaction(accepted, names, ACCEPTER)).toBe(
      "You Accepted Golddigger's Cash-Out Of 20. The Chips Went To Your Agent Wallet"
    );
    expect(describeChipTransaction(accepted, names, null)).toBe(
      "KingFish Accepted Golddigger's Cash-Out Of 20. The Chips Went To KingFish's Agent Wallet"
    );
    expect(walletRoute(accepted)).toBe('Held Cash-Out To Agent Wallet');
    expect(chipKindWord('cashout_approved')).toBe('Cash-Out Accepted');
  });

  it('never credits the agent a request was sent to, and counts the player out once', () => {
    expect(ledgerDirection(hold, ASSIGNED)).toBe('managed');
    expect(ledgerDirection(hold, PLAYER)).toBe('out');
    expect(ledgerDirection(accepted, PLAYER)).toBe('managed');
    expect(ledgerDirection(accepted, ASSIGNED)).toBe('managed');
  });

  it('returns a cancelled cash-out to the player, not out of the canceller', () => {
    expect(ledgerDirection(declined, PLAYER)).toBe('in');
    expect(ledgerDirection(declined, ASSIGNED)).toBe('managed');
    expect(describeChipTransaction(declined, names, PLAYER)).toBe(
      'DarthBayter Cancelled Your Cash-Out Of 20. The Chips Went Back To Your Player Wallet'
    );
  });

  it('titles each cash-out leg in plain words, never as a transfer to the agent it was sent to', () => {
    // The request: the player sees where it went; the agent it was sent to
    // sees a request, not chips; anyone else sees who asked whom.
    expect(cashoutRowTitle(hold, 'Golddigger', 'DarthBayter', PLAYER)).toBe(
      'Cash-Out Request To DarthBayter'
    );
    expect(cashoutRowTitle(hold, 'Golddigger', 'DarthBayter', ASSIGNED)).toBe(
      'Golddigger Requested A Cash-Out From You'
    );
    expect(cashoutRowTitle(hold, 'Golddigger', 'DarthBayter', ACCEPTER)).toBe(
      'Golddigger Requested A Cash-Out From DarthBayter'
    );
    // The acceptance names who took the chips.
    expect(cashoutRowTitle(accepted, 'Golddigger', 'KingFish', ACCEPTER)).toBe(
      "You Accepted Golddigger's Cash-Out"
    );
    expect(cashoutRowTitle(accepted, 'Golddigger', 'KingFish', PLAYER)).toBe(
      'KingFish Accepted Your Cash-Out'
    );
    expect(cashoutRowTitle(accepted, 'Golddigger', 'KingFish', ASSIGNED)).toBe(
      "KingFish Accepted Golddigger's Cash-Out"
    );
    expect(cashoutRowTitle(declined, 'DarthBayter', 'Golddigger', PLAYER)).toBe(
      'DarthBayter Cancelled Your Cash-Out'
    );
    expect(cashoutRowTitle({ transaction_type: 'agent_wallet_send' }, 'A', 'B', PLAYER)).toBeNull();
  });

  it("reads direction by the Full Statement's rule: a self move and a pot move are managed", () => {
    const self = {
      transaction_type: 'agent_wallet_self_stake',
      from_user_id: 'a',
      to_user_id: 'a',
    };
    expect(ledgerDirection(self, 'a')).toBe('managed');
    const mint = { transaction_type: 'mint', from_user_id: 'a', to_user_id: 'b' };
    expect(ledgerDirection(mint, 'b')).toBe('managed');
    expect(ledgerDirection(mint, 'a')).toBe('managed');
  });

  it('reads every other row by its sides, as before', () => {
    const send = { transaction_type: 'agent_wallet_send', from_user_id: 'a', to_user_id: 'b' };
    expect(ledgerDirection(send, 'a')).toBe('out');
    expect(ledgerDirection(send, 'b')).toBe('in');
    expect(ledgerDirection(send, 'c')).toBe('managed');
  });

  const page = read('src/pages/CashierTradePage.tsx');

  it('puts Transaction History where the Available and Selected count was', () => {
    expect(page).not.toMatch(/Available · \{selected\.size/);
    const players = page.indexOf("{advanced ? 'Select Recipients' : 'Players'}");
    const link = page.indexOf('Transaction History\n                </button>', players);
    expect(players).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(players);
    expect(page.slice(players, link)).toContain("onClick={() => setTab('record')}");
    expect(page).toContain("['record', 'Transaction History']");
  });

  it('lets only owners, co-owners and admins choose All Club Transactions', () => {
    expect(page).toContain("return role === 'owner' || role === 'co_owner' || role === 'admin';");
    expect(page).toContain("['club', 'All Club Transactions'],");
    expect(page).toContain("['mine', 'My Transactions'],");
    // Staff choose between the club and their own; agents between their own
    // and their downline (Dan's Club Data rule); a player has one book.
    expect(page).toMatch(
      /isClubStaffRole\(myRole\)\s*\?\s*\[\s*\['club', 'All Club Transactions'\],\s*\['mine', 'My Transactions'\],?\s*\]/
    );
    expect(page).toMatch(
      /isAgentRole\(myRole\)\s*\?\s*\[\s*\['mine', 'My Transactions'\],\s*\['downline', 'My Downline'\],?\s*\]/
    );
    expect(page).toMatch(/isClubStaffRole\(myRole\) && historyScope === 'club'\s*\?\s*'club'/);
    expect(page).toContain("supabase.rpc('fn_cashier_history_feed', {");
    expect(page).toContain('p_scope: historyBook,');
    expect(page).toContain('const direction = ledgerDirection(r, viewer);');
  });

  it('pins the installed door in the post-deploy cashier contract', () => {
    const contract = read('scripts/verification-harness/cashier-release-contract.sql');
    expect(contract).toContain(
      "'signature', 'public.fn_cashier_transaction_history(uuid,text,integer,integer)',"
    );
    expect(contract).toContain("'hash', '3919f3ef7a21ed33e2f0c7a80113c7d2'");
  });

  it('enforces the same rule in the database: the scope narrows a book, never widens it', () => {
    const sql = read('supabase/migrations/20261024203917_cashier_transaction_history_scope.sql');
    expect(sql).toContain("IF v_scope = 'club' AND v_role IN ('owner', 'co_owner', 'admin') THEN");
    expect(sql).toContain('AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)');
    expect(sql).toContain('v_viewer uuid := auth.uid();');
    expect(sql).toContain('STABLE SECURITY DEFINER');
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_cashier_transaction_history\(uuid, text, integer, integer\) FROM PUBLIC, anon;/
    );
    // Two branches, each naming both sides by the arena name and never a horse.
    expect(
      sql.split(
        "CASE WHEN ct.transaction_type = 'horse_treasury_funding' THEN 'club_bank_send' ELSE ct.transaction_type END"
      )
    ).toHaveLength(3);
    expect(
      sql.split(
        'public.fn_arena_name(pt.alias, pt.username, pt.display_name, pt.first_name, pt.last_name, pt.full_name)'
      )
    ).toHaveLength(3);
  });

  it('searches, pages, narrows and totals on the server (Dan 2026-10-24, second round)', () => {
    const page = read('src/pages/CashierTradePage.tsx');
    // Search runs over the whole history, debounced, never over the rows on screen.
    expect(page).toContain('p_search: historySearch || null,');
    expect(page).toContain(
      "setTimeout(() => setHistorySearch(typed.length >= 2 ? typed : ''), 350)"
    );
    // Older pages come from the last row on screen, never an offset.
    expect(page).not.toContain('p_offset');
    expect(page).toContain('p_before_at: last.createdAt,');
    // An agent picks only a player inside his downline; the server refuses anyone else.
    expect(page).toContain('.filter((row) => row.depth >= 1 && row.userId !== user?.id)');
    expect(page).toContain("historyBook === 'downline' && downlinePeople.length > 0");
    expect(page).toContain('p_person: historyPerson,');
    // The club book shows the whole club's totals; a total still being
    // counted says so and is asked again.
    expect(page).toContain("supabase.rpc('fn_cashier_history_summary', {");
    expect(page).toContain('Adding Up Earlier Days...');
    // A cash-out nobody has decided shows how long it has waited, and its
    // receipt carries its invoice number.
    expect(page).toContain('waitingFor(r.requestCreatedAt ?? r.createdAt)');
    expect(page).toContain('{receipt.invoiceNumber}');
  });
});
