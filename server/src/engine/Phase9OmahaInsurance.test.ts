/**
 * Phase 9 P9.2 close-out: chip-cash insurance on the five Omaha games, the
 * cells docs/horse-brain-phase9-economics-2026-10-02.md left open.
 *
 * Every case plays a real hand to a turn all-in and lets production own the
 * rest. The controller deals a fixed physical deck at the cash seat-law
 * ceiling, with the launch rake and BBJ configuration read from the schedule
 * the engine reads; the COMMUNITY_CARDS, ALL_IN_RUNOUT, SHOWDOWN, WINNERS and
 * HAND_COMPLETE events go through ServerTableEngine.handleHandEvent. So the
 * offer comes from runInsurancePerStreetFlow and InsuranceEngine.createOffers,
 * the purchase from respondToInsurance, the river from the controller's own
 * deck, and the contract and pot settle through settleCompletedHand's
 * insurance block against the bank. The equity worker pool is replaced by the
 * worker's own pricing function, computeInsuranceComponentsForHands, called
 * in-thread, so the pricing code is production's and only the thread hop is
 * removed.
 *
 * Expected values never come from production code:
 *   - Outs, pushes and wins come from enumerating every unseen river card with
 *     OmahaReference's own scorer (referenceOmaha), high component only.
 *   - The insured amount is hand arithmetic: pot 1,080.00 (pot-limit) or
 *     160.00 (fixed limit), minus rake 10% capped at 15.00 and BBJ 0.06 BB =
 *     1.20 at 10/20. PLO6 collects no BBJ.
 *   - The premium applies the formula InsuranceEngine states in its header,
 *     createOffers and its pricing comments: fee = insured x pLoss/pWin x
 *     houseMargin, with the probabilities conditional on no push, the default
 *     margin 1.20, and the worker's published one-decimal percentages. With L
 *     and P in tenths of a percent that is insured x 1.2 x L / (1000 - P - L),
 *     rounded to the cent.
 *   - Payouts are OmahaReference awards scaled by net / gross.
 *
 * PLO8 and FLO8 are no longer offered insurance at all (owner decision
 * 2026-10-07, insuranceContractIsExact in ServerTableEngineRunout.ts): the
 * retired high-half price with a pushing split was not the contract the
 * dialog showed. Their cases now prove the turn all-in runs out with no offer.
 *
 * As in the other Phase 9 suites this is not persistence, ledger-RPC or
 * natural-use evidence: postHandTasks (the database writes, including
 * logInsuranceSettlement) is replaced, the offer audit rows
 * (logInsuranceOfferEvent) are captured and asserted instead of inserted, the
 * engine-lease check is held open, and the BBJ drill claim returns none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./equity/EquityWorkerPool.js', async () => {
  const worker = await vi.importActual<typeof import('./equity/equityWorker.js')>(
    './equity/equityWorker.js'
  );
  return {
    getEquityPool: () => ({
      estimateInsurance: async (
        hands: import('../types.js').Card[][],
        board: import('../types.js').Card[],
        variant: string,
        shortDeck: boolean
      ) => worker.computeInsuranceComponentsForHands(hands, board, variant, shortDeck),
      estimateEquity: async (hands: unknown[]) => hands.map(() => 1 / hands.length),
    }),
  };
});
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
  describeError: (error: unknown) => String(error),
}));
// The offer audit row is a database insert; the rows are asserted, not written.
vi.mock('../services/supabase/insuranceOfferLog.js', () => ({ logInsuranceOfferEvent: vi.fn() }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async () => ({ persisted: false, alertId: null })),
}));

import { ServerTableEngine } from './ServerTableEngine.js';
import { HandController } from './HandController.js';
import { Deck } from './PokerEngine.js';
import {
  OMAHA_RULES,
  referenceDeck,
  referenceOmaha,
  referencePotLimitRaiseTo,
  settleOmahaReference,
  type OmahaVariant,
} from '../benchmark/OmahaReference.js';
import { maxSeatsForVariant } from '../config/tableSeating.js';
import { getFullRakeConfig, getPlayerCountCaps } from '../config/RakeConfig.js';
import { reportError } from '../services/errorReporter.js';
import { raiseFinancialAlert } from '../services/financialAlerts.js';
import { logInsuranceOfferEvent } from '../services/supabase/insuranceOfferLog.js';
import { captureRitEvent } from '../services/supabase/handFacts.js';
import { supabase } from '../services/supabase/client.js';
import { waitFor } from '../testing/waitBudget.js';
import type { Card, HandConfig, HandEvent, SeatPlayer } from '../types.js';

const SB = 10;
const BB = 20;
const DEALER = 1;
const LEADER_SEAT = 2;
const OPP_SEAT = 3;
const suits = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' } as const;
const parse = (text: string): Card[] =>
  text.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: suits[c[1] as keyof typeof suits],
  }));
const key = (c: Card) => c.rank + ':' + c.suit;
const cents = (amount: number) => Math.round(amount * 100);

/* The spot, the same in every game: the small blind holds top set on
   Kc 9c 4d 2h, the big blind the nut flush draw. Extra hole cards for PLO5 and
   PLO6 add no straight, no club and no boat (checked by hand: the opponent's
   rank pairs (7,6), (T,7), (A,6), (A,2), (6,2) and (7,2) need two more board
   cards for any straight, and only a pairing river gives the leader a boat). */
