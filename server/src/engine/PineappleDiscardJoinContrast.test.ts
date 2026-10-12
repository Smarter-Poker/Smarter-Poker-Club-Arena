/**
 * HORSE BRAIN PHASE 12, P12-A remainder: the discard join, chosen versus
 * forced, and the answers that must never reach the private record.
 *
 * PineappleAcceptedDiscardChain.test.ts carries one CHOSEN discard from
 * `performDiscard` into the next decision. Its suites name the forced runout
 * discard's owners (HorseDiscardControllerReceipt, the journal's discard
 * lineage) but nothing set the two side by side at the join, and nothing
 * drove the engine's own discard handler on a real controller with an answer
 * that is stale, crossed or duplicated. These cases do both, with the real
 * HandController and the real ServerTableEngine discard handler; only the
 * worker's answer is supplied by the test. No discard owner changes.
 *
 * Chosen: the engine asks the worker lane `choice`, the controller records
 * the discard on the `pineapple_discard` round with the public node
 * `private_discard_choice`, the seat keeps exactly that card as its private
 * dead card, and the hand continues to a betting decision that consumes it
 * (the Phase 12 binding counts it, never lists it).
 *
 * Forced: an all-in hand never opens the round. The engine asks the lane
 * `forced_runout` before the flop is dealt, the controller commits the
 * prepared choice outside the discard round with the public node
 * `forced_discard`, the seat holds the same kind of private record, and no
 * betting decision follows. A forced record is therefore never the
 * authoritative proof a betting decision requires (the worker's own check,
 * pinned in PineappleAcceptedDiscardChain.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(),
  decideDeep: vi.fn(),
  decideDiscard: vi.fn(),
  observeDiscardExecution: vi.fn(),
  commitDecisionEffects: vi.fn(async () => undefined),
  runWithDispatchBarrier: vi.fn(<T>(fn: () => T): T => fn()),
}));
vi.mock('./horseDecision/index.js', async () => ({
  ...(await vi.importActual<typeof import('./horseDecision/index.js')>('./horseDecision/index.js')),
  getLiveHorseDecisionWorker: () => worker,
}));
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));

import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import { evaluateRemainingVariantPolicy } from './remainingVariants/RemainingVariantLivePolicy.js';
import { controllerDecisionState } from './remainingVariants/RemainingVariantControllerSpots.test-support.js';

const TABLE = 'fb100000-0000-4000-8000-0000000000c1';
const HERO_SEAT = 2;
const key = (c: Card) => `${c.rank}${c.suit}`;
const userOf = (seat: number) => `fb200000-0000-4000-8000-0000000000c${seat}`;

function table(seats: number[], stack: number) {
  const players = seats.map((seat) => ({
    seat,
    user_id: userOf(seat),
    username: `Horse ${seat}`,
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const config = {
    tableId: TABLE,
    handNumber: 1,
    gameVariant: 'pineapple',
    smallBlind: 1,
    bigBlind: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  } as HandConfig;
  const hc = new HandController(config, players, 1);
  const events: HandEvent[] = [];
  hc.onEvent((event) => events.push(event));
  hc.start();
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 1;
  engine.currentHandActions = [];
  engine.tableInfo = {
    action_time_seconds: 15,
    big_blind: 2,
    small_blind: 1,
    game_variant: 'pineapple',
  };
  engine.seatedPlayers = seats.map((seat) => ({
    seat_number: seat,
    user_id: userOf(seat),
    username: `Horse ${seat}`,
    stack,
    is_horse: true,
    horse_profile: {},
  }));
  engine.handController = hc;
  engine.disconnectEngine = { isSittingOut: () => false, recordPlayerActed: vi.fn() };
  engine.timeBankEngine = { isArmed: () => false, getPlayerBank: () => null };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '7' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  return { hc, engine, events, config };
}

/** Four seats, everyone calls: the table is in the simultaneous discard round. */
function toDiscardRound() {
  const t = table([1, 2, 3, 4], 200);
  for (let guard = 0; t.hc.getState().stage === 'preflop' && guard < 20; guard += 1) {
    const s = t.hc.getState();
    const seated = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
    expect(
      t.hc.performAction(s.currentPlayerSeat, s.currentBet > seated.bet ? 'call' : 'check')
    ).toBe(true);
  }
  expect(t.hc.getState().stage).toBe('pineapple_discard');
  const heroThree = structuredClone(
    t.hc.getState().players.find((p) => p.seat === HERO_SEAT)!.cards
  ) as Card[];
  return { ...t, heroThree };
}

/** The worker answers `cardIndex` for this exact request, or as `shape` says. */
function answer(
  cardIndex: number,
  shape: (snapshot: { generation: number; fence: string }) => {
    generation: number;
    fence: string;
  } = (s) => s
) {
  worker.decideDiscard.mockImplementation(
    async (snapshot: { generation: number; fence: string }) => ({
      type: 'DISCARD_RESULT',
      requestId: 1,
      ...shape(snapshot),
      cardIndex,
      computeMs: 1,
      governorScale: 1,
    })
  );
}

