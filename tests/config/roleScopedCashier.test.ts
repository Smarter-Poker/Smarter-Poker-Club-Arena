/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROLE SCOPED CASHIER — the rules that live in Postgres, pinned (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, binding: "Super Agents, Agents, and Sub Agents should ONLY EVER SEE
 * their downlines... Any chips sent or claimed back transact from the Agent
 * Wallet. Agents can only claim back chips that were sent in the first 10
 * minutes... When a player requests a cash out, those chips are removed from
 * the player account and held in escrow until the agent approves or denies...
 * All transactions must be in the transaction ledger."
 *
 * Every one of those is a SERVER rule, and none of them can be proved by
 * mounting a component. CI has no database, so these read the migration that
 * defines them - the same technique tests/config/claimBackIdempotency.test.ts
 * uses, and for the same reason: the failure mode is a MISSING LINE in a
 * function that otherwise reads perfectly.
 *
 * The behaviour was also exercised against the live database before this
 * shipped: an agent with 17 downline members saw 17 rows from
 * fn_club_cashier_members in a club of 584, and the owner of the same club saw
 * all 584.
 *
 * WHAT THIS CANNOT CATCH: a migration that is committed and never applied.
 * That is scripts/ci/check-migrations-applied.mjs, which compares what a branch
 * declares against the live schema manifest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceSqlStatement } from '../helpers/sourceWindow';

const ROOT = resolve(__dirname, '../..');
const SQL = readFileSync(
  resolve(
    ROOT,
    'supabase/migrations/20260825_role_scoped_cashier_agent_wallet_and_cashout_escrow.sql'
  ),
  'utf8'
);

