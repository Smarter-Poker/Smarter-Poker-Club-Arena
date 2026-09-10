import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  commit: vi.fn(),
  obligations: vi.fn(),
  alert: vi.fn(async () => undefined),
}));
vi.mock('../services/supabase.js', async (original) => ({
  ...(await original<typeof import('../services/supabase.js')>()),
  logHandHistory: backend.commit,
  processHandPostCommitObligations: backend.obligations,
}));
vi.mock('../services/financialAlerts.js', () => ({ raiseFinancialAlert: backend.alert }));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (value: unknown) => String(value),
}));

import { ServerTableEngine } from './ServerTableEngine.js';
import { deadlineScheduler } from './DeadlineScheduler.js';

const TABLE = 'e3000000-0000-4000-8000-000000000001';
const EVENT = 'e3000000-0000-4000-8000-000000000002';
const A = 'e3000000-0000-4000-8000-000000000003';
const B = 'e3000000-0000-4000-8000-000000000004';
const C = 'e3000000-0000-4000-8000-000000000005';
const GENERATION = 'e3000000-0000-4000-8000-000000000006';

afterEach(() => {
  deadlineScheduler.cancelAll(TABLE);
  vi.clearAllMocks();
});

describe('the actual settlement method carries bounty pot evidence', () => {
  it('passes the captured tournament awards to the same hand-history commit despite next-hand memory changes', async () => {
    const engine = new ServerTableEngine(TABLE) as any;
    engine.tableInfo = {
      id: TABLE,
      tournament_id: EVENT,
      game_type: 'tournament',
      game_variant: 'nlh',
      small_blind: 1,
      big_blind: 2,
      max_players: 9,
    };
    engine.running = true;
    engine.handCount = 1_900_001;
    engine.lifecycleCanMutate = () => true;
    engine.hasCurrentEngineLeaseAuthority = () => true;
    engine.getEngineLeaseAuthority = () => ({ verified: true, generation: GENERATION });
    engine.currentHandPotSize = 600;
    engine.currentHandRake = 0;
    engine.currentHandBBJFee = 0;
    engine.currentHandDealtStacks = new Map([
      [A, 250],
      [B, 100],
      [C, 250],
    ]);
    engine.currentHandWinners = [{ userId: A, amount: 600, potIndex: 0 }];
    engine.currentHandPots = [
      { index: 0, amount: 300, eligible: [A, B, C] },
      { index: 1, amount: 300, eligible: [A, C] },
    ];
    const awards = [
      { userId: A, amount: 300, potIndex: 0, low: false },
      { userId: A, amount: 300, potIndex: 1, low: false },
    ];
    engine.currentHandPerPotAwards = awards;
    engine.currentHandSeatGenerations = new Map(
      [A, B, C].map((id) => [id, { seat_id: id, seat_joined_at: '2026-09-10T00:00:00.123456Z' }])
    );
    const players = [A, B, C].map((id, index) => ({
      user_id: id,
      username: id,
      seat_number: index + 1,
      stack: index === 0 ? 600 : 0,
      is_horse: false,
    }));
    engine.seatedPlayers = players;
    backend.commit.mockImplementation(async (request) => {
      return { handId: request.handId, settlementCommitted: true };
    });

    backend.obligations.mockImplementation(async () => {
      // End this generation after the immutable post-commit work is accepted.
      engine.lifecycleCanMutate = () => false;
      return { ok: true, pending_addons: 0 };
    });

    const pending = engine.postHandTasks(players, 1);
    engine.currentHandPerPotAwards = [{ userId: B, amount: 90, potIndex: 0, low: false }];
    await pending;

    expect(backend.alert).not.toHaveBeenCalled();
    expect(backend.commit).toHaveBeenCalledTimes(1);
    expect(backend.commit.mock.calls[0][0]).toMatchObject({
      handNumber: 1_900_001,
      tournamentId: EVENT,
      perPotAwards: awards,
      winners: [{ userId: A, amount: 600, potIndex: 0 }],
    });
  });
});
