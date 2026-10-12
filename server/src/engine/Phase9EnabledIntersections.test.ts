/**
 * Phase 9 P9.2: the enabled Omaha intersections the existing Phase 9 suites
 * did not reach. The reconciliation that names them, and the launch rules
 * that enable each one, is docs/horse-brain-phase9-economics-2026-10-02.md.
 *
 *   1. Chip cash with the published rake and BBJ deductions, for classic,
 *      single-board bomb and two/three-board bomb hands, every Omaha variant
 *      at its cash seat-law ceiling. Every earlier Omaha economics case ran
 *      with rake and BBJ at zero.
 *   2. Whole-Diamond cash at the same ceilings with an odd-unit pot: classic
 *      and single-board bomb for all five variants, and two/three-board bomb
 *      for PLO4, PLO8 and FLO8 (Phase9MultiboardUnits already holds PLO5 and
 *      PLO6 at their ceilings).
 *   3. Run it two and three times at the seat-law ceiling for PLO4, PLO6, PLO8
 *      and FLO8, in cents with rake and BBJ and in whole Diamonds, and for
 *      seven-seat PLO5 in whole Diamonds. Seven-seat PLO5 chip cash belongs
 *      to P9.1 and is not repeated here.
 *   4. Tournament chips through the controller at each variant's tournament
 *      ceiling (ten seats for PLO4/PLO8/FLO8, the deck's nine for PLO5 and
 *      seven for PLO6), with the odd-unit pot. OmahaOracleLaunchCeilings
 *      holds PLO4/FLO8 at ten seats in the oracle only.
 *
 * Expected cards, pots, returns and pre-deduction awards come from the offline
 * OmahaReference. The deductions are hand arithmetic from the published 10/20
 * schedule row (10%, cap 15.00, BBJ 0.06 BB): rake 15.00 + BBJ 1.20 on a
 * 1,620.00 pot leaves exactly 99%, and every chip fixture asserts that each
 * reference award is a whole number of dollars, so 99% of it is an exact cent
 * amount and no rounding rule is borrowed from the engine. No HandController,
 * RunItTwiceEngine or runout calculation supplies an expected value.
 *
 * As in Phase9MultiboardUnits and Phase9OmahaRitIndependent, the balanced
 * settled contributions are injected at the standing street. They are not
 * proof of a prior accepted wagering trajectory, offer dispatch, persistence
 * or natural Horse use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandController } from './HandController.js';
import { ServerTableEngine } from './ServerTableEngine.js';
import { Deck } from './PokerEngine.js';
import {
  OMAHA_RULES,
  referenceDeck,
  settleOmahaReference,
  type OmahaVariant,
} from '../benchmark/OmahaReference.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
import { maxSeatsFor } from './VariantRules.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { reportError } from '../services/errorReporter.js';
import type { Card, GameState, HandConfig, HandEvent, SeatPlayer } from '../types.js';

vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
}));

const TABLE = '99299929-9929-4929-8929-999292992999';
const SB = 10;
const BB = 20;
const DEALER = 1;
/* Hand arithmetic for every chip case: gross pot after the uncalled 60.00 is
   returned = 180 x 5 + 360 x 2 = 1,620.00. Rake 10% = 162.00, capped at 15.00
   (full cap: three or more players dealt at a six-to-eight-max table). BBJ =
   20 x 0.06 = 1.20. Net = 1,603.80 = 99% of 1,620.00.
   PLO6 collects no BBJ (BBJ_QUALIFYING_HANDS.plo6 is not eligible), so its
   row is 180 x 5 + 300 x 2 = 1,500.00 gross, rake 15.00, net 1,485.00: again
   exactly 99%. */
function chipBook(variant: OmahaVariant) {
  const plo6 = variant === 'plo6';
  return {
    contributions: plo6 ? [180, 480, 540, 180, 180] : [180, 540, 600, 180, 180],
    grossCents: plo6 ? 150_000 : 162_000,
    rake: 15,
    bbj: plo6 ? 0 : 1.2,
    netCents: plo6 ? 148_500 : 160_380,
    side: plo6 ? 600 : 720,
  };
}
const REFUND = 60;

const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const parse = (text: string): Card[] =>
  text.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: suits[c[1] as keyof typeof suits],
  }));