const TURN_BOARD = parse('Kc 9c 4d 2h');
const HOLES: Record<OmahaVariant, { leader: string; opp: string }> = {
  plo4: { leader: 'Ks Kh Qd Jd', opp: 'Ac Tc 7h 7s' },
  plo5: { leader: 'Ks Kh Qd Jd 8h', opp: 'Ac Tc 7h 7s 6d' },
  plo6: { leader: 'Ks Kh Qd Jd 8h 3h', opp: 'Ac Tc 7h 7s 6d 2s' },
  plo8: { leader: 'Ks Kh Qd Jd', opp: 'Ac Tc 7h 7s' },
  flo8: { leader: 'Ks Kh Qd Jd', opp: 'Ac Tc 7h 7s' },
};
/* By hand: 13 clubs less Kc 9c on board and Ac Tc in the opponent's hand
   leaves nine. 4c and 2c pair the board, so the leader's kings full beat the
   flush; the other seven rivers lose. Nothing ties. The unseen universe is the
   deck less the board and the two all-in hands (folded cards are unknown to
   the pricing): 52 - 4 - 8/10/12 = 40, 38, 36. */
const LOSING_RIVERS = parse('Qc Jc 8c 7c 6c 5c 3c');
const UNSEEN: Record<OmahaVariant, number> = { plo4: 40, plo5: 38, plo6: 36, plo8: 40, flo8: 40 };

interface Book {
  stack: number;
  potCents: number;
  rake: number;
  bbj: number;
  insuredCents: number;
  /** Tenths of a percent the worker publishes: round(1000 x losses / unseen). */
  lossTenths: number;
  equityTenths: number;
  premiumCents: number;
}
/* Hand arithmetic, one row per game.
   Pot limit: SB raises the pot to 60 (20 + 30 + 10), BB calls: 120. Flop pot
   bet 120, call: 360. Turn pot bet 360 all in, call: 1,080.00, 540 each.
   Fixed limit 10/20: SB completes, BB checks: 40. Flop bet 20, call: 80. Turn
   bet 40 all in, call: 160.00, 80 each.
   Rake 10% capped at 15.00 (eight, seven or six dealt is the full-cap tier);
   BBJ 20 x 0.06 = 1.20 with three or more dealt, none for PLO6.
   Premium = insured x 1.2 x L / (1000 - L), P = 0:
     PLO4/PLO8 106,380 x 12 x 175 / 8,250 = 27,078.5 -> 270.79
     PLO5      106,380 x 12 x 184 / 8,160 = 28,785.2 -> 287.85  (7/38 = 18.4%)
     PLO6      106,500 x 12 x 194 / 8,060 = 30,760.8 -> 307.61  (7/36 = 19.4%)
     FLO8       14,380 x 12 x 175 / 8,250 =  3,660.4 ->  36.60 */
const BOOK: Record<OmahaVariant, Book> = {
  plo4: {
    stack: 540,
    potCents: 108_000,
    rake: 15,
    bbj: 1.2,
    insuredCents: 106_380,
    lossTenths: 175,
    equityTenths: 825,
    premiumCents: 27_079,
  },
  plo5: {
    stack: 540,
    potCents: 108_000,
    rake: 15,
    bbj: 1.2,
    insuredCents: 106_380,
    lossTenths: 184,
    equityTenths: 816,
    premiumCents: 28_785,
  },
  plo6: {
    stack: 540,
    potCents: 108_000,
    rake: 15,
    bbj: 0,
    insuredCents: 106_500,
    lossTenths: 194,
    equityTenths: 806,
    premiumCents: 30_761,
  },
  plo8: {
    stack: 540,
    potCents: 108_000,
    rake: 15,
    bbj: 1.2,
    insuredCents: 106_380,
    lossTenths: 175,
    equityTenths: 825,
    premiumCents: 27_079,
  },
  flo8: {
    stack: 80,
    potCents: 16_000,
    rake: 15,
    bbj: 1.2,
    insuredCents: 14_380,
    lossTenths: 175,
    equityTenths: 825,
    premiumCents: 3_660,
  },
};

