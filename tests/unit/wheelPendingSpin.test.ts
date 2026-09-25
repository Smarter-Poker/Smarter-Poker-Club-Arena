/**
 * A saved wheel spin that cannot be read back is discarded, never thrown.
 *
 * The save lives in localStorage and the wheel reads it on every load, so a
 * reader that throws strands the wheel on "Reconnecting" for good. A wheel spin
 * settles atomically on the server, so dropping an unreadable save loses only
 * the reveal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/errorReporter', () => ({ reportError }));

import {
  clearWheelPending,
  readWheelPending,
  saveWheelPending,
  type WheelPendingSpin,
} from '../../src/utils/wheelPendingSpin';

const USER = 'player';
const CLUB = '00000000-0000-0000-0000-000000000003';
const KEY = `diamond-wheel-pending:v1:${USER}:${CLUB}`;
const attempt: WheelPendingSpin = {
  userId: USER,
  clubId: CLUB,
  mode: 'paid',
  commitId: 'd1000000-0000-4000-8000-000000000001',
  commitHash: 'a'.repeat(64),
  clientSeed: 'seed',
  ticketId: null,
  contractVersion: 3,
  entryDiamonds: 100,
};

beforeEach(() => {
  localStorage.clear();
  reportError.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('readWheelPending', () => {
  it('returns a valid saved spin unchanged', () => {
    saveWheelPending(attempt);
    expect(readWheelPending(USER, CLUB)).toEqual(attempt);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('discards corrupt JSON instead of throwing, and reports it', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readWheelPending(USER, CLUB)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('discards a shape this client does not send instead of throwing', () => {
    localStorage.setItem(KEY, JSON.stringify({ ...attempt, commitId: 'not-a-ticket' }));
    expect(readWheelPending(USER, CLUB)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    localStorage.setItem(KEY, JSON.stringify({ ...attempt, contractVersion: 9 }));
    expect(readWheelPending(USER, CLUB)).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('reads nothing when storage refuses to be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readWheelPending(USER, CLUB)).toBeNull();
  });

  it('clearing a corrupt save does not throw', () => {
    localStorage.setItem(KEY, '{not json');
    expect(() => clearWheelPending(attempt)).not.toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('never touches another player or club', () => {
    saveWheelPending(attempt);
    localStorage.setItem(`diamond-wheel-pending:v1:${USER}:other`, '{not json');
    expect(readWheelPending(USER, 'other')).toBeNull();
    expect(readWheelPending(USER, CLUB)).toEqual(attempt);
  });
});