/** The body of one `create or replace function fn_x(...)` up to the next one. */
function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is not declared in the migration`).toBeGreaterThan(-1);
  const rest = SQL.slice(start + 1);
  const nextIdx = rest.indexOf('create or replace function public.');
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

// ───────────────────────────────────────────────────────────────────────────
describe('who a cashier may transact with', () => {
  const scope = fn('fn_club_cashier_scope');

  it('owner, co owner and admin see everyone; the three agent roles see a downline', () => {
    for (const role of ['owner', 'co_owner', 'admin']) {
      expect(scope).toMatch(new RegExp(`when '${role}'\\s+then 'all'`));
    }
    for (const role of ['super_agent', 'agent', 'sub_agent']) {
      expect(scope).toMatch(new RegExp(`when '${role}'\\s+then 'downline'`));
    }
  });

  it('a super agent is scoped to a downline even though it may open the club bank', () => {
    // The two authorities are different, and conflating them is the whole bug:
    // standing at the bank is about the ACCOUNT, the downline is about PEOPLE.
    expect(scope).toMatch(/when 'super_agent'\s+then 'downline'/);
    expect(scope).not.toMatch(/when 'super_agent'\s+then 'all'/);
  });

  it('anything else - a player, a stranger, a typo - sees nobody', () => {
    expect(scope).toMatch(/else 'none'/);
  });

  it('the downline answer comes from fn_club_is_in_downline, not a second walk', () => {
    expect(fn('fn_club_cashier_can_transact')).toContain('fn_club_is_in_downline');
  });

  it('the member list walks the same club scoped edge the refusal walks', () => {
    const members = fn('fn_club_cashier_members');
    expect(members).toContain('cm.agent_id');
    expect(members).toContain('cm.club_id = p_club_id');
    // Staff get everyone; an agent gets only rows the recursion reached.
    expect(members).toMatch(/v_scope = 'all' or f\.uid is not null/);
    // And a malformed graph must not spin: club_members.agent_id has held
    // real cycles, and one of them once burned a caller's whole 8s budget.
    expect(members).toContain('not (e.child = any (t.path))');
    expect(members).toContain('t.depth < 20');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the agent wallet is the account that moves', () => {
  const send = fn('fn_agent_wallet_send');

  it('debits agents.agent_wallet_balance for the caller', () => {
    expect(send).toMatch(
      /update agents\s+set agent_wallet_balance = coalesce\(agent_wallet_balance, 0\) - p_amount/
    );
    expect(send).toContain('where a.club_id = p_club_id and a.user_id = v_actor');
  });

  it('never touches the `wallets` table, which is what the old path debited', () => {
    expect(send).not.toMatch(/\bfrom wallets\b/);
    expect(send).not.toMatch(/\bupdate wallets\b/);
  });

  it('refuses a recipient outside the callers downline, before any money moves', () => {
    const guard = send.indexOf('fn_club_cashier_can_transact');
    const debit = send.indexOf('update agents');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(debit);
    expect(send).toContain('That Member Is Not In Your Downline');
  });

  it('writes a ledger row, which the old ChipFlowService path never did', () => {
    expect(send).toContain('insert into chip_transactions');
    expect(send).toContain("'agent_wallet_send'");
  });

  it('stamps the ten minute clawback window on that row', () => {
    expect(send).toContain("now() + interval '10 minutes'");
    expect(send).toContain('reversible_until');
  });

  it('is idempotent on p_op_id, so a retry reports rather than resends', () => {
    expect(send).toContain('p_op_id uuid default null');
    expect(send).toMatch(/metadata ->> 'op_id' = v_op_id::text/);
    expect(send).toContain("'replayed', true");
    expect(send).toContain('when unique_violation then');
  });

  it('the unique index that settles a true race covers the new types', () => {
    const idx = sliceSqlStatement(SQL, 'chip_transactions_agent_wallet_op_id_uidx');
    for (const t of [
      'agent_wallet_send',
      'agent_wallet_claim_back',
      'cashout_request_escrow',
      'cashout_approved',
      'cashout_denied',
      'cashout_cancelled',
    ]) {
      expect(idx).toContain(`'${t}'`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the ten minute clawback, and nothing wider', () => {
  const claim = fn('fn_agent_wallet_claim_back');

  it('is anchored on the originating transaction, not on a member', () => {
    expect(claim).toContain('p_transaction_id uuid');
    expect(claim).toContain("v_src.transaction_type <> 'agent_wallet_send'");
  });

  it('refuses a claim on somebody elses send', () => {
    expect(claim).toContain('v_src.from_user_id is distinct from v_actor');
    expect(claim).toContain('You Can Only Claim Back Chips You Sent Yourself');
  });

  it('refuses once the window has closed, by the databases clock', () => {
    expect(claim).toContain('now() > v_src.reversible_until');
    expect(claim).toMatch(/Ten Minute Window To Claim These Chips Back Has Closed/);
    expect(claim).toMatch(/Must Request A Cash Out/);
  });

  it('refuses chips the player has already spent rather than going negative', () => {
    expect(claim).toContain('v_held < v_take');
    expect(claim).toContain('Those Chips Have Already Been Spent');
  });

  it('credits the claim back into the agent wallet and writes a ledger row', () => {
    expect(claim).toMatch(
      /update agents\s+set agent_wallet_balance = coalesce\(agent_wallet_balance, 0\) \+ v_take/
    );
    expect(claim).toContain("'agent_wallet_claim_back'");
  });

  it('cannot be claimed twice: the original row records what has been taken', () => {
    expect(claim).toContain("jsonb_build_object('claimed_back', v_claimed + v_take)");
    expect(claim).toContain('is_reversed = ((v_claimed + v_take) >= v_src.amount)');
  });

  it('the list of claimable sends is computed by the server, not the phone', () => {
    const list = fn('fn_agent_wallet_reversible');
    expect(list).toContain('t.reversible_until > now()');
    expect(list).toContain('t.from_user_id = auth.uid()');
    expect(list).toContain('seconds_left');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('staff may pull from any player, at any time', () => {
  const pull = fn('fn_admin_remove_player_chips');

  it('admits owner, co owner and admin, and nobody else', () => {
    expect(pull).toContain("v_actor_role not in ('owner', 'co_owner', 'admin')");
    expect(pull).toMatch(/An Agent Must Wait For A Cash Out Request/);
  });

  it('has no time limit of its own', () => {
    expect(pull).not.toContain('reversible_until');
    expect(pull).not.toContain('10 minutes');
  });

  it('credits chip_treasury, the account the Club Bank actually shows', () => {
    // It used to credit clubs.chip_pool, which no surface in the app displays:
    // the chips left the player and arrived nowhere anyone could see.
    expect(pull).toContain('chip_treasury = coalesce(chip_treasury, 0) + p_amount');
    expect(pull).not.toContain('chip_pool');
  });

  it('does not truncate a numeric amount through an integer cast', () => {
    expect(pull).not.toContain('p_amount::integer');
  });

  it('writes the pull to the ledger', () => {
    expect(pull).toContain('insert into chip_transactions');
    expect(pull).toContain("'admin_removal'");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('cash out: player to escrow to agent wallet, or back', () => {
  const request = fn('fn_cashout_request');
  const approve = fn('fn_cashout_approve');
  const release = fn('fn_cashout_release');

  it('the request takes the chips off the player immediately', () => {
    expect(request).toMatch(
      /update club_members\s+set chip_balance = coalesce\(chip_balance, 0\) - p_amount/
    );
  });

  it('and holds them in chip_escrow against the request', () => {
    expect(request).toContain('insert into chip_escrow');
    expect(request).toContain('cashout_request_id');
  });

  it('refuses a second pending request, and refuses an overdraft', () => {
    expect(request).toMatch(/You Already Have A Cash Out Waiting/);
    expect(request).toContain('v_before < p_amount');
  });

  it('notifies the agent inside the same transaction as the money', () => {
    const money = request.indexOf('update club_members');
    const notify = request.indexOf('insert into notifications');
    expect(notify).toBeGreaterThan(money);
    expect(request).toContain("'Cash Out Requested'");
  });

  it('APPROVAL credits the agent wallet, not the approvers player balance', () => {
    expect(approve).toMatch(
      /update agents\s+set agent_wallet_balance = coalesce\(agent_wallet_balance, 0\) \+ v_req\.amount/
    );
    expect(approve).not.toMatch(/update club_members\s+set chip_balance/);
  });

  it('approval requires an unreleased escrow row of the matching amount', () => {
    // Without this an unescrowed request - which the dropped INSERT policy used
    // to permit a player to create - would have credited an agent out of thin air.
    expect(approve).toContain('v_escrow.released_at is not null');
    expect(approve).toContain('v_escrow.amount <> v_req.amount');
  });

  it('approval refuses a cash out that belongs to a different agent', () => {
    expect(approve).toContain('fn_club_cashier_can_transact');
    expect(approve).toContain('That Cash Out Belongs To A Different Agent');
  });

  it('approval notifies the player and writes the ledger row', () => {
    expect(approve).toContain("'cashout_approved'");
    expect(approve).toContain("'Cash Out Approved'");
  });

  it('a decline or a self cancel puts the chips back in the player wallet', () => {
    expect(release).toMatch(
      /update club_members\s+set chip_balance = coalesce\(chip_balance, 0\) \+ v_req\.amount/
    );
    expect(release).toContain(
      "release_type = case when v_is_player then 'cancelled' else 'rejected' end"
    );
  });

  it('and the ledger says which of the two it was', () => {
    expect(release).toContain(
      "case when v_is_player then 'cashout_cancelled' else 'cashout_denied' end"
    );
  });

  it('only a decline notifies; a player cancelling their own does not', () => {
    const notifyIdx = release.indexOf('insert into notifications');
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(release.slice(0, notifyIdx)).toContain('if not v_is_player then');
  });

  it('every leg is idempotent, so a double tap cannot move money twice', () => {
    for (const body of [request, approve, release]) {
      expect(body).toContain('p_op_id uuid default null');
      expect(body).toMatch(/metadata ->> 'op_id' = v_op_id::text/);
      expect(body).toContain("'replayed', true");
    }
  });

  it('the two policies that let a player forge or self approve are dropped', () => {
    expect(SQL).toContain('drop policy if exists "cashout_insert"');
    expect(SQL).toContain('drop policy if exists "cashout_update"');
  });

  it('and the agent who has to act on a request can finally read it', () => {
    expect(SQL).toContain('create policy "cashout_read_scoped"');
    expect(SQL).toContain('agent_id = (select auth.uid())');
    expect(fn('fn_cashout_queue')).toContain('fn_club_is_in_downline');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the club bank obeys the same scope', () => {
  it('a super agent cannot reach past their downline by calling the RPC directly', () => {
    const tail = SQL.slice(SQL.indexOf('5. THE CLUB BANK OBEYS THE SAME SCOPE'));
    expect(tail).toContain('fn_club_bank_send');
    expect(tail).toContain('fn_club_bank_claim_back');
    expect(tail).toContain('fn_club_cashier_can_transact');
    expect(tail).toContain('That Member Is Not In Your Downline');
  });

  it('but may still fund their own float from the bank', () => {
    const tail = SQL.slice(SQL.indexOf('5. THE CLUB BANK OBEYS THE SAME SCOPE'));
    expect(tail).toContain('p_to_user_id <> v_actor');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the World Hub route path lands in the same accounts', () => {
  /**
   * Two doors into one flow is fine. Two doors producing incompatible state is
   * not: pages/horses/index.js still calls /api/club-arena/approve-cashout,
   * which runs fn_approve_cashout_atomic. Refusing it would have broken a live
   * surface, so it was aligned instead.
   */
  const LEGACY = readFileSync(
    resolve(
      ROOT,
      'supabase/migrations/20260825_legacy_cashout_route_fns_use_agent_wallet_and_escrow.sql'
    ),
    'utf8'
  );
  const legacyFn = (name: string) => {
    const start = LEGACY.indexOf(`create or replace function public.${name}(`);
    expect(start, `${name} is not in the legacy migration`).toBeGreaterThan(-1);
    const rest = LEGACY.slice(start + 1);
    const next = rest.indexOf('create or replace function public.');
    return next === -1 ? rest : rest.slice(0, next);
  };

  it('the route path now writes the escrow hold it never wrote', () => {
    expect(legacyFn('fn_request_cashout')).toContain('INSERT INTO chip_escrow');
  });

  it('and its approval credits the agent wallet, not the approvers balance', () => {
    const approve = legacyFn('fn_approve_cashout_atomic');
    expect(approve).toContain(
      'agent_wallet_balance = COALESCE(agent_wallet_balance, 0) + v_cashout.amount'
    );
    expect(approve).not.toMatch(/UPDATE club_members\s+SET chip_balance/);
  });

  it('both settle legs release the hold, so escrow cannot stay open forever', () => {
    expect(legacyFn('fn_approve_cashout_atomic')).toContain("release_type = 'completed'");
    expect(legacyFn('fn_cancel_cashout_atomic')).toContain('UPDATE chip_escrow');
  });

  it('and neither will pay out a hold that was already released', () => {
    for (const name of ['fn_approve_cashout_atomic', 'fn_cancel_cashout_atomic']) {
      expect(legacyFn(name)).toContain('those chips have already been released');
    }
  });

  it('a decline through the route notifies the player too', () => {
    expect(legacyFn('fn_cancel_cashout_atomic')).toContain("'Cash Out Declined'");
    expect(legacyFn('fn_approve_cashout_atomic')).toContain("'Cash Out Approved'");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the client asks the right server', () => {
  const MODAL = readFileSync(resolve(ROOT, 'src/components/wallet/WalletCashierModal.tsx'), 'utf8');
  const SERVICE = readFileSync(resolve(ROOT, 'src/services/CashoutService.ts'), 'utf8');

  it('the recipient list is the scoped RPC, not a raw club_members page', () => {
    expect(MODAL).toContain("supabase.rpc('fn_club_cashier_members'");
    expect(MODAL).not.toContain(".from('club_members')");
  });

  it('the agent send is fn_agent_wallet_send, carrying an op id', () => {
    const call = MODAL.slice(
      MODAL.indexOf("supabase.rpc('fn_agent_wallet_send'"),
      MODAL.indexOf("supabase.rpc('fn_agent_wallet_send'") + 500
    );
    expect(call).toContain('p_op_id: opIdRef.current');
  });

  it('ChipFlowService is gone from the cashier, and so is the faked result', () => {
    // The name survives in the header comment that explains why it left; what
    // must not survive is the import or a call.
    expect(MODAL).not.toContain("from '../../services/ChipFlowService'");
    expect(MODAL).not.toMatch(/ChipFlowService\.\w+\(/);
    expect(MODAL).not.toContain('res = { success: true, replayed: false }');
  });

  it('every cashout leg goes through its own RPC', () => {
    for (const rpc of [
      'fn_cashout_request_v2',
      'fn_cashout_approve_v2',
      'fn_cashout_release_v2',
      'fn_cashout_queue',
      'fn_agent_wallet_send',
      'fn_agent_wallet_claim_back',
    ]) {
      expect(SERVICE).toContain(`'${rpc}'`);
    }
  });

  it('the notification for each cash-out leg is raised by the RPC, not the client', () => {
    // REWRITTEN 2026-08-30 (#1498). This used to assert the client called
    // pushNotificationService.sendToUser on request, approval and decline.
    //
    // It was asserting a duplicate. The cash-out RPCs write the notification
    // themselves, inside the money transaction -- fn_cashout_approve emits
    // 'cashout_approved', fn_cashout_release 'cashout_cancelled' /
    // 'cashout_denied', fn_cashout_request 'cashout_request_escrow',
    // fn_expire_stale_cashouts 'cashout_expired_refund' -- and
    // trg_mirror_notification_to_push_outbox turns every one into a push. The
    // client call was a SECOND push over the same event; OneSignal's retirement
    // on 2026-08-19 only made the duplication invisible by killing the
    // transport it went through.
    //
    // So what matters now is that the client calls the RPC that owns the rule,
    // and does NOT send its own push on top.
    for (const rpc of ['fn_cashout_request_v2', 'fn_cashout_approve_v2', 'fn_cashout_release_v2']) {
      expect(SERVICE).toContain(`'${rpc}'`);
    }
    expect(SERVICE).not.toContain('pushNotificationService.sendToUser');
  });

  it('has no client push shim or transport alongside the server-owned invoice notification', () => {
    const code = SERVICE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toContain('pushQuietly');
    expect(code).not.toContain('PushNotificationService');
    expect(code).not.toContain('sendToUser');
    expect(code).not.toMatch(/\.from\(['"](?:notifications|push_outbox)['"]\)/);
  });
});