/** Hold the answer until the test releases it. */
function heldAnswer() {
  let release!: (cardIndex: number) => void;
  worker.decideDiscard.mockImplementation(
    (snapshot: { generation: number; fence: string }) =>
      new Promise((done) => {
        release = (cardIndex) =>
          done({
            type: 'DISCARD_RESULT',
            requestId: 1,
            generation: snapshot.generation,
            fence: snapshot.fence,
            cardIndex,
            computeMs: 1,
            governorScale: 1,
          });
      })
  );
  return { release: (cardIndex: number) => release(cardIndex) };
}

const discardRecords = (hc: HandController, seat: number) =>
  hc.getState().actionHistory.filter((a) => a.seat === seat && a.action === 'discard');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P12-A: chosen versus forced discard at the join', () => {
  it('a chosen discard is the round record, the private card and the next decision input', async () => {
    const { hc, engine, events, heroThree, config } = toDiscardRound();
    answer(1);
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);

    expect(worker.decideDiscard).toHaveBeenCalledTimes(1);
    expect(worker.decideDiscard.mock.calls[0][0].journalContext).toMatchObject({
      lane: 'choice',
      seat: HERO_SEAT,
    });
    // The private record is exactly the card at the answered index.
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT).map(key)).toEqual([key(heroThree[1])]);
    expect(discardRecords(hc, HERO_SEAT)).toEqual([
      expect.objectContaining({ stage: 'pineapple_discard', amount: 0 }),
    ]);
    const publicNode = events.find(
      (e) => e.type === 'PLAYER_ACTION' && e.action === 'discard' && e.seat === HERO_SEAT
    ) as Extract<HandEvent, { type: 'PLAYER_ACTION' }>;
    expect(publicNode.publicNode).toMatchObject({ reason: 'private_discard_choice' });
    expect(JSON.stringify(publicNode)).not.toContain(key(heroThree[1]));
    expect(worker.observeDiscardExecution).toHaveBeenCalledTimes(1);
    expect(worker.observeDiscardExecution.mock.calls[0][0]).toMatchObject({
      selectedIndex: 1,
      controller: { seat: HERO_SEAT, chosenIndex: 1, discardedCard: heroThree[1] },
    });

    // The rest of the table discards; the hand reaches the flop betting.
    for (const seat of [1, 3, 4]) expect(hc.performDiscard(seat, 0)).toBe(true);
    vi.advanceTimersByTime(HAND_COMPLETION.DISCARD_SETTLE_MS);
    expect(hc.getState().stage).toBe('flop');
    expect(hc.getState().currentPlayerSeat).toBe(HERO_SEAT);
    const spot = controllerDecisionState(hc, 'pineapple', 'cash', config)!;
    expect(spot.hero.knownDeadCards!.map(key)).toEqual([key(heroThree[1])]);
    expect(spot.hero.cards.map(key)).toEqual([heroThree[0], heroThree[2]].map(key));
    // The Phase 12 betting proposal consumes it, as a count only.
    const r = evaluateRemainingVariantPolicy(
      spot.hero,
      spot.state,
      spot.baseline,
      null,
      'shadow',
      () => 0
    );
    expect(r.receipt.inputs!.privateCards).toEqual({
      heroHoleCards: 2,
      heroKnownDeadCards: 1,
      postDiscard: true,
      cardValues: 'not_recorded',
    });
    expect(JSON.stringify(r.receipt.inputs)).not.toContain(heroThree[1].suit);
    engine.clearLooseHandTimers();
  });

  it('a forced runout discard is a different record: no round, no choice, no next decision', async () => {
    const { hc, engine, events } = table([1, 2], 50);
    // Both seats all in preflop: the discard round never opens.
    let s = hc.getState();
    expect(hc.performAction(s.currentPlayerSeat, 'all_in')).toBe(true);
    s = hc.getState();
    expect(hc.performAction(s.currentPlayerSeat, 'call')).toBe(true);
    expect(events.some((e) => e.type === 'ALL_IN_RUNOUT')).toBe(true);
    const pending = hc.getPineappleRunoutDiscardSnapshot()!;
    const originals = new Map(pending.players.map((p) => [p.seat, structuredClone(p.cards)]));
    answer(1);
    expect(await engine.preparePineappleRunoutDiscards(hc)).toBe(true);
    expect(worker.decideDiscard).toHaveBeenCalledTimes(2);
    for (const call of worker.decideDiscard.mock.calls)
      expect(call[0].journalContext).toMatchObject({ lane: 'forced_runout' });
    // Prepared, not committed: nothing is private yet and nothing observed.
    for (const seat of [1, 2]) expect(hc.getPineappleKnownDeadCards(seat)).toEqual([]);
    expect(worker.observeDiscardExecution).not.toHaveBeenCalled();

    hc.continueRunout();
    for (const seat of [1, 2]) {
      const three = originals.get(seat)!;
      // The same kind of private record as a chosen discard...
      expect(hc.getPineappleKnownDeadCards(seat).map(key)).toEqual([key(three[1])]);
      // ...committed outside the discard round, under its own public node.
      const records = discardRecords(hc, seat);
      expect(records).toHaveLength(1);
      expect(records[0].stage).not.toBe('pineapple_discard');
    }
    const nodes = events
      .filter((e) => e.type === 'PLAYER_ACTION' && e.action === 'discard')
      .map((e) => (e as Extract<HandEvent, { type: 'PLAYER_ACTION' }>).publicNode);
    expect(nodes).toEqual([
      expect.objectContaining({ reason: 'forced_discard' }),
      expect.objectContaining({ reason: 'forced_discard' }),
    ]);
    expect(worker.observeDiscardExecution).toHaveBeenCalledTimes(2);
    // No betting decision follows a forced discard: nobody can act.
    const state = hc.getState();
    for (const p of state.players)
      expect(hc.getAuthoritativeActionState(p.user_id)?.canAct ?? false).toBe(false);
  });
});