const key = (c: Card) => c.rank + ':' + c.suit;
const wire = (board: Card[]) => board.map((c) => c.rank + c.suit);
const cents = (amount: number) => Math.round(amount * 100);
function sorted<T>(rows: T[]): T[] {
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

type CashAsset = 'chips' | 'diamonds';
/** Tournament chips: whole units, no rake and no BBJ. */
type Asset = CashAsset | 'tournament';
const whole = (asset: Asset) => asset !== 'chips';
/* The ceiling a table of this kind may hold: the cash seat law, or for a
   tournament the deck ceiling under the ten-seat table maximum, the same
   expression TournamentManagerBase applies. */
const seatsFor = (variant: OmahaVariant, asset: Asset) =>
  asset === 'tournament' ? Math.min(10, maxSeatsFor(variant)) : maxSeatsForVariant(variant);
const LIVE = ['As 2s Jh Td', 'Kh Kd Qc Qd', 'Ah 3h 9s 9d'].map(parse);
/* Board order puts the short stack's scoop first, so even a one-board hand
   pays two players and the deduction is shared, not taken from one award. */
const BOARDS = ['7c Tc Ad 5h 6h', '3c 4d 8h Kc Qh', '5c 6d 9h Th Jc'].map(parse);
/* Seats 1-3 are live, 4 and 5 fold after reaching the main-pot level, the rest
   fold having put nothing in. Seat 1 is all in short; seat 3 is 60 over seat 2
   and gets it back uncalled. The Diamond row moves one unit onto every
   main-pot contributor so the main pot is odd (905) and the odd-unit rules
   (earliest board, high before low, clockwise from the button) are reached. */
const DIAMOND_CONTRIBUTIONS = [181, 541, 601, 181, 181];
function contributionsFor(variant: OmahaVariant, asset: Asset): number[] {
  return whole(asset) ? DIAMOND_CONTRIBUTIONS : chipBook(variant).contributions;
}

function physicalDeal(variant: OmahaVariant, seats: number, boardCount: 1 | 2 | 3) {
  const holes = OMAHA_RULES[variant].holes;
  const boards = BOARDS.slice(0, boardCount);
  const used = new Set([...LIVE.flat(), ...boards.flat()].map(key));
  const free = referenceDeck().filter((c) => !used.has(key(c)));
  const hands = Array.from({ length: seats }, (_, i) =>
    i < 3 ? [...LIVE[i], ...free.splice(0, holes - 4)] : free.splice(0, holes)
  );
  const remaining = [...boards.flat(), ...free];
  const physical = [...hands.flat(), ...remaining];
  // The whole deck, every card once: the seat-law ceiling leaves room for
  // every hole card plus three five-card boards.
  expect(physical).toHaveLength(52);
  expect(new Set(physical.map(key)).size).toBe(52);
  expect(seats * holes + boardCount * 5).toBeLessThanOrEqual(52);
  return { hands, boards, remaining };
}

function contributionOf(variant: OmahaVariant, asset: Asset, i: number): number {
  return contributionsFor(variant, asset)[i] ?? 0;
}

function chipDeductionConfig(variant: OmahaVariant, seats: number): Partial<HandConfig> {
  // The launch configuration, read from the published schedule the engine
  // reads, and pinned to the hand-stated numbers above.
  const rc = getFullRakeConfig(SB, BB, variant);
  expect([rc.rakePercent, rc.rakeCap, rc.bbjEnabled, rc.bbjFeeBB]).toEqual(
    variant === 'plo6' ? [10, 15, false, 0] : [10, 15, true, 0.06]
  );
  return {
    rakeConfig: {
      percent: rc.rakePercent,
      cap: rc.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: getPlayerCountCaps(rc.rakeCap, seats),
    },
    bbjConfig: {
      enabled: rc.bbjEnabled,
      feeBB: rc.bbjFeeBB,
      minPotBB: rc.rules.minPotBB,
      minPlayersDealt: rc.rules.minPlayersDealt,
    },
  };
}

/** Expected post-deduction amount for one reference amount, in cents. */
function expectedCents(variant: OmahaVariant, asset: Asset, referenceAmount: number): number {
  const c = cents(referenceAmount);
  if (whole(asset)) {
    expect(c % 100).toBe(0);
    return c;
  }
  // Fixture guard, not a rule: a whole-dollar award keeps 99% exact in cents.
  expect(c % 100).toBe(0);
  const book = chipBook(variant);
  return (c * book.netCents) / book.grossCents;
}

function referenceFor(
  variant: OmahaVariant,
  asset: Asset,
  players: SeatPlayer[],
  boards: Card[][]
) {
  const expected = settleOmahaReference({
    variant,
    players: players.map((p) => ({
      id: p.user_id,
      seat: p.seat,
      cards: p.cards.map((c) => ({ ...c })),
      contributed: p.totalInvested,
      folded: p.is_folded,
    })),
    boards,
    chipUnit: whole(asset) ? 1 : 0.01,
    dealerSeat: DEALER,
  });
  // Independent pot geometry: main pot to seats 1-3, side pot to seats 2-3,
  // and seat 3's uncalled 60 returned.
  const main = whole(asset) ? 905 : 900;
  expect(expected.pots.map((p) => [p.amount, [...p.eligible].sort()])).toEqual([
    [main, ['p1', 'p2', 'p3']],
    [whole(asset) ? 720 : chipBook(variant).side, ['p2', 'p3']],
  ]);
  expect(expected.refunds).toEqual({ p3: REFUND });
  return expected;
}

const FEATURES = ['classic', 'bomb1', 'bomb2', 'bomb3'] as const;
type Feature = (typeof FEATURES)[number];
const boardsOf = (f: Feature): 1 | 2 | 3 => (f === 'bomb2' ? 2 : f === 'bomb3' ? 3 : 1);

function settlementCases(): Array<[OmahaVariant, Asset, Feature]> {
  const out: Array<[OmahaVariant, Asset, Feature]> = [];
  for (const variant of Object.keys(OMAHA_RULES) as OmahaVariant[])
    for (const asset of ['chips', 'diamonds'] as const)
      for (const feature of FEATURES) {
        // Already at the ceiling with whole Diamonds in Phase9MultiboardUnits.
        if (
          asset === 'diamonds' &&
          boardsOf(feature) > 1 &&
          (variant === 'plo5' || variant === 'plo6')
        )
          continue;
        out.push([variant, asset, feature]);
      }
  // A tournament deals neither bombs (no tournament path enables them) nor
  // run it twice, so its enabled intersection here is the classic hand.
  for (const variant of Object.keys(OMAHA_RULES) as OmahaVariant[])
    out.push([variant, 'tournament', 'classic']);
  return out;
}

describe('Phase 9 P9.2 enabled settlement intersections at the seat ceiling', () => {
  for (const [variant, asset, feature] of settlementCases())
    it(`${variant} ${seatsFor(variant, asset)} seats, ${feature}, ${asset}${asset === 'chips' ? ' with rake' + (variant === 'plo6' ? '' : ' and BBJ') : ''}`, () => {
      const seats = seatsFor(variant, asset);
      const boardCount = boardsOf(feature);
      const deal = physicalDeal(variant, seats, boardCount);
      const initialStacks = Array.from({ length: seats }, (_, i) =>
        i === 0 ? contributionOf(variant, asset, 0) : 1000
      );
      const players: SeatPlayer[] = initialStacks.map((stack, i) => ({
        user_id: `p${i + 1}`,
        username: `P${i + 1}`,
        seat: i + 1,
        stack,
        cards: [],
        bet: 0,
        totalInvested: 0,
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }));
      const events: HandEvent[] = [];
      const controller = new HandController(
        {
          tableId: TABLE,
          handNumber: 1,
          gameVariant: variant,
          smallBlind: SB,
          bigBlind: BB,
          asset: asset === 'diamonds' ? 'diamonds' : 'chips',
          isTournament: asset === 'tournament',
          ...(feature === 'classic' ? {} : { bombPot: { anteMultiplier: 1, boardCount } }),
          ...(asset === 'chips'
            ? chipDeductionConfig(variant, seats)
            : { rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true } }),
        } as HandConfig,
        players,
        DEALER
      );
      controller.onEvent((event) => events.push(event));
      controller.start();
      const state = (controller as unknown as { state: GameState }).state;
      let steps = seats * 4;
      while (state.stage !== 'river' && steps-- > 0) {
        const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
        expect(
          controller.performAction(actor.seat, actor.bet < state.currentBet ? 'call' : 'check')
        ).toBe(true);
      }
      expect(state.stage).toBe('river');
      // The controller dealt every seat and every requested board itself.
      expect(state.players.every((p) => p.cards.length === OMAHA_RULES[variant].holes)).toBe(true);
      expect(controller.getActiveBoardCount()).toBe(boardCount);
      state.players.forEach((p, i) => {
        p.cards = deal.hands[i].map((c) => ({ ...c }));
        p.totalInvested = contributionOf(variant, asset, i);
        p.stack = initialStacks[i] - p.totalInvested;
        p.bet = 0;
        p.is_all_in = i === 0;
        p.is_folded = i >= 3;
      });
      state.communityCards = deal.boards[0].map((c) => ({ ...c }));
      if (boardCount >= 2) state.communityCards2 = deal.boards[1].map((c) => ({ ...c }));
      if (boardCount === 3) state.communityCards3 = deal.boards[2].map((c) => ({ ...c }));
      state.pot = contributionsFor(variant, asset).reduce((s, n) => s + n, 0);
      state.currentBet = 0;
      const beforePayout = state.players.map((p) => p.stack);
      const expected = referenceFor(variant, asset, state.players, deal.boards);

      // Seat 2 acts first after the button; seats 2 and 3 check the river.
      expect(state.currentPlayerSeat).toBe(2);
      steps = 4;
      while (controller.getState().stage !== 'showdown' && steps-- > 0)
        expect(controller.performAction(state.currentPlayerSeat, 'check')).toBe(true);

      const win = events.find((e) => e.type === 'WINNERS') as Extract<
        HandEvent,
        { type: 'WINNERS' }
      >;
      expect(win).toBeDefined();
      expect(reportError).not.toHaveBeenCalled();
      const paidCents = Object.fromEntries(
        Object.entries(expected.totals)
          .filter(([, n]) => n > 0)
          .map(([id, n]) => [id, expectedCents(variant, asset, n)])
      );
      expect(Object.fromEntries(win.winners.map((w) => [w.userId, cents(w.amount)]))).toEqual(
        paidCents
      );
      expect(
        sorted(
          (win.perPotAwards ?? [])
            .filter((a) => a.amount > 0)
            .map((a) => ({
              board: (a as { board?: number }).board ?? 1,
              potIndex: a.potIndex,
              playerId: a.userId,
              low: a.low === true,
              cents: cents(a.amount),
            }))
        )
      ).toEqual(
        sorted(
          expected.awards.map((a) => ({
            board: a.boardIndex + 1,
            potIndex: a.potIndex,
            playerId: a.playerId,
            low: a.half === 'low',
            cents: expectedCents(variant, asset, a.amount),
          }))
        )
      );
      state.players.forEach((p, i) => {
        expect(cents(p.returnedUncalled ?? 0)).toBe(cents(expected.refunds[p.user_id] ?? 0));
        expect(cents(p.stack)).toBe(
          cents(beforePayout[i]) +
            (paidCents[p.user_id] ?? 0) +
            cents(expected.refunds[p.user_id] ?? 0)
        );
        expect(p.cards).toEqual(deal.hands[i]);
      });
      const complete = events.filter((e) => e.type === 'HAND_COMPLETE');
      expect(complete).toEqual([
        expect.objectContaining({
          handNumber: 1,
          rake: asset === 'chips' ? chipBook(variant).rake : 0,
          bbjFee: asset === 'chips' ? chipBook(variant).bbj : 0,
        }),
      ]);
      // Conservation: every stack plus the deductions is the table's money.
      const deductionsCents =
        asset === 'chips' ? cents(chipBook(variant).rake + chipBook(variant).bbj) : 0;
      expect(state.players.reduce((s, p) => s + cents(p.stack), 0) + deductionsCents).toBe(
        initialStacks.reduce((s, n) => s + cents(n), 0)
      );
      if (whole(asset))
        for (const p of state.players) expect(Number.isSafeInteger(p.stack)).toBe(true);
    });
});

