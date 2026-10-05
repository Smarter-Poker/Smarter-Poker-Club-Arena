/**
 * HORSE BRAIN PHASE 12, P12-A: one really accepted discard reaches the next
 * decision, and the worker accepts it.
 *
 * The chain the completion plan asks P12-A to finish is
 *   three-card request -> exact chosen index/card -> controller acceptance
 *   -> retained two-card state + private dead card
 *   -> subsequent betting sample / read frame.
 *
 * Each link already had tests. The JOIN between the last two did not:
 *  - PineappleDiscardFold proves the real controller's private retention, and
 *    stops at the controller.
 *  - workerRuntime proves the refusals and the decision-key binding, against
 *    hand-built `pineappleRequest` fixtures.
 *  - HorseDecisionEffectCommit proves the snapshot builder with
 *    `getPineappleKnownDeadCards` replaced by a vi.fn returning a fabricated
 *    card, the hero's two cards assigned by hand, and a hand-written
 *    actionHistory.
 * So no case carried ONE accepted discard from `performDiscard` through the
 * engine's own snapshot into a request the live worker admits. A fabricated
 * dead card satisfies every one of those suites.
 *
 * These cases close that. A real HandController deals three cards, a real
 * `performDiscard` is accepted at a CHOSEN index (1, so a last-card default
 * cannot pass), and the real `ServerTableEngineTurns.scheduleHorseAction`
 * builds the next decision from that controller. The snapshot it produces,
 * carrying the engine's own `decisionKey` unmodified, is then handed to a real
 * `HorseDecisionWorkerRuntime` - the component that refuses a post-discard
 * state without authoritative proof. A FAST_RESULT means the producer
 * satisfies the consumer on real data. The two tampered copies prove those
 * refusals are live on that same real data and not only on fixtures.
 *
 * What these cases do NOT claim: nothing here qualifies Pineapple policy,
 * strength or promotion, and the forced-runout discard (which has no
 * subsequent betting turn to reach) keeps its existing owners in
 * HorseDiscardControllerReceipt and horseDecisionJournal/discard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, HandConfig, HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import type {
  FastHorseDecisionRequest,
  FastHorseDecisionResult,
  HorseDecisionWorkerReady,
  HorseDecisionWorkerResponse,
  LiveHorseDecisionSnapshot,
} from './horseDecision/protocol.js';

const worker = vi.hoisted(() => ({
  decideFast: vi.fn(),
  decideDeep: vi.fn(),
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

import { HAND_COMPLETION } from '../config/handCompletionSpec.js';
import { HandController, type HorseDiscardControllerReceipt } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { horsePlanBatchBindingFromRequest } from './HorsePlanHandIdentity.js';
import {
  HorseDecisionWorkerRuntime,
  type HorseDecisionWorkerDependencies,
} from './horseDecision/workerRuntime.js';
import { HorseLogic } from './HorseLogic.js';

const TABLE = 'fb100000-0000-4000-8000-0000000000b1';
const HERO_SEAT = 2; // dealer 1, four seats: the small blind opens every postflop street.
const SEATS = [1, 2, 3, 4];
const key = (c: Card) => `${c.rank}${c.suit}`;

/* ---------------------------------------------------------------- the table */

