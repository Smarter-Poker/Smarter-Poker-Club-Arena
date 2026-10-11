import { describe, expect, it, vi } from 'vitest';
import { readCommittedSeatStacks } from './committedSeatStackRead.js';

function fixture() {
  let clock = 0;
  let alive = true;
  const read = vi.fn();
  const progress = vi.fn();
  const report = vi.fn();
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  return {
    read,
    progress,
    report,
    sleep,
    stop: () => {
      alive = false;
    },
    options: { read, progress, report, sleep, now: () => clock, canReflect: () => alive },
    elapsed: () => clock,
  };
}

describe('the committed stack read stays inside its hand barrier', () => {
  it('recovers a schema-cache outage and returns absolute stacks exactly once', async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST002', message: 'cache unavailable' },
      })
      .mockResolvedValueOnce({ data: [{ user_id: 'player', stack: '113.25' }], error: null });
    expect(await readCommittedSeatStacks(f.options)).toEqual([
      { user_id: 'player', stack: '113.25' },
    ]);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.progress).toHaveBeenCalledOnce();
  });

  it('retries a thrown read timeout without replaying a financial operation', async () => {
    const f = fixture();
    f.read
      .mockRejectedValueOnce(new Error('supabase_timeout'))
      .mockResolvedValue({ data: [], error: null });
    expect(await readCommittedSeatStacks(f.options)).toEqual([]);
    expect(f.read).toHaveBeenCalledTimes(2);
  });

  it('discards a late successful response after authority is lost', async () => {
    const f = fixture();
    f.read.mockImplementation(async () => {
      f.stop();
      return { data: [{ user_id: 'player', stack: 999 }], error: null };
    });
    expect(await readCommittedSeatStacks(f.options)).toBeNull();
    expect(f.sleep).not.toHaveBeenCalled();
  });

  it('stops at the budget on a sustained outage and preserves the failure', async () => {
    const f = fixture();
    const error = { code: 'PGRST002', message: 'cache unavailable' };
    f.read.mockResolvedValue({ data: null, error });
    await expect(readCommittedSeatStacks(f.options)).rejects.toEqual(error);
    expect(f.elapsed()).toBe(60_000);
    expect(f.read.mock.calls.length).toBeLessThan(25);
  });

  it('never retries permission failures or invents an empty read on missing truth', async () => {
    const f = fixture();
    const error = { code: '42501', message: 'permission denied' };
    f.read.mockResolvedValue({ data: null, error });
    await expect(readCommittedSeatStacks(f.options)).rejects.toEqual(error);
    expect(f.read).toHaveBeenCalledOnce();
    f.read.mockResolvedValue({ data: null, error: null });
    await expect(readCommittedSeatStacks(f.options)).rejects.toThrow('no row set');
    f.read.mockResolvedValue({ data: [{ user_id: 'player', stack: null }], error: null });
    await expect(readCommittedSeatStacks(f.options)).rejects.toThrow('malformed');
    for (const stack of [undefined, true, '', '  ', 'NaN']) {
      f.read.mockResolvedValue({ data: [{ user_id: 'player', stack }], error: null });
      await expect(readCommittedSeatStacks(f.options)).rejects.toThrow('malformed');
    }
  });

  it('does not start another attempt if the lease is lost during backoff', async () => {
    const f = fixture();
    f.read.mockResolvedValue({ data: null, error: new Error('fetch failed') });
    f.sleep.mockImplementation(async () => f.stop());
    expect(await readCommittedSeatStacks(f.options)).toBeNull();
    expect(f.read).toHaveBeenCalledOnce();
  });
});
