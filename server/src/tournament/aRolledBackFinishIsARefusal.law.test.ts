/**
 * A FINISH THE DATABASE ROLLED BACK IS A REFUSAL, NOT AN UNKNOWN (2026-09-26)
 *
 * 02:30 UTC: 85c5885a (100 Chip Spin PLO4, 300.00) and later 66e80c08 were
 * each asked to finish five times while the platform's single finish lane was
 * held. Every attempt, and the serialized resolver after them, was answered by
 * PostgreSQL with 55P03 (lock timeout). None of them could have committed. The
 * engine still reported "Tournament completion may have committed but its
 * immutable receipt could not be resolved", fenced the manager and stopped
 * every table engine of the event. Both completed on their own path an hour
 * later, paid exactly once.
 *
 * A response carrying a SQLSTATE is the database stating that this attempt
 * rolled back. When every attempt says so, nothing of this request can still
 * commit, and the finish is a refusal the manager retries. A lost response, or
 * a resolver that reports a commit, stays unknown and fail-closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), verify: vi.fn() }));

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('./completionSettlementReceipt.js', () => ({
  verifyTournamentCompletionReceipt: mocks.verify,
}));

import {
  databaseStatedRollback,
  requestTournamentTerminalReceipt,
  TerminalSettlementOutcomeUnknownError,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';

const TOURNAMENT_ID = '85c5885a-79b9-4be3-9782-1caddd20520b';
const WINNER_ID = '311733e3-1801-4200-8459-4b1983d61a64';
const LOCK_TIMEOUT = { code: '55P03', message: 'canceling statement due to lock timeout' };
const LOST = { code: '', message: 'Error: supabase_timeout' };
const noWait = async (): Promise<void> => undefined;
const finish = () =>
  requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
    attempts: 5,
    wait: noWait,
  });

describe('a finish the database rolled back is a refusal, not an unknown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockReturnValue(null);
  });

  it('the 02:30 shape: five lock timeouts and a resolver lock timeout are a retryable refusal', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: LOCK_TIMEOUT });
    const outcome = finish();
    await expect(outcome).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    await expect(finish()).rejects.toThrow(/rolled back by the database, so none committed/);
    // The resolver was still asked first: a committed receipt would have won.
    expect(mocks.rpc).toHaveBeenCalledWith(
      'fn_resolve_tournament_terminal_outcome',
      expect.objectContaining({ p_tournament_id: TOURNAMENT_ID })
    );
  });

  it('NEGATIVE: one lost response among the refusals keeps it unknown', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: LOCK_TIMEOUT })
      .mockResolvedValueOnce({ data: null, error: LOST })
      .mockResolvedValue({ data: null, error: LOCK_TIMEOUT });
    await expect(finish()).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
  });

  it('NEGATIVE: a thrown transport failure keeps it unknown', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new Error('supabase_timeout'))
      .mockResolvedValue({ data: null, error: LOCK_TIMEOUT });
    await expect(finish()).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
  });

  it('NEGATIVE: a resolver that reports a commit it cannot prove keeps it unknown', async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'fn_resolve_tournament_terminal_outcome'
        ? {
            data: {
              ok: true,
              terminal_committed: true,
              definitively_not_committed: false,
              status: 'COMPLETED',
              mode: 'places',
              tournament_id: TOURNAMENT_ID,
              receipt: { unverifiable: true },
            },
            error: null,
          }
        : { data: null, error: LOCK_TIMEOUT }
    );
    await expect(finish()).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
  });

  it('NEGATIVE: a success whose receipt cannot be verified keeps it unknown', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { some: 'receipt' }, error: null })
      .mockResolvedValue({ data: null, error: LOCK_TIMEOUT });
    await expect(finish()).rejects.toBeInstanceOf(TerminalSettlementOutcomeUnknownError);
  });

  it('only a SQLSTATE or a PostgREST code is the database stating a rollback', () => {
    expect(databaseStatedRollback(LOCK_TIMEOUT)).toBe(true);
    expect(databaseStatedRollback({ code: '40P01', message: 'deadlock detected' })).toBe(true);
    expect(databaseStatedRollback({ code: 'PGRST002', message: 'schema cache' })).toBe(true);
    expect(databaseStatedRollback(LOST)).toBe(false);
    expect(databaseStatedRollback({ message: 'fetch failed' })).toBe(false);
    expect(databaseStatedRollback({ code: 502 })).toBe(false);
    expect(databaseStatedRollback(null)).toBe(false);
    expect(databaseStatedRollback(new Error('supabase_timeout'))).toBe(false);
  });
});
