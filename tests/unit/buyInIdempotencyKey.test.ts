import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lockCashBuyInJournal,
  createCashBuyInJournal,
  executeCashBuyIn,
  cashBuyInReceiptMatches,
  type CashBuyInAttempt,
  type CashBuyInRpc,
} from '../../src/services/CashBuyInRecovery';

const user = 'd0000000-0000-4000-8000-000000000001';
const table = 'b0000000-0000-4000-8000-000000000001';
const id1 = 'c0000000-0000-4000-8000-000000000001';
const id2 = 'c0000000-0000-4000-8000-000000000002';
const intent = {
  p_user_id: user,
  p_table_id: table,
  p_seat_number: 2,
  p_amount: 100,
  p_auto_rebuy: false,
  p_club_id: null,
};
const storage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
};
function fixture() {
  const local = storage();
  let tail = Promise.resolve();
  const lock = <T>(_key: string, work: () => T): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
  const createId = vi.fn().mockReturnValueOnce(id1).mockReturnValue(id2);
  const tab = () => {
    const session = storage();
    const journal = createCashBuyInJournal(() => ({ local, session, lock, createId }));
    return { journal, session };
  };
  return { local, createId, tab };
}
const receipt = (attempt: CashBuyInAttempt) => ({
  status: 'confirmed',
  request: {
    door: 'atomic_table_buyin',
    user_id: user,
    table_id: table,
    seat_number: 2,
    amount: 100,
    auto_rebuy: false,
    club_id: null,
  },
});
afterEach(() => vi.useRealTimers());

describe('durable cash buy-in identity', () => {
  it('survives a new tab/reload and ignores changed amount or seat while unresolved', async () => {
    const f = fixture();
    const first = await f.tab().journal.reserve(intent);
    const reloaded = f.tab().journal;
    expect(reloaded.read(user, table)).toEqual(first.attempt);
    const retry = await reloaded.reserve({ ...intent, p_amount: 250, p_seat_number: 3 });
    expect(retry.recovered).toBe(true);
    expect(retry.attempt).toEqual(first.attempt);
    expect(f.createId).toHaveBeenCalledOnce();
  });

  it('canonicalizes UUID casing across a deep link and its returned receipt', async () => {
    const f = fixture();
    const journal = f.tab().journal;
    const first = await journal.reserve({
      ...intent,
      p_user_id: user.toUpperCase(),
      p_table_id: table.toUpperCase(),
    });
    expect(first.attempt.payload.p_user_id).toBe(user);
    expect(journal.read(user.toUpperCase(), table.toUpperCase())).toEqual(first.attempt);
    expect(cashBuyInReceiptMatches(first.attempt, receipt(first.attempt))).toBe(true);
  });

  it('reserves one identity for simultaneous browser tabs', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      f.tab().journal.reserve(intent),
      f.tab().journal.reserve(intent),
    ]);
    expect(a.attempt).toEqual(b.attempt);
    expect(f.createId).toHaveBeenCalledOnce();
  });

  it('keeps the unanswered tab identity after another tab clears the shared receipt', async () => {
    const f = fixture();
    const a = f.tab();
    const b = f.tab();
    const old = await a.journal.reserve(intent);
    await b.journal.reserve(intent);
    await a.journal.complete(old.attempt);
    const next = await a.journal.reserve(intent);
    expect(next.attempt.payload.p_idempotency_key).toBe(id2);
    expect(b.journal.read(user, table)).toEqual(old.attempt);
    await b.journal.complete(old.attempt);
    expect(a.journal.read(user, table)).toEqual(next.attempt);
    expect(f.tab().journal.read(user, table)).toEqual(next.attempt);
  });

  it('does not expire an unknown outcome or read it for another account', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = fixture();
    const journal = f.tab().journal;
    const old = await journal.reserve(intent);
    vi.setSystemTime(1000 + 365 * 86400_000);
    expect(f.tab().journal.read(user, table)).toEqual(old.attempt);
    expect(journal.read(id2, table)).toBeNull();
  });

  it('retains corrupt data and refuses to replace it with a new purchase identity', async () => {
    const f = fixture();
    const a = f.tab();
    await a.journal.reserve(intent);
    const key = [...f.local.data.keys()][0];
    f.local.setItem(key, '{broken');
    const next = f.tab();
    await expect(next.journal.reserve(intent)).rejects.toThrow();
    expect(f.local.getItem(key)).toBe('{broken');
    expect(f.createId).toHaveBeenCalledOnce();
  });

  it('fails before returning an attempt if persistence is unavailable', async () => {
    const f = fixture();
    const a = f.tab();
    f.local.setItem = () => {
      throw new Error('quota');
    };
    await expect(a.journal.reserve(intent)).rejects.toThrow('quota');
  });
});

