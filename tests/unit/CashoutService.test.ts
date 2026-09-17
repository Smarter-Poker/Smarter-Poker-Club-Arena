/** Source-only candidate: real client parser with synthetic transport receipts. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CASHOUT_IDS as ID, cashoutV2Receipt, type FixtureCashoutKind } from '../helpers/cashoutV2Receipt';

const state = vi.hoisted(() => ({
  userId: null as string | null,
  read: { data: [] as unknown, error: null as null | { message: string } },
  queryCalls: [] as Array<[string, ...unknown[]]>,
  auth: undefined as undefined | ((event: { payload: { isAuthenticated: boolean; userId?: string } }) => void),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {
  rpc: vi.fn(),
  from: vi.fn(() => {
    const chain: any = {};
    for (const method of ['select','eq','order']) chain[method] = (...args: unknown[]) => { state.queryCalls.push([method,...args]); return chain; };
    chain.limit = async (...args: unknown[]) => { state.queryCalls.push(['limit',...args]); return state.read; };
    chain.maybeSingle = async () => ({ data: null, error: null });
    return chain;
  }),
} }));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({
  loaded: !!state.userId, authenticated: !!state.userId, userId: state.userId,
}) }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: {
  emit: vi.fn(), subscribe: vi.fn((name, handler) => { if (name === 'AUTH_STATE_CHANGED') state.auth = handler; return vi.fn(); }),
} }));
vi.mock('../../src/utils/retryAsync', () => ({ retryAsync: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn(async (id: string) => id) }));
vi.mock('../../src/services/PushNotificationService', () => ({ pushNotificationService: { sendToUser: vi.fn() } }));
import { cashoutService, captureCashoutAccountGuard, CashoutOutcomeUnknownError } from '../../src/services/CashoutService';
import { masterBus } from '../../src/core/MasterBus';
import { supabase } from '../../src/lib/supabase';
import { resolveClubUUID } from '../../src/utils/clubIdResolver';
import { pushNotificationService } from '../../src/services/PushNotificationService';
const rpc = vi.mocked(supabase.rpc);
const current = () => true;
const intent = (amount = 250, isCurrent = current) => ({ clubId: ID.club, playerId: ID.player, amount, isCurrent });
const accept = (kind: FixtureCashoutKind = 'hold', options: Parameters<typeof cashoutV2Receipt>[1] = {}) =>
  rpc.mockResolvedValueOnce({ data: cashoutV2Receipt(kind, options), error: null } as never);
function signIn(userId: string | null) {
  state.userId = userId;
  state.auth?.({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } });
}
function request(amount = 250, isCurrent = current) {
  return cashoutService.requestCashout(ID.player, ID.club, amount, undefined, ID.operation, isCurrent);
}
function act(kind: FixtureCashoutKind) {
  if (kind === 'hold') return request();
  if (kind === 'cancellation') return cashoutService.cancelCashout(ID.cashout, ID.player, ID.operation, intent());
  if (kind === 'approval') return cashoutService.approveCashout(ID.cashout, ID.agent, undefined, ID.operation, intent());
  return cashoutService.rejectCashout(ID.cashout, ID.agent, undefined, ID.operation, intent());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockReset();
  vi.mocked(resolveClubUUID).mockReset().mockImplementation(async id => id);
  state.read = { data: [], error: null }; state.queryCalls = [];
  signIn(ID.player);
});

describe('verified v2 cashier lifecycle', () => {
  it.each(['hold', 'approval', 'cancellation', 'decline'] as const)('%s requires matching canonical event and document', async kind => {
    if (kind === 'approval' || kind === 'decline') signIn(ID.agent);
    accept(kind);
    const result = await act(kind);
    expect(result).toBeTruthy();
    expect(rpc).toHaveBeenCalledExactlyOnceWith(kind === 'hold' ? 'fn_cashout_request_v2' : kind === 'approval' ? 'fn_cashout_approve_v2' : 'fn_cashout_release_v2', {
      p_club_id: ID.club, p_amount: '250.00', p_expected_actor_id: state.userId,
      p_op_id: ID.operation, p_note: null, ...(kind === 'hold' ? {} : { p_cashout_id: ID.cashout }),
    });
    expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled(); // Current request comes from the locked RPC receipt.
    expect(masterBus.emit).toHaveBeenCalledWith('BALANCE_UPDATED', expect.objectContaining({ userId: ID.player }));
    expect(masterBus.emit).not.toHaveBeenCalledWith('BALANCE_UPDATED', expect.objectContaining({ amount: expect.anything() }));
  });
  it('normalizes the immutable note and returns the actual current DTO', async () => {
    accept('hold', { note: 'Taxi' });
    const row = await cashoutService.requestCashout(ID.player, ID.club, 250, '  Taxi  ', ID.operation, current);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_note: 'Taxi' });
    expect(row).toMatchObject({ id: ID.cashout, playerId: ID.player, clubId: ID.club, agentId: ID.agent,
      amount: 250, status: 'pending', createdAt: '2026-09-15T09:00:00+00:00', updatedAt: '2026-09-15T09:00:00+00:00' });
  });
  it.each(['approved', 'cancelled', 'rejected', 'expired'] as const)('returns %s current request on a verified historical hold replay', async currentStatus => {
    accept('hold', { replayed: true, currentStatus });
    expect(await request()).toMatchObject({ status: currentStatus });
    expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
  });
  it('permits a player who is also club owner to request their own hold', async () => {
    const receipt = cashoutV2Receipt(); receipt.actor_role = receipt.cashier.actor_role = 'owner';
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(request()).resolves.toMatchObject({ playerId: ID.player });
  });
  it('retains the original key after a lost reply and sends only a caller-requested replay', async () => {
    rpc.mockRejectedValueOnce(new Error('connection lost'));
    await expect(request()).rejects.toMatchObject({ name: 'CashoutOutcomeUnknownError', operationId: ID.operation, clubId: ID.club });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(masterBus.emit).not.toHaveBeenCalled();
    accept('hold', { replayed: true });
    await request();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
  it('refuses the retired completion stub instead of fabricating success', async () => {
    await expect(cashoutService.completeCashout(ID.cashout, ID.agent)).rejects.toThrow(/Retired/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('no unverified success or silent legacy fallback', () => {
  const mutations: Array<[string, (receipt: any) => void]> = [
    ['bare legacy success', r => { for (const key of Object.keys(r)) if (key !== 'success') delete r[key]; }],
    ['missing nested document', r => { delete r.cashier; }],
    ['missing invoice identity', r => { r.invoice_id = r.cashier.invoice_id = null; }],
    ['missing source ledger identity', r => { delete r.source_ledger_id; delete r.cashier.source_ledger_id; }],
    ['wrong account', r => { r.actor_user_id = r.cashier.actor_user_id = ID.other; }],
    ['wrong club', r => { r.club_id = r.cashier.club_id = ID.otherClub; }],
    ['wrong player', r => { r.player_id = r.cashier.player_id = ID.other; }],
    ['wrong operation', r => { r.op_id = ID.other; }],
    ['wrong event phase', r => { r.event_kind = r.cashier.event_kind = 'approval'; }],
    ['false custody flag', r => { r.custody_movement_recorded = r.cashier.custody_movement_recorded = false; }],
    ['false refund flag', r => { r.refund_recorded = r.cashier.refund_recorded = true; }],
    ['different document phase', r => { r.cashier.display_state = 'approved'; }],
    ['wrong physical wallet', r => { r.ledger_from_entity_id = r.cashier.ledger_from_entity_id = ID.agent; }],
    ['hold has terminal link', r => { r.hold_event_id = r.cashier.hold_event_id = ID.holdEvent; }],
    ['amount as number', r => { r.amount = r.cashier.amount = 250; }],
    ['fractional cent', r => { r.amount = r.cashier.amount = '250.001'; }],
    ['exponential amount', r => { r.amount = r.cashier.amount = '2.5e2'; }],
    ['wrong amount', r => { r.amount = r.cashier.amount = '250.01'; }],
    ['unbounded decimal parse', r => { r.amount = r.cashier.amount = '1'.repeat(129) + '.00'; }],
    ['wallet balance not exact', r => { r.actor_wallet_after = '750.001'; }],
    ['wallet balance omitted', r => { delete r.actor_wallet_after; }],
    ['missing updated timestamp', r => { delete r.request.updated_at; }],
    ['missing nullable timestamp', r => { delete r.request.completed_at; }],
    ['impossible calendar timestamp', r => { r.issued_at = r.cashier.issued_at = '2026-02-30T09:00:00Z'; }],
    ['overlong timestamp', r => { r.issued_at = r.cashier.issued_at = '2026-09-15T09:00:00.' + '0'.repeat(129) + 'Z'; }],
    ['negative wallet balance', r => { r.actor_wallet_after = '-1.00'; }],
    ['unsafe wallet cents', r => { r.actor_wallet_after = '9007199254740992.00'; }],
    ['invalid issue timestamp', r => { r.issued_at = r.cashier.issued_at = 'yesterday'; }],
    ['invented hold earning time', r => { r.occurred_at = r.cashier.occurred_at = r.issued_at; }],
    ['different current request', r => { r.request.id = ID.other; }],
    ['different request assigned agent', r => { r.request.agent_id = ID.other; }],
    ['different request amount', r => { r.request.amount = '249.99'; }],
    ['fresh hold claims terminal state', r => { r.request.status = 'approved'; }],
    ['status alone completed', r => { r.request.status = 'completed'; }],
    ['contradictory pending update time', r => { r.request.updated_at = r.issued_at; }],
    ['pending has acknowledgment', r => { r.request.acknowledged_at = r.issued_at; }],
    ['mismatched operation note', r => { r.accepted_note = 'other operation'; }],
    ['missing accepted note', r => { delete r.accepted_note; }],
    ['mismatched accepted note', r => { r.request.player_note = 'another operation'; }],
    ['missing replay marker', r => { delete r.replayed; }],
  ];
  it.each(mutations)('refuses %s as unknown and emits nothing', async (_name, mutate) => {
    const receipt = cashoutV2Receipt(); mutate(receipt);
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(request()).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(masterBus.emit).not.toHaveBeenCalled();
    expect(pushNotificationService.sendToUser).not.toHaveBeenCalled();
  });
  it.each(['approval', 'cancellation', 'decline'] as const)('refuses %s for another request or missing original hold', async kind => {
    signIn(kind === 'cancellation' ? ID.player : ID.agent);
    const receipt = cashoutV2Receipt(kind);
    receipt.cashout_id = receipt.cashier.cashout_id = ID.other as typeof ID.cashout;
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(act(kind)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    const noHold = cashoutV2Receipt(kind); noHold.hold_event_id = noHold.cashier.hold_event_id = null;
    rpc.mockResolvedValueOnce({ data: noHold, error: null } as never);
    await expect(act(kind)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it.each(['approval','decline'] as const)('refuses a player role on %s', async kind => {
    signIn(ID.agent); const receipt = cashoutV2Receipt(kind); receipt.actor_role = receipt.cashier.actor_role = 'player';
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(act(kind)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it('never dispatches self approval', async () => {
    await expect(cashoutService.approveCashout(ID.cashout, ID.player, undefined, ID.operation, intent())).rejects.toThrow(/Own Cashout/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses an uppercase self-decline intent before club resolution or dispatch', async () => {
    const player = 'a1000000-0000-4000-8000-000000000001';
    signIn(player);
    await expect(cashoutService.rejectCashout(ID.cashout, player, undefined, ID.operation,
      { ...intent(), playerId: player.toUpperCase() })).rejects.toThrow(/Player Cancellation/);
    expect(resolveClubUUID).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled(); expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it('canonicalizes validated player, club, request and operation UUIDs before approval and receipt matching', async () => {
    const player = 'a1000000-0000-4000-8000-000000000001';
    const club = 'b1000000-0000-4000-8000-000000000004';
    const cashout = 'c1000000-0000-4000-8000-000000000006';
    const operation = 'd1000000-0000-4000-8000-000000000008';
    signIn(ID.agent);
    const original = cashoutV2Receipt('approval');
    const receipt = { ...original, player_id: player, club_id: club, cashout_id: cashout, op_id: operation,
      cashier: { ...original.cashier, player_id: player, club_id: club, cashout_id: cashout },
      request: { ...original.request, player_id: player, club_id: club, id: cashout } };
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(cashoutService.approveCashout(cashout.toUpperCase(), ID.agent, undefined,
      operation.toUpperCase(), { ...intent(), playerId: player.toUpperCase(), clubId: club.toUpperCase() })).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_cashout_approve_v2', {
      p_club_id: club, p_cashout_id: cashout, p_expected_actor_id: ID.agent,
      p_amount: '250.00', p_op_id: operation, p_note: null,
    });
    expect(masterBus.emit).toHaveBeenCalledWith('CASHOUT_APPROVED', { cashoutId: cashout, clubId: club });
    expect(masterBus.emit).toHaveBeenCalledWith('BALANCE_UPDATED', { source: 'cashout_approved', userId: player });
  });
  it('accepts an exact zero actor wallet balance', async () => {
    const receipt = cashoutV2Receipt(); receipt.actor_wallet_after = '0.00';
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(request()).resolves.toMatchObject({ status: 'pending' });
  });
  it.each(['approval','cancellation','decline'] as const)('refuses contradictory terminal state or destination for %s', async kind => {
    signIn(kind === 'cancellation' ? ID.player : ID.agent);
    const badState = cashoutV2Receipt(kind); badState.request.status = 'pending';
    rpc.mockResolvedValueOnce({ data: badState, error: null } as never);
    await expect(act(kind)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    const badDestination = cashoutV2Receipt(kind);
    badDestination.ledger_to_entity_id = badDestination.cashier.ledger_to_entity_id = ID.other as typeof ID.player;
    rpc.mockResolvedValueOnce({ data: badDestination, error: null } as never);
    await expect(act(kind)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it.each(['approval','cancellation','decline'] as const)('requires exact recorded terminal times for %s', async kind => {
    signIn(kind === 'cancellation' ? ID.player : ID.agent);
    const receipt = cashoutV2Receipt(kind); receipt.request.updated_at = receipt.request.created_at;
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(act(kind)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it('a rejected hold replay requires its actual terminal phase timestamps', async () => {
    const receipt = cashoutV2Receipt('hold', { replayed: true, currentStatus: 'rejected' }); receipt.request.cancelled_at = null;
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(request()).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
  });
  it('decline never attributes the refunded player balance to the acting agent', async () => {
    signIn(ID.agent); const receipt = cashoutV2Receipt('decline'); receipt.actor_wallet_after = '750.00';
    rpc.mockResolvedValueOnce({ data: receipt, error: null } as never);
    await expect(act('decline')).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
  });
  it.each([null, undefined, []])('keeps malformed transport envelope %s unknown', async response => {
    rpc.mockResolvedValueOnce(response as never);
    await expect(request()).rejects.toMatchObject({ name: 'CashoutOutcomeUnknownError', operationId: ID.operation });
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it('preserves an explicit server refusal without events', async () => {
    rpc.mockResolvedValueOnce({ data: { success: false, error: 'Source Hold Unverified' }, error: null } as never);
    await expect(request()).rejects.toThrow('Source Hold Unverified');
    expect(masterBus.emit).not.toHaveBeenCalled();
  });
  it.each(['returned', 'thrown'] as const)('keeps %s transport failure unknown and never calls an older RPC', async failure => {
    if (failure === 'returned') rpc.mockResolvedValueOnce({ data: null, error: { message: 'v2 missing' } } as never);
    else rpc.mockImplementationOnce(() => { throw new Error('sync transport failure'); });
    await expect(request()).rejects.toMatchObject({ name: 'CashoutOutcomeUnknownError', operationId: ID.operation });
    expect(rpc).toHaveBeenCalledTimes(1); expect(masterBus.emit).not.toHaveBeenCalled();
  });
});

describe('captured account and view authority', () => {
  it('requires retained operation, actor and caller view guard before lookup or RPC', async () => {
    await expect(cashoutService.requestCashout(ID.player, ID.club, 250)).rejects.toThrow(/Retained Operation/);
    await expect(cashoutService.approveCashout(ID.cashout, ID.agent, undefined, ID.operation)).rejects.toThrow(/Retained Operation/);
    await expect(cashoutService.requestCashout(ID.player, ID.club, 250, undefined, 'not-a-uuid', current)).rejects.toThrow();
    signIn(null); await expect(request()).rejects.toThrow(/Sign In/);
    expect(resolveClubUUID).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses a closed view before dispatch', async () => {
    await expect(request(250, () => false)).rejects.toBeInstanceOf(CashoutOutcomeUnknownError);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses an account switch while club resolution is pending', async () => {
    const pending = deferred<string>(); vi.mocked(resolveClubUUID).mockReturnValueOnce(pending.promise);
    const result = request(); signIn(ID.other); pending.resolve(ID.club);
    await expect(result).rejects.toBeInstanceOf(CashoutOutcomeUnknownError); expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['account', 'club', 'unmount', 'aba'] as const)('does not publish success after %s changes during an RPC', async change => {
    const pending = deferred<any>(); const started = deferred<void>(); let live = true;
    rpc.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const result = request(250, () => live); await started.promise;
    if (change === 'account' || change === 'aba') signIn(ID.other);
    if (change === 'aba') signIn(ID.player);
    if (change === 'club' || change === 'unmount') live = false;
    pending.resolve({ data: cashoutV2Receipt(), error: null });
    await expect(result).rejects.toMatchObject({ name: 'CashoutOutcomeUnknownError', operationId: ID.operation });
    expect(masterBus.emit).not.toHaveBeenCalled(); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('shares a permanently invalidated account guard with non-React callers', () => {
    const isCurrent = captureCashoutAccountGuard(ID.player); expect(isCurrent()).toBe(true);
    signIn(ID.other); signIn(ID.player); expect(isCurrent()).toBe(false); expect(isCurrent()).toBe(false);
    expect(() => captureCashoutAccountGuard(ID.other)).toThrow(/Sign In/);
    signIn(null); expect(() => captureCashoutAccountGuard(ID.player)).toThrow(/Sign In/);
  });
});

describe('exact cent wire amounts', () => {
  it.each([0.01, 0.29, 1.25, 308.5, 1e9])('serializes %s as exact fixed cents', async amount => {
    accept('hold', { amount }); await request(amount);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount: amount.toFixed(2) });
  });
  it.each([NaN, Infinity, -Infinity, 0, -1, 1.001, 0.30000000000000004, 1e9 + 0.01, Number.MAX_SAFE_INTEGER])('refuses %s before dispatch', async amount => {
    await expect(request(amount)).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled();
  });
});

describe('existing reads and separately scoped wallet paths', () => {
  it('returns null for an unknown request', async () => { expect(await cashoutService.getCashout(ID.cashout)).toBeNull(); });
  it('reads the scoped queue and maps names without a second read', async () => {
    signIn(ID.agent);
    rpc.mockResolvedValueOnce({ data: [{ ...cashoutV2Receipt().request, player_name: 'Dana', amount: 250 }], error: null } as never);
    const [row] = await cashoutService.getAgentPendingCashouts(ID.agent, ID.club);
    expect(row.playerName).toBe('Dana'); expect(row.amount).toBe(250);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_cashout_queue', { p_club_id: ID.club, p_status: 'pending' });
  });
  it('keeps the agent wallet send and transaction-anchored claim APIs unchanged', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true, transaction_id: ID.transaction, amount: 100 }, error: null } as never);
    await cashoutService.sendChipsToPlayer(ID.agent, ID.player, ID.club, 100, 'buy in');
    expect(rpc.mock.calls[0][0]).toBe('fn_agent_wallet_send'); expect(rpc.mock.calls[0][1]).toMatchObject({ p_destination: 'player_wallet' });
    rpc.mockResolvedValueOnce({ data: { success: true, amount: 100, agent_wallet_after: 900 }, error: null } as never);
    expect(await cashoutService.claimBackSend(ID.club, ID.transaction)).toMatchObject({ agentWalletAfter: 900 });
    expect(rpc.mock.calls[1][0]).toBe('fn_agent_wallet_claim_back');
    expect(rpc.mock.calls[1][1]).not.toHaveProperty('p_player_id');
  });
  it('preserves claim refusal and the blanket player-removal prohibition', async () => {
    rpc.mockResolvedValueOnce({ data: { success: false, error: 'Ten Minute Window Closed' }, error: null } as never);
    await expect(cashoutService.claimBackSend(ID.club, ID.transaction)).rejects.toThrow(/Ten Minute Window/);
    await expect(cashoutService.canRemoveChips(ID.agent, ID.player, ID.club, 10)).resolves.toBe(false);
    await expect(cashoutService.removeChipsFromPlayer(ID.agent, ID.player, ID.club, 10)).rejects.toThrow(/cannot remove chips/i);
  });
});

describe('request read scope and unavailable data', () => {
  it('canonicalizes an uppercase resolved club in both scoped queue readers', async () => {
    const club = 'b1000000-0000-4000-8000-000000000004';
    const row = { ...cashoutV2Receipt().request, club_id: club };
    state.read = { data: [row], error: null };
    await expect(cashoutService.getPlayerCashouts(ID.player, club.toUpperCase(), 'pending')).resolves.toEqual([
      expect.objectContaining({ clubId: club, playerId: ID.player, status: 'pending' }),
    ]);
    expect(state.queryCalls).toContainEqual(['eq', 'club_id', club]);
    signIn(ID.agent);
    rpc.mockResolvedValueOnce({ data: [row], error: null } as never);
    await expect(cashoutService.getAgentPendingCashouts(ID.agent, club.toUpperCase())).resolves.toEqual([
      expect.objectContaining({ clubId: club, playerId: ID.player, status: 'pending' }),
    ]);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('fn_cashout_queue', { p_club_id: club, p_status: 'pending' });
  });
  it('distinguishes unavailable player history from an empty result', async () => {
    state.read = { data: null, error: { message: 'permission denied' } };
    await expect(cashoutService.getPlayerCashouts(ID.player, ID.club)).rejects.toThrow('permission denied');
    state.read = { data: [], error: null };
    await expect(cashoutService.getPlayerCashouts(ID.player, ID.club)).resolves.toEqual([]);
  });
  it('filters pending before the bounded history limit and rejects inconsistent returned rows', async () => {
    state.read = { data: [cashoutV2Receipt().request], error: null };
    await expect(cashoutService.getPlayerCashouts(ID.player, ID.club, 'pending')).resolves.toHaveLength(1);
    const status = state.queryCalls.findIndex(call => call[0] === 'eq' && call[1] === 'status' && call[2] === 'pending');
    expect(status).toBeGreaterThan(-1); expect(status).toBeLessThan(state.queryCalls.findIndex(call => call[0] === 'limit'));
    state.read = { data: [cashoutV2Receipt('hold', { replayed: true, currentStatus: 'approved' }).request], error: null };
    await expect(cashoutService.getPlayerCashouts(ID.player, ID.club, 'pending')).rejects.toThrow(/Scope/);
  });
  it.each(['club','player','amount','duplicate','malformed'] as const)('rejects %s history inconsistency', async fault => {
    const row: any = { ...cashoutV2Receipt().request };
    if (fault === 'club') row.club_id = ID.otherClub;
    if (fault === 'player') row.player_id = ID.other;
    if (fault === 'amount') row.amount = '250.001';
    state.read = { data: fault === 'duplicate' ? [row,row] : fault === 'malformed' ? {} : [row], error: null };
    await expect(cashoutService.getPlayerCashouts(ID.player, ID.club)).rejects.toThrow(/Could Not Be Verified/);
  });
  it.each(['amount','club','status','duplicate','malformed'] as const)('rejects %s agent queue inconsistency', async fault => {
    signIn(ID.agent); const row: any = { ...cashoutV2Receipt().request };
    if (fault === 'amount') row.amount = 'garbage';
    if (fault === 'club') row.club_id = ID.otherClub;
    if (fault === 'status') row.status = 'approved';
    rpc.mockResolvedValueOnce({ data: fault === 'duplicate' ? [row,row] : fault === 'malformed' ? null : [row], error: null } as never);
    await expect(cashoutService.getAgentPendingCashouts(ID.agent, ID.club)).rejects.toThrow(/Could Not Be Verified/);
  });
  it('does not invent update time for a legacy queue row', async () => {
    signIn(ID.agent); const row: any = { ...cashoutV2Receipt().request }; delete row.updated_at;
    rpc.mockResolvedValueOnce({ data: [row], error: null } as never);
    const [request] = await cashoutService.getAgentPendingCashouts(ID.agent, ID.club);
    expect(request.updatedAt).toBeUndefined(); expect(request.createdAt).toBe(row.created_at);
  });
  it('refuses switched account during agent read instead of returning its old rows', async () => {
    signIn(ID.agent); const pending = deferred<any>(); const started = deferred<void>();
    rpc.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const result = cashoutService.getAgentPendingCashouts(ID.agent, ID.club); await started.promise;
    signIn(ID.other); pending.resolve({ data: [cashoutV2Receipt().request], error: null });
    await expect(result).rejects.toThrow(/Account Changed/);
  });
  it('retires browser expiry without dispatch or success-shaped zero', async () => {
    await expect(cashoutService.expireStale()).rejects.toThrow(/Browser Cashout Expiry Is Retired/);
    expect(rpc).not.toHaveBeenCalled(); expect(masterBus.emit).not.toHaveBeenCalled();
  });
});
