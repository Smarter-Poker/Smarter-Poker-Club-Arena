/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CLAIM BACK MUST BE ANCHORED, BOUNDED, AND UNREPEATABLE (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS FILE USED TO PIN
 *
 * fn_cashier_claim_back moved chips off a player and onto the caller, with no
 * time limit of any kind: an agent could pull chips off a downline player days
 * after sending them, with no request from that player. It was given an
 * idempotency key on 2026-08-24 and this file pinned that key. The key was
 * real. The AUTHORITY behind it was not.
 *
 * Dan 2026-08-25, binding: "THE CLAWBACK IS ONLY IN EFFECT FOR THE FIRST 10
 * MINUTES WHEN CHIPS ARE SENT, AND AGENT CAN ONLY REMOVE CHIPS IF REQUESTED BY
 * THE PLAYER AFTER THAT."
 *
 * So the trade grid now calls fn_agent_wallet_claim_back, which is a different
 * shape and a stricter one:
 *
 *   1. ANCHORED on one originating `agent_wallet_send` row, not on a member and
 *      an amount. You can only take back a specific send you actually made.
 *   2. BOUNDED by reversible_until, re-read from that row by the DATABASE's
 *      clock. A phone with a skewed clock cannot buy itself more time.
 *   3. UNREPEATABLE: the originating row records what has already been taken
 *      (`claimed_back`), and p_op_id makes a lost response replay rather than
 *      collect twice.
 *
 * The double-charge shape this file was written for is unchanged and still
 * covered — a claim that COMMITTED and then failed on the way back is
 * indistinguishable from one that never ran, and the natural retry must not
 * charge again. It is now covered by (3) rather than by a composed text key.
 *
 * Source-level on purpose: the failure is a MISSING ARGUMENT on an RPC call,
 * which renders identically to the correct code until you read the payload.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SRC = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.tsx'), 'utf8');
const SQL = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260830235990_cashier_claim_back_cent_integrity.sql'),
  'utf8'
);

/**
 * One RPC call's argument object, sliced to the END OF THE CALL rather than to
 * a fixed character count. It used to be `+ 700`, and on 2026-08-25 a comment
 * added inside the call pushed the argument past the 700th character - so the
 * assertions started failing on a change that made the key STRICTER. A window
 * measured in characters silently stops covering what it is named after.
 */
function callArgs(src: string, rpc: string): string {
  const start = src.indexOf(`supabase.rpc('${rpc}'`);
  if (start < 0) return '';
  const end = src.indexOf('});', start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 3);
}

