/** Phase 9 P9.1: ported from the prepared Horse packet (SHA256
 * f4787b661124957ad28ab390063a0a2eefb61eb3cb602723f9df178f256cc7e0)
 * and rebased onto current source; each adaptation is marked REBASE.
 * Seven-seat PLO5 cash: real accepted betting trajectory,
 * actual ALL_IN_RUNOUT dispatch, Horse consent and RIT settlement. Only the
 * initial physical deck is fixed, before dealing. No stack/card/history state
 * is injected after start. No DB persistence, jackpot payout or live use proof. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import { maxSeatsForVariant, isSeatCountLegal } from '../config/tableSeating.js';
import { getPlayerCountCaps } from '../config/RakeConfig.js';
import { settleOmahaReference } from '../benchmark/OmahaReference.js';
import { reportError } from '../services/errorReporter.js';
import type { ActionRecord, Card, GameState, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: false, alertId: null })),
}));
const TABLE = '91000000-0000-4000-8000-000000000009';
const PROBE_TABLE = '91000000-0000-4000-8000-000000000109';
const engines: Record<string, any>[] = [];
const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const parse = (text: string): Card[] =>
  text.split(' ').map((card) => ({
    rank: card[0] as Card['rank'],
    suit: suits[card[1] as keyof typeof suits],
  }));
const cardKey = (card: Card) => `${card.rank}:${card.suit}`;
const cents = (amount: number) => Math.round(amount * 100);
const sorted = <T>(rows: T[]) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

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
  // Test-owned fake clocks only; this is cleanup, not a no-orphan runtime claim.
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

function initialDeck(prefix: 0 | 3) {
  const boards =
    prefix === 0
      ? ['Qc Jc Tc 2d 3d', 'Qh Jh Th 4d 5d', 'Qs Js Ts 6d 7d'].map(parse)
      : ['Qc Jc Tc 2d 3d', 'Qc Jc Tc 4d 5d', 'Qc Jc Tc 6d 7d'].map(parse);
  const shared = boards[0].slice(0, prefix);
  const physicalBoards = [...shared, ...boards.flatMap((board) => board.slice(prefix))];
  const hands = ['Ac Kc', 'Ah Kh', 'As Ks'].map(parse).concat([[], [], [], []]);
  const reserved = [...hands.flat(), ...physicalBoards];
  expect(new Set(reserved.map(cardKey)).size).toBe(reserved.length);
  const used = new Set(reserved.map(cardKey));
  const free: Card[] = [];
  for (const suit of Object.values(suits))
    for (const rank of '23456789TJQKA') {
      const card = { rank: rank as Card['rank'], suit };
      if (!used.has(cardKey(card))) free.push(card);
    }
  // Round-robin filler allocation is unrelated to either evaluator. The three
  // literal AK suited holdings own the unique royal on their named board.
  while (hands.some((hand) => hand.length < 5)) {
    for (const hand of hands) if (hand.length < 5) hand.push(free.shift()!);
  }
  const ordered = [...hands.flat(), ...physicalBoards, ...free];
  expect(ordered).toHaveLength(52);
  expect(new Set(ordered.map(cardKey)).size).toBe(52);
  return { hands, boards, ordered, shared };
}

const cases = [
  { prefix: 0, runs: 2, handNumber: 2 },
  { prefix: 0, runs: 3, handNumber: 3 },
  { prefix: 3, runs: 3, handNumber: 3 },
] as const;

describe('PLO5 seven-seat accepted offer-to-payout with actual rake and BBJ config', () => {
  it.each(cases)('$prefix shared cards / $runs runs', async ({ prefix, runs, handNumber }) => {
    expect(maxSeatsForVariant('plo5')).toBe(7);
    expect(isSeatCountLegal('plo5', 7)).toBe(true);
    expect(isSeatCountLegal('plo5', 8)).toBe(false);
    const physical = initialDeck(prefix);
    const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
    engines.push(engine);
    Object.assign(engine, {
      running: true,
      handCount: handNumber,
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

    // Condition this finite population on the existing deterministic accept
    // branch. Do not stub the Horse verdict, timing, scheduler or responder.
    // This proves neither natural acceptance rates nor every Horse personality.
    const ids: string[] = [];
    for (let n = 1; n <= 70 && ids.length < 7; n++) {
      const id = `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      if (engine.horseRitVerdict(id) === 'multi') ids.push(id);
    }
    expect(ids).toHaveLength(7);
    const thinkMs = probeHorseRitThinkMs(PROBE_TABLE, handNumber, ids);
    for (const id of ids) {
      expect(engine.horseRitVerdict(id)).toBe('multi');
      expect(thinkMs.get(id)!.chooserMs).toBeLessThan(20_000);
      expect(thinkMs.get(id)!.responderMs).toBeLessThan(20_000);
    }
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
    engine.seatedPlayers = players.map((player) => ({
      user_id: player.user_id,
      seat_number: player.seat,
      username: player.username,
      stack: player.stack,
      is_horse: true,
    }));
    const emitted: Record<string, any>[] = [];
    engine.hub = {
      emitEvent: (_table: string, event: Record<string, any>) =>
        emitted.push(structuredClone(event)),
    };
    // Isolate cosmetic/network and persistence surfaces. Neither offer logic,
    // response transport nor settlement/scoring/controller code is replaced.
    engine.broadcastCurrentState = vi.fn();
    engine.broadcastAllInEquity = vi.fn().mockResolvedValue(undefined);
    engine.markProgress = vi.fn();
    engine.killForRestart = vi.fn();
    const singleRunFallback = vi.spyOn(engine, 'safeContinueRunout');
    expect(engine.applyRunItTwiceConfig()).toEqual({ ritEffective: true, insuranceEnabled: false });
    const full = engine.getFullRakeAndBBJConfig();
    expect(full).toMatchObject({ rakePercent: 10, rakeCap: 5, bbjEnabled: true, bbjFeeBB: 0.25 });
    expect(full.rules.minPlayersDealt).toBe(3);

    // Mock only pre-deal shuffle ordering. The real Deck.deal, actual forced
    // bets and every later player contribution remain controller-owned.
    const shuffle = vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(function (this: Deck) {
      (this as unknown as { cards: Card[] }).cards = structuredClone(physical.ordered);
    });
    const controller = new HandController(
      {
        tableId: TABLE,
        handNumber,
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
        // Execute the actual production event switch. Other event kinds are
        // observed here but their DB/broadcast handlers are outside this test.
        dispatches.push(engine.handleHandEvent(event, engine.seatedPlayers));
      }
    });
    controller.start();
    expect(controller.getState().players.map((player) => player.cards)).toEqual(physical.hands);
    const acceptedActions: ActionRecord[] = [];
    const act = (passive: boolean) => {
      const before = controller.getState();
      const actor = before.players.find((player) => player.seat === before.currentPlayerSeat)!;
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
      const oldCount = before.actionHistory!.length;
      expect(controller.performAction(actor.seat, action, amount)).toBe(true);
      const after = controller.getState();
      expect(after.actionHistory!.length).toBe(oldCount + 1);
      acceptedActions.push(structuredClone(after.actionHistory!.at(-1)!));
      expect(cents(after.players.reduce((sum, player) => sum + player.stack, 0) + after.pot)).toBe(
        70000
      );
    };
    if (prefix === 3) {
      for (let n = 0; n < 7 && controller.getState().stage === 'preflop'; n++) act(true);
      expect(controller.getState().stage).toBe('flop');
      expect(controller.getCommunityCards()).toEqual(physical.shared);
    }
    for (let n = 0; n < 35 && !atPark; n++) act(false);
    expect(atPark).toBeDefined();
    expect(atPark!.stage).toBe(prefix === 0 ? 'preflop' : 'flop');
    expect(atPark!.pot).toBe(700);
    expect(
      atPark!.players.map((player) => [
        player.stack,
        player.totalInvested,
        player.is_all_in,
        player.is_folded,
      ])
    ).toEqual(Array.from({ length: 7 }, () => [0, 100, true, false]));
    expect(atPark!.actionHistory).toEqual(acceptedActions);
    expect(events.filter((event) => event.type === 'ALL_IN_RUNOUT')).toHaveLength(1);
    await Promise.all(dispatches);
    const offer = emitted.find((event) => event.type === 'rit_offer')!;
    expect(offer).toMatchObject({ table_id: TABLE, hand_number: handNumber, pot: 700, maxRuns: 3 });
    expect(sorted(offer.allPlayerIds)).toEqual(sorted(ids));
    expect(ids).toContain(offer.chooserPlayerId);
    expect(engine.runItTwiceEngine.getState(TABLE)).toMatchObject({
      status: 'offered',
      handId: `${TABLE}:${handNumber}`,
      pot: 700,
    });

    const boards = physical.boards.slice(0, runs);
    const reference = settleOmahaReference({
      variant: 'plo5',
      chipUnit: 0.01,
      dealerSeat: 1,
      sharedPrefixLength: prefix,
      boards,
      players: atPark!.players.map((player) => ({
        id: player.user_id,
        seat: player.seat,
        cards: player.cards,
        contributed: player.totalInvested,
        folded: player.is_folded,
      })),
    });
    const boardGross = runs === 2 ? [35000, 35000] : [23334, 23333, 23333];
    const winnerIds = boards.map((_, index) => ids[prefix === 3 ? 0 : index]);
    expect(reference.pots).toEqual([{ amount: 700, eligible: ids }]);
    expect(Object.values(reference.refunds).every((amount) => amount === 0)).toBe(true);
    expect(
      reference.awards.map((award) => [
        award.boardIndex,
        award.playerId,
        award.half,
        cents(award.amount),
      ])
    ).toEqual(winnerIds.map((id, index) => [index, id, 'high', boardGross[index]]));
    // Literal schedule: min(700×10%,5)=5 rake;2×0.25=0.50 BBJ, ONCE.
    // Gross odd cent goes to board1. Proportional rounding and its single-cent
    // repair produce347.25 per board (two runs) or231.50 (three runs).
    const boardNet = runs === 2 ? [34725, 34725] : [23150, 23150, 23150];
    const expectedPaid = Object.fromEntries(ids.map((id) => [id, 0]));
    winnerIds.forEach((id, index) => {
      expectedPaid[id] += boardNet[index];
    });

    await vi.advanceTimersByTimeAsync(25_000);
    const result = emitted.find((event) => event.type === 'rit_result')!;
    expect(emitted.filter((event) => event.type === 'rit_result')).toHaveLength(1);
    expect(result).toMatchObject({ runs, base_board_count: prefix, net_pot: 694.5 });
    expect(result.boards).toEqual(
      boards.map((board) => board.map((card) => card.rank + card.suit))
    );
    expect(emitted.findIndex((event) => event.type === 'rit_all_accepted')).toBeGreaterThanOrEqual(
      0
    );
    expect(emitted.findIndex((event) => event.type === 'rit_all_accepted')).toBeLessThan(
      emitted.indexOf(result)
    );
    expect(emitted.some((event) => event.type === 'rit_single_run')).toBe(false);
    expect(
      sorted(
        result.per_board_awards.map((award: any) => [
          award.board,
          award.user_id,
          award.low,
          cents(award.amount),
        ])
      )
    ).toEqual(sorted(winnerIds.map((id, index) => [index + 1, id, false, boardNet[index]])));
    for (const award of result.per_board_awards) {
      const seat = ids.indexOf(award.user_id);
      const own = new Set(physical.hands[seat].map(cardKey));
      const board = new Set(boards[award.board - 1].map(cardKey));
      expect(award.cards).toHaveLength(5);
      expect(new Set(award.cards.map(cardKey)).size).toBe(5);
      expect(award.cards.filter((card: Card) => own.has(cardKey(card)))).toHaveLength(2);
      expect(award.cards.filter((card: Card) => board.has(cardKey(card)))).toHaveLength(3);
    }
    const after = controller.getState();
    expect(
      Object.fromEntries(after.players.map((player) => [player.user_id, cents(player.stack)]))
    ).toEqual(expectedPaid);
    expect(cents(after.players.reduce((sum, player) => sum + player.stack, 0))).toBe(69450);
    expect(after.players.every((player) => (player.returnedUncalled ?? 0) === 0)).toBe(true);
    expect(events.filter((event) => event.type === 'HAND_COMPLETE')).toEqual([
      expect.objectContaining({ handNumber, rake: 5, bbjFee: 0.5 }),
    ]);
    expect(engine.currentHandPots).toEqual([{ index: 0, amount: 700, eligible: ids }]);
    expect(engine.ritResolutionOwner).toBeNull();
    expect(engine.runoutPayoutMutationUnsafe).toBe(false);
    expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(false);
    expect(singleRunFallback).not.toHaveBeenCalled();
    expect(engine.killForRestart).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
