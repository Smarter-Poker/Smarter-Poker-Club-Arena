import { describe, it, expect, vi, afterEach } from 'vitest';
const auth = vi.hoisted(() => ({ id: 'hero' }));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: auth.id }) }));
const payload = {
  duration: 0,
  handsPlayed: 0,
  handsWon: 0,
  totalRebuys: 1,
  profitLoss: 0,
  biggestPot: 0,
  peakStack: 0,
  tournament: {
    userId: 'hero',
    tournamentId: 'nightly-reload',
    finishPlace: 353,
    entrants: 375,
    prize: 0,
    bountyWinnings: 0,
    knockouts: 0,
    rebuys: 1,
    addOns: 1,
    buyInAmount: 35,
  },
};
afterEach(() => {
  sessionStorage.clear();
  vi.resetModules();
  auth.id = 'hero';
});
describe('an unacknowledged tournament report survives reload for its owner', () => {
  it('restores the report and keeps explicit dismissal after another reload', async () => {
    let store = await import('../../src/services/pendingSessionSummary');
    store.publishSessionSummary(payload);
    vi.resetModules();
    store = await import('../../src/services/pendingSessionSummary');
    expect(store.peekSessionSummary()?.tournament).toMatchObject(payload.tournament);
    store.dismissSessionSummary();
    vi.resetModules();
    store = await import('../../src/services/pendingSessionSummary');
    expect(store.peekSessionSummary()).toBeNull();
    store.publishSessionSummary(payload);
    expect(store.peekSessionSummary()).toBeNull();
  });
  it("never restores one account's report into another account", async () => {
    const store = await import('../../src/services/pendingSessionSummary');
    store.publishSessionSummary(payload);
    auth.id = 'another';
    expect(store.peekSessionSummary()).toBeNull();
    auth.id = 'hero';
    expect(store.peekSessionSummary()?.tournament?.finishPlace).toBe(353);
  });
});
