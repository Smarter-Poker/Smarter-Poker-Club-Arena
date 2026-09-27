/**
 * Phase 6C step (d): re-derive, independently, the calculations a journaled
 * Horse decision claims, and compare.
 *
 * INDEPENDENCE RULE. This file imports nothing from HorseLogic, HorsePreflop,
 * HorseTournamentPreflop, HorsePhase6Attribution, PokerEngine or any other
 * production policy module. Every rule below is restated from the published
 * Phase 6 domain (docs/horse-brain-phase6c-replay-protocol-2026-09-26.md) so
 * that a defect in the production arithmetic cannot agree with itself here.
 * The atlas shift table is deliberately NOT restated: the cell coordinate is
 * qualified, the shifts inside the cell are the production atlas's claim and
 * are checked for existence by references.ts, not for value here.
 */
import type { HorseReplayCheck } from './verdict.js';

type Seat = {
  seat: number;
  user_id: string;
  stack: number;
  bet: number;
  totalInvested: number;
  deadInvested?: number;
  individualAnteInvested?: number;
  cards: unknown[];
  knownDeadCards?: unknown[];
  is_folded: boolean;
  is_all_in: boolean;
  is_sitting_out: boolean;
};
type HistoryAction = {
  seat: number;
  action: string;
  stage: string;
  isFullRaise?: boolean;
};
type MState = {
  orbitCostChips: number;
  realM: number;
  effectiveM: number;
  projectedOrbitCostChips: number;
  projectedM: number;
  projectedEffectiveM: number;
  projectedStackBB: number;
  velocityMPerMinute: number;
  coveringOpponentM: number | null;
  coveringOpponents: Array<{
    userId: string;
    stackChips: number;
    realM: number;
    effectiveM: number;
  }>;
  zone: string;
  previousZone: string | null;
};
type Tournament = {
  contextStatus?: string;
  anteType?: string;
  currentSmallBlind?: number;
  currentBigBlind?: number;
  currentAnte?: number;
  playersAtTable?: number;
  nextSmallBlind?: number | null;
  nextBigBlind?: number | null;
  nextAnte?: number | null;
  nextBlindInMin?: number | null;
  nextBlindMult?: number | null;
  m?: MState;
};
type GameState = {
  players: Seat[];
  pot: number;
  currentBet: number;
  bigBlind: number;
  stage: string;
  gameVariant: string;
  gameMode?: string;
  toCall?: number;
  contestablePot?: number;
  dealerSeat?: number;
  dealtSeatIds?: number[];
  actionHistory?: HistoryAction[];
  straddleActive?: boolean;
  allInOrFold?: boolean;
  ante?: number;
  bigBlindAnte?: boolean;
  bettingStructure?: string;
  variantRules?: {
    deckSize: number;
    holeCardsDealt: number;
    holeCardsUse: string;
    boardCardsUse: string;
  };
  tournament?: Tournament;
};
type Attribution = {
  route: string;
  lookup: {
    coordinate: {
      gameFamily: string;
      contextStatus: string;
      tableSize: number;
      heroPosition: string;
      raiserPosition: string | null;
      anteType: string;
      branch: string;
      stackBB: number;
      mVelocityMPerMinute: number;
    };
    policy: {
      cell: string;
      source: string;
      fallbackReason: string | null;
      depth: { lower: number; upper: number; weight: number };
    };
  } | null;
} | null;

export interface IndependentQualificationInput {
  player: Seat;
  gameState: GameState;
  opts?: Record<string, unknown> | null;
  attribution: Attribution;
}

export interface IndependentQualification {
  pot_odds: HorseReplayCheck;
  m_state: HorseReplayCheck;
  ante_mode: HorseReplayCheck;
  atlas_coordinate: HorseReplayCheck;
  route: HorseReplayCheck;
  /** Routes the snapshot admits under the published gates; a chart route being
   * admissible means the decision may have consulted the chart store. */
  admissibleRoutes: string[];
  /** True when a hold'em heads-up postflop open node could have consulted the postflop store. */
  postflopStoreConsultPossible: boolean;
}

