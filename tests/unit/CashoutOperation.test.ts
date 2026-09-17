import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import { CASHOUT_IDS as ID, cashoutV2Receipt, cashoutLookupEnvelope } from '../helpers/cashoutV2Receipt';
const account = vi.hoisted(() => ({ userId: null as string | null,
  auth: undefined as undefined | ((event: { payload: { isAuthenticated: boolean; userId?: string } }) => void),
}));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({
  loaded: !!account.userId, authenticated: !!account.userId, userId: account.userId,
}) }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: {
  emit: vi.fn(), subscribe: vi.fn((name, handler) => { if (name === 'AUTH_STATE_CHANGED') account.auth = handler; return vi.fn(); }),
} }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/strictClubIdResolver', () => ({ resolveClubUUIDStrict: vi.fn() }));
import { resolveClubUUIDStrict } from '../../src/utils/strictClubIdResolver';
import { prepareCashoutOperation, captureCashoutStart, captureCashoutReceiptCheck, recoverCashoutOperation, confirmCashoutOperation, runCashoutOperation as dispatchCashoutOperation, type CashoutStart, type CashoutKind } from '../../src/services/CashoutOperation';
import { reserveAgentWalletOperation } from '../../src/services/AgentWalletIntent';
import { supabase } from '../../src/lib/supabase';
const rpc = vi.fn(); // Financial transition transport only; lookup is separately asserted.
const lookup = vi.fn();
const transport = vi.mocked(supabase.rpc);
const intent = { userId: ID.player, playerId: ID.player, clubId: ID.club, targetId: ID.player,
  kind: 'cashout_request' as const, amount: 250, isCurrent: () => true };