describe('receipt recovery never silently creates another purchase', () => {
  const attempt: CashBuyInAttempt = {
    version: 1,
    createdAt: 1000,
    payload: { ...intent, p_idempotency_key: id1 },
  };
  it('checks the exact receipt before a reviewed retry and does not purchase again when confirmed', async () => {
    const rpc = vi.fn<CashBuyInRpc>().mockResolvedValue({ data: receipt(attempt), error: null });
    expect(await executeCashBuyIn(attempt, true, rpc)).toEqual({
      kind: 'confirmed',
      fromReceipt: true,
    });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][0]).toBe('fn_ca_cash_buyin_receipt');
  });

  it('only an explicit retry can resend the original full payload', async () => {
    const rpc = vi
      .fn<CashBuyInRpc>()
      .mockResolvedValueOnce({ data: { status: 'unconfirmed' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await executeCashBuyIn(attempt, true, rpc)).toEqual({
      kind: 'confirmed',
      fromReceipt: true,
    });
    expect(rpc.mock.calls[1][0]).toBe('atomic_table_buyin');
    expect(rpc.mock.calls[1][1]).toEqual(attempt.payload);
  });

  it.each(['amount', 'seat_number', 'user_id', 'table_id', 'auto_rebuy', 'club_id'])(
    'refuses a receipt with mismatched %s',
    async (field) => {
      const value = receipt(attempt);
      (value.request as any)[field] = 'different';
      expect(cashBuyInReceiptMatches(attempt, value)).toBe(false);
      const rpc = vi.fn<CashBuyInRpc>().mockResolvedValue({ data: value, error: null });
      expect((await executeCashBuyIn(attempt, true, rpc)).kind).toBe('unknown');
      expect(rpc.mock.calls.every((call) => call[0] === 'fn_ca_cash_buyin_receipt')).toBe(true);
    }
  );

  it('does not submit after ownership changes during receipt lookup', async () => {
    let current = true;
    const rpc = vi.fn<CashBuyInRpc>().mockImplementation(async () => {
      current = false;
      return { data: { status: 'unconfirmed' }, error: null };
    });
    expect((await executeCashBuyIn(attempt, true, rpc, () => current)).kind).toBe('unknown');
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][0]).toBe('fn_ca_cash_buyin_receipt');
  });

  it('a database timeout remains unknown and never causes an automatic mutation retry', async () => {
    const rpc = vi
      .fn<CashBuyInRpc>()
      .mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } })
      .mockResolvedValue({ data: { status: 'unconfirmed' }, error: null });
    expect((await executeCashBuyIn(attempt, false, rpc)).kind).toBe('unknown');
    expect(rpc.mock.calls.filter((call) => call[0] === 'atomic_table_buyin')).toHaveLength(1);
  });

  it('bounds a hung receipt read without ever starting the purchase', async () => {
    vi.useFakeTimers();
    const rpc = vi.fn<CashBuyInRpc>().mockReturnValue(new Promise(() => {}));
    const pending = executeCashBuyIn(attempt, true, rpc);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await pending).kind).toBe('unknown');
    expect(rpc.mock.calls.every((call) => call[0] === 'fn_ca_cash_buyin_receipt')).toBe(true);
    expect(rpc.mock.calls.every((call) => call[2].aborted)).toBe(true);
  });
});

describe('the browser reservation lock', () => {
  it('runs the critical section inside a read/write transaction and waits for commit', async () => {
    const request: any = {};
    const gate: any = {};
    const transaction: any = { objectStore: vi.fn(() => ({ get: vi.fn(() => gate) })) };
    const db: any = { transaction: vi.fn(() => transaction), close: vi.fn() };
    request.result = db;
    const work = vi.fn(() => 'saved');
    let complete = false;
    const pending = lockCashBuyInJournal(work, { open: () => request } as any).then((value) => {
      complete = true;
      return value;
    });
    request.onsuccess();
    expect(db.transaction).toHaveBeenCalledWith('journal', 'readwrite');
    expect(work).not.toHaveBeenCalled();
    gate.onsuccess();
    await Promise.resolve();
    expect(work).toHaveBeenCalledOnce();
    expect(complete).toBe(false);
    transaction.oncomplete();
    expect(await pending).toBe('saved');
    expect(db.close).toHaveBeenCalledOnce();
  });

  it('does not run a timed-out reservation when a blocked database opens late', async () => {
    vi.useFakeTimers();
    const request: any = {};
    const db: any = { transaction: vi.fn(), close: vi.fn() };
    request.result = db;
    const work = vi.fn();
    const pending = lockCashBuyInJournal(work, { open: () => request } as any);
    const assertion = expect(pending).rejects.toThrow('Safely Saved In Time');
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    request.onsuccess();
    expect(work).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledOnce();
  });
});
