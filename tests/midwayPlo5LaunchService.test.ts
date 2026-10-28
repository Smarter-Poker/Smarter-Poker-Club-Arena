import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  resolve: vi.fn(),
  ready: vi.fn(),
}));
vi.mock('../src/lib/supabase', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('../src/utils/clubIdResolver', () => ({
  resolveClubUUID: mocks.resolve,
}));
import { launchMidwayPlo5 } from '../src/services/MidwayPlo5LaunchService';
vi.mock('../src/services/GameServerAPI', () => ({ isCashGameHorseArrivalsReady: mocks.ready }));
import {
  MIDWAY_PLO5_CLUB_ID,
  MIDWAY_PLO5_LINEUP,
  MIDWAY_PLO5_REQUEST_ID,
  MIDWAY_PLO5_STARTS_AT,
} from '../src/config/midwayPlo5Launch';

const gameId = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const policyId = '33333333-3333-4333-8333-333333333333';
const policy = { version: 1, policy_id: policyId };
let game: Record<string, unknown>;
let tables: Array<Record<string, unknown>>;
describe('the approved Midway launch has one durable request and a verified scoped anchor', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-28T20:30:00Z'));
    mocks.rpc.mockReset().mockResolvedValue({
      data: {
        ok: true,
        game_id: gameId,
        table_id: tableId,
        horse_arrivals: policy,
        replayed: false,
      },
      error: null,
    });
    mocks.resolve.mockReset().mockResolvedValue(MIDWAY_PLO5_CLUB_ID);
    mocks.ready.mockReset().mockResolvedValue(true);
    game = {
      id: gameId,
      club_id: MIDWAY_PLO5_CLUB_ID,
      template_name: 'madness',
      variant: 'plo5',
      sb: 2,
      bb: 5,
      handedness: 6,
      must_move: true,
      enabled: true,
      closed_at: null,
      ruleset_snapshot: { horse_arrivals: policy },
    };
    tables = [
      {
        id: tableId,
        cluster_id: gameId,
        status: 'waiting',
        is_deleted: false,
        settings: { horse_arrivals: policy },
      },
    ];
    mocks.from.mockReset().mockImplementation((name: string) =>
      name === 'cash_games'
        ? {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: game, error: null }),
              }),
            }),
          }
        : {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: async () => ({ data: tables, error: null }),
                }),
              }),
            }),
          }
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('submits exactly the approved order through the narrow creator and verifies its persisted game and table', async () => {
    await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).resolves.toEqual({
      gameId,
      tableId,
      replayed: false,
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('fn_cash_game_create_horse_arrivals', {
      p_request_id: MIDWAY_PLO5_REQUEST_ID,
      p_club_id: MIDWAY_PLO5_CLUB_ID,
      p_starts_at: MIDWAY_PLO5_STARTS_AT,
      p_ranked_horse_ids: MIDWAY_PLO5_LINEUP.map((player) => player.id),
    });
    expect(new Set(MIDWAY_PLO5_LINEUP.map((player) => player.id)).size).toBe(20);
    expect(mocks.from.mock.calls.map(([name]) => name)).toEqual(['cash_games', 'tables']);
  });

  it('an unknown acknowledgement retries the same request and resolves the replay without inventing a table', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: new Error('Connection Lost'),
    });
    await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).rejects.toThrow(
      'Connection Lost'
    );
    expect(mocks.from).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: true, game_id: gameId, replayed: true },
      error: null,
    });
    await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).resolves.toEqual({
      gameId,
      tableId,
      replayed: true,
    });
    expect(mocks.rpc.mock.calls.map(([, request]) => request.p_request_id)).toEqual([
      MIDWAY_PLO5_REQUEST_ID,
      MIDWAY_PLO5_REQUEST_ID,
    ]);
  });

  it('refuses before any create RPC when the serving engine has no arrival protocol', async () => {
    mocks.ready.mockResolvedValue(false);
    await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).rejects.toThrow(
      'Not Ready To Launch Yet'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('refuses a wrong club before any create call', async () => {
    mocks.resolve.mockResolvedValue('44444444-4444-4444-8444-444444444444');
    await expect(launchMidwayPlo5('other-club', () => {})).rejects.toThrow(
      'Only Available In Midway'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(['closed', 'unrestricted', 'wrong-policy', 'wrong-cluster'])(
    'refuses %s persisted readback',
    async (kind) => {
      if (kind === 'closed') game.closed_at = '2026-10-28T20:20:00Z';
      if (kind === 'unrestricted') tables[0].settings = {};
      if (kind === 'wrong-policy')
        tables[0].settings = {
          horse_arrivals: {
            version: 1,
            policy_id: '55555555-5555-4555-8555-555555555555',
          },
        };
      if (kind === 'wrong-cluster') tables[0].cluster_id = '55555555-5555-4555-8555-555555555555';
      await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).rejects.toThrow(
        /Could Not Be Verified|No Verified Active Table/
      );
    }
  );

  it('does not fall back to unrestricted creation when the new contract is missing', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Missing Function' },
    });
    await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).rejects.toEqual({
      code: 'PGRST202',
      message: 'Missing Function',
    });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      'fn_cash_game_create_horse_arrivals',
    ]);
  });

  it('refuses before the start floor and after a changed operator identity', async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-28T19:59:59Z'));
    await expect(launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {})).rejects.toThrow(
      'Start Time Has Not Arrived'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-28T20:30:00Z'));
    let reads = 0;
    await expect(
      launchMidwayPlo5(MIDWAY_PLO5_CLUB_ID, () => {
        if (++reads === 2) throw new Error('Session Changed');
      })
    ).rejects.toThrow('Session Changed');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