/* ── Run it two and three times at the ceiling ─────────────────────────── */

const engines: Record<string, any>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network is not admitted in this isolated settlement test');
    })
  );
});
afterEach(() => {
  for (const engine of engines.splice(0)) engine.runItTwiceEngine.disposeAll();
  vi.unstubAllGlobals();
});

function ritEngine(variant: OmahaVariant, asset: CashAsset, seats: number) {
  const engine = new ServerTableEngine(TABLE) as unknown as Record<string, any>;
  engines.push(engine);
  engine.running = true;
  engine.handCount = 1;
  engine.tableInfo = {
    game_variant: variant,
    small_blind: SB,
    big_blind: BB,
    max_players: seats,
    tournament_id: null,
    game_type: 'cash',
    run_it_twice: true,
    allow_run_it_twice: true,
    run_it_twice_enabled: false,
    run_it_mode: 'player_choice',
    insurance_enabled: false,
    arena: { id: 'synthetic-arena', asset, is_platform: true, union_id: null },
  };
  engine.safeContinueRunout = vi.fn();
  engine.killForRestart = vi.fn();
  return engine;
}

/* Seven-seat PLO5 chip cash is P9.1's accepted-betting port and is not
   repeated. The whole-Diamond PLO5 table at the same ceiling is not part of
   P9.1, so it is held here. */
