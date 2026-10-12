/** Phase 9 P9.1: ported from the prepared Horse packet (SHA256
 * 4d70877d12a65a2f3761ec7a65a23e7bc6341820eb79cce01f6d8ae02f4d898e)
 * and rebased onto current source; each adaptation is marked REBASE.
 * Conditional classic PLO5 cash, seven dealt Horses.
 * Real pot-limit actions, actual Horse verdict/think timers, event-driven offer
 * refusal and single-board controller payout. Only initial IDs/deck/config are
 * selected. No post-deal stack, card, pot or action-history injection; no DB,
 * natural-choice frequency, policy strength, jackpot award or live-use claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import { deadlineScheduler } from './DeadlineScheduler.js';
import { maxSeatsForVariant, isSeatCountLegal } from '../config/tableSeating.js';
import { getPlayerCountCaps } from '../config/RakeConfig.js';
import { settleOmahaReference } from '../benchmark/OmahaReference.js';
import { reportError } from '../services/errorReporter.js';
import type { ActionRecord, Card, GameState, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: false, alertId: null })),
}));
const TABLE = '91000000-0000-4000-8000-000000000019';
const PROBE_TABLE = '91000000-0000-4000-8000-000000000119';
const engines: Record<string, any>[] = [];
const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const parse = (text: string): Card[] =>
  text.split(' ').map((card) => ({
    rank: card[0] as Card['rank'],
    suit: suits[card[1] as keyof typeof suits],
  }));
const cardKey = (card: Card) => `${card.rank}:${card.suit}`;
const cents = (amount: number) => Math.round(amount * 100);
const sortedIds = (ids: string[]) => [...ids].sort();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Network not admitted in this fixture');
    })
  );
});
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.running = false;
    engine.runItTwiceEngine.disposeAll();
    engine.insuranceEngine.disposeAll();
    engine.preciseTimer.dispose();
  }
  // Assertions below inspect cancellation before this test-owned cleanup.
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// REBASE 2026-10-02: current source has no horseRitThinkMs; scheduleHorseRITResponses
// computes each Horse's delay inline. Read those actual delays from the real
// scheduler on a separate, non-running engine at the same hand number. The
// probe's callbacks are cleared, never fired, and no verdict or delay is replaced.
function probeHorseRitThinkMs(table: string, handNumber: number, ids: string[]) {
  const probe = new ServerTableEngine(table) as unknown as Record<string, any>;
  engines.push(probe);
  Object.assign(probe, {
    running: false,
    handCount: handNumber,
    seatedPlayers: ids.map((user_id, i) => ({
      user_id,
      seat_number: i + 1,
      username: `Probe ${i + 1}`,
      stack: 0,
      is_horse: true,
    })),
  });
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const read = (chooser: string, all: string[]) => {
    const from = timer.mock.calls.length;
    probe.scheduleHorseRITResponses(chooser, all);
    for (const result of timer.mock.results.slice(from)) clearTimeout(result.value);
    return timer.mock.calls.slice(from).map((args) => args[1] as number);
  };
  // A chooser outside the seated Horses schedules exactly one responder timer per id.
  const responder = read('probe-chooser-not-seated', ids);
  const chooser = ids.map((id) => read(id, [id]));
  timer.mockRestore();
  expect(responder).toHaveLength(ids.length);
  expect(chooser.every((delays) => delays.length === 1)).toBe(true);
  return new Map(ids.map((id, i) => [id, { chooserMs: chooser[i][0], responderMs: responder[i] }]));
}

function initialDeck() {
  const board = parse('Qc Jc Tc 2d 3d');
  // Seat1 has the unique highest preflop pair rank, and the only possible
  // royal on this flop. Omaha uses exactly Ac Kc + Qc Jc Tc, not its four aces.
  const hands: Card[][] = [parse('Ac Kc Ad Ah As'), [], [], [], [], [], []];
  const reserved = [...hands.flat(), ...board];
  const used = new Set(reserved.map(cardKey));
  expect(used.size).toBe(reserved.length);
  const free: Card[] = [];
  for (const suit of Object.values(suits))
    for (const rank of '23456789TJQKA') {
      const card = { rank: rank as Card['rank'], suit };
      if (!used.has(cardKey(card))) free.push(card);
    }
  while (hands.some((hand) => hand.length < 5)) {
    for (const hand of hands) if (hand.length < 5) hand.push(free.shift()!);
  }
  const ordered = [...hands.flat(), ...board, ...free];
  expect(ordered).toHaveLength(52);
  expect(new Set(ordered.map(cardKey)).size).toBe(52);
  return { board, hands, ordered };
}

type Scenario =
  | { kind: 'chooser_once'; prefix: 0; handNumber: 2 }
  | { kind: 'responder_decline'; prefix: 3; handNumber: 3 };
type Horse = { id: string; verdict: 'once' | 'multi'; chooserMs: number; responderMs: number };

function population(engine: Record<string, any>, scenario: Scenario) {
  // A finite initial-population selection reads the actual production methods.
  // It does not replace their verdicts/timing or force responses after dealing.
  // REBASE: the current responder delay keys on the id's first character, so the
  // finite pool varies that leading hex digit; the suffix keeps every id unique.
  const poolIds = Array.from(
    { length: 1024 },
    (_, n) => `${(n % 16).toString(16)}3000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`
  );
  const thinkMs = probeHorseRitThinkMs(PROBE_TABLE, scenario.handNumber, poolIds);
  const pool: Horse[] = poolIds.map((id) => ({
    id,
    verdict: engine.horseRitVerdict(id),
    chooserMs: thinkMs.get(id)!.chooserMs,
    responderMs: thinkMs.get(id)!.responderMs,
  }));
  const multi = pool.filter((h) => h.verdict === 'multi');
  const once = pool.filter((h) => h.verdict === 'once');
  if (scenario.kind === 'chooser_once') {
    const chooser = [...once].sort((a, b) => a.chooserMs - b.chooserMs)[0];
    expect(chooser).toBeDefined();
    const later = multi
      .filter((h) => h.responderMs > chooser.chooserMs + 100)
      .sort((a, b) => b.responderMs - a.responderMs)
      .slice(0, 6);
    expect(later).toHaveLength(6);
    return { horses: [chooser, ...later], refusalMs: chooser.chooserMs, declinerId: chooser.id };
  }
  const chooser = [...multi].sort((a, b) => a.chooserMs - b.chooserMs)[0];
  expect(chooser).toBeDefined();
  // REBASE: the prepared 5-9 s window targeted the archived think-time spread;
  // current source answers inside 2.5-3.7 s. Every ordering gap is retained.
  const decliner = once
    .filter(
      (h) =>
        h.responderMs > chooser.chooserMs + 500 &&
        multi.some(
          (m) =>
            m.id !== chooser.id &&
            m.responderMs > chooser.chooserMs + 100 &&
            m.responderMs < h.responderMs - 100
        ) &&
        multi.filter((m) => m.id !== chooser.id && m.responderMs > h.responderMs + 100).length >= 4
    )
    .sort((a, b) => a.responderMs - b.responderMs)[0];
  expect(decliner).toBeDefined();
  const early = multi.find(
    (h) =>
      h.id !== chooser.id &&
      h.responderMs > chooser.chooserMs + 100 &&
      h.responderMs < decliner.responderMs - 100
  );
  expect(early).toBeDefined();
  const later = multi
    .filter(
      (h) => h.id !== chooser.id && h.id !== early!.id && h.responderMs > decliner.responderMs + 100
    )
    .sort((a, b) => b.responderMs - a.responderMs)
    .slice(0, 4);
  expect(later).toHaveLength(4);
  return {
    horses: [chooser, decliner, early!, ...later],
    refusalMs: decliner.responderMs,
    declinerId: decliner.id,
  };
}

const cases: Scenario[] = [
  { kind: 'chooser_once', prefix: 0, handNumber: 2 },
  { kind: 'responder_decline', prefix: 3, handNumber: 3 },
];

describe('seven-seat PLO5 Horse refusal after actual accepted betting', () => {
  it.each(cases)(
    '$kind with $prefix common cards pays one board exactly once',
    async (scenario) => {
      expect(maxSeatsForVariant('plo5')).toBe(7);
      expect(isSeatCountLegal('plo5', 7)).toBe(true);
      expect(isSeatCountLegal('plo5', 8)).toBe(false);
      const physical = initialDeck();
      const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
      engines.push(engine);
      Object.assign(engine, {
        running: true,
        handCount: scenario.handNumber,
        tableInfo: {
          game_variant: 'plo5',
          small_blind: 1,
          big_blind: 2,
          max_players: 7,
          min_buy_in: 80,
          max_buy_in: 400,
          tournament_id: null,
          game_type: 'cash',
          run_it_twice: true,
          allow_run_it_twice: true,
          run_it_twice_enabled: false,
          run_it_mode: 'player_choice',
          insurance_enabled: false,
          bbj_percent: 100,
          arena: { id: 'synthetic-chip-arena', asset: 'chips', is_platform: true, union_id: null },
        },
      });
      const chosen = population(engine, scenario);
      const ids = chosen.horses.map((h) => h.id);
      expect(new Set(ids).size).toBe(7);
      expect(chosen.horses.filter((h) => h.verdict === 'once')).toHaveLength(1);
      expect(chosen.horses.every((h) => h.chooserMs < 20_000 && h.responderMs < 20_000)).toBe(true);
      const players: SeatPlayer[] = ids.map((user_id, i) => ({
        user_id,
        seat: i + 1,
        username: `Synthetic Horse ${i + 1}`,
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }));
      engine.seatedPlayers = players.map((p) => ({
        user_id: p.user_id,
        seat_number: p.seat,
        username: p.username,
        stack: p.stack,
        is_horse: true,
      }));
      const emitted: Record<string, any>[] = [];
      const ritEvents: Record<string, any>[] = [];
      engine.hub = {
        emitEvent: (_table: string, event: Record<string, any>) =>
          emitted.push(structuredClone(event)),
      };
      // Only cosmetic/network/persistence surfaces are isolated. The chooser,
      // responders, waits, pacing and both settlement entry points remain real.
      engine.broadcastCurrentState = vi.fn();
      engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
      engine.markProgress = vi.fn();
      engine.killForRestart = vi.fn();
      engine.runItTwiceEngine.addEventListener((event: Record<string, any>) =>
        ritEvents.push(structuredClone(event))
      );
      const response = vi.spyOn(engine, 'respondToRIT');
      const paced = vi.spyOn(engine, 'pacedAllInRunout');
      const multiResolve = vi.spyOn(engine, 'dealAndResolveRIT');
      const continueRunout = vi.spyOn(engine, 'safeContinueRunout');
      const addListener = vi.spyOn(engine.runItTwiceEngine, 'addEventListener');
      const removeListener = vi.spyOn(engine.runItTwiceEngine, 'removeEventListener');
      const cancelDeadline = vi.spyOn(deadlineScheduler, 'cancel');
      const startTimer = vi.spyOn(globalThis, 'setTimeout');
      const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
      const startPoll = vi.spyOn(globalThis, 'setInterval');
      const clearPoll = vi.spyOn(globalThis, 'clearInterval');
      const idleTimerCount = vi.getTimerCount();
      expect(engine.applyRunItTwiceConfig()).toEqual({
        ritEffective: true,
        insuranceEnabled: false,
      });
      const full = engine.getFullRakeAndBBJConfig();
      expect(full).toMatchObject({ rakePercent: 10, rakeCap: 5, bbjEnabled: true, bbjFeeBB: 0.25 });
      expect(full.rules.minPlayersDealt).toBe(3);
      const shuffle = vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(function (this: Deck) {
        (this as unknown as { cards: Card[] }).cards = structuredClone(physical.ordered);
      });
      const controller = new HandController(
        {
          tableId: TABLE,
          handNumber: scenario.handNumber,
          gameVariant: 'plo5',
          smallBlind: 1,
          bigBlind: 2,
          asset: 'chips',
          ritEnabled: true,
          rakeConfig: {
            percent: full.rakePercent,
            cap: full.rakeCap,
            noFlopNoDrop: true,
            playerCountCaps: getPlayerCountCaps(full.rakeCap),
          },
          bbjConfig: {
            enabled: full.bbjEnabled,
            feeBB: full.bbjFeeBB,
            minPotBB: full.rules.minPotBB,
            minPlayersDealt: full.rules.minPlayersDealt,
          },
        },
        players,
        1
      );
      shuffle.mockRestore();
      engine.handController = controller;
      const events: HandEvent[] = [];
      const dispatches: Promise<void>[] = [];
      let atPark: GameState | undefined;
      controller.onEvent((event) => {
        events.push(structuredClone(event));
        if (event.type === 'ALL_IN_RUNOUT') {
          atPark = controller.getState();
          dispatches.push(engine.handleHandEvent(event, engine.seatedPlayers));
        }
      });
      controller.start();
      expect(controller.getState().players.map((p) => p.cards)).toEqual(physical.hands);
      const accepted: ActionRecord[] = [];
      const act = (passive: boolean) => {
        const before = controller.getState();
        const actor = before.players.find((p) => p.seat === before.currentPlayerSeat)!;
        expect(actor).toBeDefined();
        const menu = controller.getAuthoritativeActionState(actor.user_id)!;
        expect(menu.canAct).toBe(true);
        expect(menu.structure).toBe('pot_limit');
        let action: 'all_in' | 'raise' | 'bet' | 'call' | 'check';
        let amount = 0;
        if (!passive && menu.legalActions.includes('all_in')) action = 'all_in';
        else if (!passive && menu.legalActions.includes('raise')) {
          action = 'raise';
          amount = menu.maxRaiseTo!;
        } else if (!passive && menu.legalActions.includes('bet')) {
          action = 'bet';
          amount = menu.maxRaiseTo!;
        } else action = menu.legalActions.includes('call') ? 'call' : 'check';
        expect(menu.legalActions).toContain(action);
        if (action === 'raise' || action === 'bet') {
          expect(amount).toBeGreaterThanOrEqual(menu.minRaiseTo!);
          expect(amount).toBeLessThanOrEqual(menu.maxRaiseTo!);
        }
        expect(controller.performAction(actor.seat, action, amount)).toBe(true);
        const after = controller.getState();
        expect(after.actionHistory!.length).toBe(before.actionHistory!.length + 1);
        accepted.push(structuredClone(after.actionHistory!.at(-1)!));
        expect(cents(after.players.reduce((sum, p) => sum + p.stack, 0) + after.pot)).toBe(70000);
      };
      if (scenario.prefix === 3) {
        for (let n = 0; n < 7 && controller.getState().stage === 'preflop'; n++) act(true);
        expect(controller.getState().stage).toBe('flop');
        expect(controller.getCommunityCards()).toEqual(physical.board.slice(0, 3));
      }
      for (let n = 0; n < 35 && !atPark; n++) act(false);
      expect(atPark).toBeDefined();
      expect(atPark!.stage).toBe(scenario.prefix === 0 ? 'preflop' : 'flop');
      expect(atPark!.pot).toBe(700);
      expect(
        atPark!.players.map((p) => [p.stack, p.totalInvested, p.is_all_in, p.is_folded])
      ).toEqual(Array.from({ length: 7 }, () => [0, 100, true, false]));
      expect(atPark!.actionHistory).toEqual(accepted);
      expect(events.filter((e) => e.type === 'ALL_IN_RUNOUT')).toHaveLength(1);
      await Promise.all(dispatches);
      const offer = emitted.find((e) => e.type === 'rit_offer')!;
      expect(offer).toMatchObject({
        table_id: TABLE,
        hand_number: scenario.handNumber,
        pot: 700,
        maxRuns: 3,
        timeoutSeconds: 25,
        chooserPlayerId: ids[0],
      });
      expect(sortedIds(offer.allPlayerIds)).toEqual(sortedIds(ids));
      expect(engine.runItTwiceEngine.getState(TABLE)).toMatchObject({
        status: 'offered',
        handId: `${TABLE}:${scenario.handNumber}`,
        chooserDecided: false,
        pot: 700,
      });
      expect(
        deadlineScheduler.persistPending(TABLE).filter((d) => d.eventId === 'rit_offer')
      ).toEqual([{ eventId: 'rit_offer', deadlineMs: offer.deadline_ts }]);
      // REBASE: current waitForRITResponse observes the offer with one 250 ms poll,
      // not a listener. The only listener is the permanent forwarder.
      expect(addListener).toHaveBeenCalledTimes(1);
      const pollIndices = startPoll.mock.calls.flatMap((args, index) =>
        args[1] === 250 ? [index] : []
      );
      expect(pollIndices).toHaveLength(1);
      const pollHandle = startPoll.mock.results[pollIndices[0]].value;
      const safetyIndices = startTimer.mock.calls.flatMap((args, index) =>
        args[1] === 30_000 ? [index] : []
      );
      expect(safetyIndices).toHaveLength(1);
      const safetyHandle = startTimer.mock.results[safetyIndices[0]].value;

      // The separate reference must agree with a literal unique royal winner.
      // It verifies gross economics; rake/BBJ expectations below are independent.
      const reference = settleOmahaReference({
        variant: 'plo5',
        chipUnit: 0.01,
        dealerSeat: 1,
        boards: [physical.board],
        players: atPark!.players.map((p) => ({
          id: p.user_id,
          seat: p.seat,
          cards: p.cards,
          contributed: p.totalInvested,
          folded: p.is_folded,
        })),
      });
      expect(reference.pots).toEqual([{ amount: 700, eligible: ids }]);
      expect(Object.values(reference.refunds).every((amount) => amount === 0)).toBe(true);
      expect(
        reference.awards.map((a) => [a.boardIndex, a.playerId, a.half, cents(a.amount)])
      ).toEqual([[0, ids[0], 'high', 70000]]);

      await vi.advanceTimersByTimeAsync(chosen.refusalMs + 10);
      // REBASE: the wait notices the refusal on its next 250 ms poll tick.
      await vi.advanceTimersByTimeAsync(250);
      const expectedCalls =
        scenario.kind === 'chooser_once'
          ? [[ids[0], undefined, 1]]
          : [
              [ids[0], undefined, 3],
              [ids[2], 'accept'],
              [ids[1], 'decline'],
            ];
      expect(response.mock.calls).toEqual(expectedCalls);
      expect(response.mock.results.map((r) => r.value)).toEqual(
        scenario.kind === 'chooser_once'
          ? [{ success: true, status: 'declined_by_chooser' }]
          : [
              { success: true, status: 'waiting_for_others' },
              { success: true, status: 'waiting_for_others' },
              { success: true, status: 'declined' },
            ]
      );
      // REBASE: current RunItTwiceEngine.chooserDecides(1) ends the offer without an
      // engine event (its 'chooser' decline reason belonged to the archived
      // listener-driven wait); the felt notice and the declined state carry it.
      expect(ritEvents.filter((e) => e.type === 'RIT_DECLINED')).toEqual(
        scenario.kind === 'chooser_once'
          ? []
          : [
              expect.objectContaining({
                tableId: TABLE,
                handId: `${TABLE}:${scenario.handNumber}`,
                declinedBy: chosen.declinerId,
                reason: 'player',
              }),
            ]
      );
      expect(engine.runItTwiceEngine.getState(TABLE)).toMatchObject({
        chooserDecided: true,
        chosenRuns: scenario.kind === 'chooser_once' ? 1 : 3,
      });
      expect(ritEvents.some((e) => e.type === 'RIT_ACCEPTED')).toBe(false);
      expect(emitted.filter((e) => e.type === 'rit_single_run')).toEqual([
        expect.objectContaining({
          table_id: TABLE,
          hand_number: scenario.handNumber,
          reason: scenario.kind === 'chooser_once' ? 'chooser_chose_one' : 'player_declined',
          player_id: chosen.declinerId,
        }),
      ]);
      expect(engine.runItTwiceEngine.getState(TABLE).status).toBe('declined');
      expect(sortedIds([...engine.runItTwiceEngine.getState(TABLE).acceptedBy])).toEqual(
        sortedIds(scenario.kind === 'chooser_once' ? [ids[0]] : [ids[0], ids[2]])
      );
      expect(engine.runItTwiceEngine.getChosenRuns(TABLE)).toBe(1);
      expect(cancelDeadline).toHaveBeenCalledWith(TABLE, 'rit_offer');
      expect(deadlineScheduler.persistPending(TABLE).some((d) => d.eventId === 'rit_offer')).toBe(
        false
      );
      expect(removeListener).not.toHaveBeenCalled();
      expect(clearPoll).toHaveBeenCalledWith(pollHandle);
      expect(clearTimer).toHaveBeenCalledWith(safetyHandle);
      expect(paced).toHaveBeenCalledTimes(1);
      expect(multiResolve).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(40_000 - chosen.refusalMs - 10 - 250);
      const after = controller.getState();
      expect(controller.getCommunityCards()).toEqual(physical.board);
      expect(controller.getRemainingDeck()).toEqual(physical.ordered.slice(40));
      expect(after.players.map((p) => p.cards)).toEqual(physical.hands);
      expect(after.actionHistory).toEqual(accepted);
      const winnerEvents = events.filter(
        (e): e is Extract<HandEvent, { type: 'WINNERS' }> => e.type === 'WINNERS'
      );
      expect(winnerEvents).toHaveLength(1);
      expect(winnerEvents[0].winners.map((w) => [w.userId, cents(w.amount)])).toEqual([
        [ids[0], 69450],
      ]);
      expect(
        winnerEvents[0].perPotAwards?.map((a) => [
          a.potIndex,
          a.userId,
          a.low === true,
          cents(a.amount),
        ])
      ).toEqual([[0, ids[0], false, 69450]]);
      expect(winnerEvents[0].winners[0].hand?.cards.map(cardKey).sort()).toEqual(
        parse('Ac Kc Qc Jc Tc').map(cardKey).sort()
      );
      expect(after.players.map((p) => [p.user_id, cents(p.stack)])).toEqual(
        ids.map((id, i) => [id, i === 0 ? 69450 : 0])
      );
      expect(after.players.every((p) => (p.returnedUncalled ?? 0) === 0)).toBe(true);
      expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toEqual([
        expect.objectContaining({ handNumber: scenario.handNumber, rake: 5, bbjFee: 0.5 }),
      ]);
      expect(cents(after.players.reduce((sum, p) => sum + p.stack, 0)) + 500 + 50).toBe(70000);
      expect(continueRunout).toHaveBeenCalledTimes(1);
      expect(continueRunout).toHaveBeenCalledWith('paced_runout_complete', controller);
      expect(emitted.some((e) => e.type === 'rit_result' || e.type === 'rit_all_accepted')).toBe(
        false
      );
      expect(response.mock.calls).toEqual(expectedCalls); // Later scheduled Horse callbacks became no-ops.
      expect(vi.getTimerCount()).toBe(idleTimerCount); // Exact test clock; not a process-wide orphan claim.
      expect(reportError).not.toHaveBeenCalled();
      expect(engine.killForRestart).not.toHaveBeenCalled();

      // Real late public responses are refused. Passing the expired safety/offer
      // deadlines again must not create another notice, continuation or payout.
      const settled = structuredClone(after);
      const eventCount = events.length;
      const wireCount = emitted.length;
      expect(engine.respondToRIT(ids[0], undefined, 3)).toEqual({
        success: false,
        error: 'No active Run It Twice offer',
      });
      expect(engine.respondToRIT(ids[1], 'accept')).toEqual({
        success: false,
        error: 'No active Run It Twice offer',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.getState()).toEqual(settled);
      expect(events).toHaveLength(eventCount);
      expect(emitted).toHaveLength(wireCount);
      expect(paced).toHaveBeenCalledTimes(1);
      expect(continueRunout).toHaveBeenCalledTimes(1);
      expect(removeListener).not.toHaveBeenCalled();
      expect(clearPoll).toHaveBeenCalledTimes(1);
      expect(deadlineScheduler.persistPending(TABLE)).toEqual([]);
      expect(vi.getTimerCount()).toBe(idleTimerCount);
    }
  );
});
