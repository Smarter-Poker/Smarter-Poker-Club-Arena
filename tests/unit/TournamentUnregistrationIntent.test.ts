import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTournamentUnregistrationIntent as submit } from '../../src/services/TournamentUnregistrationIntent';
const key = 'ca:tournament-unregister:v1:player:event';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  let lane = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_key: string, fn: () => Promise<void>) => {
        const work = lane.then(fn);
        lane = work.then(
          () => undefined,
          () => undefined
        );
        return work;
      },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Original Tournament Unregistration Intent', () => {
  it('coalesces overlapping submits and permits a distinct later operation', async () => {
    const send = vi.fn(async (_requestId: string) => undefined);
    await Promise.all([submit('player', 'event', send), submit('player', 'event', send)]);
    expect(send).toHaveBeenCalledTimes(1);
    const first = send.mock.calls[0][0];
    await submit('player', 'event', send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).not.toBe(first);
  });
  it('retains the original identity across module reload after an unknown outcome', async () => {
    let original = '';
    await expect(
      submit('player', 'event', async (id) => {
        original = id;
        expect(JSON.parse(localStorage.getItem(key)!).requestId).toBe(id);
        expect(JSON.parse(sessionStorage.getItem(key)!).requestId).toBe(id);
        throw new Error('Response Lost');
      })
    ).rejects.toThrow('Response Lost');
    vi.resetModules();
    const reloaded = await import('../../src/services/TournamentUnregistrationIntent');
    const send = vi.fn(async (_requestId: string) => undefined);
    await reloaded.withTournamentUnregistrationIntent('player', 'event', send);
    expect(send).toHaveBeenCalledWith(original);
  });
  it('an older uncertain tab preserves its request without replacing a newer shared request', async () => {
    const original = crypto.randomUUID(),
      newer = crypto.randomUUID();
    const shared = JSON.stringify({ requestId: newer, state: 'pending' });
    localStorage.setItem(key, shared);
    sessionStorage.setItem(key, JSON.stringify({ requestId: original, state: 'pending' }));
    const send = vi.fn(async (_requestId: string) => undefined);
    await submit('player', 'event', send);
    expect(send).toHaveBeenCalledWith(original);
    expect(localStorage.getItem(key)).toBe(shared);
  });
  it('storage failure prevents the financial request', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('Storage Failed');
      },
    });
    const send = vi.fn(async (_requestId: string) => undefined);
    await expect(submit('player', 'event', send)).rejects.toThrow('Storage Failed');
    expect(send).not.toHaveBeenCalled();
  });
});
