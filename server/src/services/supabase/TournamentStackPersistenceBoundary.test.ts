import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  reportError: vi.fn(),
  raiseFinancialAlert: vi.fn(),
}));

vi.mock('./client.js', () => ({
  supabase: { rpc: mock.rpc, from: mock.from },
}));
vi.mock('../errorReporter.js', () => ({ reportError: mock.reportError }));
vi.mock('../financialAlerts.js', () => ({ raiseFinancialAlert: mock.raiseFinancialAlert }));

import { STACK_WRITE_RETRY_DELAYS_MS, syncStacks } from './tables.js';

const TABLE_ID = '00000000-0000-4000-8000-000000000001';
const TOURNAMENT_ID = '00000000-0000-4000-8000-000000000002';
const PLAYER_A = '00000000-0000-4000-8000-000000000003';
const PLAYER_B = '00000000-0000-4000-8000-000000000004';

const players = [
  { user_id: PLAYER_A, stack: 0, stack_before: 1_000 },
  { user_id: PLAYER_B, stack: 3_000, stack_before: 2_000 },
];

const exactReceipt = {
  success: true,
  written: { [PLAYER_A]: 0, [PLAYER_B]: 3_000 },
  tournament_id: TOURNAMENT_ID,
  tournament_players_synced: true,
  tournament_player_count: 2,
  tournament_player_user_ids: [PLAYER_A, PLAYER_B],
  tournament_player_chips: [
    { user_id: PLAYER_A, chips: 0 },
    { user_id: PLAYER_B, chips: 3_000 },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  mock.rpc.mockReset();
  mock.from.mockReset();
  mock.reportError.mockReset();
  mock.raiseFinancialAlert.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('the hand owns its exact stack payload until the receipt is authoritative', () => {
  it('outlives a 28-second PGRST002 reload and accepts only the eventual exact standings receipt', async () => {
    let calls = 0;
    mock.rpc.mockImplementation(async () => {
      calls += 1;
      if (calls <= 10) {
        return {
          data: null,
          error: { code: 'PGRST002', message: 'schema cache is reloading' },
        };
      }
      if (calls === 11) {
        return {
          data: {
            ...exactReceipt,
            tournament_player_count: 1,
            tournament_player_user_ids: [PLAYER_A],
            tournament_player_chips: [{ user_id: PLAYER_A, chips: 0 }],
          },
          error: null,
        };
      }
      return { data: exactReceipt, error: null };
    });

    const result = syncStacks(TABLE_ID, players, 7_001, {
      rake: 0,
      bbj: 0,
      expectedTournamentId: TOURNAMENT_ID,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(true);
    expect(calls).toBe(12);
    const retryElapsedMs = STACK_WRITE_RETRY_DELAYS_MS.slice(0, calls - 1).reduce(
      (sum, delay) => sum + delay,
      0
    );
    expect(retryElapsedMs).toBeGreaterThan(28_000);

    const payloads = mock.rpc.mock.calls.map(([, payload]) => payload);
    expect(payloads.every((payload) => payload === payloads[0])).toBe(true);
    expect(payloads[0]).toEqual({
      p_table_id: TABLE_ID,
      p_hand_number: 7_001,
      p_stacks: players.map(({ user_id, stack, stack_before }) => ({
        user_id,
        stack,
        stack_before,
      })),
      p_rake: 0,
      p_bbj: 0,
      p_ref: null,
      p_inflow: null,
    });
    expect(mock.raiseFinancialAlert).not.toHaveBeenCalled();
  });

  it('fails closed immediately when the database definitively refuses the hand', async () => {
    mock.rpc.mockResolvedValue({
      data: { success: false, reason: 'refused', error: 'conservation violation' },
      error: null,
    });

    await expect(
      syncStacks(TABLE_ID, players, 7_002, {
        rake: 0,
        bbj: 0,
        expectedTournamentId: TOURNAMENT_ID,
      })
    ).resolves.toBe(false);
    expect(mock.rpc).toHaveBeenCalledTimes(1);
  });
});