const legacyKey = 'smarter-poker:agent-wallet-operation:v1:' + createHash('sha256').update(JSON.stringify([
  ID.player, ID.club, ID.player, 'cashout_request', 'club_chips', '250.00', '',
])).digest('hex');
const historyKey = legacyKey.replace('agent-wallet-operation:v1:', 'cashout-generations:v2:');
function history() { return JSON.parse(localStorage.getItem(historyKey)!); }
function signIn(value: string | null) {
  account.userId = value;
  account.auth?.({ payload: { isAuthenticated: !!value, userId: value ?? undefined } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function receipt(args: any, options: Parameters<typeof cashoutV2Receipt>[1] = {}, kind: 'hold' | 'cancellation' = 'hold') {
  return { data: { ...cashoutV2Receipt(kind, { amount: Number(args.p_amount), ...options }), op_id: args.p_op_id }, error: null };
}
// Explicit caller ordering used in these storage cases. A separate test below
// calls the raw dispatch API to prove it cannot skip the authoritative lookup.
async function runCashoutOperation<K extends CashoutKind>(captured: CashoutStart<K>) {
  const result = await recoverCashoutOperation(captured);
  return result.found ? result.result : dispatchCashoutOperation(captured);
}
async function start(value = intent) { return captureCashoutStart(await prepareCashoutOperation(value)); }
beforeEach(() => {
  signIn(null); signIn(ID.player);
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(resolveClubUUIDStrict).mockReset().mockResolvedValue(ID.club);
  lookup.mockReset().mockImplementation(async (_name, args) => ({ data: cashoutLookupEnvelope(args), error: null }));
  transport.mockReset().mockImplementation((name, args) =>
    (name === 'fn_cashout_operation_receipt_v2' ? lookup(name, args) : rpc(name, args)) as never);
  rpc.mockReset().mockImplementation(async (_name, args) => receipt(args) as never);
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (key: string, _options: unknown, fn: () => unknown) => {
      const next = (locks.get(key) ?? Promise.resolve()).then(fn);
      locks.set(key, next.catch(() => undefined));
      return next;
    },
  } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// These unit cases exercise real wrapper/storage/service imports and strict
// receipt parsing. Their serialized lock shim is NOT native multi-page proof.
describe('prepared cashout generation and exact service receipts', () => {
  it('retains an unknown operation and retries only on another explicit captured start', async () => {
    rpc.mockRejectedValueOnce(new Error('Response Lost'));
    await expect(runCashoutOperation(await start())).rejects.toThrow(/Response Was Lost/);
    expect(rpc).toHaveBeenCalledTimes(1);
    const operation = rpc.mock.calls[0][1]!.p_op_id;
    expect(history().generations[0].acknowledged).toBe(false);
    expect(sessionStorage.getItem(historyKey)).not.toBeNull();
    await runCashoutOperation(await start());
    expect(rpc.mock.calls[1][1]!.p_op_id).toBe(operation);
    expect(history().generations[0].acknowledged).toBe(true);
    expect(localStorage.getItem(legacyKey)).toMatch(/^cashout-generations:v2:/);
    expect(sessionStorage.getItem(historyKey)).toBeNull();
  });

  it('keeps a captured G1 behind a completed G2 without falling forward or minting G3', async () => {
    const prepared = await prepareCashoutOperation(intent);
    const delayed = captureCashoutStart(prepared);
    await runCashoutOperation(captureCashoutStart(prepared));
    const first = rpc.mock.calls[0][1]!.p_op_id;
    await runCashoutOperation(await start());
    const second = rpc.mock.calls[1][1]!.p_op_id;
    expect(second).not.toBe(first);
    lookup.mockImplementationOnce(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
      { ...cashoutV2Receipt('hold', { replayed: true, currentStatus: 'approved' }), op_id: first }), error: null }));
    expect((await runCashoutOperation(delayed)).status).toBe('approved');
    expect(lookup.mock.calls[2][1]!.p_op_id).toBe(first);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(history().head).toBe(2);
    expect(history().generations.map((item: any) => item.operationId)).toEqual([first, second]);
    expect(history().generations[0].starts).toHaveLength(2);
  });

  it('refuses an unprepared gesture while an alias is unresolved', async () => {
    const gate = deferred<string>();
    vi.mocked(resolveClubUUIDStrict).mockReturnValueOnce(gate.promise);
    const preparing = prepareCashoutOperation({ ...intent, clubId: 'slow-alias' });
    expect(() => captureCashoutStart({ kind: 'cashout_request', clubId: ID.club } as never)).toThrow(/Prepare/);
    expect(rpc).not.toHaveBeenCalled();
    gate.resolve(ID.club);
    await runCashoutOperation(captureCashoutStart(await preparing));
    expect(rpc.mock.calls[0][1]!.p_club_id).toBe(ID.club);
  });

  it('a late exact G1 acknowledgment preserves an admitted G2 live session pointer and unacknowledged history', async () => {
    const prepared = await prepareCashoutOperation(intent);
    const delayed = captureCashoutStart(prepared);
    await runCashoutOperation(captureCashoutStart(prepared));
    const first = rpc.mock.calls[0][1]!.p_op_id;
    const response = deferred<any>();
    lookup.mockReturnValueOnce(response.promise);
    const oldRecovery = recoverCashoutOperation(delayed);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    const oldPointer = JSON.parse(sessionStorage.getItem(historyKey)!);
    // Model another tab with an empty session while retaining shared history.
    // This shim is source qualification coverage, not a native multi-page run.
    sessionStorage.removeItem(historyKey);
    const newer = await start();
    expect(await recoverCashoutOperation(newer)).toEqual({ found: false });
    const newPointerRaw = sessionStorage.getItem(historyKey);
    const newerBefore = history().generations[1];
    expect(JSON.parse(newPointerRaw!).generation).toBe(2);
    expect(newerBefore.acknowledged).toBe(false);
    expect(newerBefore.starts).toHaveLength(1);
    expect(newerBefore.starts[0].acknowledged).toBe(false);
    response.resolve({ data: cashoutLookupEnvelope(lookup.mock.calls[1][1],
      { ...cashoutV2Receipt('hold', { replayed: true }), op_id: first }), error: null });
    expect(await oldRecovery).toMatchObject({ found: true });
    expect(sessionStorage.getItem(historyKey)).toBe(newPointerRaw);
    expect(history().head).toBe(2);
    expect(history().generations[1]).toEqual(newerBefore);
    expect(history().generations[0].starts.find((item: any) => item.startId === oldPointer.startId).acknowledged).toBe(true);
    expect(history().generations).toHaveLength(2);
    expect(rpc).toHaveBeenCalledOnce();
    await dispatchCashoutOperation(newer);
    expect(sessionStorage.getItem(historyKey)).toBeNull();
  });

  it('coalesces only actual overlapping service calls, while binding both starts durably', async () => {
    const gate = deferred<any>();
    rpc.mockImplementationOnce(() => gate.promise as never);
    const prepared = await prepareCashoutOperation(intent);
    const one = runCashoutOperation(captureCashoutStart(prepared));
    const two = runCashoutOperation(captureCashoutStart(prepared));
    await vi.waitFor(() => expect(history().generations[0].starts).toHaveLength(2));
    expect(rpc).toHaveBeenCalledTimes(1);
    gate.resolve(receipt(rpc.mock.calls[0][1]));
    await Promise.all([one, two]);
    expect(history().generations[0].starts.every((item: any) => item.acknowledged)).toBe(true);
    expect(sessionStorage.getItem(historyKey)).toBeNull();
  });

  it('a fresh view recovers the same UUID while an old retired response is pending, and old cleanup cannot delete its submission', async () => {
    let oldCurrent = true;
    const oldResponse = deferred<any>();
    const newResponse = deferred<any>();
    rpc.mockImplementationOnce(() => oldResponse.promise as never).mockImplementationOnce(() => newResponse.promise as never);
    const old = runCashoutOperation(await start({ ...intent, isCurrent: () => oldCurrent }));
    const oldRefusal = expect(old).rejects.toThrow(/Changed/);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    oldCurrent = false;
    const freshPrepared = await prepareCashoutOperation(intent);
    const fresh = runCashoutOperation(captureCashoutStart(freshPrepared));
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[1][1]!.p_op_id).toBe(rpc.mock.calls[0][1]!.p_op_id);
    oldResponse.resolve(receipt(rpc.mock.calls[0][1]));
    await oldRefusal;
    const overlapping = runCashoutOperation(captureCashoutStart(freshPrepared));
    await vi.waitFor(() => expect(history().generations[0].starts).toHaveLength(3));
    expect(rpc).toHaveBeenCalledTimes(2);
    newResponse.resolve(receipt(rpc.mock.calls[1][1], { replayed: true }));
    await Promise.all([fresh, overlapping]);
  });

  it('does not treat arbitrary success or a stored tombstone as financial proof', async () => {
    rpc.mockResolvedValueOnce({ data: { success: true }, error: null } as never);
    await expect(runCashoutOperation(await start())).rejects.toThrow(/Receipt Was Not Confirmed/);
    expect(history().generations[0].acknowledged).toBe(false);
    await runCashoutOperation(await start());
    await runCashoutOperation(await start());
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('terminal cancellation retains its operation after acknowledgment', async () => {
    rpc.mockImplementation(async (_name, args) => receipt(args, {}, 'cancellation') as never);
    const terminal = { ...intent, targetId: ID.cashout, kind: 'cashout_cancel' as const };
    await runCashoutOperation(captureCashoutStart(await prepareCashoutOperation(terminal)));
    const original = rpc.mock.calls[0][1]!.p_op_id;
    lookup.mockImplementationOnce(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
      { ...cashoutV2Receipt('cancellation', { replayed: true }), op_id: original }), error: null }));
    await runCashoutOperation(captureCashoutStart(await prepareCashoutOperation(terminal)));
    expect(lookup.mock.calls[1][1]!.p_op_id).toBe(original);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('refuses an account A to B to A change during preparation without a render', async () => {
    const gate = deferred<string>();
    vi.mocked(resolveClubUUIDStrict).mockReturnValueOnce(gate.promise);
    const pending = prepareCashoutOperation(intent);
    signIn(ID.other); signIn(ID.player); gate.resolve(ID.club);
    await expect(pending).rejects.toThrow(/Changed/);
    expect(rpc).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('refuses obsolete input or read epoch before dispatch and keeps the selected operation', async () => {
    let current = true;
    const captured = await start({ ...intent, isCurrent: () => current });
    const operation = history().generations[0].operationId;
    current = false;
    await expect(runCashoutOperation(captured)).rejects.toThrow(/Changed/);
    expect(history().generations[0].operationId).toBe(operation);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses staff self-actions and unsupported cancellation notes before storage or RPC', async () => {
    await expect(prepareCashoutOperation({ ...intent, targetId: ID.cashout, kind: 'cashout_approve' })).rejects.toThrow(/Original Player/);
    await expect(prepareCashoutOperation({ ...intent, targetId: ID.cashout, kind: 'cashout_cancel', note: 'different' })).rejects.toThrow(/Original Player/);
    await expect(reserveAgentWalletOperation(intent)).rejects.toThrow(/Prepare/);
    expect(rpc).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
  });
});

describe('legacy migration and storage interruption', () => {
  it('adopts the exact legacy operation and prevents an empty-session old client from reserving another UUID', async () => {
    const legacyOperation = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
    localStorage.setItem(legacyKey, legacyOperation);
    sessionStorage.setItem(legacyKey, legacyOperation.toUpperCase());
    await runCashoutOperation(await start());
    expect(rpc.mock.calls[0][1]!.p_op_id).toBe(legacyOperation);
    expect(history().generations[0].operationId).toBe(legacyOperation);
    expect(localStorage.getItem(legacyKey)).not.toBe(legacyOperation);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });

  it('refuses conflicting saved legacy UUIDs without discarding either one', async () => {
    localStorage.setItem(legacyKey, ID.operation); sessionStorage.setItem(legacyKey, ID.other);
    await expect(prepareCashoutOperation(intent)).rejects.toThrow(/Saved Cashout Identity/);
    expect(localStorage.getItem(legacyKey)).toBe(ID.operation);
    expect(sessionStorage.getItem(legacyKey)).toBe(ID.other);
    expect(localStorage.getItem(historyKey)).toBeNull(); expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['initializing', 'marker', 'active', 'start', 'pointer'])(
    'interruption after %s write retains the original UUID or refuses before dispatch', async phase => {
      localStorage.setItem(legacyKey, ID.operation);
      const original = Storage.prototype.setItem;
      let faulted = false;
      const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
        original.call(this, key, value);
        const data = key === historyKey ? JSON.parse(value) : null;
        const matches = phase === 'marker' ? key === legacyKey && value.startsWith('cashout-generations:v2:')
          : phase === 'pointer' ? this === sessionStorage && key === historyKey
          : this === localStorage && key === historyKey && (phase === 'initializing' ? data.state === 'initializing'
            : phase === 'active' ? data.state === 'active' && !data.generations[0].starts.length
              : data.generations?.[0]?.starts.length > 0);
        if (!faulted && matches) { faulted = true; throw new Error('Interrupted Storage Write'); }
      });
      await expect((async () => runCashoutOperation(await start()))()).rejects.toThrow(/Interrupted Storage Write/);
      expect(faulted).toBe(true); expect(rpc).not.toHaveBeenCalled();
      fault.mockRestore();
      await runCashoutOperation(await start());
      expect(rpc.mock.calls[0][1]!.p_op_id).toBe(ID.operation);
      expect(history().generations[0].operationId).toBe(ID.operation);
    }
  );

  it('an acknowledgment write failure preserves the verified result and the same explicit replay identity', async () => {
    const original = Storage.prototype.setItem;
    let faulted = false;
    const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      original.call(this, key, value);
      if (!faulted && this === localStorage && key === historyKey && JSON.parse(value).generations[0].acknowledged) {
        faulted = true; throw new Error('Acknowledgment Readback Interrupted');
      }
    });
    expect((await runCashoutOperation(await start())).status).toBe('pending');
    expect(sessionStorage.getItem(historyKey)).not.toBeNull();
    const first = rpc.mock.calls[0][1]!.p_op_id;
    fault.mockRestore();
    await runCashoutOperation(await start());
    expect(rpc.mock.calls[1][1]!.p_op_id).toBe(first);
  });

  it.each(['marker', 'history'])('missing active %s refuses instead of creating another operation', async missing => {
    rpc.mockRejectedValueOnce(new Error('Lost'));
    await expect(runCashoutOperation(await start())).rejects.toThrow();
    localStorage.removeItem(missing === 'marker' ? legacyKey : historyKey);
    await expect(prepareCashoutOperation(intent)).rejects.toThrow(/Saved Cashout Identity/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('exact original operation recovery before any new payment', () => {
  it('confirmation observes the original hold again and recovers another tab outcome without a payer', async () => {
    const captured = await start();
    expect(await recoverCashoutOperation(captured)).toEqual({ found: false });
    const original = lookup.mock.calls[0][1];
    lookup.mockImplementationOnce(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
      { ...cashoutV2Receipt('hold', { replayed: true, currentStatus: 'approved' }), op_id: original.p_op_id }), error: null }));
    expect(await confirmCashoutOperation(captured)).toMatchObject({ found: true, result: { status: 'approved' } });
    expect(await dispatchCashoutOperation(captured)).toMatchObject({ status: 'approved' });
    expect(lookup.mock.calls[1][1]).toEqual(original);
    expect(lookup).toHaveBeenCalledTimes(2); expect(rpc).not.toHaveBeenCalled();
    expect(history().head).toBe(1); expect(history().generations[0].starts).toHaveLength(1);
  });

  it('confirmation synchronously revokes cached absence and shares an unknown result without dispatch or automatic lookup retry', async () => {
    const captured = await start();
    await recoverCashoutOperation(captured);
    const response = deferred<any>(); lookup.mockReturnValueOnce(response.promise);
    const confirming = confirmCashoutOperation(captured);
    const repeated = confirmCashoutOperation(captured);
    const recovery = recoverCashoutOperation(captured);
    const refusals = [confirming, repeated, recovery].map(value => expect(value).rejects.toThrow(/Could Not Be Verified/));
    await expect(dispatchCashoutOperation(captured)).rejects.toThrow(/Check The Exact/);
    response.resolve({ data: null, error: { message: 'Outcome Unavailable' } });
    await Promise.all(refusals);
    await expect(dispatchCashoutOperation(captured)).rejects.toThrow(/Check The Exact/);
    await expect(confirmCashoutOperation(captured)).rejects.toThrow(/Could Not Be Verified/);
    await expect(recoverCashoutOperation(captured)).rejects.toThrow(/Could Not Be Verified/);
    expect(lookup).toHaveBeenCalledTimes(2); expect(rpc).not.toHaveBeenCalled();
  });

  it('exact confirmation absence allows only the original operation and cannot re-observe after execution starts', async () => {
    const captured = await start();
    await recoverCashoutOperation(captured);
    expect(await confirmCashoutOperation(captured)).toEqual({ found: false });
    const response = deferred<any>(); rpc.mockReturnValueOnce(response.promise);
    const running = dispatchCashoutOperation(captured);
    await expect(confirmCashoutOperation(captured)).rejects.toThrow(/Confirmation Could Not Be Verified/);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0][1].p_op_id).toBe(lookup.mock.calls[0][1].p_op_id);
    response.resolve(receipt(rpc.mock.calls[0][1])); await running;
    expect(lookup).toHaveBeenCalledTimes(2); expect(rpc).toHaveBeenCalledOnce();
  });

  it('confirmation cannot acknowledge or dispatch across an account ABA', async () => {
    const captured = await start(); await recoverCashoutOperation(captured);
    const response = deferred<any>(); lookup.mockReturnValueOnce(response.promise);
    const confirming = confirmCashoutOperation(captured);
    const refused = expect(confirming).rejects.toThrow(/Changed/);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    signIn(ID.other); signIn(ID.player);
    response.resolve({ data: cashoutLookupEnvelope(lookup.mock.calls[1][1],
      { ...cashoutV2Receipt('hold', { replayed: true }), op_id: lookup.mock.calls[1][1].p_op_id }), error: null });
    await refused;
    await expect(dispatchCashoutOperation(captured)).rejects.toThrow(/Changed/);
    expect(history().generations[0].acknowledged).toBe(false); expect(rpc).not.toHaveBeenCalled();
  });

  it('requires a completed authoritative lookup on the same opaque start', async () => {
    const captured = await start();
    await expect(dispatchCashoutOperation(captured)).rejects.toThrow(/Check The Exact/);
    expect(lookup).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
    await recoverCashoutOperation(captured);
    await dispatchCashoutOperation(captured);
    expect(lookup).toHaveBeenCalledOnce(); expect(rpc).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0][1].p_op_id).toBe(rpc.mock.calls[0][1].p_op_id);
  });

  it('recovers the prior canonical hold and current terminal DTO without a second payer', async () => {
    rpc.mockRejectedValueOnce(new Error('Lost'));
    await expect(runCashoutOperation(await start())).rejects.toThrow(/Response Was Lost/);
    const original = rpc.mock.calls[0][1].p_op_id;
    lookup.mockImplementationOnce(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
      { ...cashoutV2Receipt('hold', { replayed: true, currentStatus: 'approved' }), op_id: original }), error: null }));
    const captured = await start();
    const recovered = await recoverCashoutOperation(captured);
    expect(recovered).toMatchObject({ found: true, result: { id: ID.cashout, status: 'approved' } });
    expect(await dispatchCashoutOperation(captured)).toMatchObject({ status: 'approved' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(history().generations[0].acknowledged).toBe(true);
  });

  it.each(['transport', 'missing', 'null', 'ambiguous', 'wrong-actor', 'wrong-action', 'wrong-operation', 'wrong-target', 'wrong-amount', 'wrong-note', 'old-receipt'])(
    'refuses %s recovery and never falls through to a financial RPC or retries that start', async failure => {
      lookup.mockImplementationOnce(async (_name, args) => {
        const data: any = cashoutLookupEnvelope(args);
        if (failure === 'transport') throw new Error('Response Lost');
        if (failure === 'missing') return { data: null, error: { code: 'PGRST202' } };
        if (failure === 'null') return { data: null, error: null };
        if (failure === 'ambiguous') data.found = undefined;
        if (failure === 'wrong-actor') data.actor_user_id = ID.other;
        if (failure === 'wrong-action') data.action = 'release';
        if (failure === 'wrong-operation') data.op_id = ID.other;
        if (failure === 'wrong-target') data.cashout_id = ID.cashout;
        if (failure === 'wrong-amount') data.amount = '250.01';
        if (failure === 'wrong-note') data.accepted_note = 'another note';
        if (failure === 'old-receipt') { data.found = true; data.receipt = { success: true, replayed: true }; }
        return { data, error: null };
      });
      const captured = await start();
      await expect(recoverCashoutOperation(captured)).rejects.toThrow(/Could Not Be Verified|Receipt Was Not Confirmed/);
      await expect(dispatchCashoutOperation(captured)).rejects.toThrow(/Check The Exact/);
      await expect(recoverCashoutOperation(captured)).rejects.toThrow();
      expect(lookup).toHaveBeenCalledOnce(); expect(rpc).not.toHaveBeenCalled();
      expect(history().generations[0].acknowledged).toBe(false);
    }
  );

  it('refuses account A to B to A during the lookup without any new payment', async () => {
    const gate = deferred<any>(); lookup.mockReturnValueOnce(gate.promise);
    const captured = await start(); const checking = recoverCashoutOperation(captured);
    const refused = expect(checking).rejects.toThrow(/Changed/);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    signIn(ID.other); signIn(ID.player);
    gate.resolve({ data: cashoutLookupEnvelope(lookup.mock.calls[0][1]), error: null });
    await refused;
    await expect(dispatchCashoutOperation(captured)).rejects.toThrow(/Changed/);
    expect(rpc).not.toHaveBeenCalled();
  });
});