// Published Phase 6 domain, restated.
const POSITIONS_BY_SIZE: Record<number, string[]> = {
  2: ['SB', 'BB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'HJ', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'MP', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'MP', 'HJ', 'CO', 'BTN'],
  10: ['SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'UTG3', 'MP', 'HJ', 'CO', 'BTN'],
};
const DEPTH_ANCHORS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 60, 80, 100];
const M_ZONES = ['dead', 'red', 'orange', 'yellow', 'green', 'blue'];
const M_BOUNDARIES = [1, 5, 10, 20, 40];
const M_HYSTERESIS = 0.5;
const PLAYERS_MIN = 2;
const PLAYERS_MAX = 10;
const BBA_CEILING_BB = 2;
const PROJECTION_MAX_MINUTES = 3;
const PROJECTION_MIN_MULTIPLIER_EXCLUSIVE = 1.15;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const positive = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
const near = (a: unknown, b: unknown, tol: number): boolean =>
  a === null || b === null
    ? a === b
    : typeof a === 'number' &&
      typeof b === 'number' &&
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Math.abs(a - b) <= tol;
const check = (
  status: HorseReplayCheck['status'],
  expected: unknown,
  observed: unknown,
  detail: string | null = null
): HorseReplayCheck => ({ status, expected, observed, detail });
const notApplicable = (detail: string): HorseReplayCheck =>
  check('not_applicable', null, null, detail);

export function independentMZone(effectiveM: number, previousZone: string | null): string {
  const m = Math.max(0, Number.isFinite(effectiveM) ? effectiveM : 0);
  const index = M_BOUNDARIES.findIndex((boundary) => m < boundary);
  const candidate = index < 0 ? 'blue' : M_ZONES[index];
  if (!previousZone) return candidate;
  const prev = M_ZONES.indexOf(previousZone);
  const cand = M_ZONES.indexOf(candidate);
  if (prev < 0 || cand === prev) return candidate;
  if (Math.abs(cand - prev) > 1) return candidate;
  if (cand > prev) {
    const boundary = M_BOUNDARIES[Math.min(prev, M_BOUNDARIES.length - 1)];
    return m >= boundary + M_HYSTERESIS ? candidate : previousZone;
  }
  const boundary = M_BOUNDARIES[Math.min(cand, M_BOUNDARIES.length - 1)];
  return m < boundary - M_HYSTERESIS ? candidate : previousZone;
}

function orbitCost(
  sb: number,
  bb: number,
  ante: number,
  anteType: string,
  players: number
): number {
  const blinds = positive(sb) + positive(bb);
  const a = positive(ante);
  let anteCost = 0;
  if (anteType === 'per_player') anteCost = a * players;
  else if (anteType === 'big_blind' && a > 0 && players > 0) {
    const total = bb > 0 && a >= bb ? a : a * players;
    anteCost = bb > 0 ? Math.min(total, bb * BBA_CEILING_BB) : total;
  }
  return blinds + anteCost;
}

export function independentMState(hero: Seat, gs: GameState): MState | null {
  const t = gs.tournament;
  if (!t || typeof t.anteType !== 'string') return null;
  const players = clamp(Math.floor(t.playersAtTable || 0), PLAYERS_MIN, PLAYERS_MAX);
  const orbit = orbitCost(
    t.currentSmallBlind ?? 0,
    t.currentBigBlind ?? 0,
    t.currentAnte ?? 0,
    t.anteType,
    players
  );
  const stack = Math.max(0, Number(hero.stack) || 0);
  const realM = orbit > 0 ? stack / orbit : 0;
  const scale = players / 10;
  const effectiveM = realM * scale;
  const hasNext = positive(t.nextSmallBlind) > 0 && positive(t.nextBigBlind) > 0;
  const projectedOrbit = hasNext
    ? orbitCost(
        t.nextSmallBlind as number,
        t.nextBigBlind as number,
        t.nextAnte ?? t.currentAnte ?? 0,
        t.anteType,
        players
      )
    : orbit;
  const projectedM = projectedOrbit > 0 ? stack / projectedOrbit : realM;
  const projectedEffectiveM = projectedM * scale;
  const projectedStackBB =
    positive(t.nextBigBlind) > 0
      ? stack / (t.nextBigBlind as number)
      : positive(t.currentBigBlind) > 0
        ? stack / (t.currentBigBlind as number)
        : 0;
  const minutes = positive(t.nextBlindInMin);
  const velocityMPerMinute =
    minutes > 0 ? Math.max(0, effectiveM - projectedEffectiveM) / minutes : 0;
  const coveringOpponents = gs.players
    .filter((p) => p.user_id !== hero.user_id && !p.is_sitting_out)
    .map((p) => ({
      userId: String(p.user_id || ''),
      stackChips: Math.max(0, Number(p.stack) || 0),
    }))
    .filter((p) => p.userId.length > 0 && p.stackChips > 0 && p.stackChips >= stack)
    .sort(
      (a, b) =>
        a.stackChips - b.stackChips || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
    )
    .map((p) => ({
      ...p,
      realM: orbit > 0 ? p.stackChips / orbit : 0,
      effectiveM: orbit > 0 ? (p.stackChips / orbit) * scale : 0,
    }));
  const previousZone = t.m?.previousZone ?? null;
  return {
    orbitCostChips: orbit,
    realM,
    effectiveM,
    projectedOrbitCostChips: projectedOrbit,
    projectedM,
    projectedEffectiveM,
    projectedStackBB,
    velocityMPerMinute,
    coveringOpponentM: coveringOpponents[0]?.realM ?? null,
    coveringOpponents,
    zone: independentMZone(effectiveM, previousZone),
    previousZone,
  };
}

export function independentDepthBracket(stackBB: number): {
  lower: number;
  upper: number;
  weight: number;
} {
  const depth = clamp(
    Number.isFinite(stackBB) ? stackBB : 20,
    DEPTH_ANCHORS[0],
    DEPTH_ANCHORS[DEPTH_ANCHORS.length - 1]
  );
  for (let i = 0; i < DEPTH_ANCHORS.length; i++) {
    const lower = DEPTH_ANCHORS[i];
    if (depth === lower || i === DEPTH_ANCHORS.length - 1)
      return { lower, upper: lower, weight: 0 };
    const upper = DEPTH_ANCHORS[i + 1];
    if (depth < upper) return { lower, upper, weight: (depth - lower) / (upper - lower) };
  }
  return { lower: 100, upper: 100, weight: 0 };
}

/** Seats dealt into the hand, from the canonical census when it is present. */
function dealtSeats(gs: GameState): number[] {
  const ids = gs.dealtSeatIds;
  const seats =
    ids === undefined
      ? gs.players.map((p) => p.seat)
      : gs.players.filter((p) => ids.includes(p.seat)).map((p) => p.seat);
  return [...new Set(seats.filter(Number.isFinite))].sort((a, b) => a - b);
}

function clockwiseOrder(dealerSeat: number, seats: number[]): number[] {
  const order: number[] = [];
  let cursor = dealerSeat;
  for (let i = 0; i < seats.length; i++) {
    const next = seats.find((s) => s > cursor) ?? seats[0];
    order.push(next);
    cursor = next;
  }
  return order;
}

export function independentTournamentPosition(
  heroSeat: number,
  dealerSeat: number | undefined,
  seats: number[]
): string {
  if (dealerSeat === undefined || !seats.includes(heroSeat) || seats.length < 2) return 'MP';
  if (seats.length === 2) return heroSeat === dealerSeat ? 'SB' : 'BB';
  const order = clockwiseOrder(dealerSeat, seats);
  const ring = POSITIONS_BY_SIZE[clamp(order.length, PLAYERS_MIN, PLAYERS_MAX)];
  return ring[order.indexOf(heroSeat)] ?? 'MP';
}

/** The chart consult's coarse position (sb/bb/early/middle/late); null when the
 * legacy ring cannot be named from public facts. */
function chartPosition(heroSeat: number, gs: GameState, v13: boolean): string | null {
  const hasCensus = gs.dealtSeatIds !== undefined;
  const allDealt = hasCensus || gs.tournament !== undefined;
  if (v13 && !allDealt) return null;
  const players = hasCensus
    ? gs.players.filter((p) => gs.dealtSeatIds!.includes(p.seat))
    : gs.players;
  const inHand = players
    .filter((p) => v13 || !p.is_folded || p.seat === heroSeat)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  if (gs.dealerSeat === undefined || inHand.length < 2) return 'middle';
  const order: number[] = [];
  let cursor = gs.dealerSeat;
  for (let i = 0; i < inHand.length; i++) {
    const next = inHand.find((s) => s > cursor) ?? inHand[0];
    order.push(next);
    cursor = next;
    if (order.length > 1 && next === order[0]) break;
  }
  const index = order.indexOf(heroSeat);
  const n = order.length;
  if (index === -1) return 'middle';
  if (n === 2) return heroSeat === gs.dealerSeat ? 'sb' : 'bb';
  if (index === 0) return 'sb';
  if (index === 1) return 'bb';
  const nonBlind = n - 2;
  const position = index - 2;
  if (position >= nonBlind - 2) return 'late';
  return position < Math.max(1, Math.ceil((nonBlind - 2) / 2)) ? 'early' : 'middle';
}

function variantFacts(gs: GameState) {
  const v = (gs.gameVariant || 'nlh').toLowerCase();
  const rules = gs.variantRules;
  const omaha = rules
    ? rules.holeCardsUse === 'exactly_two' && rules.boardCardsUse === 'exactly_three'
    : /omaha|plo|flo/.test(v);
  const short = rules ? rules.deckSize === 36 : /short/.test(v);
  const holes = rules ? rules.holeCardsDealt : /pineapple/.test(v) ? 3 : omaha ? 4 : 2;
  const fixed =
    rules && gs.bettingStructure !== undefined
      ? gs.bettingStructure === 'fixed_limit'
      : /^fl|fixed/.test(v);
  return { omaha, short, holes, fixed };
}

interface PreflopLine {
  raises: number;
  limpers: number;
  callers: number;
  priorCallers: number;
  first: number;
  last: number;
  history: HistoryAction[];
  straddle: boolean;
}

function preflopLine(gs: GameState, opts: Record<string, unknown> | null | undefined): PreflopLine {
  const bb = gs.bigBlind > 0 ? gs.bigBlind : 2;
  const history = (gs.actionHistory ?? []).filter((a) => a.stage === 'preflop');
  let raises = 0,
    limpers = 0,
    callers = 0,
    priorCallers = 0,
    first = -1,
    last = -1;
  for (const a of history) {
    if (
      a.action === 'raise' ||
      a.action === 'bet' ||
      (a.action === 'all_in' && a.isFullRaise !== undefined)
    ) {
      raises++;
      priorCallers = callers;
      callers = 0;
      if (first < 0) first = a.seat;
      last = a.seat;
    } else if (a.action === 'call' || a.action === 'all_in') {
      if (raises === 0) limpers++;
      else callers++;
    }
  }
  const straddle =
    (opts?.v18Straddle ?? true) !== false &&
    gs.straddleActive === true &&
    raises === 0 &&
    gs.currentBet > bb * 1.05 &&
    gs.currentBet <= bb * 2.2;
  if (!straddle && history.length === 0 && gs.currentBet > bb * 1.05)
    raises = gs.currentBet > bb * 4.5 ? 2 : 1;
  return { raises, limpers, callers, priorCallers, first, last, history, straddle };
}

export function independentBranch(input: {
  raises: number;
  limpers: number;
  callers: number;
  callersOfPreviousRaise: number;
  opponentsAllIn: number;
  opponentsLeft: number;
  mZone: string | undefined;
  heroPosition: string;
  raiserPosition: string | null;
  heroPreviouslyActed: boolean;
  heroWasInitialRaiser: boolean;
  squeezed: boolean;
}): string {
  if (
    input.opponentsAllIn >= 2 ||
    (input.opponentsAllIn >= 1 &&
      (input.callers >= 1 || (input.raises >= 1 && input.opponentsLeft >= 2)))
  )
    return 'multiway_all_in';
  if (input.squeezed || (input.raises >= 2 && input.heroWasInitialRaiser))
    return 'three_bet_facing';
  const heroBlind = input.heroPosition === 'SB' || input.heroPosition === 'BB';
  const raiserBlind = input.raiserPosition === 'SB' || input.raiserPosition === 'BB';
  if (heroBlind && input.opponentsLeft === 1 && (input.raises === 0 || raiserBlind))
    return input.heroPosition === 'BB' && input.raises > 0 ? 'bb_defense' : 'blind_vs_blind';
  if (input.raises === 0) return input.limpers > 0 ? 'limp_facing' : 'unopened';
  if (input.raises >= 2) return 'three_bet_facing';
  const pressure = ['dead', 'red', 'orange', 'yellow'].includes(input.mZone ?? '');
  if (input.callers > 0) {
    if (pressure) return 'reshove';
    return ['CO', 'BTN', 'SB', 'BB'].includes(input.heroPosition) ? 'squeeze' : 'overcall';
  }
  if (pressure && ['HJ', 'CO', 'BTN', 'SB'].includes(input.raiserPosition ?? 'UTG'))
    return 'reshove';
  if (input.heroPosition === 'BB') return 'bb_defense';
  return input.heroPreviouslyActed ? 'open_facing' : 'cold_call';
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Hero's contestable pot after a hypothetical call: the dead pool, every live
 * level hero's investment reaches, and orphaned levels folded into the main
 * pot; minus the call itself. Restated from the settlement rules. */
export function independentContestablePot(players: Seat[], hero: Seat, toCall: number): number {
  const call = cents(Math.min(Math.max(0, toCall), Math.max(0, hero.stack)));
  const live = (p: Seat, extra: number) =>
    Math.max(
      0,
      cents(
        (p.totalInvested ?? p.bet ?? 0) +
          extra -
          (p.deadInvested ?? 0) +
          (p.individualAnteInvested ?? 0)
      )
    );
  const rows = players.map((p) => ({
    folded: p.is_folded,
    hero: p.user_id === hero.user_id,
    investment: live(p, p.user_id === hero.user_id ? call : 0),
  }));
  const deadTotal = cents(
    players.reduce((s, p) => s + (p.deadInvested ?? 0) - (p.individualAnteInvested ?? 0), 0)
  );
  const contributors = rows.filter((r) => r.investment > 0);
  const heroLive = rows.find((r) => r.hero)?.investment ?? 0;
  if (contributors.length === 0) return cents(Math.max(0, deadTotal - call));
  const levels = [...new Set(contributors.map((r) => r.investment))].sort((a, b) => a - b);
  let previous = 0,
    eligible = 0,
    orphaned = 0,
    mainPotSeen = false,
    heroInMain = false;
  for (const level of levels) {
    const contribution = level - previous;
    const total = contributors.filter((r) => r.investment >= level).length;
    const claimants = contributors.filter((r) => !r.folded && r.investment >= level);
    if (total > 0 && claimants.length > 0) {
      if (!mainPotSeen) {
        mainPotSeen = true;
        heroInMain = claimants.some((r) => r.hero);
      }
      if (heroLive >= level) eligible += contribution * total;
    } else if (total > 0) orphaned = cents(orphaned + contribution * total);
    previous = level;
  }
  if (orphaned > 0 && mainPotSeen && heroInMain) eligible += orphaned;
  const deadPool = cents(deadTotal + (mainPotSeen ? 0 : orphaned));
  const heroPutIn = (hero.totalInvested ?? hero.bet ?? 0) + call > 0;
  if (deadPool > 0 && heroPutIn) eligible += deadPool;
  return cents(Math.max(0, cents(eligible) - call));
}

// The five checks.
export function qualifyHorseDecisionIndependently(
  input: IndependentQualificationInput
): IndependentQualification {
  const { player: hero, gameState: gs, attribution } = input;
  const opts = input.opts ?? null;
  const bb = gs.bigBlind > 0 ? gs.bigBlind : 2;
  const tournamentMode = gs.gameMode
    ? gs.gameMode === 'tournament'
    : gs.tournament != null || (gs.bigBlind ?? 0) >= 10;
  const preflop = gs.stage === 'preflop';
  const { omaha, short, holes, fixed } = variantFacts(gs);

  // (1) Pot odds: the canonical state's toCall and contestablePot are the
  // claims the decision priced against; break-even equity is derived from them.
  const toCall = Math.max(0, gs.currentBet - hero.bet);
  const contestable = independentContestablePot(gs.players, hero, toCall);
  const call = Math.min(toCall, Math.max(0, hero.stack));
  const breakEven = call > 0 ? call / (contestable + call) : 0;
  const pot_odds = check(
    near(gs.toCall, toCall, 0.005) && near(gs.contestablePot, contestable, 0.01)
      ? 'agreed'
      : 'disagreed',
    { toCall, contestablePot: contestable, breakEvenEquity: breakEven },
    { toCall: gs.toCall ?? null, contestablePot: gs.contestablePot ?? null }
  );

  // (2) M / effective stack coordinate.
  let m_state: HorseReplayCheck;
  const expectedM = tournamentMode ? independentMState(hero, gs) : null;
  const observedM = gs.tournament?.m ?? null;
  if (!tournamentMode) m_state = notApplicable('outside_tournament');
  else if (!expectedM || !observedM)
    m_state = check('disagreed', expectedM, observedM, 'm_state_missing');
  else {
    const keys: Array<keyof MState> = [
      'orbitCostChips',
      'realM',
      'effectiveM',
      'projectedOrbitCostChips',
      'projectedM',
      'projectedEffectiveM',
      'projectedStackBB',
      'velocityMPerMinute',
      'coveringOpponentM',
    ];
    const numbers = keys.every((k) =>
      near(observedM[k] as number | null, expectedM[k] as number | null, 1e-8)
    );
    const covering =
      Array.isArray(observedM.coveringOpponents) &&
      observedM.coveringOpponents.length === expectedM.coveringOpponents.length &&
      [...observedM.coveringOpponents]
        .sort((a, b) => a.stackChips - b.stackChips || (a.userId < b.userId ? -1 : 1))
        .every((o, i) => {
          const e = expectedM.coveringOpponents[i];
          return (
            o.userId === e.userId &&
            near(o.stackChips, e.stackChips, 1e-8) &&
            near(o.realM, e.realM, 1e-8) &&
            near(o.effectiveM, e.effectiveM, 1e-8)
          );
        });
    const zones =
      observedM.zone === expectedM.zone && observedM.previousZone === expectedM.previousZone;
    m_state = check(numbers && covering && zones ? 'agreed' : 'disagreed', expectedM, observedM);
  }

  // (3) Ante mode: the tournament's declared ante type must agree with the
  // hand's posted-ante facts and with the coordinate the atlas was asked for.
  let ante_mode: HorseReplayCheck;
  if (!tournamentMode || !gs.tournament) ante_mode = notApplicable('outside_tournament');
  else {
    const declared = gs.tournament.anteType ?? null;
    const fromHand =
      gs.bigBlindAnte === true ? 'big_blind' : (gs.ante ?? 0) > 0 ? 'per_player' : 'none';
    const coordinate = attribution?.lookup?.coordinate.anteType ?? null;
    const agreed = declared === fromHand && (coordinate === null || coordinate === declared);
    ante_mode = check(
      agreed ? 'agreed' : 'disagreed',
      { fromHand, declared },
      { declared, coordinate }
    );
  }

  // (4) Atlas coordinate.
  let atlas_coordinate: HorseReplayCheck;
  const line = preflop ? preflopLine(gs, opts) : null;
  const seats = dealtSeats(gs);
  if (!tournamentMode || !preflop)
    atlas_coordinate = notApplicable(tournamentMode ? 'postflop' : 'outside_tournament');
  else if (!attribution) atlas_coordinate = check('disagreed', null, null, 'attribution_missing');
  else if (!attribution.lookup) atlas_coordinate = notApplicable(`no_lookup:${attribution.route}`);
  else if (!gs.tournament?.m || !line)
    atlas_coordinate = check('disagreed', null, attribution.lookup.coordinate, 'm_state_missing');
  else {
    const t = gs.tournament;
    const m = t.m!;
    const heroPosition = independentTournamentPosition(hero.seat, gs.dealerSeat, seats);
    const raiserPosition =
      line.last >= 0 ? independentTournamentPosition(line.last, gs.dealerSeat, seats) : null;
    const opponent =
      line.last >= 0
        ? gs.players.find(
            (p) => p.seat === line.last && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
          )
        : undefined;
    const heroDepth = Math.max(0, hero.stack + hero.bet);
    const depth = opponent
      ? Math.min(heroDepth, Math.max(0, opponent.stack + opponent.bet)) / bb
      : heroDepth / bb;
    const imminent =
      typeof t.nextBlindInMin === 'number' &&
      t.nextBlindInMin <= PROJECTION_MAX_MINUTES &&
      (t.nextBlindMult ?? 1) > PROJECTION_MIN_MULTIPLIER_EXCLUSIVE;
    const priorActed = line.history.some(
      (a) => a.seat === hero.seat && a.action !== 'fold' && a.action !== 'check'
    );
    const voluntaryAllIn = new Set(
      line.history.filter((a) => a.action === 'all_in').map((a) => a.seat)
    );
    const branch = independentBranch({
      raises: line.raises,
      limpers: line.limpers,
      callers: line.callers,
      callersOfPreviousRaise: line.priorCallers,
      opponentsAllIn: gs.players.filter(
        (p) => p.seat !== hero.seat && !p.is_folded && p.is_all_in && voluntaryAllIn.has(p.seat)
      ).length,
      opponentsLeft: gs.players.filter(
        (p) =>
          !p.is_folded &&
          p.seat !== hero.seat &&
          (opts?.v13 === false || !p.is_sitting_out || p.is_all_in)
      ).length,
      mZone: imminent
        ? independentMZone(Math.min(m.effectiveM, m.projectedEffectiveM), m.zone)
        : m.zone,
      heroPosition,
      raiserPosition,
      heroPreviouslyActed: priorActed,
      heroWasInitialRaiser: line.first === hero.seat,
      squeezed:
        (opts?.v18Squeeze ?? true) !== false &&
        line.raises === 2 &&
        line.priorCallers >= 1 &&
        line.first === hero.seat,
    });
    const family = omaha ? 'omaha' : !short && holes === 2 && !fixed ? 'nlh' : 'other';
    const tableSize = t.playersAtTable ?? seats.length;
    const anteType =
      t.anteType ??
      (gs.bigBlindAnte === true ? 'big_blind' : (gs.ante ?? 0) > 0 ? 'per_player' : 'none');
    const contextStatus = t.contextStatus ?? 'incomplete';
    const ring = POSITIONS_BY_SIZE[tableSize] ?? [];
    const validCoordinate =
      Number.isSafeInteger(tableSize) &&
      tableSize >= PLAYERS_MIN &&
      tableSize <= PLAYERS_MAX &&
      ring.includes(heroPosition) &&
      (raiserPosition === null ||
        (raiserPosition !== heroPosition && ring.includes(raiserPosition)));
    const source =
      family === 'nlh' && contextStatus === 'complete' && validCoordinate
        ? 'deterministic_baseline'
        : 'labeled_fallback';
    const fallbackReason = !validCoordinate
      ? 'invalid_coordinate'
      : family !== 'nlh'
        ? 'unsupported_variant'
        : contextStatus !== 'complete'
          ? 'incomplete_context'
          : null;
    const bracket = independentDepthBracket(depth);
    const velocity = Math.round(clamp(m.velocityMPerMinute / 2, 0, 1) * 1000) / 1000;
    const cell = [
      'phase6-v1',
      family,
      source,
      validCoordinate ? tableSize : `invalid-${String(tableSize)}`,
      heroPosition,
      raiserPosition ?? 'NONE',
      anteType,
      branch,
      `${bracket.lower}-${bracket.upper}@${bracket.weight}`,
      `velocity=${velocity}`,
    ].join(':');
    const expected = {
      coordinate: {
        gameFamily: family,
        contextStatus,
        tableSize,
        heroPosition,
        raiserPosition,
        anteType,
        branch,
        stackBB: depth,
        mVelocityMPerMinute: m.velocityMPerMinute,
      },
      policy: { cell, source, fallbackReason, depth: bracket },
    };
    const c = attribution.lookup.coordinate;
    const p = attribution.lookup.policy;
    const agreed =
      c.gameFamily === family &&
      c.contextStatus === contextStatus &&
      c.tableSize === tableSize &&
      c.heroPosition === heroPosition &&
      c.raiserPosition === raiserPosition &&
      c.anteType === anteType &&
      c.branch === branch &&
      near(c.stackBB, depth, 1e-9) &&
      near(c.mVelocityMPerMinute, m.velocityMPerMinute, 1e-9) &&
      p.cell === cell &&
      p.source === source &&
      p.fallbackReason === fallbackReason &&
      p.depth.lower === bracket.lower &&
      p.depth.upper === bracket.upper &&
      near(p.depth.weight, bracket.weight, 1e-12);
    atlas_coordinate = check(agreed ? 'agreed' : 'disagreed', expected, attribution.lookup);
  }

  // (5) Route admissibility under the published reference gates.
  const admissible: string[] = [];
  let postflopStoreConsultPossible = false;
  if (preflop && line) {
    const usesIntentReference = (opts?.v7Preflop as boolean | undefined) ?? opts?.v7 !== false;
    if (!usesIntentReference) admissible.push('legacy_preflop');
    else {
      const chartsOn =
        (opts?.v27GtoCharts ?? true) !== false &&
        hero.cards.length === 2 &&
        !omaha &&
        !short &&
        !fixed &&
        gs.straddleActive !== true;
      if (chartsOn) {
        const position = chartPosition(hero.seat, gs, opts?.v13 !== false);
        const depth = (hero.stack + hero.bet) / bb;
        if (
          line.raises === 0 &&
          line.limpers === 0 &&
          line.callers === 0 &&
          !line.history.some((a) => a.action === 'all_in') &&
          position !== 'bb' &&
          toCall <= bb &&
          depth > 0 &&
          depth <= 15
        )
          admissible.push('chart_open_jam');
        const raiserPosition =
          line.last >= 0 ? chartPosition(line.last, gs, opts?.v13 !== false) : null;
        const opponents = gs.players.filter(
          (x) =>
            !x.is_folded &&
            x.seat !== hero.seat &&
            (opts?.v13 === false || !x.is_sitting_out || x.is_all_in)
        ).length;
        const effective = Math.min(depth, gs.currentBet / bb);
        if (
          (position === null || position === 'bb') &&
          line.raises === 1 &&
          (raiserPosition === null || raiserPosition === 'sb') &&
          opponents === 1 &&
          line.history.some((a) => a.seat === line.last && a.action === 'all_in') &&
          toCall > 0 &&
          effective > 0 &&
          effective <= 25
        )
          admissible.push('chart_bb_defend');
      }
      if (
        (opts?.v38Ev ?? true) !== false &&
        toCall > 0 &&
        (omaha || short || holes !== 2 || fixed) &&
        line.last >= 0 &&
        gs.allInOrFold !== true
      ) {
        const raiser = gs.players.find((x) => x.seat === line.last);
        const callAmount = Math.min(toCall, hero.stack);
        if (raiser && (raiser.is_all_in === true || callAmount >= hero.stack * 0.4)) {
          const committed = gs.players.filter(
            (x) =>
              !x.is_folded &&
              (!x.is_sitting_out || x.is_all_in) &&
              x.seat !== hero.seat &&
              (x.is_all_in || (Number.isFinite(x.bet) && x.bet >= gs.currentBet - 0.005))
          );
          const perOpponent = omaha ? holes : hero.cards.length;
          if (
            committed.length > 0 &&
            perOpponent >= 2 &&
            committed.length * perOpponent <=
              (short ? 36 : 52) - hero.cards.length - (hero.knownDeadCards?.length ?? 0) - 5
          )
            admissible.push('variant_price');
        }
      }
      admissible.push('intent_engine');
    }
  } else if (!preflop) {
    const live = gs.players.filter(
      (x) => !x.is_folded && x.seat !== hero.seat && (!x.is_sitting_out || x.is_all_in)
    ).length;
    postflopStoreConsultPossible =
      hero.cards.length === 2 && holes === 2 && !omaha && !short && !fixed && live === 1;
  }
  const route = !preflop
    ? notApplicable('postflop')
    : !attribution
      ? check('disagreed', admissible, null, 'attribution_missing')
      : check(
          admissible.includes(attribution.route) ? 'agreed' : 'disagreed',
          admissible,
          attribution.route
        );

  return {
    pot_odds,
    m_state,
    ante_mode,
    atlas_coordinate,
    route,
    admissibleRoutes: admissible,
    postflopStoreConsultPossible,
  };
}
