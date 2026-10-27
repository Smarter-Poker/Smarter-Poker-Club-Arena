import { expect, it, vi } from 'vitest';
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: 'owner' }) }));
it('receives only the authenticated owner completion and does not reopen acknowledged results', async () => {
  let receive: ((event: { data: unknown }) => void) | undefined;
  const postMessage = vi.fn();
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      postMessage = postMessage;
      set onmessage(fn: typeof receive) {
        receive = fn;
      }
    }
  );
  const store = await import('../../src/services/pendingSessionSummary');
  const off = store.subscribeSessionSummary(() => {});
  const payload = {
    duration: 1,
    handsPlayed: 1,
    handsWon: 0,
    totalRebuys: 0,
    profitLoss: 3.3,
    biggestPot: 0,
    peakStack: 10,
    closeTableId: 'table',
    closeSeat: 2,
    closeOccupancyId: 'occupancy-one',
    sessionStart: 100,
  };
  receive!({ data: { owner: 'other', payload } });
  expect(store.peekSessionSummary()).toBeNull();
  receive!({ data: { owner: 'owner', payload } });
  expect(store.peekSessionSummary()?.profitLoss).toBe(3.3);
  expect(postMessage).not.toHaveBeenCalled();
  store.dismissSessionSummary();
  receive!({ data: { owner: 'owner', payload } });
  expect(store.peekSessionSummary()).toBeNull();
  receive!({ data: { owner: 'owner', payload: { ...payload, sessionStart: 200 } } });
  expect(store.peekSessionSummary()).toBeNull();
  receive!({
    data: {
      owner: 'owner',
      payload: { ...payload, closeOccupancyId: 'occupancy-two', sessionStart: 200 },
    },
  });
  expect(store.peekSessionSummary()?.closeOccupancyId).toBe('occupancy-two');
  store.clearSessionSummary();
  off();
  vi.unstubAllGlobals();
});
