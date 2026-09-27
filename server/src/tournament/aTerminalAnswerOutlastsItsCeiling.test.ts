/**
 * THE TERMINAL AUTHORITY IS ASKED ON A CLIENT THAT OUTLASTS IT (2026-09-27)
 *
 * fn_complete_tournament_terminal and fn_resolve_tournament_terminal_outcome
 * run under their own 45-second statement ceiling and queue on the platform
 * finish lane. Asked on the 15-second game-data client, an attempt that
 * waited behind the lane was abandoned before the database answered, and a
 * plain refusal became "outcome unknown" (every table engine fenced). These
 * tests pin that every terminal write and resolver goes to the client whose
 * deadline is longer than that ceiling, and that its answer is still read
 * exactly as before: a SQLSTATE is a proven refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  gameRpc: vi.fn(),
  terminalRpc: vi.fn(),
  from: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: mocks.gameRpc, from: mocks.from },
  maintenanceSupabase: { rpc: mocks.terminalRpc, from: mocks.from },
}));
vi.mock('./completionSettlementReceipt.js', () => ({
  verifyTournamentCompletionReceipt: mocks.verify,
}));

import {
  requestTournamentTerminalReceipt,
  TerminalSettlementRefusedError,
} from './terminalSettlementRpc.js';

const TOURNAMENT_ID = '00000000-0000-4000-8000-00000000a001';
const WINNER_ID = '00000000-0000-4000-8000-00000000a002';
const LOCK_TIMEOUT = { code: '55P03', message: 'canceling statement due to lock timeout' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the terminal authority answers on a client that outlasts it', () => {
  it('sends every completion attempt and the resolver through the long-deadline client', async () => {
    mocks.terminalRpc.mockImplementation(async (fn: string) =>
      fn === 'fn_resolve_tournament_terminal_outcome'
        ? {
            data: {
              ok: true,
              tournament_id: TOURNAMENT_ID,
              mode: 'places',
              terminal_committed: false,
              definitively_not_committed: true,
              status: 'RUNNING',
              receipt: null,
            },
            error: null,
          }
        : { data: null, error: LOCK_TIMEOUT }
    );

    await expect(
      requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
        attempts: 3,
        wait: async () => undefined,
      })
    ).rejects.toBeInstanceOf(TerminalSettlementRefusedError);

    const called = mocks.terminalRpc.mock.calls.map((call) => call[0]);
    expect(called).toEqual([
      'fn_complete_tournament_terminal',
      'fn_complete_tournament_terminal',
      'fn_complete_tournament_terminal',
      'fn_resolve_tournament_terminal_outcome',
    ]);
    expect(mocks.gameRpc).not.toHaveBeenCalled();
  });

  it('a database refusal on every attempt and on the resolver stays a proven refusal', async () => {
    mocks.terminalRpc.mockResolvedValue({ data: null, error: LOCK_TIMEOUT });

    const outcome = requestTournamentTerminalReceipt(TOURNAMENT_ID, 'places', WINNER_ID, {
      attempts: 2,
      wait: async () => undefined,
    });

    await expect(outcome).rejects.toBeInstanceOf(TerminalSettlementRefusedError);
    await expect(outcome).rejects.toThrow(/rolled back by the database, so none committed/);
  });

  it('the long-deadline client outlasts the 45-second ceiling of both terminal functions', () => {
    const client = readFileSync(join(__dirname, '..', 'services', 'supabase', 'client.ts'), 'utf8');
    const match = /MAINTENANCE_SUPABASE_TIMEOUT_MS \?\? ([0-9_]+)\)/.exec(client);
    expect(match, 'the maintenance client deadline must stay a named literal').not.toBeNull();
    const deadlineMs = Number(match![1].replace(/_/g, ''));
    expect(deadlineMs).toBeGreaterThan(45_000);
  });
});
