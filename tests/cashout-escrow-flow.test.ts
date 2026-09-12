/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE CASH OUT ESCROW FLOW, PINNED (2026-08-25)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, binding: "when a player requests a cash out, those chips should be removed
 * from the player account and held in escrow, until the agent approves the cash
 * out, or denies it. once approved the chips go into the agents wallet, if
 * canceled returns to player wallet. Owners, Co Owners and Admins can pull from
 * any player at any time. Push notifications and messages must trigger, upon a
 * player requesting cash out, and when its approved, all transactions must be in
 * the transaction ledger."
 *
 * tests/unit/CashoutService.test.ts already pins WHICH RPC each leg calls. This
 * file pins the four things that audit found actually broken, so none of them can
 * come back:
 *
 *  1. IDEMPOTENCY IS ONLY REAL IF THE KEY IS STABLE. Every leg passed a p_op_id,
 *     which reads as protected and is not: the id was minted inside the call, so
 *     the retry a dropped response provokes carried a DIFFERENT key and the
 *     server's replay branch never fired. Each leg now accepts one from the
 *     caller, and the two screens hold it in a ref across a failure.
 *
 *  2. A REPLAY MUST NOT RE-PUSH. `replayed: true` means this attempt moved
 *     nothing. Pushing again tells an agent a second cash out arrived.
 *
 *  3. A FAILED QUEUE READ IS NOT AN EMPTY QUEUE. getAgentPendingCashouts
 *     swallowed the error and returned [], which the panel renders as "No
 *     Pending Cashout Requests" - an agent shown an empty worklist while chips
 *     wait in escrow. It throws now, which is what makes the panel's Retry state
 *     reachable at all.
 *
 *  4. expireStale READ A SCALAR AS ROWS. The live function RETURNS INTEGER; this
 *     code did `for (const rec of data)`, which is a TypeError on any number
 *     other than the zero that `|| []` happened to mask. It only ever looked
 *     healthy on the runs that did nothing.
 *
 * Plus the source-level rules the compiler cannot catch: no emoji, no em dashes,
 * and no padStart on money.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
        }),
      }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

vi.mock('../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
  isUUID: () => true,
}));

vi.mock('../src/services/PushNotificationService', () => ({
  pushNotificationService: { sendToUser: vi.fn().mockResolvedValue(true) },
}));

import { cashoutService, newOpId } from '../src/services/CashoutService';
import { supabase } from '../src/lib/supabase';
import { pushNotificationService } from '../src/services/PushNotificationService';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const push = pushNotificationService.sendToUser as unknown as ReturnType<typeof vi.fn>;