/** Classify one complete board for the leader, high component only. */
function highOutcome(leader: Card[], opp: Card[], board: Card[]): 'win' | 'push' | 'loss' {
  const a = referenceOmaha(leader, board).high;
  const b = referenceOmaha(opp, board).high;
  return a > b ? 'win' : a === b ? 'push' : 'loss';
}

/** Independent pricing from the reference: every unseen river, high half. */
function referencePricing(variant: OmahaVariant) {
  const leader = parse(HOLES[variant].leader);
  const opp = parse(HOLES[variant].opp);
  const known = new Set([...leader, ...opp, ...TURN_BOARD].map(key));
  const unseen = referenceDeck().filter((c) => !known.has(key(c)));
  const losses: Card[] = [];
  let pushes = 0;
  let wins = 0;
  for (const river of unseen) {
    const outcome = highOutcome(leader, opp, [...TURN_BOARD, river]);
    if (outcome === 'loss') losses.push(river);
    else if (outcome === 'push') pushes++;
    else wins++;
  }
  return { unseen: unseen.length, losses, pushes, wins };
}

/** The stated formula, in integer cents and tenths of a percent. */
function premiumCentsFor(insuredCents: number, lossTenths: number, pushTenths: number): number {
  return Math.round((insuredCents * 12 * lossTenths) / (10 * (1000 - pushTenths - lossTenths)));
}

/* ── The hand ─────────────────────────────────────────────────────────── */