describe('P12-A: stale, crossed and duplicate answers never reach the private record', () => {
  /** After a refused answer the seat still owes its discard and holds three cards. */
  const untouched = (hc: HandController, heroThree: Card[]) => {
    expect(hc.owesPineappleDiscard(HERO_SEAT)).toBe(true);
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT)).toEqual([]);
    expect(discardRecords(hc, HERO_SEAT)).toEqual([]);
    expect(
      hc
        .getState()
        .players.find((p) => p.seat === HERO_SEAT)!
        .cards.map(key)
    ).toEqual(heroThree.map(key));
    expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
  };

  it.each([
    [
      'another fence',
      (s: { generation: number; fence: string }) => ({ ...s, fence: `${s.fence}:x` }),
    ],
    [
      'another generation',
      (s: { generation: number; fence: string }) => ({ ...s, generation: s.generation + 1 }),
    ],
  ])('refuses an answer that crossed its fence (%s)', async (_label, shape) => {
    const { hc, engine, heroThree } = toDiscardRound();
    answer(1, shape);
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);
    expect(worker.decideDiscard).toHaveBeenCalledTimes(1);
    untouched(hc, heroThree);
    engine.clearLooseHandTimers();
  });

  it.each([3, -1, 1.5])('refuses an answer with an impossible index (%s)', async (index) => {
    const { hc, engine, heroThree } = toDiscardRound();
    answer(index);
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);
    untouched(hc, heroThree);
    engine.clearLooseHandTimers();
  });

  it('drops a late answer after the hand moved on (stale hand)', async () => {
    const { hc, engine, heroThree } = toDiscardRound();
    const held = heldAnswer();
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);
    expect(worker.decideDiscard).toHaveBeenCalledTimes(1);
    // The engine is on its next hand when the answer arrives.
    engine.handCount += 1;
    held.release(1);
    await vi.advanceTimersByTimeAsync(0);
    untouched(hc, heroThree);
    engine.clearLooseHandTimers();
  });

  it('drops a late answer after the round was re-armed (stale generation)', async () => {
    const { hc, engine, heroThree } = toDiscardRound();
    const held = heldAnswer();
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);
    // Teardown of the decision work moves the generation on.
    engine.cancelPineappleDecisionWork();
    held.release(1);
    await vi.advanceTimersByTimeAsync(0);
    untouched(hc, heroThree);
    engine.clearLooseHandTimers();
  });

  it('drops a late answer for a seat that was folded for its missed discard (stale actor)', async () => {
    const { hc, engine, heroThree } = toDiscardRound();
    const held = heldAnswer();
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);
    expect(hc.foldForMissedDiscard(HERO_SEAT)).toBe(true);
    held.release(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hc.getState().players.find((p) => p.seat === HERO_SEAT)!.is_folded).toBe(true);
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT)).toEqual([]);
    expect(discardRecords(hc, HERO_SEAT)).toEqual([]);
    expect(worker.observeDiscardExecution).not.toHaveBeenCalled();
    expect(heroThree).toHaveLength(3);
    engine.clearLooseHandTimers();
  });

  it('keeps the first accepted discard when a second answer arrives (duplicate)', async () => {
    const { hc, engine, heroThree } = toDiscardRound();
    const held = heldAnswer();
    engine.handlePineappleDiscard({ type: 'PINEAPPLE_DISCARD_REQUIRED', seats: [HERO_SEAT] });
    await vi.advanceTimersByTimeAsync(1_201);
    // The seat's discard is accepted first (index 0) ...
    expect(hc.performDiscard(HERO_SEAT, 0)).toBe(true);
    // ... and the worker's later answer for the same seat (index 1) is refused.
    held.release(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT).map(key)).toEqual([key(heroThree[0])]);
    expect(discardRecords(hc, HERO_SEAT)).toHaveLength(1);
    expect(
      hc
        .getState()
        .players.find((p) => p.seat === HERO_SEAT)!
        .cards.map(key)
    ).toEqual([heroThree[1], heroThree[2]].map(key));
    // And a direct second submission is refused by the controller itself.
    expect(hc.performDiscard(HERO_SEAT, 1)).toBe(false);
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT).map(key)).toEqual([key(heroThree[0])]);
    engine.clearLooseHandTimers();
  });
});