/** The body of one `create or replace function fn_x(...)` up to the next one. */
function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is not declared in the migration`).toBeGreaterThan(-1);
  const rest = SQL.slice(start + 1);
  const next = rest.indexOf('create or replace function public.');
  return next === -1 ? rest : rest.slice(0, next);
}

const CLAIM_CALL = callArgs(SRC, 'fn_agent_wallet_claim_back');

// ───────────────────────────────────────────────────────────────────────────
describe('the client asks for a claim it is allowed to make', () => {
  it('calls the anchored RPC, and not the unbounded one', () => {
    expect(SRC).toContain("supabase.rpc('fn_agent_wallet_claim_back'");
    // The name survives in the header comment that explains why it left; a CALL
    // must not. The SQL function is deliberately still in Postgres.
    expect(SRC).not.toContain("supabase.rpc('fn_cashier_claim_back'");
    // fn_admin_remove_player_chips is the staff-only pull, which has no time
    // limit BY DESIGN and refuses agents outright. It is not this screen's.
    expect(SRC).not.toContain("supabase.rpc('fn_admin_remove_player_chips'");
  });

  it('identifies ONE originating send, not a member and a number', () => {
    expect(CLAIM_CALL).toContain('p_transaction_id: row.transaction_id');
    expect(CLAIM_CALL).toContain('p_amount: null');
    expect(CLAIM_CALL).not.toContain('p_from_user_id');
  });

  it('carries an op id, so a lost response replays instead of collecting twice', () => {
    // The same key must survive an uncertain response. Minting inside the RPC
    // arguments made the natural retry a different operation, defeating the
    // server's replay receipt precisely when the first response was lost.
    expect(SRC).toContain('claimOpIdsRef.current.get(row.transaction_id) || newOpId()');
    expect(CLAIM_CALL).toMatch(/p_op_id:\s*heldOpId/);
    expect(SRC).toContain('claimOpIdsRef.current.delete(row.transaction_id)');
  });

  it('offers only what the server says is still claimable', () => {
    expect(SRC).toContain("supabase.rpc('fn_agent_wallet_reversible'");
    /**
     * UPDATED 2026-08-25, and the old assertion is exactly the defect.
     *
     * It pinned `new Date(r.reversible_until).getTime() > nowTick`, where
     * nowTick is `Date.now()` - the BROWSER WALL CLOCK. The title of this test
     * says "what the SERVER says", and `seconds_left` (which the server
     * computes for precisely this) was selected, typed on ReversibleSend, and
     * never read on either cashier surface. A device ten minutes fast emptied
     * the list while live sends sat in it; ten minutes slow offered every
     * expired row and each tap collected a refusal.
     *
     * It now re-filters against the server's own seconds_left minus locally
     * measured MONOTONIC elapsed time (performance.now, which no clock
     * correction or DST jump can move), shared with WalletCashierModal through
     * secondsLeftFromServer in cashierModes.
     */
    expect(SRC).toMatch(/secondsLeftFor\(r\) > 0/);
    expect(SRC).toContain('secondsLeftFromServer(row.seconds_left');
    expect(SRC).toContain('performance.now()');
    expect(SRC).not.toMatch(/new Date\(r\.reversible_until\)\.getTime\(\) > nowTick/);
  });

  it('cannot fire twice from one tap, or from two', () => {
    const body = SRC.slice(
      SRC.indexOf('const claimBack = async'),
      SRC.indexOf('const stillClaimable = useMemo(')
    );
    expect(body).toMatch(/if \(!clubUuid \|\| claimingId \|\| busyRef\.current\) return;/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('and the server is what actually decides', () => {
  const claim = fn('fn_agent_wallet_claim_back');

  it('refuses anything that is not one of the caller own agent wallet sends', () => {
    expect(claim).toContain("v_src.transaction_type <> 'agent_wallet_send'");
    expect(claim).toContain('v_src.from_user_id is distinct from v_actor');
  });

  it('refuses once the window has closed, by its own clock', () => {
    expect(claim).toContain('now() > v_src.reversible_until');
    expect(claim).toMatch(/Ten Minute Window To Claim These Chips Back Has Closed/);
    expect(claim).toMatch(/Must Request A Cash Out/);
  });

  it('records what has already been taken, so the rest cannot be taken twice', () => {
    expect(claim).toContain("jsonb_build_object('claimed_back', v_claimed_after)");
    expect(claim).toContain('v_complete := (v_src.amount - v_claimed_after) < 0.01');
    expect(claim).toContain('is_reversed = v_complete');
  });

  it('is idempotent on p_op_id, settled by the unique index rather than a pre-check', () => {
    expect(claim).toMatch(/metadata ->> 'op_id' = v_op_id::text/);
    expect(claim).toContain('when unique_violation then');
    expect(claim).toContain("'replayed', true");
  });

  it('refuses sub-cent claims and retry keys reused for another send', () => {
    expect(claim).toContain('p_amount <> round(p_amount, 2)');
    expect(claim).toContain("metadata ->> 'original_transaction_id'");
    expect(claim).toContain('That Retry Key Belongs To A Different Claim Back');
  });

  it('and the chips land back in the AGENT WALLET, with a ledger row', () => {
    expect(claim).toMatch(
      /update public\.agents\s+set agent_wallet_balance = coalesce\(agent_wallet_balance, 0\) \+ v_take/
    );
    expect(claim).toContain("'agent_wallet_claim_back'");
  });
});