const accept = (payload: Record<string, unknown>) =>
  rpc.mockResolvedValueOnce({ data: { success: true, ...payload } });

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SERVICE = read('src/services/CashoutService.ts');
const MODAL = read('src/components/wallet/CashoutRequestModal.tsx');
const PANEL = read('src/components/agent/AgentCashoutPanel.tsx');
const DISPUTE = read('src/components/wallet/DisputeSubmitModal.tsx');

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the op id is the CALLERS, so a retry can replay instead of paying twice', () => {
  it('newOpId is exported, and mints something Postgres will accept as a uuid', () => {
    // p_op_id is a uuid column. The fallback for a webview without
    // crypto.randomUUID has to be uuid-shaped or the one call that moves the
    // chips dies on 22P02.
    expect(typeof newOpId).toBe('function');
    expect(newOpId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(newOpId()).not.toBe(newOpId());
  });

  it('requestCashout forwards the id it was given rather than minting its own', async () => {
    accept({ cashout_id: 'c1', agent_id: 'a1', amount: 250, player_name: 'Dana' });
    await cashoutService.requestCashout('p1', 'club-1', 250, undefined, 'op-fixed-1');
    expect(rpc.mock.calls[0][1].p_op_id).toBe('op-fixed-1');
  });

  it('approveCashout forwards it too', async () => {
    accept({ cashout_id: 'c1', player_id: 'p1', club_id: 'club-1', amount: 250 });
    await cashoutService.approveCashout('c1', 'a1', undefined, 'op-fixed-2');
    expect(rpc.mock.calls[0][1].p_op_id).toBe('op-fixed-2');
  });

  it('rejectCashout and cancelCashout forward it as well', async () => {
    accept({ cashout_id: 'c1', player_id: 'p1', club_id: 'club-1', amount: 250 });
    await cashoutService.rejectCashout('c1', 'a1', 'no', 'op-fixed-3');
    expect(rpc.mock.calls[0][1].p_op_id).toBe('op-fixed-3');

    rpc.mockClear();
    accept({ cashout_id: 'c2', player_id: 'p1', club_id: 'club-1', amount: 250 });
    await cashoutService.cancelCashout('c2', 'p1', 'op-fixed-4');
    expect(rpc.mock.calls[0][1].p_op_id).toBe('op-fixed-4');
  });

  it('and still mints one when nobody supplies it, so old callers stay safe', async () => {
    accept({ cashout_id: 'c1', agent_id: 'a1', amount: 250 });
    await cashoutService.requestCashout('p1', 'club-1', 250);
    expect(rpc.mock.calls[0][1].p_op_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('the sheet HOLDS its id across a failure and clears it on success', () => {
    // Both, or neither protection works: cleared on failure and a retry escrows
    // twice; never cleared and a genuinely new request replays the old one.
    expect(MODAL).toMatch(/const requestOpIdRef = useRef<string \| null>\(null\)/);
    expect(MODAL).toMatch(/if \(!requestOpIdRef\.current\) requestOpIdRef\.current = newOpId\(\)/);
    expect(MODAL).toMatch(/requestOpIdRef\.current = null;[\s\S]{0,80}if \(!isMounted\.current\)/);
    expect(MODAL).toMatch(
      /useEffect\(\(\) => \{\s*requestOpIdRef\.current = null;\s*\}, \[amount, note\]\)/
    );
  });

  it('the agent panel keys its ids by ACTION as well as cashout', () => {
    // chip_transactions_agent_wallet_op_id_uidx spans cashout_approved,
    // cashout_denied and cashout_cancelled together, so one key reused across an
    // approve and a later decline collides on the index instead of replaying -
    // and fn_cashout_release has no unique_violation handler to soften it.
    expect(PANEL).toMatch(/opIdFor = \(action: 'approve' \| 'reject', cashoutId: string\)/);
    expect(PANEL).toContain("opIdFor('approve', cashout.id)");
    expect(PANEL).toContain("opIdFor('reject', cashout.id)");
    expect(PANEL).toContain('opIdsRef.current.delete(`approve:${cashout.id}`)');
    expect(PANEL).toContain('opIdsRef.current.delete(`reject:${cashout.id}`)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a replay moved nothing, so nobody is told twice', () => {
  it('no push on a replayed request', async () => {
    accept({ replayed: true, cashout_id: 'c1', agent_id: 'a1', amount: 250 });
    await cashoutService.requestCashout('p1', 'club-1', 250, undefined, 'op-1');
    expect(push).not.toHaveBeenCalled();
  });

  it('no push on a replayed approval', async () => {
    accept({ replayed: true, cashout_id: 'c1', player_id: 'p1', amount: 250 });
    await cashoutService.approveCashout('c1', 'a1', undefined, 'op-2');
    expect(push).not.toHaveBeenCalled();
  });

  it('no push on a replayed decline', async () => {
    accept({ replayed: true, cashout_id: 'c1', player_id: 'p1', amount: 250 });
    await cashoutService.rejectCashout('c1', 'a1', 'no', 'op-3');
    expect(push).not.toHaveBeenCalled();
  });

  it('but a real request and a real approval both reach the RPC that notifies', async () => {
    // REWRITTEN 2026-08-30 (#1498). This asserted the CLIENT pushed to the
    // agent on request and to the player on approval. Both were duplicates:
    // tr_notify_agent_on_cashout raises 'cashout_request' on the INSERT and
    // fn_cashout_approve raises 'cashout_approved' inside the money
    // transaction, and trg_mirror_notification_to_push_outbox turns each into a
    // push. The client's extra send went through a transport OneSignal's
    // retirement had already killed, so the duplication never showed up.
    //
    // The property worth protecting is unchanged in spirit: a real request
    // reaches the agent and a real approval reaches the player. It is just the
    // RPC that carries it, so that is what is asserted.
    accept({ cashout_id: 'c1', agent_id: 'agent-9', amount: 250, player_name: 'Dana' });
    await cashoutService.requestCashout('p1', 'club-1', 250);
    expect(rpc.mock.calls[0][0]).toBe('fn_cashout_request');
    expect(push).not.toHaveBeenCalled();

    rpc.mockClear();
    accept({ cashout_id: 'c1', player_id: 'player-3', club_id: 'club-1', amount: 250 });
    await cashoutService.approveCashout('c1', 'a1');
    expect(rpc.mock.calls[0][0]).toBe('fn_cashout_approve');
    expect(push).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a player cannot ask for an amount the server is bound to refuse', () => {
  it('zero, negative and NaN never reach the database', async () => {
    for (const bad of [0, -5, Number.NaN]) {
      rpc.mockClear();
      await expect(cashoutService.requestCashout('p1', 'club-1', bad)).rejects.toThrow(
        /Greater Than Zero/i
      );
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('nor does a fractional cent count', async () => {
    await expect(cashoutService.requestCashout('p1', 'club-1', 1.001)).rejects.toThrow(
      /Whole Cents/i
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('the sheet refuses the same three before it touches the service', () => {
    expect(MODAL).toContain('validateCashoutAmount(amount)');
    expect(MODAL).toContain('setError(validation.error)');
    expect(MODAL).toContain("setError('That Is More Than Your Available Balance')");
    // Presets select an explicitly displayed amount at the cent quantum.
    expect(MODAL).toContain('cashoutPercentage(currentBalance, pct)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('an empty queue and a broken queue are different answers', () => {
  it('getAgentPendingCashouts throws on a read failure instead of returning []', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    await expect(cashoutService.getAgentPendingCashouts('a1', 'club-1')).rejects.toThrow(
      /permission denied/
    );
  });

  it('and returns rows normally', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          id: 'c1',
          club_id: 'club-1',
          player_id: 'p1',
          player_name: 'Dana',
          agent_id: 'a1',
          amount: 500,
          status: 'pending',
          created_at: '2026-08-25T00:00:00Z',
        },
      ],
      error: null,
    });
    const rows = await cashoutService.getAgentPendingCashouts('a1', 'club-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(500);
  });

  it('the panel now surfaces that failure, which is what makes its Retry reachable', () => {
    expect(PANEL).toContain("safeErrorMessage(err, 'Failed to load cashout requests')");
    expect(PANEL).toContain('Failed To Load Cashout Requests');
    // And a load that succeeds clears the stale banner.
    expect(PANEL).toMatch(/setCashouts\(pending\);[\s\S]{0,200}setError\(null\);/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('expireStale reads what the function actually returns', () => {
  it('an integer count, not a table of rows', async () => {
    rpc.mockResolvedValueOnce({ data: 3, error: null });
    await expect(cashoutService.expireStale(72)).resolves.toEqual({ expired: 3 });
  });

  it('zero is zero, not a crash and not a lie', async () => {
    rpc.mockResolvedValueOnce({ data: 0, error: null });
    await expect(cashoutService.expireStale()).resolves.toEqual({ expired: 0 });
  });

  it('a transport failure reports nothing expired rather than throwing in a cron', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    await expect(cashoutService.expireStale()).resolves.toEqual({ expired: 0 });
  });

  it("and 'expired' is a status the type system admits exists", () => {
    expect(SERVICE).toMatch(/\|\s*'expired'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the agent may never take chips outside the two ways Dan allows', () => {
  it('the blanket removal is still a flat refusal', async () => {
    await expect(cashoutService.canRemoveChips('a1', 'p1', 'club-1', 10)).resolves.toBe(false);
    await expect(cashoutService.removeChipsFromPlayer('a1', 'p1', 'club-1', 10)).rejects.toThrow(
      /cannot remove chips/i
    );
  });

  it('the clawback is anchored on a TRANSACTION and carries the caller op id', async () => {
    accept({ amount: 100, agent_wallet_after: 900 });
    await cashoutService.claimBackSend('club-1', 'tx-1', undefined, undefined, 'op-cb');
    const args = rpc.mock.calls[0][1];
    expect(args.p_transaction_id).toBe('tx-1');
    expect(args.p_op_id).toBe('op-cb');
    expect(args).not.toHaveProperty('p_player_id');
  });

  it('staff keep their own pull, which is a different function entirely', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true, removed: 50, balance_after: 10 } });
    await cashoutService.adminRemovePlayerChips('club-1', 'p1', 50, 'audit');
    expect(rpc.mock.calls[0][0]).toBe('fn_admin_remove_player_chips');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('two taps are one cash out', () => {
  it('the sheet locks synchronously, not on a rendered disabled attribute', () => {
    expect(MODAL).toMatch(/const submitLockRef = useRef\(false\)/);
    expect(MODAL).toMatch(/if \(submitLockRef\.current\) return;/);
    expect(MODAL).toMatch(/const cancelLockRef = useRef\(false\)/);
    expect(MODAL).toMatch(/if \(cancelLockRef\.current\) return;/);
  });

  it('the panel locks per cashout, so the other card still works', () => {
    expect(PANEL).toMatch(/const inFlightRef = useRef<Set<string>>\(new Set\(\)\)/);
    expect(PANEL).toMatch(/if \(inFlightRef\.current\.has\(cashout\.id\)\) return;/);
  });

  it('the dispute sheet locks too, and no longer swallows its failure', () => {
    expect(DISPUTE).toMatch(/const submitLockRef = useRef\(false\)/);
    expect(DISPUTE).toContain("reportError(err, 'DisputeSubmitModal.handleSubmit'");
  });

  it('and neither sheet can be closed out from under a call that is moving chips', () => {
    expect(MODAL).toMatch(/const closeIfIdle = \(\) => \{/);
    expect(MODAL).toContain('onClick={closeIfIdle}');
    expect(DISPUTE).toContain('onClick={closeIfIdle}');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('house rules the compiler cannot enforce', () => {
  const FILES: Array<[string, string]> = [
    ['CashoutService.ts', SERVICE],
    ['CashoutRequestModal.tsx', MODAL],
    ['AgentCashoutPanel.tsx', PANEL],
    ['DisputeSubmitModal.tsx', DISPUTE],
    ['CashoutRequestModal.css', read('src/components/wallet/CashoutRequestModal.css')],
    ['AgentCashoutPanel.css', read('src/components/agent/AgentCashoutPanel.css')],
  ];

  // Astral-plane characters and variation selectors: the emoji CLAUDE.md
  // section 5 rule 3 bans because SWC chokes on them. Plain BMP symbols the
  // codebase already uses on purpose (the retry arrow, the warning triangle,
  // the tick) are not emoji and stay.
  const EMOJI = /[\u{1F000}-\u{1FAFF}]|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}/u;

  it.each(FILES)('%s carries no emoji', (_name, src) => {
    expect(EMOJI.test(src)).toBe(false);
  });

  it.each(FILES)('%s has no em dash or en dash in a quoted user-facing string', (_name, src) => {
    // Comments are allowed to use them; a string a player can read is not,
    // because it bypasses formatPopupText when it renders inline.
    const strings = src.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) || [];
    const offenders = strings.filter((s) => /[—–]/.test(s));
    expect(offenders).toEqual([]);
  });

  it.each(FILES)('%s never formats an amount with padStart', (_name, src) => {
    expect(src).not.toContain('padStart(');
  });

  it('every chip amount on screen goes through toLocaleString', () => {
    expect(MODAL).toContain('currentBalance.toLocaleString()');
    expect(MODAL).toContain('cashout.amount.toLocaleString()');
    expect(PANEL).toContain('cashout.amount.toLocaleString()');
  });

  it('Supabase reads use maybeSingle, never single', () => {
    expect(SERVICE).toContain('.maybeSingle()');
    expect(SERVICE).not.toMatch(/\.single\(\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the escrow story the screens tell matches the one the server runs', () => {
  it('the sheet promises a cancel any time before approval, and no false clock', () => {
    // fn_cashout_release accepts a player's cancel for as long as the request is
    // pending. The ten minute countdown that used to be DRAWN here belongs to
    // fn_agent_wallet_claim_back and a completely different pot of money.
    //
    // Comments stripped first, deliberately. The header explains at length why
    // that countdown was wrong, and an assertion that cannot tell the
    // explanation from the offence would force the next person to delete the
    // explanation to make the test green.
    const code = MODAL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(MODAL).toContain('You Can Cancel');
    expect(code).not.toMatch(/Cancel Window/);
    expect(code).not.toMatch(/\b10\s*\*\s*60\s*\*\s*1000\b/);
  });

  it('the panel says where the chips go, in both directions', () => {
    expect(PANEL).toContain('Approving Moves Them Into Your Agent Wallet');
    expect(PANEL).toContain('Returns Them To The Player');
  });

  it('the panel scopes its realtime filter to a RESOLVED club uuid', () => {
    // club_id=eq.25450 against a uuid column matches nothing, which silently
    // turned realtime off for every club addressed by its 6-digit code.
    expect(PANEL).toContain('await resolveClubUUID(clubId)');
    expect(PANEL).toContain('`club_id=eq.${resolved}`');
    expect(PANEL).not.toContain('`club_id=eq.${clubId}`');
  });
});
