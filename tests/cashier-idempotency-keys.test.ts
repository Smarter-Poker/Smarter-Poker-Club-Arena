/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE TRADE GRID MOVES MONEY THE WAY THE CASHIER DOES (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, binding: "IT SHOULD BE REMOVING OR ADDING TO PLAYER WALLET DIRECTLY, AND
 * SENT FROM AND DEPOSITING INTO AGENT WALLETS. THE CLAWBACK IS ONLY IN EFFECT
 * FOR THE FIRST 10 MINUTES WHEN CHIPS ARE SENT, AND AGENT CAN ONLY REMOVE CHIPS
 * IF REQUESTED BY THE PLAYER AFTER THAT."
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED
 *
 * It pinned p_idempotency_key on fn_cashier_send_chips and fn_cashier_claim_back
 * — a SECOND, older money path that moved club_members.chip_balance ↔
 * club_members.chip_balance and never touched agents.agent_wallet_balance at
 * all. Those keys were real and the tests were right about them; the path they
 * guarded was the wrong one. CLAUDE.md §8: when you deliberately replace
 * behaviour a test pins, you update that test in the SAME commit.
 *
 * The trade grid now calls the functions the Club Bank Cashier already used:
 *   fn_agent_wallet_send        debits the caller's agent wallet, credits the
 *                               recipient, one ledger row, keyed on p_op_id,
 *                               reversible_until = now() + 10 minutes
 *   fn_agent_wallet_claim_back  anchored on ONE send, refused by the database's
 *                               clock once the window closes
 *   fn_agent_wallet_reversible  what is still claimable, countdown server-side
 *
 * THE KEY SHAPE CHANGED WITH THE PATH. fn_agent_wallet_send takes a single
 * `p_op_id uuid`, not a composed text key, so a batch cannot reuse one nonce
 * across recipients: the second recipient would match the first's row and be
 * reported as a replay while receiving nothing. Hence one op id PER TARGET,
 * minted once and held across a failure — which is the same protection the
 * composed key gave, expressed in the convention the rest of the codebase uses.
 *
 * Source-level assertions on purpose. Mounting the page cannot prove an argument
 * reaches an RPC without a live database, and the argument being absent or
 * misshapen is exactly the defect.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.tsx'), 'utf8');

/** The body of runTransfers, where every batched chip movement happens. */
const RUN_TRANSFERS = PAGE.slice(
  PAGE.indexOf('const runTransfers ='),
  PAGE.indexOf('const loadReversible =')
);

/**
 * One RPC call's argument object, sliced by SYNTAX rather than by a fixed
 * character count. A `+ 1400` window is exactly what broke the sibling test in
 * tests/config/claimBackIdempotency.test.ts when a comment was added inside a
 * call: the window silently stopped covering the thing it is named after.
 */
function callArgs(src: string, rpc: string): string {
  const start = src.indexOf(`supabase.rpc('${rpc}'`);
  if (start < 0) return '';
  const end = src.indexOf('});', start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 3);
}

// ───────────────────────────────────────────────────────────────────────────
describe('the trade grid spends the AGENT WALLET', () => {
  it('finds the function it is asserting about', () => {
    expect(RUN_TRANSFERS.length).toBeGreaterThan(500);
    expect(RUN_TRANSFERS).toContain('fn_agent_wallet_send');
    expect(RUN_TRANSFERS).toContain('fn_issue_tournament_ticket');
  });

  it('sends through fn_agent_wallet_send, which debits agents.agent_wallet_balance', () => {
    // The server half is pinned in tests/config/roleScopedCashier.test.ts: that
    // function debits the caller's agent wallet, refuses a recipient outside the
    // downline BEFORE any money moves, and writes a chip_transactions row.
    const call = callArgs(RUN_TRANSFERS, 'fn_agent_wallet_send');
    expect(call).toContain('p_club_id: clubUuid');
    expect(call).toContain('p_to_user_id: t.userId');
    expect(call).toContain('p_amount: value');
    expect(call).toContain('p_destination');
    expect(call).toContain('p_op_id');
  });

  it('never calls the old club-ledger money path again', () => {
    // Both functions still EXIST in Postgres and are deliberately not dropped in
    // this change. What must not survive is a second CALLER moving chips a
    // different way from the cashier modal. The names survive in the header
    // comment that explains why they left; a call must not.
    expect(PAGE).not.toContain("supabase.rpc('fn_cashier_send_chips'");
    expect(PAGE).not.toContain("supabase.rpc('fn_cashier_claim_back'");
  });

  it('names the destination wallet from the RECIPIENT role, not a hardcoded one', () => {
    // Chips to a player land in the balance they buy in with; chips to a sub
    // agent land in the float they distribute from. fn_agent_wallet_send refuses
    // 'agent_wallet' for any role that cannot hold one, so this has to agree.
    const call = callArgs(RUN_TRANSFERS, 'fn_agent_wallet_send');
    expect(call).toMatch(/p_destination:\s*canHoldAgentWallet\(t\.role\)/);
    expect(call).toContain("'agent_wallet'");
    expect(call).toContain("'player_wallet'");
  });

  it('checks the pot the send actually spends, not the club bank or the player balance', () => {
    // An owner with a large treasury and an unfunded float sailed past the old
    // check and collected N server refusals instead.
    expect(RUN_TRANSFERS).toMatch(/kind === 'send' && agentWallet !== null && total > agentWallet/);
    // And an unread balance must not refuse a send the server would allow.
    expect(RUN_TRANSFERS).toContain('agentWallet !== null');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('one op id per target, held across a failure', () => {
  it('mints a uuid per target rather than reusing one across the batch', () => {
    expect(PAGE).toMatch(/const opIdFor = \(userId: string\)/);
    expect(PAGE).toMatch(/opIdsRef\.current\.get\(userId\)/);
    expect(PAGE).toMatch(/opIdsRef\.current\.set\(userId, fresh\)/);
    expect(callArgs(RUN_TRANSFERS, 'fn_agent_wallet_send')).toContain('p_op_id: opIdFor(t.userId)');
  });

  it('the fallback op id is a UUID, because p_op_id is a uuid column', () => {
    // crypto.randomUUID is undefined on http origins and Safari < 15.4. The old
    // fallback was `${Date.now()}-${random}`, fine for a text key and a 22P02
    // from Postgres on the one call that moves the chips.
    expect(PAGE).toMatch(/function newOpId\(\): string/);
    expect(PAGE).toContain("'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'");
    expect(PAGE).not.toContain('function newSubmissionId');
  });

  it('is cleared when the amount or the selection changes', () => {
    // A changed amount or selection is a NEW intent and must not replay the old
    // one. Retained across a failure, cleared on a change: both, or neither
    // protection works.
    expect(PAGE).toMatch(
      /useEffect\(\(\) => \{\s*submissionIdRef\.current = null;\s*opIdsRef\.current = new Map\(\);\s*\},\s*\[amount, selected, clubUuid\]\)/
    );
  });

  it('is retained across a failure, which is what makes a retry safe', () => {
    expect(RUN_TRANSFERS).toMatch(
      /if \(ok === targets\.length\) \{\s*submissionIdRef\.current = null;\s*opIdsRef\.current = new Map\(\);/
    );
  });

  it('the ticket path keeps its own composed key, because it is a different RPC', () => {
    const call = callArgs(RUN_TRANSFERS, 'fn_issue_tournament_ticket');
    expect(call).toContain('p_idempotency_key');
    expect(call).toMatch(/\$\{clubUuid\}/);
    expect(call).toMatch(/\$\{submissionId\}/);
    expect(call).toMatch(/\$\{t\.userId\}/);
    expect(call).toMatch(/\$\{value\}/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the recipient list is the one the server will accept', () => {
  it('comes from fn_club_cashier_members, not a hand-scoped club_members page', () => {
    expect(PAGE).toContain("supabase.rpc('fn_club_cashier_members'");
    // The old path paged club_members and scoped it three different ways, one of
    // which handed a super agent every UNASSIGNED member of the club - people
    // fn_agent_wallet_send would then refuse.
    expect(PAGE).not.toContain("supabase.rpc('ca_club_my_downline'");
    expect(PAGE).not.toMatch(/\.select\('user_id, role, chip_balance[^']*agent_id'\)/);
  });

  it('still reads the viewer own membership, which is a different question', () => {
    // Role and personal chip balance are the viewer's own row, not a roster.
    expect(PAGE).toMatch(/\.from\('club_members'\)[\s\S]{0,120}select\('role, chip_balance'\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the ten minute rule is what the UI offers', () => {
  const CLAIM = PAGE.slice(
    PAGE.indexOf('const claimBack = async'),
    PAGE.indexOf('const stillClaimable = useMemo(')
  );

  it('claim back is anchored on a transaction, never on an amount against a player', () => {
    const call = callArgs(PAGE, 'fn_agent_wallet_claim_back');
    expect(call).toContain('p_transaction_id: row.transaction_id');
    expect(call).toContain('p_op_id: newOpId()');
    expect(call).not.toContain('p_from_user_id');
  });

  it('the claimable list is computed by the server, not from created_at on the phone', () => {
    expect(PAGE).toContain("supabase.rpc('fn_agent_wallet_reversible'");
    expect(PAGE).toContain('reversible_until');
  });

  it('a row whose window ran out while the modal was open loses its button', () => {
    expect(PAGE).toMatch(/const stillClaimable = useMemo\(/);
    /**
     * UPDATED 2026-08-25, and the old assertion is the reason.
     *
     * It pinned `new Date(r.reversible_until).getTime() > nowTick`, which is the
     * BROWSER WALL CLOCK - the exact thing the comment three lines above it
     * promised the countdown was not. `seconds_left` was fetched from
     * fn_agent_wallet_reversible and never read. On a device whose clock is ten
     * minutes fast that filter emptied the list while live sends were sitting
     * in it; ten minutes slow, it offered every expired row and each tap
     * collected a refusal.
     *
     * The filter is now the server's own seconds_left minus locally measured
     * MONOTONIC elapsed time (performance.now, which no clock correction moves),
     * shared with WalletCashierModal through secondsLeftFromServer.
     */
    expect(PAGE).toMatch(/secondsLeftFor\(r\) > 0/);
    expect(PAGE).toContain('secondsLeftFromServer(row.seconds_left');
    expect(PAGE).toContain('performance.now()');
    expect(PAGE).not.toMatch(/new Date\(r\.reversible_until\)\.getTime\(\) > nowTick/);
  });

  it('and the empty state says what the player has to do instead', () => {
    // "Make the UI say so rather than offering a control that will be refused."
    expect(PAGE).toMatch(/Nothing Is Still Inside Its Ten Minute Window/);
    expect(PAGE).toMatch(/Request A Cash Out/);
  });

  it('a refusal is never toasted as a success', () => {
    expect(CLAIM.length).toBeGreaterThan(200);
    expect(CLAIM).toMatch(/if \(!res\?\.success\) throw new Error/);
  });
});