function pineappleHandToFlop() {
  const players = SEATS.map((seat) => ({
    seat,
    user_id: `fb200000-0000-4000-8000-0000000000b${seat}`,
    username: `Horse ${seat}`,
    stack: 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  })) as SeatPlayer[];
  const hc = new HandController(
    {
      tableId: TABLE,
      handNumber: 1,
      gameVariant: 'pineapple',
      smallBlind: 1,
      bigBlind: 2,
      rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    } as HandConfig,
    players,
    1
  );
  const live = () => (hc as unknown as { state: any }).state;
  hc.start();

  // Preflop: everyone in, so every seat is dealt three and owes a discard.
  for (let guard = 0; live().stage === 'preflop' && guard < 20; guard += 1) {
    const seat = live().currentPlayerSeat;
    if (!seat || seat <= 0) break;
    const seated = live().players.find((p: SeatPlayer) => p.seat === seat);
    const toCall = live().currentBet - (seated?.bet ?? 0);
    expect(hc.performAction(seat, toCall > 0 ? 'call' : ('check' as never), 0)).toBe(true);
  }
  expect(live().stage).toBe('pineapple_discard');
  for (const p of live().players as SeatPlayer[]) expect(p.cards).toHaveLength(3);

  // One private receipt per seat, captured before any public action is emitted.
  const receipts = new Map<number, HorseDiscardControllerReceipt>();
  for (const seat of SEATS) {
    hc.observeNextPineappleDiscard(seat, (receipt) => receipts.set(seat, receipt));
  }

  // The hero chooses index 1. A "discard the last card" default cannot pass.
  const heroThree = structuredClone(
    (live().players as SeatPlayer[]).find((p) => p.seat === HERO_SEAT)!.cards
  ) as Card[];
  expect(hc.performDiscard(HERO_SEAT, 1)).toBe(true);
  for (const seat of SEATS.filter((s) => s !== HERO_SEAT)) {
    expect(hc.performDiscard(seat, 0)).toBe(true);
  }
  expect(hc.allPineappleDiscardsIn()).toBe(true);
  vi.advanceTimersByTime(HAND_COMPLETION.DISCARD_SETTLE_MS);
  expect(live().stage).toBe('flop');
  expect(live().currentPlayerSeat).toBe(HERO_SEAT);

  return { hc, live, receipts, heroThree };
}

/* ------------------------------------------------- the engine that asks once */

/** Capture the snapshot `scheduleHorseAction` really built, and check. */
function engineFor(hc: HandController, live: () => any) {
  const enginePlayer = (live().players as SeatPlayer[]).find((p) => p.seat === HERO_SEAT)!;
  const player = {
    seat_number: HERO_SEAT,
    user_id: enginePlayer.user_id,
    username: enginePlayer.username,
    stack: enginePlayer.stack,
    is_horse: true,
    horse_profile: {},
  };
  const engine = new ServerTableEngine(TABLE) as any;
  engine.running = true;
  engine.isCurrentEngine = () => true;
  engine.handCount = 1;
  engine.tableInfo = {
    action_time_seconds: 15,
    big_blind: 2,
    small_blind: 1,
    game_variant: 'pineapple',
  };
  engine.seatedPlayers = [player];
  engine.handController = hc;
  engine.disconnectEngine = { isSittingOut: () => false, recordPlayerActed: vi.fn() };
  engine.timeBankEngine = { isArmed: () => false, getPlayerBank: () => null };
  engine.getEngineLeaseAuthority = () => ({ verified: true, generation: '7' });
  engine.humansSeated = () => 0;
  engine.tableFormat = () => 'cash';
  engine.markProgress = vi.fn();
  return { engine, player };
}

/** The horse checks, so the hand walks on to the next street for real. */
function answerCheck() {
  worker.decideFast.mockImplementation(
    async (snapshot: LiveHorseDecisionSnapshot): Promise<FastHorseDecisionResult> => ({
      type: 'FAST_RESULT',
      planIssueDisposition: 'no_effects',
      planBinding: horsePlanBatchBindingFromRequest({ ...snapshot, requestId: 1 }),
      requestId: 1,
      generation: snapshot.generation,
      fence: snapshot.fence,
      decision: { action: 'check', thinkTime: 1 } as HorseDecision,
      rngBefore: 11,
      rngAfter: 22,
      computeMs: 1,
      governorScale: 1,
      effects: [],
    })
  );
}

/** One engine per hand: put the hero on the clock and read what it published. */
function horseAsker(hc: HandController, live: () => any) {
  const { engine, player } = engineFor(hc, live);
  return function ask(): LiveHorseDecisionSnapshot {
    const before = worker.decideFast.mock.calls.length;
    const state = hc.getState();
    const enginePlayer = state.players.find((p) => p.seat === HERO_SEAT)!;
    // The fast lane is dispatched synchronously inside scheduleHorseAction:
    // the snapshot exists the moment the call returns. Nothing here waits on
    // the commit, which AHorseWholeStackRaiseIsNotACall already owns.
    engine.scheduleHorseAction(player, HERO_SEAT, enginePlayer, state);
    expect(
      worker.decideFast.mock.calls.length,
      'scheduleHorseAction never reached the worker'
    ).toBe(before + 1);
    return worker.decideFast.mock.calls[before][0] as LiveHorseDecisionSnapshot;
  };
}

