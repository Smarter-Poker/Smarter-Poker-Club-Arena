import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decisionWorker = vi.hoisted(() => {
  const commitDecisionEffects = vi.fn(async (authority: { generation: number; fence: string }) => ({
    type: 'ACK' as const,
    requestId: 999,
    ...authority,
    operation: 'COMMIT_DECISION_EFFECTS' as const,
  }));
  const decideFast = vi.fn(async (snapshot: { generation: number; fence: string }) => ({
    type: 'FAST_RESULT' as const,
    requestId: 1,
    generation: snapshot.generation,
    fence: snapshot.fence,
    decision: { action: 'bet' as const, amount: 20, thinkTime: 1 },
    rngBefore: 11,
    rngAfter: 22,
    computeMs: 2,
    governorScale: 1,
    effects: [
      {
        type: 'raise_plan' as const,
        handKey: 'table:hand',
        userId: 'horse-1',
        street: 'flop',
        plan: 'foldToRaise' as const,
      },
    ],
  }));
  const worker = {
    decideFast,
    decideDeep: vi.fn(),
    commitDecisionEffects,
    runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
  };
  return { worker, decideFast, commitDecisionEffects };
});

vi.mock('./horseDecision/index.js', async () => {
  const actual = await vi.importActual<typeof import('./horseDecision/index.js')>(
    './horseDecision/index.js'
  );
  return {
    ...actual,
    getLiveHorseDecisionWorker: () => decisionWorker.worker,
  };
});

import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'fafafafa-fafa-fafa-fafa-fafafafafafa';

function harness(intendedActionAccepted: boolean) {
  const player = {
    seat_number: 1,
    user_id: 'horse-1',
    username: 'Horse One',
    stack: 100,
    is_horse: true,
    horse_profile: {},
  };
  const enginePlayer = {
    seat: 1,
    user_id: player.user_id,
    username: player.username,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [
      { rank: 'A', suit: 'hearts' },
      { rank: 'K', suit: 'hearts' },
    ],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const state = {
    currentPlayerSeat: 1,
    currentBet: 0,
    minRaise: 2,
    pot: 10,
    communityCards: [
      { rank: 'Q', suit: 'hearts' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
    ],
    stage: 'flop' as const,
    players: [
      enginePlayer,
      {
        ...enginePlayer,
        seat: 2,
        user_id: 'human-2',
        username: 'Human Two',
      },
    ],
    dealerSeat: 2,
    actionHistory: [],
  };
  const performAction = vi.fn().mockReturnValueOnce(intendedActionAccepted).mockReturnValue(true);
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 12;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, game_variant: 'nlh' };
  engine.seatedPlayers = [player];
  engine.handController = { getState: () => state, performAction };
  engine.disconnectEngine = { isSittingOut: () => false };
  engine.timeBankEngine = { getPlayerBank: () => null };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'lease-9' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  return { engine, player, enginePlayer, state, performAction };
}

beforeEach(() => {
  vi.useFakeTimers();
  decisionWorker.decideFast.mockClear();
  decisionWorker.commitDecisionEffects.mockClear();
  decisionWorker.worker.runWithDispatchBarrier.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('authoritative horse action effect commit', () => {
  it('commits one captured plan only after the intended wager is accepted', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(true);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenCalledTimes(1);
    expect(performAction).toHaveBeenCalledWith(1, 'bet', 20);
    expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledTimes(1);
    expect(decisionWorker.commitDecisionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ generation: expect.any(Number), fence: expect.any(String) }),
      [expect.objectContaining({ type: 'raise_plan', handKey: 'table:hand' })]
    );
  });

  it('does not commit an intended wager plan when that wager is rejected and degraded', async () => {
    const { engine, player, enginePlayer, state, performAction } = harness(false);

    engine.scheduleHorseAction(player, 1, enginePlayer, state);
    await vi.advanceTimersByTimeAsync(250);

    expect(performAction).toHaveBeenNthCalledWith(1, 1, 'bet', 20);
    expect(performAction).toHaveBeenNthCalledWith(2, 1, 'check');
    expect(decisionWorker.commitDecisionEffects).not.toHaveBeenCalled();
  });
});