function ritCases(): Array<[OmahaVariant, 2 | 3, CashAsset]> {
  const out: Array<[OmahaVariant, 2 | 3, CashAsset]> = [];
  for (const variant of Object.keys(OMAHA_RULES) as OmahaVariant[])
    for (const runs of [2, 3] as const)
      for (const asset of ['chips', 'diamonds'] as const)
        if (!(variant === 'plo5' && asset === 'chips')) out.push([variant, runs, asset]);
  return out;
}

describe('Phase 9 P9.2 run it N times at the cash seat-law ceiling', () => {
  for (const [variant, runs, asset] of ritCases())
    it(`${variant} ${maxSeatsForVariant(variant)} seats preflop, ${runs} runs, ${asset}${asset === 'chips' ? ' with rake' + (variant === 'plo6' ? '' : ' and BBJ') : ''}`, async () => {
      const seats = maxSeatsForVariant(variant);
      const deal = physicalDeal(variant, seats, runs);
      const initialStacks = Array.from({ length: seats }, (_, i) =>
        i < 3 ? contributionOf(variant, asset, i) : 1000
      );
      const players: SeatPlayer[] = initialStacks.map((stack, i) => ({
        user_id: 'p' + (i + 1),
        username: 'P' + (i + 1),
        seat: i + 1,
        stack,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      }));
      const handEvents: HandEvent[] = [];
      const controller = new HandController(
        {
          tableId: TABLE,
          handNumber: 1,
          gameVariant: variant,
          smallBlind: SB,
          bigBlind: BB,
          asset,
          ritEnabled: true,
          ...(asset === 'chips'
            ? chipDeductionConfig(variant, seats)
            : { rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true } }),
        } as HandConfig,
        players,
        DEALER
      );
      controller.onEvent((e) => handEvents.push(e));
      controller.start();
      expect(controller.getState().stage).toBe('preflop');
      const state = (controller as unknown as { state: GameState }).state;
      state.players.forEach((p, i) => {
        expect(p.cards).toHaveLength(OMAHA_RULES[variant].holes);
        p.cards = deal.hands[i].map((c) => ({ ...c }));
        p.totalInvested = contributionOf(variant, asset, i);
        p.bet = contributionOf(variant, asset, i);
        p.stack = initialStacks[i] - p.totalInvested;
        p.is_folded = i >= 3;
        p.is_all_in = i < 3;
      });
      state.pot = contributionsFor(variant, asset).reduce((s, n) => s + n, 0);
      state.currentBet = contributionOf(variant, asset, 2);
      state.communityCards = [];
      // Production Deck/getRemainingDeck stay in the path; only the
      // isolated deck's physical order is fixed: run 1, run 2, run 3.
      const deck = new Deck();
      (deck as unknown as { cards: Card[] }).cards = deal.remaining.map((c) => ({ ...c }));
      state.deck = deck as any;
      expect(controller.getRemainingDeck()).toHaveLength(52 - seats * OMAHA_RULES[variant].holes);
      const expected = referenceFor(variant, asset, state.players, deal.boards);

      const engine = ritEngine(variant, asset, seats);
      engine.handController = controller;
      engine.seatedPlayers = state.players.map((p) => ({
        user_id: p.user_id,
        seat_number: p.seat,
        stack: p.stack,
        is_horse: true,
      }));
      const emitted: Record<string, any>[] = [];
      engine.hub = {
        emitEvent: (_table: string, event: Record<string, unknown>) =>
          emitted.push(structuredClone(event)),
      };
      // The launch rule: a cash table above two seats offers the question.
      expect(engine.applyRunItTwiceConfig()).toEqual({
        ritEffective: true,
        insuranceEnabled: false,
      });
      expect(engine.runItTwiceEngine.maxRunsAllowed(TABLE)).toBe(3);
      const ids = ['p1', 'p2', 'p3'];
      engine.runItTwiceEngine.offer(TABLE, `${TABLE}:1`, 'p2', ids, state.pot);
      engine.runItTwiceEngine.chooserDecides(TABLE, 'p2', runs);
      for (const id of ['p1', 'p3']) engine.runItTwiceEngine.accept(TABLE, id);
      const accepted = engine.runItTwiceEngine.getState(TABLE);
      expect(accepted.status).toBe('accepted');
      expect(accepted.chosenRuns).toBe(runs);
      expect([...accepted.acceptedBy].sort()).toEqual(ids);
      await engine.dealAndResolveRIT(state.players.filter((p) => !p.is_folded));

      expect(engine.safeContinueRunout).not.toHaveBeenCalled();
      expect(engine.killForRestart).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
      const result = emitted.find((e) => e.type === 'rit_result');
      expect(result).toBeDefined();
      // Exactly the reference cards, run by run, none of them reused.
      expect(result!.boards).toEqual(deal.boards.map(wire));
      expect(result!.runs).toBe(runs);
      expect(result!.base_board_count).toBe(0);
      expect(engine.currentHandRitBoards).toBe(runs);
      expect(
        engine.currentHandPots.map((p: any) => [cents(p.amount), [...p.eligible].sort()])
      ).toEqual(expected.pots.map((p) => [cents(p.amount), [...p.eligible].sort()]));
      expect(
        sorted(
          engine.currentHandPerPotAwards
            .filter((a: any) => a.amount > 0)
            .map((a: any) => ({
              board: a.board,
              potIndex: a.potIndex,
              playerId: a.userId,
              low: a.low === true,
              cents: cents(a.amount),
            }))
        )
      ).toEqual(
        sorted(
          expected.awards.map((a) => ({
            board: a.boardIndex + 1,
            potIndex: a.potIndex,
            playerId: a.playerId,
            low: a.half === 'low',
            cents: expectedCents(variant, asset, a.amount),
          }))
        )
      );
      const paidCents = Object.fromEntries(
        Object.entries(expected.totals)
          .filter(([, n]) => n > 0)
          .map(([id, n]) => [id, expectedCents(variant, asset, n)])
      );
      expect(
        Object.fromEntries(engine.currentHandWinners.map((w: any) => [w.userId, cents(w.amount)]))
      ).toEqual(paidCents);
      expect(
        Object.fromEntries(
          Object.entries(result!.distribution).map(([id, n]) => [id, cents(n as number)])
        )
      ).toEqual(paidCents);
      expect(cents(result!.net_pot)).toBe(
        asset === 'chips'
          ? chipBook(variant).netCents
          : cents(DIAMOND_CONTRIBUTIONS.reduce((s, n) => s + n, 0) - REFUND)
      );
      state.players.forEach((p, i) => {
        expect(cents(p.returnedUncalled ?? 0)).toBe(cents(expected.refunds[p.user_id] ?? 0));
        expect(cents(p.stack)).toBe(
          cents(initialStacks[i] - contributionOf(variant, asset, i)) +
            (paidCents[p.user_id] ?? 0) +
            cents(expected.refunds[p.user_id] ?? 0)
        );
        expect(p.cards).toEqual(deal.hands[i]);
      });
      expect(handEvents.filter((e) => e.type === 'HAND_COMPLETE')).toEqual([
        expect.objectContaining({
          handNumber: 1,
          rake: asset === 'chips' ? chipBook(variant).rake : 0,
          bbjFee: asset === 'chips' ? chipBook(variant).bbj : 0,
        }),
      ]);
      const deductionsCents =
        asset === 'chips' ? cents(chipBook(variant).rake + chipBook(variant).bbj) : 0;
      expect(state.players.reduce((s, p) => s + cents(p.stack), 0) + deductionsCents).toBe(
        initialStacks.reduce((s, n) => s + cents(n), 0)
      );
      expect(engine.ritResolutionOwner).toBeNull();
      expect(engine.runoutPayoutMutationUnsafe).toBe(false);
      expect(engine.runItTwiceEngine.hasPendingOffer(TABLE)).toBe(false);
    });
});