/* ------------------------------------------------------- the real worker end */

function runtimeHarness(realDecision: boolean) {
  const messages: HorseDecisionWorkerResponse[] = [];
  const seen: Array<{ player: SeatPlayer; gameState: HorseGameStateV2; frozen: boolean }> = [];
  const readiness = () => ({
    solverStores: {
      charts: 7,
      postflop: 8,
      postflopV31: 9,
      postflopV31Dataset: {
        id: '11111111-1111-4111-8111-111111111111',
        checksum: 'a'.repeat(64),
      },
    },
    solverPolicyArtifact: {
      totalPolicies: 12,
    } as HorseDecisionWorkerReady['solverPolicyArtifact'],
    governor: {
      enabled: true,
      scale: 1,
      p50Ms: 350,
      p99Ms: 500,
      sampledAt: 99,
      throttledForS: 0,
      stale: false,
      timerLateMs: 0,
    },
  });
  let rng = 101;
  let now = 10;
  const deps: HorseDecisionWorkerDependencies = {
    async startServices() {
      return readiness();
    },
    async stopServices() {},
    decide(p, gs, style, mods, opts) {
      seen.push({
        player: p as SeatPlayer,
        gameState: gs as HorseGameStateV2,
        frozen: Object.isFrozen(p) && Object.isFrozen(gs),
      });
      if (realDecision) return HorseLogic.decide(p, gs, style, mods, opts);
      rng = 202;
      return { action: 'check', thinkTime: 1 } as HorseDecision;
    },
    decideDiscard: () => 1,
    captureDecisionEffects<T>(fn: () => T) {
      return { value: fn(), effects: [] };
    },
    applyDecisionEffects() {},
    saveRng: () => rng,
    restoreRng(state) {
      rng = state;
    },
    governorScale: () => 1,
    workerReadiness: () => readiness(),
    observeCompletedHand() {},
    noteDecision() {},
    noteFeature() {},
    now() {
      const value = now;
      now += 6;
      return value;
    },
  };
  const runtime = new HorseDecisionWorkerRuntime((message) => messages.push(message), deps);
  return { runtime, messages, seen };
}

