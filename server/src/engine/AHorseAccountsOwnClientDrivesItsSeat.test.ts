/**
 * A HORSE ACCOUNT'S OWN CLIENT DRIVES ITS SEAT (2026-10-22), ordinary tables.
 *
 * Lightning pilot witnesses play pilot horse accounts through the ordinary
 * client. While that client controls the seat (a live authenticated engine
 * socket for the user on this table plus a client claim: the table page's
 * heartbeat, an action, a pre-action or a time bank request), the brain does
 * not act on the seat's turns. The turn runs on the human clock: the action
 * timer, then the time bank, then the ordinary timeout. Closing the last
 * socket hands control, and the current turn, back to the brain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(),
  decideDeep: vi.fn(),
  commitDecisionEffects: vi.fn(async () => ({})),
  runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
}));
vi.mock('./horseDecision/index.js', async () => ({
  ...(await vi.importActual<typeof import('./horseDecision/index.js')>('./horseDecision/index.js')),
  getLiveHorseDecisionWorker: () => worker,
}));

import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'fafa1300-1234-4321-9876-aaaaaaaaaaaa';
const PLAYER = '0097309f-2864-4d09-b02b-56bca012a9c3'; // pilot horse 009's shape
const engines: any[] = [];

function result(snapshot: any, thinkTime = 3000) {
  return {
    type: 'FAST_RESULT',
    requestId: 1,
    generation: snapshot.generation,
    fence: snapshot.fence,
    decision: { action: 'bet', amount: 20, thinkTime },
    rngBefore: 11,
    rngAfter: 22,
    computeMs: 2,
    governorScale: 1,
    effects: [],
  };
}

function harness(horse = true) {
  const seated = {
    user_id: PLAYER,
    seat_number: 1,
    username: 'Fixture Horse',
    stack: 100,
    is_horse: horse,
    horse_profile: {},
  };
  const hero = {
    user_id: PLAYER,
    seat: 1,
    username: 'Fixture Horse',
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
    stage: 'flop',
    communityCards: [
      { rank: 'Q', suit: 'hearts' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'diamonds' },
    ],
    communityCards2: [],
    communityCards3: [],
    players: [hero, { ...hero, seat: 2, user_id: 'other-player', cards: [] }],
    dealerSeat: 2,
    actionHistory: [],
    pots: [],
  };
  const engine = new ServerTableEngine(TABLE) as any;
  engines.push(engine);
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: 'fixture-lease' });
  engine.handCount = 12;
  engine.tableInfo = { action_time_seconds: 15, big_blind: 2, game_variant: 'nlh' };
  engine.seatedPlayers = [seated];
  engine.hub = { emitEvent: vi.fn() };
  engine.rePushHoleCards = vi.fn(async () => {});
  engine.markProgress = vi.fn();
  engine.humansSeated = () => (horse ? 0 : 1);
  engine.tableFormat = () => 'cash';
  const performAction = vi.fn(
    (
      seat: number,
      action: string,
      amount: number,
      origin: string,
      onAccepted?: (v: any) => void
    ) => {
      onAccepted?.({
        seat,
        userId: PLAYER,
        action,
        amount,
        stage: state.stage,
        timestamp: Date.now(),
      });
      state.currentPlayerSeat = 2;
      return true;
    }
  );
  engine.handController = {
    getState: () => state,
    getDecisionActionCount: () => state.actionHistory.length,
    performAction,
    getAuthoritativeActionState: () => ({
      schemaVersion: 1,
      heroSeat: 1,
      currentPlayerSeat: state.currentPlayerSeat,
      canAct: state.currentPlayerSeat === 1,
      legalActions: ['fold', 'check', 'bet', 'all_in'],
      toCall: 0,
      minRaiseTo: 2,
      maxRaiseTo: 100,
      structure: 'no_limit',
      fixedBetSize: null,
      wagersCapped: false,
    }),
    computeLivePots: () => [{ amount: 10, eligiblePlayers: [PLAYER, 'other-player'] }],
    getContestablePotForCall: () => 10,
    getChipRulesSnapshot: () => ({ asset: 'chips', chipUnit: 0.01 }),
    getActiveBoardCount: () => 1,
    getRakeConfigSnapshot: () => ({ percent: 10, cap: 5, noFlopNoDrop: true, playerCountCaps: [] }),
  };
  engine.disconnectEngine.configure(TABLE, { disconnectTimeoutSeconds: 30 });
  engine.disconnectEngine.registerPlayer(TABLE, PLAYER);
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20, autoActivate: true });
  engine.timeBankEngine.initializePlayer(TABLE, PLAYER, { remainingSeconds: 40, usesRemaining: 2 });
  return { engine, state, seated, performAction };
}

async function turn(h: ReturnType<typeof harness>) {
  await h.engine.handleTurnChange({ type: 'TURN_CHANGE', seat: 1, availableActions: [] }, [
    h.seated,
  ]);
}

/**
 * Advance the clock while a present seat keeps heartbeating, as a live client
 * (or the engine's own horse heartbeat) does every few seconds.
 */
