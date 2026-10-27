import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => ({ userId: 'owner' }) }));
import {
  clearSessionSummary,
  dismissSessionSummary,
  peekSessionSummary,
  publishSessionSummary,
} from '../../src/services/pendingSessionSummary';
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
};
beforeEach(() => {
  clearSessionSummary();
  sessionStorage.clear();
});
describe('session result acknowledgement closes only its UI table', () => {
  it('keeps the table until acknowledgement then closes exactly once', () => {
    const close = vi.fn();
    publishSessionSummary(payload);
    expect(close).not.toHaveBeenCalled();
    dismissSessionSummary(close);
    expect(close).toHaveBeenCalledExactlyOnceWith('table', 2);
    expect(peekSessionSummary()).toBeNull();
    dismissSessionSummary(close);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('allows acknowledgement while a clearly pending cashout is still settling', () => {
    const close = vi.fn();
    publishSessionSummary({ ...payload, plPending: true });
    dismissSessionSummary(close);
    expect(peekSessionSummary()).toBeNull();
    expect(close).toHaveBeenCalledExactlyOnceWith('table', 2);
  });
});