describe('receipt-only checks for an exact in-view terminal intent', () => {
  it('recaptures the same generation after its row retires but cannot call a payer even after absence', async () => {
    let rowCurrent = true; let viewCurrent = true;
    const terminal = { ...intent, targetId: ID.cashout, kind: 'cashout_cancel' as const,
      isCurrent: () => rowCurrent && viewCurrent, receiptViewCurrent: () => viewCurrent };
    const original = captureCashoutStart(await prepareCashoutOperation(terminal));
    await recoverCashoutOperation(original);
    const operation = lookup.mock.calls[0][1].p_op_id;
    rowCurrent = false;
    const check = captureCashoutReceiptCheck(original, () => viewCurrent);
    expect(await recoverCashoutOperation(check)).toEqual({ found: false });
    expect(lookup.mock.calls[1][1].p_op_id).toBe(operation);
    await expect(dispatchCashoutOperation(check)).rejects.toThrow(/Only Check/);
    expect(rpc).not.toHaveBeenCalled();
    lookup.mockImplementationOnce(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
      { ...cashoutV2Receipt('cancellation', { replayed: true }), op_id: operation }), error: null }));
    const nextCheck = captureCashoutReceiptCheck(original, () => viewCurrent);
    expect(await recoverCashoutOperation(nextCheck)).toEqual({ found: true, result: true });
    await expect(dispatchCashoutOperation(nextCheck)).rejects.toThrow(/Only Check/);
    expect(rpc).not.toHaveBeenCalled();
    viewCurrent = false;
    expect(() => captureCashoutReceiptCheck(original, () => true)).toThrow(/Changed/);
    viewCurrent = true;
    expect(() => captureCashoutReceiptCheck(original, () => true)).toThrow(/Changed/);
  });

  it('account ABA cannot recapture an original terminal start under a new live view', async () => {
    const original = captureCashoutStart(await prepareCashoutOperation({ ...intent,
      targetId: ID.cashout, kind: 'cashout_cancel', receiptViewCurrent: () => true }));
    signIn(ID.other); signIn(ID.player);
    expect(() => captureCashoutReceiptCheck(original, () => true)).toThrow(/Changed/);
    expect(lookup).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });

  it('a found receipt survives acknowledgment storage failure and retains its original operation', async () => {
    const captured = await start();
    lookup.mockImplementation(async (_name, args) => ({ data: cashoutLookupEnvelope(args,
      { ...cashoutV2Receipt('hold', { replayed: true }), op_id: args.p_op_id }), error: null }));
    const originalWrite = Storage.prototype.setItem;
    const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage && key === historyKey && JSON.parse(value).generations[0].acknowledged) {
        throw new Error('Local Acknowledgment Unavailable');
      }
      originalWrite.call(this, key, value);
    });
    expect(await recoverCashoutOperation(captured)).toMatchObject({ found: true, result: { id: ID.cashout } });
    expect(sessionStorage.getItem(historyKey)).not.toBeNull();
    expect(history().generations[0].acknowledged).toBe(false);
    const operation = lookup.mock.calls[0][1].p_op_id;
    fault.mockRestore();
    await recoverCashoutOperation(await start());
    expect(lookup.mock.calls[1][1].p_op_id).toBe(operation);
    expect(rpc).not.toHaveBeenCalled();
  });
});