const engines: Record<string, any>[] = [];
let tableSeq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network is not admitted in this isolated settlement test');
    })
  );
});
afterEach(async () => {
  for (const engine of engines.splice(0)) {
    engine.running = false;
    engine.insuranceEngine.disposeAll();
    engine.runItTwiceEngine.disposeAll();
    engine.preciseTimer.dispose();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function physicalDeck(variant: OmahaVariant, seats: number, river: Card) {
  const holes = OMAHA_RULES[variant].holes;
  const leader = parse(HOLES[variant].leader);
  const opp = parse(HOLES[variant].opp);
  const board = [...TURN_BOARD, river];
  const used = new Set([...leader, ...opp, ...board].map(key));
  const free = referenceDeck().filter((c) => !used.has(key(c)));
  const hands = Array.from({ length: seats }, (_, i) =>
    i === LEADER_SEAT - 1 ? leader : i === OPP_SEAT - 1 ? opp : free.splice(0, holes)
  );
  const ordered = [...hands.flat(), ...board, ...free];
  expect(ordered).toHaveLength(52);
  expect(new Set(ordered.map(key)).size).toBe(52);
  return { hands, board, ordered };
}

interface Played {
  engine: Record<string, any>;
  controller: HandController;
  events: HandEvent[];
  emitted: Record<string, any>[];
  ids: string[];
  initialStacks: number[];
  offer: Record<string, any>;
  broadcast: Record<string, any>;
}

async function playToOffer(
  variant: OmahaVariant,
  river: Card,
  // Route each hub event through the audit capture first, as
  // TableStateHub.emitEvent does in production.
  opts: { auditCapture?: boolean; expectNoOffer?: boolean } = {}
): Promise<Played> {
  const seats = maxSeatsForVariant(variant);
  expect(seats).toBe({ plo4: 8, plo5: 7, plo6: 6, plo8: 8, flo8: 8 }[variant]);
  const book = BOOK[variant];
  const table = `9a2e0000-0000-4000-8000-${String(++tableSeq).padStart(12, '0')}`;
  const deck = physicalDeck(variant, seats, river);
  const ids = Array.from({ length: seats }, (_, i) => `p${i + 1}`);
  const initialStacks = ids.map((_, i) => (i === 1 || i === 2 ? book.stack : 1000));

  const rc = getFullRakeConfig(SB, BB, variant);
  expect([rc.rakePercent, rc.rakeCap, rc.bbjEnabled, rc.bbjFeeBB]).toEqual(
    variant === 'plo6' ? [10, 15, false, 0] : [10, 15, true, 0.06]
  );

  const engine = new ServerTableEngine(table) as unknown as Record<string, any>;
  engines.push(engine);
  const emitted: Record<string, any>[] = [];
  Object.assign(engine, {
    running: true,
    handCount: 1,
    tableInfo: {
      game_variant: variant,
      small_blind: SB,
      big_blind: BB,
      max_players: seats,
      tournament_id: null,
      game_type: 'cash',
      run_it_twice: false,
      allow_run_it_twice: false,
      run_it_twice_enabled: false,
      insurance_enabled: true,
      bbj_percent: 100,
      arena: { id: 'synthetic-chip-arena', asset: 'chips', is_platform: true, union_id: null },
    },
    seatedPlayers: ids.map((user_id, i) => ({
      user_id,
      seat_number: i + 1,
      username: `P${i + 1}`,
      stack: initialStacks[i],
      // Humans: nothing auto-answers the offer; the test answers it.
      is_horse: false,
    })),
    hub: {
      emitEvent: (t: string, e: Record<string, any>) => {
        if (opts.auditCapture) captureRitEvent(t, e);
        emitted.push(structuredClone(e));
      },
    },
    allInFirstPauseMs: 1,
    allInStreetPauseMs: 1,
    allInStreetRevealMs: 1,
    allInPreShowdownPauseMs: 1,
    showdownSettleMs: 1,
  });
  // Cosmetic and persistence surfaces only. Offer, purchase, runout,
  // settlement and the insurance bank arithmetic stay production code.
  engine.broadcastCurrentState = vi.fn();
  engine.markProgress = vi.fn();
  engine.killForRestart = vi.fn();
  engine.flushSnapshot = vi.fn().mockResolvedValue(undefined);
  engine.postHandTasks = vi.fn().mockResolvedValue(undefined);
  engine.claimBBJDrill = vi.fn().mockResolvedValue(null);
  // No lease or process ownership is under test (as in InsuranceRitExclusivity).
  engine.lifecycleCanMutate = () => true;
  // What start() does with the row: the insurance switch, the default contract.
  const config = engine.applyRunItTwiceConfig();
  expect(config).toEqual({ ritEffective: false, insuranceEnabled: true });
  engine.insuranceEngine.configure(table, { enabled: config.insuranceEnabled });
  for (let i = 0; i < seats; i++)
    engine.atomicStackService.initializeStack(table, ids[i], initialStacks[i]);

  const players: SeatPlayer[] = ids.map((user_id, i) => ({
    user_id,
    seat: i + 1,
    username: `P${i + 1}`,
    stack: initialStacks[i],
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
  // Only the pre-deal shuffle order is fixed; Deck.deal stays production.
  const shuffle = vi.spyOn(Deck.prototype, 'shuffle').mockImplementation(function (this: Deck) {
    (this as unknown as { cards: Card[] }).cards = structuredClone(deck.ordered);
  });
  const controller = new HandController(
    {
      tableId: table,
      handNumber: 1,
      gameVariant: variant,
      smallBlind: SB,
      bigBlind: BB,
      asset: 'chips',
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
    } as HandConfig,
    players,
    DEALER
  );
  shuffle.mockRestore();
  engine.handController = controller;
  const events: HandEvent[] = [];
  const dispatch = new Set([
    'COMMUNITY_CARDS',
    'ALL_IN_RUNOUT',
    'SHOWDOWN',
    'WINNERS',
    'HAND_COMPLETE',
  ]);
  controller.onEvent((event) => {
    events.push(structuredClone(event));
    if (dispatch.has(event.type)) void engine.handleHandEvent(event, engine.seatedPlayers, 1);
  });
  controller.start();
  expect(controller.getState().players.map((p) => p.cards)).toEqual(deck.hands);

  const act = (seat: number, action: string, amount = 0) => {
    const s = controller.getState();
    expect(s.currentPlayerSeat).toBe(seat);
    const menu = controller.getAuthoritativeActionState(ids[seat - 1])!;
    expect(menu.legalActions).toContain(action);
    if (action === 'raise' || action === 'bet') {
      expect(amount).toBeGreaterThanOrEqual(menu.minRaiseTo!);
      expect(amount).toBeLessThanOrEqual(menu.maxRaiseTo!);
    }
    expect(controller.performAction(seat, action as never, amount)).toBe(true);
  };
  // Preflop: everyone but the blinds folds, the button last.
  for (let seat = 4; seat <= seats; seat++) act(seat, 'fold');
  act(DEALER, 'fold');
  if (variant === 'flo8') {
    act(LEADER_SEAT, 'call');
    act(OPP_SEAT, 'check');
    expect(controller.getState().pot).toBe(40);
    act(LEADER_SEAT, 'bet', 20);
    act(OPP_SEAT, 'call');
    expect(controller.getState().pot).toBe(80);
    act(LEADER_SEAT, 'bet', 40);
  } else {
    const pre = referencePotLimitRaiseTo(SB + BB, BB, SB, book.stack - SB);
    expect(pre).toBe(60);
    act(LEADER_SEAT, 'raise', pre);
    act(OPP_SEAT, 'call');
    expect(controller.getState().pot).toBe(120);
    const flop = referencePotLimitRaiseTo(120, 0, 0, book.stack - 60);
    expect(flop).toBe(120);
    act(LEADER_SEAT, 'bet', flop);
    act(OPP_SEAT, 'call');
    expect(controller.getState().pot).toBe(360);
    const turn = referencePotLimitRaiseTo(360, 0, 0, book.stack - 180);
    expect(turn).toBe(360);
    act(LEADER_SEAT, 'bet', turn);
  }
  act(OPP_SEAT, 'call');

  const park = events.find((e) => e.type === 'ALL_IN_RUNOUT') as Record<string, any>;
  expect(park).toBeDefined();
  expect(park.board).toEqual(TURN_BOARD);
  expect(cents(park.pot)).toBe(book.potCents);
  const atPark = controller.getState();
  expect(atPark.players.map((p) => [p.stack, p.totalInvested, p.is_all_in])).toEqual(
    ids.map((_, i) => (i === 1 || i === 2 ? [0, book.stack, true] : [initialStacks[i], 0, false]))
  );

  await waitFor(
    () =>
      engine.insuranceEngine.getOffers(table).length > 0 ||
      events.some((e) => e.type === 'HAND_COMPLETE'),
    'an insurance offer on the turn'
  );
  const offers = engine.insuranceEngine.getOffers(table);
  if (opts.expectNoOffer) {
    await waitFor(() => events.some((e) => e.type === 'HAND_COMPLETE'), 'the hand to complete');
    expect(engine.insuranceEngine.getOffers(table)).toHaveLength(0);
    expect(emitted.some((e) => e.type === 'insurance_offers')).toBe(false);
    return {
      engine,
      controller,
      events,
      emitted,
      ids,
      initialStacks,
      offer: undefined,
      broadcast: undefined,
    } as unknown as Played;
  }
  expect(offers).toHaveLength(1);
  const broadcast = emitted.find((e) => e.type === 'insurance_offers')!;
  expect(broadcast).toBeDefined();
  return { engine, controller, events, emitted, ids, initialStacks, offer: offers[0], broadcast };
}

function expectOffer(variant: OmahaVariant, played: Played) {
  const book = BOOK[variant];
  const ref = referencePricing(variant);
  // The reference agrees with the hand count above.
  expect(ref.unseen).toBe(UNSEEN[variant]);
  expect(ref.losses.map(key).sort()).toEqual(LOSING_RIVERS.map(key).sort());
  expect(ref.pushes).toBe(0);
  expect(ref.wins).toBe(ref.unseen - LOSING_RIVERS.length);
  const lossTenths = Math.round((1000 * ref.losses.length) / ref.unseen);
  expect(lossTenths).toBe(book.lossTenths);
  expect(Math.round((1000 * ref.wins) / ref.unseen)).toBe(book.equityTenths);
  // Insured = pot net of rake and BBJ, by hand.
  expect(book.potCents - cents(book.rake + book.bbj)).toBe(book.insuredCents);
  expect(premiumCentsFor(book.insuredCents, lossTenths, 0)).toBe(book.premiumCents);

  const o = played.offer;
  expect(o.playerId).toBe(played.ids[LEADER_SEAT - 1]);
  expect(o.status).toBe('offered');
  expect(o.boardLength).toBe(4);
  expect(Math.round(o.equity * 10)).toBe(book.equityTenths);
  expect(cents(o.fullInsuredAmount)).toBe(book.insuredCents);
  expect(cents(o.insuredAmount)).toBe(book.insuredCents);
  expect(o.coveragePercent).toBe(100);
  expect(cents(o.fullPremium)).toBe(book.premiumCents);
  expect(cents(o.premium)).toBe(book.premiumCents);
  expect(cents(o.atRisk)).toBe(cents(book.stack));
  // EV cashout alternative: insured x equity x (1 - 1%), to the cent.
  expect(cents(o.evCashoutAmount)).toBe(
    Math.round((book.insuredCents * book.equityTenths * 99) / 100_000)
  );
  // What the popup shows: the insurable pot, the turn, the reference outs.
  const b = played.broadcast;
  expect(cents(b.pot)).toBe(book.insuredCents);
  expect(b.street).toBe('turn');
  expect(b.outCount).toBe(LOSING_RIVERS.length);
  expect(b.outs.map(key).sort()).toEqual(LOSING_RIVERS.map(key).sort());
  expect(Math.round(b.outPct * 10)).toBe(lossTenths);
}

async function buyAndSettle(played: Played) {
  const { engine, events, ids } = played;
  const r = engine.respondToInsurance(ids[LEADER_SEAT - 1], 'accept');
  expect(r).toMatchObject({ success: true, status: 'accepted' });
  await waitFor(() => events.some((e) => e.type === 'HAND_COMPLETE'), 'the hand to complete');
  await waitFor(
    () => (engine.postHandTasks as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    'settlement to reach the post-hand chain'
  );
  return r;
}

/** Settle the river with the reference, then the deductions and the contract by hand. */
function expectSettlement(
  variant: OmahaVariant,
  played: Played,
  river: Card,
  contract: 'premium' | 'payout' | 'push'
) {
  const book = BOOK[variant];
  const { engine, controller, events, ids, initialStacks } = played;
  const leaderId = ids[LEADER_SEAT - 1];
  const board = [...TURN_BOARD, river];
  const final = controller.getState();
  expect(final.communityCards).toEqual(board);
  const reference = settleOmahaReference({
    variant,
    chipUnit: 0.01,
    dealerSeat: DEALER,
    boards: [board],
    players: final.players.map((p) => ({
      id: p.user_id,
      seat: p.seat,
      cards: p.cards,
      contributed: p.totalInvested,
      folded: p.is_folded,
    })),
  });
  expect(reference.pots.map((p) => [cents(p.amount), [...p.eligible].sort()])).toEqual([
    [book.potCents, [ids[1], ids[2]]],
  ]);
  const netCents = book.insuredCents; // the leader is eligible for the whole pot
  const paid: Record<string, number> = {};
  for (const [id, amount] of Object.entries(reference.totals))
    if (amount > 0) {
      // Fixture guard: every award is an exact share of the net.
      expect((cents(amount) * netCents) % book.potCents).toBe(0);
      paid[id] = (cents(amount) * netCents) / book.potCents;
    }
  const win = events.find((e) => e.type === 'WINNERS') as Extract<HandEvent, { type: 'WINNERS' }>;
  expect(Object.fromEntries(win.winners.map((w) => [w.userId, cents(w.amount)]))).toEqual(paid);
  expect(events.filter((e) => e.type === 'HAND_COMPLETE')).toEqual([
    expect.objectContaining({ rake: book.rake, bbjFee: book.bbj }),
  ]);

  const premium = contract === 'premium' ? book.premiumCents : 0;
  const payout = contract === 'payout' ? book.insuredCents : 0;
  const settlements = engine.currentHandInsuranceSettlements as Record<string, any>[];
  expect(settlements).toHaveLength(1);
  expect(settlements[0]).toMatchObject({
    playerId: leaderId,
    kind: 'insurance',
    won: contract === 'payout',
  });
  expect(cents(settlements[0].insuredAmount)).toBe(book.insuredCents);
  expect(cents(settlements[0].premium)).toBe(premium);
  expect(cents(settlements[0].payout)).toBe(payout);
  // The bank's side: premiums in, payouts out. The seat side is its mirror.
  const bankNetCents = premium - payout;
  expect(cents(engine.currentHandInsuranceNet)).toBe(payout - premium);
  expect(raiseFinancialAlert).not.toHaveBeenCalled();
  // The offer audit trail the engine writes: offered, accepted, settled.
  const pick = (row: Record<string, any>) => ({
    ...row,
    premium: row.premium === null ? null : cents(row.premium),
    insuredAmount: row.insuredAmount === null ? null : cents(row.insuredAmount),
    pot: row.pot === null ? null : cents(row.pot),
  });
  const base = { tableId: engine.tableId, clubId: null, handNumber: 1, playerId: leaderId };
  expect(vi.mocked(logInsuranceOfferEvent).mock.calls.map(([row]) => pick(row))).toEqual([
    {
      ...base,
      event: 'offered',
      equityPercent: book.equityTenths / 10,
      premium: book.premiumCents,
      insuredAmount: book.insuredCents,
      pot: book.insuredCents,
      street: 'turn',
    },
    {
      ...base,
      event: 'accepted',
      equityPercent: null,
      premium: book.premiumCents,
      insuredAmount: book.insuredCents,
      pot: null,
      street: null,
    },
    {
      ...base,
      event: 'settled',
      equityPercent: null,
      premium,
      insuredAmount: book.insuredCents,
      pot: null,
      street: null,
    },
  ]);

  const expectedStacks = ids.map((id, i) => {
    let c = cents(initialStacks[i]) - (i === 1 || i === 2 ? cents(book.stack) : 0);
    c += paid[id] ?? 0;
    if (id === leaderId) c += payout - premium;
    return c;
  });
  expect(controller.getState().players.map((p) => cents(p.stack))).toEqual(expectedStacks);
  expect(engine.seatedPlayers.map((p: { stack: number }) => cents(p.stack))).toEqual(
    expectedStacks
  );
  // Conservation: stacks + deductions + the bank's net = the table's money.
  expect(
    expectedStacks.reduce((s, n) => s + n, 0) + cents(book.rake + book.bbj) + bankNetCents
  ).toBe(initialStacks.reduce((s, n) => s + cents(n), 0));
  expect(engine.insuranceEngine.getOffers(engine.tableId)).toHaveLength(0);
  expect(reportError).not.toHaveBeenCalled();
  expect(engine.killForRestart).not.toHaveBeenCalled();
}

/* ── PLO4, PLO5, PLO6 ─────────────────────────────────────────────────── */

const WIN_RIVER = parse('5d')[0];
const LOSE_RIVER = parse('8c')[0];

describe('Phase 9 P9.2 chip-cash insurance, PLO4/PLO5/PLO6 at the seat ceiling', () => {
  for (const variant of ['plo4', 'plo5', 'plo6'] as const) {
    it(`${variant}: offer priced from the reference outs; the insured leader wins, the premium is charged`, async () => {
      // 5d: no club, no pair; the leader's set holds (reference, below).
      expect(
        highOutcome(parse(HOLES[variant].leader), parse(HOLES[variant].opp), [
          ...TURN_BOARD,
          WIN_RIVER,
        ])
      ).toBe('win');
      const played = await playToOffer(variant, WIN_RIVER);
      expectOffer(variant, played);
      const r = await buyAndSettle(played);
      expect(cents(r.premium)).toBe(BOOK[variant].premiumCents);
      expect(cents(r.insuredAmount)).toBe(BOOK[variant].insuredCents);
      expectSettlement(variant, played, WIN_RIVER, 'premium');
    });

    it(`${variant}: the insured leader loses to a river club, the bank pays the insured amount and no premium`, async () => {
      expect(
        highOutcome(parse(HOLES[variant].leader), parse(HOLES[variant].opp), [
          ...TURN_BOARD,
          LOSE_RIVER,
        ])
      ).toBe('loss');
      const played = await playToOffer(variant, LOSE_RIVER);
      expectOffer(variant, played);
      await buyAndSettle(played);
      expectSettlement(variant, played, LOSE_RIVER, 'payout');
    });
  }
});

/* ── PLO8, FLO8: insurance is not offered (owner decision 2026-10-07) ──── */

describe('PLO8/FLO8: a hi-lo hand runs out with no insurance offer', () => {
  for (const variant of ['plo8', 'flo8'] as const) {
    for (const river of ['Qs', '8c', '5d']) {
      it(`${variant}: the turn all-in is run out to ${river} with no offer and no EV cashout`, async () => {
        // Qs is a leader scoop, 8c an opponent scoop and 5d a high/low split:
        // under the retired high-half contract the last one pushed. None of
        // the three is offered now, whatever the river.
        const played = await playToOffer(variant, parse(river)[0], { expectNoOffer: true });
        const r = played.engine.respondToInsurance(played.ids[LEADER_SEAT - 1], 'accept');
        expect(r.success).toBe(false);
      });
    }
  }
});

/* ── Phase 9 close-out: the offer's audit row re-checks its own premium ───── */

describe('Phase 9 close-out: the engine_insurance_offers audit row carries the pricing inputs', () => {
  for (const variant of ['plo4', 'plo5', 'plo6'] as const) {
    it(`${variant}: details.pricing alone reproduces the offered premium by the formula, with no cards`, async () => {
      const book = BOOK[variant];
      const rows: Record<string, any>[] = [];
      const original = supabase.from.bind(supabase);
      vi.spyOn(supabase, 'from').mockImplementation(((table: string) =>
        table === 'action_audit_logs'
          ? {
              insert: (row: Record<string, any>) => {
                rows.push(structuredClone(row));
                return Promise.resolve({ data: null, error: null });
              },
            }
          : original(table)) as never);

      const played = await playToOffer(variant, parse('Qs')[0], { auditCapture: true });
      const audit = rows.filter((r) => r.action_type === 'engine_insurance_offers');
      expect(audit).toHaveLength(1);
      const row = audit[0];
      // Private-safe: no cards, no board, and no user a client policy could match.
      expect(row.user_id).toBeNull();
      expect(JSON.stringify(row)).not.toMatch(/"(rank|suit|cards|holeCards|board|outs)"/);
      // The existing audit fields are unchanged.
      expect(row.details).toMatchObject({
        table_id: played.engine.tableId,
        hand_number: 1,
        offers: 1,
      });
      expect(cents(row.details.pot)).toBe(book.insuredCents);

      expect(row.details.pricing).toHaveLength(1);
      const p = row.details.pricing[0];
      expect(p).toMatchObject({
        schema: 'insurance_offer_pricing.v1',
        player_id: played.ids[LEADER_SEAT - 1],
        seat: LEADER_SEAT,
        variant,
        street: 'turn',
        board_length: 4,
        insurable_pot_source: 'net_of_rake_bbj',
        push_pct: 0,
        runouts: UNSEEN[variant],
        exact: true,
        out_count: LOSING_RIVERS.length,
        house_margin: 1.2,
        max_insurable_percent: 100,
        coverage_percent: 100,
      });

      // 1. The insurable pot from the recorded pot and deductions (hand book).
      expect(cents(p.gross_pot)).toBe(book.potCents);
      expect(cents(p.live_pot_total)).toBe(book.potCents);
      expect(cents(p.eligible_pot)).toBe(book.potCents);
      expect([p.rake, p.bbj_fee]).toEqual([book.rake, book.bbj]);
      const netFrac = Math.max(0, (p.live_pot_total - p.rake - p.bbj_fee) / p.live_pot_total);
      expect(Math.round(p.eligible_pot * netFrac * 100) / 100).toBe(p.insurable_pot);
      expect(cents(p.insurable_pot)).toBe(book.insuredCents);

      // 2. The worker's percentages as used, one decimal (reference counts).
      expect(Math.round(p.strict_loss_pct * 10)).toBe(book.lossTenths);
      expect(Math.round(p.equity_pct * 10)).toBe(book.equityTenths);
      expect(Math.round(p.strict_win_pct * 10)).toBe(1000 - book.lossTenths);
      expect(p.loss_given_no_push).toBe(
        Math.min(1, p.strict_loss_pct / 100 / (1 - p.push_pct / 100))
      );
      expect(p.win_given_no_push).toBe(1 - p.loss_given_no_push);

      // 3. The premium, recomputed from the row alone by the stated formula,
      //    in the engine's operation order...
      const insured = Math.round(p.insurable_pot * (p.max_insurable_percent / 100) * 100) / 100;
      const lossGivenNoPush = Math.min(1, p.strict_loss_pct / 100 / (1 - p.push_pct / 100));
      const recomputed =
        Math.round(((insured * lossGivenNoPush * p.house_margin) / (1 - lossGivenNoPush)) * 100) /
        100;
      expect(insured).toBe(p.full_insured_amount);
      expect(recomputed).toBe(p.full_premium);
      // ...and in exact integer arithmetic: insured x margin x L / (1000 - P - L).
      expect(
        premiumCentsFor(
          cents(p.full_insured_amount),
          Math.round(p.strict_loss_pct * 10),
          Math.round(p.push_pct * 10)
        )
      ).toBe(cents(p.full_premium));
      expect(cents(p.full_premium)).toBe(book.premiumCents);

      // 4. It is the premium that was actually offered: the engine's offer,
      //    the popup, and the insurance_offer_events 'offered' row.
      expect(p.full_premium).toBe(played.offer.fullPremium);
      expect(p.premium).toBe(played.offer.premium);
      expect(p.insured_amount).toBe(played.offer.insuredAmount);
      expect(played.broadcast.offers[0].fullPremium).toBe(p.full_premium);
      expect(played.broadcast.offers[0].pricing).toBeUndefined();
      expect(played.broadcast.pricing).toBeUndefined();
      const offered = vi.mocked(logInsuranceOfferEvent).mock.calls.map(([r]) => r);
      expect(offered).toEqual([
        expect.objectContaining({
          event: 'offered',
          playerId: p.player_id,
          street: p.street,
          premium: p.full_premium,
          insuredAmount: p.full_insured_amount,
          pot: p.insurable_pot,
          equityPercent: p.equity_pct,
        }),
      ]);

      played.engine.respondToInsurance(played.ids[LEADER_SEAT - 1], 'decline');
      await waitFor(
        () => played.events.some((e) => e.type === 'HAND_COMPLETE'),
        'the hand to complete'
      );
    });
  }
});