async function play(h: ReturnType<typeof harness>, ms: number, beat = true) {
  for (let left = ms; left > 0; ) {
    const step = Math.min(1_000, left);
    await vi.advanceTimersByTimeAsync(step);
    left -= step;
    if (beat) h.engine.disconnectEngine.heartbeat(TABLE, PLAYER);
  }
}

function clientTakesSeat(h: ReturnType<typeof harness>) {
  h.engine.heartbeat(PLAYER, { transportOnly: true }); // socket admitted (onConnect)
  h.engine.heartbeat(PLAYER, {}); // the table page's own heartbeat
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  worker.decideFast.mockReset().mockImplementation(async (snapshot) => result(snapshot));
  worker.decideDeep.mockReset();
  worker.commitDecisionEffects.mockClear();
});

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.cancelHorseDecisionWork();
    engine.timeBankEngine.dispose(TABLE);
    engine.preciseTimer.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a horse account driven by its own client plays on the human clock', () => {
  it('no brain action through the action clock; the time bank activates; the client action is accepted', async () => {
    const h = harness();
    clientTakesSeat(h);
    expect(h.engine.isOwnClientControlling(PLAYER)).toBe(true);
    await turn(h);
    // The whole action clock and its grace: the brain is never asked.
    await play(h, 16_900);
    expect(worker.decideFast).not.toHaveBeenCalled();
    expect(h.performAction).not.toHaveBeenCalled();
    expect(h.engine.timeBankActivatedThisTurn).toBe(false);
    // The clock expires into the time bank, exactly as for a human.
    await play(h, 300);
    expect(h.engine.timeBankActivatedThisTurn).toBe(true);
    expect(h.engine.timeBankEngine.getPlayerBank(TABLE, PLAYER)?.isActive).toBe(true);
    expect(h.engine.timeBankEngine.getUsesRemaining(TABLE, PLAYER)).toBe(1);
    await play(h, 10_000);
    expect(worker.decideFast).not.toHaveBeenCalled();
    expect(h.performAction).not.toHaveBeenCalled();
    // The client's own action lands through the client door.
    const r = h.engine.handlePlayerAction(PLAYER, 'check', undefined, h.engine.getActionContext());
    expect(r.success).toBe(true);
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls[0].slice(0, 2)).toEqual([1, 'check']);
    expect(worker.decideFast).not.toHaveBeenCalled();
  });

  it('a manual time bank request from the client is honoured on its turn', async () => {
    const h = harness();
    clientTakesSeat(h);
    await turn(h);
    await play(h, 4_000);
    const r = await h.engine.activateTimeBank(PLAYER);
    expect(r.success).toBe(true);
    await play(h, 20_000);
    expect(worker.decideFast).not.toHaveBeenCalled();
    expect(h.performAction).not.toHaveBeenCalled();
    expect(h.engine.timeBankActivatedThisTurn).toBe(true);
  });

  it('an idle client is timed out through the ordinary path, never by the brain', async () => {
    const h = harness();
    clientTakesSeat(h);
    await turn(h);
    await play(h, 17_200 + 22_500);
    expect(worker.decideFast).not.toHaveBeenCalled();
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls[0][1]).toBe('check');
  });

  it('a horse with no client acts on its own inside the clock, with no time bank', async () => {
    const h = harness();
    await turn(h);
    await play(h, 4_000);
    expect(worker.decideFast).toHaveBeenCalledTimes(1);
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls[0].slice(0, 3)).toEqual([1, 'bet', 20]);
    expect(h.engine.timeBankActivatedThisTurn).toBe(false);
  });

  it('a socket alone, or a claim alone, is not control', async () => {
    const socketOnly = harness();
    socketOnly.engine.heartbeat(PLAYER, { transportOnly: true });
    expect(socketOnly.engine.isOwnClientControlling(PLAYER)).toBe(false);
    await turn(socketOnly);
    await play(socketOnly, 4_000);
    expect(socketOnly.performAction).toHaveBeenCalledTimes(1);

    worker.decideFast.mockClear();
    const claimOnly = harness();
    claimOnly.engine.heartbeat(PLAYER, {});
    expect(claimOnly.engine.isOwnClientControlling(PLAYER)).toBe(false);
    await turn(claimOnly);
    await play(claimOnly, 4_000);
    expect(claimOnly.performAction).toHaveBeenCalledTimes(1);
  });

  it('the client disconnecting hands the current turn back to the brain, inside the running clock', async () => {
    const h = harness();
    clientTakesSeat(h);
    await turn(h);
    await play(h, 6_000);
    expect(worker.decideFast).not.toHaveBeenCalled();
    const deadline = h.engine.playerTurnStartTime + h.engine.playerTurnDuration * 1000;
    h.engine.notifyTransportDisconnect(PLAYER);
    expect(h.engine.isOwnClientControlling(PLAYER)).toBe(false);
    await play(h, 4_000);
    expect(worker.decideFast).toHaveBeenCalledTimes(1);
    expect(h.performAction).toHaveBeenCalledTimes(1);
    expect(h.performAction.mock.calls[0].slice(0, 3)).toEqual([1, 'bet', 20]);
    expect(Date.now()).toBeLessThan(deadline);
    expect(h.engine.timeBankActivatedThisTurn).toBe(false);
  });

  it('a reconnected socket needs a fresh claim before it holds the seat again', async () => {
    const h = harness();
    clientTakesSeat(h);
    h.engine.notifyTransportDisconnect(PLAYER);
    h.engine.heartbeat(PLAYER, { transportOnly: true });
    expect(h.engine.isOwnClientControlling(PLAYER)).toBe(false);
    h.engine.heartbeat(PLAYER, {});
    expect(h.engine.isOwnClientControlling(PLAYER)).toBe(true);
  });

  it('a client claim mid-turn stops the brain decision already waiting out its think time', async () => {
    const h = harness();
    h.engine.heartbeat(PLAYER, { transportOnly: true });
    await turn(h);
    await play(h, 1_000);
    expect(worker.decideFast).toHaveBeenCalledTimes(1);
    expect(h.performAction).not.toHaveBeenCalled();
    // The client arms a pre-action: its door is a claim.
    h.engine.setPreAction(PLAYER, 'auto_check');
    expect(h.engine.isOwnClientControlling(PLAYER)).toBe(true);
    await play(h, 5_000);
    expect(h.performAction.mock.calls.some((c) => c[1] === 'bet')).toBe(false);
  });

  it('a human seat is untouched by any of it', async () => {
    const h = harness(false);
    clientTakesSeat(h);
    await turn(h);
    await play(h, 10_000);
    h.engine.notifyTransportDisconnect(PLAYER);
    await play(h, 2_000);
    expect(worker.decideFast).not.toHaveBeenCalled();
  });
});