/** Hand the engine's own snapshot to the real worker, unmodified by default. */
async function throughTheWorker(
  snapshot: LiveHorseDecisionSnapshot,
  opts: { realDecision?: boolean; tamper?: (r: FastHorseDecisionRequest) => void } = {}
) {
  const realDecision = opts.realDecision === true;
  const h = runtimeHarness(realDecision);
  const request = structuredClone({
    ...snapshot,
    type: 'DECIDE_FAST' as const,
    requestId: 1,
  }) as FastHorseDecisionRequest;
  opts.tamper?.(request);
  // The worker's own FIFO and the variant sampler's work budget both run on a
  // real clock (the sampler reads performance.now(), which fake timers freeze).
  // The engine snapshot above is already captured, so nothing the engine
  // scheduled depends on this window.
  vi.useRealTimers();
  try {
    h.runtime.receive(request);
    await h.runtime.drain();
  } finally {
    vi.useFakeTimers();
  }
  return { ...h, last: h.messages.at(-1) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  answerCheck();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ the cases */

describe('P12-A: an accepted Pineapple discard reaches the next decision', () => {
  it('carries the exact chosen card from performDiscard into the engine snapshot', async () => {
    const { hc, live, receipts, heroThree } = pineappleHandToFlop();
    const receipt = receipts.get(HERO_SEAT);

    // Link 2: the receipt names the card at the index the hero chose.
    expect(receipt, 'no private receipt for the accepted discard').toBeTruthy();
    expect(key(receipt!.discardedCard)).toBe(key(heroThree[1]));

    // Link 3: the controller retained the other two, in their dealt order.
    const retained = (live().players as SeatPlayer[]).find((p) => p.seat === HERO_SEAT)!.cards;
    expect(retained.map(key)).toEqual([heroThree[0], heroThree[2]].map(key));
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT).map(key)).toEqual([key(heroThree[1])]);

    // Link 4: the engine's own snapshot, with nothing replaced.
    const snapshot = horseAsker(hc, live)();
    expect(snapshot.player.cards.map(key)).toEqual([heroThree[0], heroThree[2]].map(key));
    expect((snapshot.player.knownDeadCards ?? []).map(key)).toEqual([key(heroThree[1])]);
    expect(snapshot.gameState.stage).toBe('flop');
    expect(snapshot.gameState.gameVariant).toBe('pineapple');
    expect(snapshot.gameState.variantRules).toMatchObject({
      holeCardsDealt: 3,
      holeCardsUse: 'discard_to_two',
    });
  });

  it('keeps the discarded card private: no public seat and no board carries it', async () => {
    const { hc, live, receipts, heroThree } = pineappleHandToFlop();
    const snapshot = horseAsker(hc, live)();
    const dead = key(receipts.get(HERO_SEAT)!.discardedCard);
    expect(dead).toBe(key(heroThree[1]));

    for (const seat of snapshot.gameState.players) {
      expect(seat.cards).toEqual([]);
      expect(seat.knownDeadCards).toBeUndefined();
    }
    const board = [
      ...snapshot.gameState.communityCards,
      ...(snapshot.gameState.communityCards2 ?? []),
      ...(snapshot.gameState.communityCards3 ?? []),
    ];
    expect(board.map(key)).not.toContain(dead);
    // The whole public half of the snapshot, serialized: the card appears once,
    // on the hero's private side, and nowhere a seat could read it.
    expect(JSON.stringify(snapshot.gameState)).not.toContain(dead);
  });

  it('is ACCEPTED by the real worker on the engine’s own decision key', async () => {
    const { hc, live, receipts, heroThree } = pineappleHandToFlop();
    const snapshot = horseAsker(hc, live)();

    const r = await throughTheWorker(snapshot);
    expect(r.last, JSON.stringify(r.messages)).toMatchObject({
      type: 'FAST_RESULT',
      requestId: 1,
    });
    // The sample/read frame the worker handed the brain is the post-discard
    // state: two cards, and the accepted discard as its one dead card.
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].player.cards.map(key)).toEqual([heroThree[0], heroThree[2]].map(key));
    expect((r.seen[0].player.knownDeadCards ?? []).map(key)).toEqual([
      key(receipts.get(HERO_SEAT)!.discardedCard),
    ]);
    expect(r.seen[0].frozen).toBe(true);
  });

  it('runs a real HorseLogic decision on that real post-discard state', async () => {
    const { hc, live } = pineappleHandToFlop();
    const snapshot = horseAsker(hc, live)();

    const r = await throughTheWorker(snapshot, { realDecision: true });
    expect(r.last, JSON.stringify(r.messages)).toMatchObject({ type: 'FAST_RESULT' });
    if (r.last?.type !== 'FAST_RESULT') return;
    expect(snapshot.gameState.legalActions).toContain(r.last.decision.action);
  });

  it('still carries the same dead card on the next street of the same hand', async () => {
    const { hc, live, heroThree } = pineappleHandToFlop();

    // The whole table checks the flop through the controller, which is the
    // same submission a seat of either kind makes.
    for (let guard = 0; live().stage === 'flop' && guard < 10; guard += 1) {
      const seat = live().currentPlayerSeat;
      if (!seat || seat <= 0) break;
      expect(hc.performAction(seat, 'check' as never, 0)).toBe(true);
    }
    expect(live().stage).toBe('turn');
    expect(live().currentPlayerSeat).toBe(HERO_SEAT);
    // Two streets after the discard round, the retained pair is unchanged and
    // the private record is still the card the hero actually threw.
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT).map(key)).toEqual([key(heroThree[1])]);

    const turn = horseAsker(hc, live)();
    expect(turn.gameState.stage).toBe('turn');
    expect(turn.gameState.communityCards).toHaveLength(4);
    expect(turn.player.cards.map(key)).toEqual([heroThree[0], heroThree[2]].map(key));
    expect((turn.player.knownDeadCards ?? []).map(key)).toEqual([key(heroThree[1])]);

    const r = await throughTheWorker(turn);
    expect(r.last, JSON.stringify(r.messages)).toMatchObject({ type: 'FAST_RESULT' });
    expect((r.seen[0].player.knownDeadCards ?? []).map(key)).toEqual([key(heroThree[1])]);
  });

  it('reads the first accepted choice after a refused second discard', async () => {
    const { hc, live, heroThree } = pineappleHandToFlop();
    // The round is closed, so a late second choice is refused: the next
    // decision must still read the card the controller actually accepted.
    expect(hc.performDiscard(HERO_SEAT, 0)).toBe(false);
    expect(hc.getPineappleKnownDeadCards(HERO_SEAT).map(key)).toEqual([key(heroThree[1])]);

    const snapshot = horseAsker(hc, live)();
    expect(snapshot.player.cards.map(key)).toEqual([heroThree[0], heroThree[2]].map(key));
    expect((snapshot.player.knownDeadCards ?? []).map(key)).toEqual([key(heroThree[1])]);
    const r = await throughTheWorker(snapshot);
    expect(r.last, JSON.stringify(r.messages)).toMatchObject({ type: 'FAST_RESULT' });
  });

  it('gives each seat its own dead card, never another seat’s', async () => {
    const { hc, receipts, heroThree } = pineappleHandToFlop();
    for (const seat of SEATS) {
      const own = receipts.get(seat);
      expect(own, `no receipt for seat ${seat}`).toBeTruthy();
      expect(hc.getPineappleKnownDeadCards(seat).map(key)).toEqual([key(own!.discardedCard)]);
    }
    const all = SEATS.map((s) => key(hc.getPineappleKnownDeadCards(s)[0]));
    expect(new Set(all).size).toBe(SEATS.length);
    expect(all[SEATS.indexOf(HERO_SEAT)]).toBe(key(heroThree[1]));
  });
});

