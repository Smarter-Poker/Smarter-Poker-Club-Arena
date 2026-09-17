/** Source-only v2 client escrow regression. Native fixtures own actual money proof. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASHOUT_IDS as ID, cashoutV2Receipt, type FixtureCashoutKind } from './helpers/cashoutV2Receipt';
const identity = vi.hoisted(() => ({ userId: '' }));
vi.mock('../src/lib/supabase', () => ({ supabase: {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  rpc: vi.fn(),
} }));
vi.mock('../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({ loaded: true, authenticated: true, userId: identity.userId }) }));
vi.mock('../src/core/MasterBus', () => ({ masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) } }));
vi.mock('../src/utils/retryAsync', () => ({ retryAsync: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../src/services/PushNotificationService', () => ({ pushNotificationService: { sendToUser: vi.fn() } }));
import { cashoutService, newOpId, CashoutOutcomeUnknownError } from '../src/services/CashoutService';
import { supabase } from '../src/lib/supabase';
import { pushNotificationService } from '../src/services/PushNotificationService';
const rpc = vi.mocked(supabase.rpc);
const push = vi.mocked(pushNotificationService.sendToUser);
const current = () => true;
const intent = { clubId: ID.club, playerId: ID.player, amount: 250, isCurrent: current };
const accept = (payload: Record<string, unknown>) => rpc.mockResolvedValueOnce({ data: { success: true, ...payload }, error: null } as never);
const receipt = (kind: FixtureCashoutKind, replayed = false) => rpc.mockResolvedValueOnce({ data: cashoutV2Receipt(kind, { replayed }), error: null } as never);
const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const SERVICE = read('src/services/CashoutService.ts');
const MODAL = read('src/components/wallet/CashoutRequestModal.tsx');
const PANEL = read('src/components/agent/AgentCashoutPanel.tsx');
const DISPUTE = read('src/components/wallet/DisputeSubmitModal.tsx');
const OPERATIONS = read('src/services/CashoutOperation.ts');
beforeEach(() => { vi.clearAllMocks(); rpc.mockReset(); identity.userId = ID.player; });

describe('the caller retains the operation identity', () => {
  it('exports UUID generation for caller-owned operations', () => {
    expect(newOpId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(newOpId()).not.toBe(newOpId());
  });
  it.each(['hold', 'approval', 'decline', 'cancellation'] as const)('forwards the exact %s operation and account/club tuple', async kind => {
    if (kind === 'approval' || kind === 'decline') identity.userId = ID.agent;
    receipt(kind);
    if (kind === 'hold') await cashoutService.requestCashout(ID.player, ID.club, 250, undefined, ID.operation, current);
    else if (kind === 'approval') await cashoutService.approveCashout(ID.cashout, ID.agent, undefined, ID.operation, intent);
    else if (kind === 'decline') await cashoutService.rejectCashout(ID.cashout, ID.agent, undefined, ID.operation, intent);
    else await cashoutService.cancelCashout(ID.cashout, ID.player, ID.operation, intent);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_op_id: ID.operation, p_club_id: ID.club, p_amount: '250.00', p_expected_actor_id: identity.userId });
  });
  it('requires a retained key and view guard rather than minting another payment attempt', async () => {
    await expect(cashoutService.requestCashout(ID.player, ID.club, 250)).rejects.toThrow(/Retained Operation/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('holds the same key after an unknown response until an explicit caller retry', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'lost' } } as never);
    await expect(cashoutService.requestCashout(ID.player, ID.club, 250, undefined, ID.operation, current)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(rpc).toHaveBeenCalledTimes(1);
    receipt('hold', true);
    await cashoutService.requestCashout(ID.player, ID.club, 250, undefined, ID.operation, current);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
  it('both views use the shared durable operation store with distinct action kinds', () => {
    expect(MODAL).toContain('await runCashoutOperation(');
    expect(MODAL).toContain("kind: 'cashout_request'");
    expect(MODAL).toContain("kind: 'cashout_cancel'");
    expect(PANEL).toContain("kind: 'cashout_approve'");
    expect(PANEL).toContain("kind: 'cashout_decline'");
    expect(OPERATIONS).toContain('await admitAgentCashoutStart(');
    expect(OPERATIONS).toContain('await acknowledgeAgentCashoutStart(admitted)');
    expect(MODAL).not.toContain('requestOpIdRef.current = null');
  });
});

describe('the server exclusively owns notification delivery', () => {
  it.each([false, true])('request and approval add no client push, replayed=%s', async replayed => {
    receipt('hold', replayed);
    await cashoutService.requestCashout(ID.player, ID.club, 250, undefined, ID.operation, current);
    identity.userId = ID.agent; receipt('approval', replayed);
    await cashoutService.approveCashout(ID.cashout, ID.agent, undefined, ID.operation, intent);
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['fn_cashout_request_v2', 'fn_cashout_approve_v2']);
    expect(push).not.toHaveBeenCalled();
  });
  it('a replayed decline adds no client push', async () => {
    identity.userId = ID.agent; receipt('decline', true);
    await cashoutService.rejectCashout(ID.cashout, ID.agent, undefined, ID.operation, intent);
    expect(push).not.toHaveBeenCalled();
  });
});

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
    expect(MODAL).toContain('cashoutPercentage(currentBalance ?? NaN, pct)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('an empty queue and a broken queue are different answers', () => {
  it('getAgentPendingCashouts throws on a read failure instead of returning []', async () => {
    identity.userId = ID.agent;
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } } as never);
    await expect(cashoutService.getAgentPendingCashouts(ID.agent, ID.club)).rejects.toThrow(
      /permission denied/
    );
  });

  it('and returns verified scoped rows normally', async () => {
    identity.userId = ID.agent;
    rpc.mockResolvedValueOnce({ data: [{ ...cashoutV2Receipt().request, amount: 500 }], error: null } as never);
    const rows = await cashoutService.getAgentPendingCashouts(ID.agent, ID.club);
    expect(rows).toHaveLength(1); expect(rows[0].amount).toBe(500);
  });

  it('the panel now surfaces that failure, which is what makes its Retry reachable', () => {
    expect(PANEL).toContain("safeErrorMessage(err, 'Failed to load cashout requests')");
    expect(PANEL).toContain('Failed To Load Cashout Requests');
    // And a load that succeeds clears the stale banner.
    expect(PANEL).toMatch(/setCashouts\(pending\);[\s\S]{0,200}setError\(null\);/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('browser expiry cannot report scheduler success', () => {
  it('refuses the service-only operation without invoking an old RPC', async () => {
    await expect(cashoutService.expireStale(72)).rejects.toThrow(/Browser Cashout Expiry Is Retired/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("retains expired as a historical request status", () => {
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
    expect(MODAL).toContain('submitLockRef.current || !isCurrent()');
    expect(MODAL).toContain('submitLockRef.current = true;');
    expect(MODAL).toMatch(/const cancelLockRef = useRef\(false\)/);
    expect(MODAL).toContain('cancelLockRef.current || !isCurrent()');
    expect(MODAL).toContain('cancelLockRef.current = true;');
  });

  it('the panel locks per cashout, so the other card still works', () => {
    expect(PANEL).toMatch(/const inFlightRef = useRef<Set<string>>\(new Set\(\)\)/);
    expect(PANEL).toContain('inFlightRef.current.has(cashout.id)');
    expect(PANEL).toContain('inFlightRef.current.add(cashout.id)');
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
    expect(MODAL).toContain('currentBalance!.toLocaleString()');
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