describe('P12-A: the join cannot be faked on the same real data', () => {
  it('refuses the real snapshot once its private dead card is removed', async () => {
    const { hc, live } = pineappleHandToFlop();
    const snapshot = horseAsker(hc, live)();

    const r = await throughTheWorker(snapshot, {
      tamper: (request) => {
        request.player.knownDeadCards = [];
      },
    });
    expect(r.seen).toEqual([]);
    expect(r.last).toMatchObject({
      type: 'ERROR',
      message: 'horse state known discard or physical cards are invalid',
    });
  });

  it('refuses the real snapshot once the accepted discard leaves its history', async () => {
    const { hc, live } = pineappleHandToFlop();
    const snapshot = horseAsker(hc, live)();
    expect(
      (snapshot.gameState.actionHistory ?? []).some(
        (a) => a.seat === HERO_SEAT && a.action === 'discard' && a.stage === 'pineapple_discard'
      )
    ).toBe(true);

    const r = await throughTheWorker(snapshot, {
      tamper: (request) => {
        request.gameState.actionHistory = (request.gameState.actionHistory ?? []).filter(
          (a) => !(a.seat === HERO_SEAT && a.action === 'discard')
        );
      },
    });
    expect(r.seen).toEqual([]);
    expect(r.last).toMatchObject({
      type: 'ERROR',
      message: 'horse state pineapple post-discard cards lack authoritative discard proof',
    });
  });

  it('refuses a substituted dead card the controller never accepted', async () => {
    const { hc, live, heroThree } = pineappleHandToFlop();
    const snapshot = horseAsker(hc, live)();
    // A card the hero still holds is not a discard: it collides with the hand.
    const r = await throughTheWorker(snapshot, {
      tamper: (request) => {
        request.player.knownDeadCards = [structuredClone(heroThree[0])];
      },
    });
    expect(r.seen).toEqual([]);
    expect(r.last).toMatchObject({ type: 'ERROR' });
    expect((r.last as { message?: string }).message).toMatch(
      /known discard or physical cards are invalid|decision key/
    );
  });
});
