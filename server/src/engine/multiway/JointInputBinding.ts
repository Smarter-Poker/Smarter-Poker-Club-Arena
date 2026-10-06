import type { SeatPlayer } from '../../types.js';
import type { HorseGameStateV2 } from '../HorseLogic.js';
import { bettingStructureFor } from '../BettingStructure.js';
import { horseCanonicalMaterialSha256 } from '../HorseTournamentUtilityEvidence.js';
import { plo4BlindSeatsStatus, plo4ButtonOffset } from '../plo4/Plo4LivePolicy.js';
import { remainingVariantChipUnit } from '../remainingVariants/RemainingVariantLivePolicy.js';
import { JOINT_ACTION_PACK } from './JointActionModel.js';
import { JOINT_RANGE_PACK, type JointRangeSamples } from './JointRangeSampler.js';
import { JOINT_LIVE_DOMAIN } from './JointSampleAcquisition.js';

/** The nine variants the joint owner serves (VariantRules' known variants). */
export const JOINT_VARIANTS = Object.freeze([
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'flo8',
  'flh',
  'pineapple',
  'short_deck',
] as const);
export type JointVariant = (typeof JOINT_VARIANTS)[number];

/** P13.1: whether the decision consumed a complete joint sample population. */
export type JointRangeStatus = 'consumed' | 'unavailable';
const RANGE_STATUSES: readonly JointRangeStatus[] = ['consumed', 'unavailable'];

/**
 * P13.1: the facts a Phase 13 joint proposal actually consumed, copied and
 * frozen when it was computed, modeled field for field on the Phase 12
 * `RemainingVariantInputBinding`. A private receipt field: never public state
 * or telemetry, and it holds no card value of any kind (boards and hole cards
 * are counted, never listed). Positions are the controller's own action order
 * from the blinds the engine posted (JointResponseOrder.ts), never a dealer
 * offset. The range block is the joint sampler's work, not a calibration.
 */
export interface JointInputBinding {
  readonly version: 'joint-input-binding-v1';
  readonly variant: JointVariant;
  readonly mode: 'cash' | 'tournament';
  readonly packs: Readonly<{ domain: string; range: string; action: string }>;
  readonly approximation: Readonly<{
    status: 'explicit_joint_heuristic';
    rangeSource: string;
    rangeConfidence: string;
    calibratedConfidence: null;
    solverInput: false;
  }>;
  readonly census: Readonly<{
    dealerSeat: number;
    heroSeat: number;
    dealtSeats: readonly number[];
    dealtPlayers: number;
    liveOpponents: number;
    contestingOpponentSeats: readonly number[];
    foldedSeats: readonly number[];
    awaySeats: readonly number[];
    allInSeats: readonly number[];
    foldedCount: number;
    awayCount: number;
    boardCount: 1 | 2 | 3;
    bombPot: boolean;
    /** Null when no sample was completed. */
    physicalCardsPerSample: number | null;
    unknownDealtCardsPerSample: number | null;
  }>;
  readonly positions: Readonly<{
    /** As HandController posted them; null on a bomb hand or a cash state
     * the engine walked from the button. */
    blindSeats: Readonly<{ smallBlind: number | null; bigBlind: number }> | null;
    /** Dealt seats in the controller's action order for this street. */
    actionOrder: readonly number[];
    firstToActSeat: number;
    heroOffset: number;
    /** Opponents who still owe a response after the hero, in order. */
    playersBehindSeats: readonly number[];
    straddle: 'table_enabled_utg_2bb' | 'none';
  }>;
  readonly geometry: Readonly<{
    bettingStructure: 'no_limit' | 'pot_limit' | 'fixed_limit';
    /** The unit pots and settlements are computed in (cash chips: cents). */
    settlementUnit: 0.01 | 1;
    /** The unit the horse legalizer lands wagers on: whole chips whenever
     * the big blind is whole, cents otherwise. */
    legalChipStep: 0.01 | 1;
    /** Whether every candidate was priced in the legalizer's own form. */
    legalForm: 'horse_legalizer' | 'not_supplied';
    bigBlind: number;
    pot: number;
    currentBet: number;
    heroBet: number;
    heroStack: number;
    callCost: number;
    minRaiseTo: number | null;
    maxRaiseTo: number | null;
    stackRaiseTo: number;
    noLimit: Readonly<{ wagerCap: number | null }> | null;
    potLimit: Readonly<{ wagerCap: number | null }> | null;
    fixedLimit: Readonly<{ fixedBetSize: number | null; wagersCapped: boolean }> | null;
    rake: Readonly<{
      percent: number;
      cap: number;
      noFlopNoDrop: boolean;
      playerCountCaps: ReadonlyArray<Readonly<{ players: number; cap: number }>> | null;
      timed: boolean;
      dealtCount: number;
    }>;
    bbj: boolean;
  }>;
  readonly depth: Readonly<{
    effectiveBB: number;
    heroCoverBB: number;
    deepestOpponentCoverBB: number;
    maxStackBB: number;
    basis: 'stack_plus_street_bet_vs_deepest_contesting_opponent';
  }>;
  /** Counts only; never a card value. */
  readonly boards: Readonly<{
    street: 'preflop' | 'flop' | 'turn' | 'river';
    count: 1 | 2 | 3;
    cardsPerBoard: 0 | 3 | 4 | 5;
    cardValues: 'not_recorded';
  }>;
  readonly ranges: Readonly<{
    status: JointRangeStatus;
    /** A population acquired for this decision, or the identical one Phase 7
     * acquired earlier in the same decision and this owner reused. */
    acquisition: 'fresh' | 'reused_phase7';
    provenance: Readonly<{
      requested: number;
      completed: number;
      sampleBudgetExhausted: boolean;
      uniformEscapes: number;
      opponents: ReadonlyArray<
        Readonly<{
          seat: number;
          folded: boolean;
          live: boolean;
          allIn: boolean;
          raises: number;
          calls: number;
          checks: number;
          prior: 'uniform_bomb_deal' | 'structural_variant_prior';
        }>
      >;
    }>;
  }>;
  readonly objective: Readonly<{
    kind: 'cash_net_chips' | 'tournament_phase7_utility';
    asset: 'chips' | 'diamonds';
  }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullableFinite = (value: unknown) => value === null || finite(value);
const count = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const near = (a: unknown, b: number, tolerance = 1e-6) =>
  typeof a === 'number' && Math.abs(a - b) <= tolerance;
const seatList = (value: unknown, max = 10): value is number[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every(
    (seat, i) =>
      Number.isSafeInteger(seat) && seat >= 1 && seat <= 10 && (i === 0 || seat > value[i - 1])
  );
const physicalSeat = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10;
const subset = (a: readonly number[], b: readonly number[]) => a.every((x) => b.includes(x));
const freezeTree = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
};

export function isJointVariant(value: unknown): value is JointVariant {
  return JOINT_VARIANTS.some((variant) => variant === value);
}

/**
 * Assemble the binding from the values the proposal consumed. Every value is
 * copied (never an alias of the caller's state) and the result is frozen.
 */
export function buildJointInputBinding(input: {
  hero: SeatPlayer;
  state: HorseGameStateV2;
  dealtSeats: readonly number[];
  actionOrder: readonly number[];
  playersBehind: readonly string[];
  evidence: JointRangeSamples | null;
  requestedSamples: number;
  consumed: boolean;
  reused: boolean;
  legalFormSupplied: boolean;
}): JointInputBinding {
  const { hero, state: s } = input;
  const dealt = [...input.dealtSeats].sort((a, b) => a - b);
  const seats = s.players.filter((p) => dealt.includes(p.seat));
  const seatsOf = (rows: readonly SeatPlayer[]) => rows.map((p) => p.seat).sort((a, b) => a - b);
  const contesting = seats.filter((p) => p.user_id !== hero.user_id && !p.is_folded);
  const structure = s.bettingStructure as 'no_limit' | 'pot_limit' | 'fixed_limit';
  const tournament = s.gameMode === 'tournament';
  const asset = s.asset === 'diamonds' ? 'diamonds' : 'chips';
  const stackRaiseTo = hero.bet + hero.stack;
  const maxRaiseTo = s.maxRaiseTo ?? null;
  const wagerCap = maxRaiseTo === null ? null : Math.min(maxRaiseTo, stackRaiseTo);
  const rake = s.rakeConfig!;
  const deepest = Math.max(...contesting.map((p) => p.stack + p.bet));
  const heroCoverBB = stackRaiseTo / s.bigBlind;
  const deepestOpponentCoverBB = deepest / s.bigBlind;
  const blinds =
    s.stage === 'preflop' && !s.bombPot && s.blindSeats
      ? { smallBlind: s.blindSeats.smallBlind, bigBlind: s.blindSeats.bigBlind }
      : null;
  const evidence = input.evidence;
  const boardCount = (s.boardCount ?? 1) as 1 | 2 | 3;
  const street = s.stage as 'preflop' | 'flop' | 'turn' | 'river';
  const bySeat = new Map(s.players.map((p) => [p.user_id, p.seat]));
  return freezeTree({
    version: 'joint-input-binding-v1',
    variant: s.gameVariant as JointVariant,
    mode: tournament ? 'tournament' : 'cash',
    packs: {
      domain: JOINT_LIVE_DOMAIN.version,
      range: JOINT_RANGE_PACK.version,
      action: JOINT_ACTION_PACK.version,
    },
    approximation: {
      status: 'explicit_joint_heuristic',
      rangeSource: JOINT_RANGE_PACK.source,
      rangeConfidence: JOINT_RANGE_PACK.confidence,
      calibratedConfidence: null,
      solverInput: false,
    },
    census: {
      dealerSeat: s.dealerSeat!,
      heroSeat: hero.seat,
      dealtSeats: [...dealt],
      dealtPlayers: dealt.length,
      liveOpponents: contesting.length,
      contestingOpponentSeats: seatsOf(contesting),
      foldedSeats: seatsOf(seats.filter((p) => p.is_folded)),
      awaySeats: seatsOf(seats.filter((p) => p.is_sitting_out)),
      allInSeats: seatsOf(seats.filter((p) => p.is_all_in)),
      foldedCount: seats.filter((p) => p.is_folded).length,
      awayCount: seats.filter((p) => p.is_sitting_out).length,
      boardCount,
      bombPot: s.bombPot === true,
      physicalCardsPerSample:
        evidence && evidence.samples.length ? evidence.physicalCardsPerSample : null,
      unknownDealtCardsPerSample:
        evidence && evidence.samples.length ? evidence.unknownDealtCardsPerSample : null,
    },
    positions: {
      blindSeats: blinds,
      actionOrder: [...input.actionOrder],
      firstToActSeat: input.actionOrder[0],
      heroOffset: plo4ButtonOffset(hero.seat, s.dealerSeat!, dealt),
      playersBehindSeats: input.playersBehind.map((id) => bySeat.get(id)!),
      straddle: s.straddleActive ? 'table_enabled_utg_2bb' : 'none',
    },
    geometry: {
      bettingStructure: structure,
      settlementUnit: s.chipUnit === 1 ? 1 : 0.01,
      legalChipStep: remainingVariantChipUnit(s.bigBlind),
      legalForm: input.legalFormSupplied ? 'horse_legalizer' : 'not_supplied',
      bigBlind: s.bigBlind,
      pot: s.pot,
      currentBet: s.currentBet,
      heroBet: hero.bet,
      heroStack: hero.stack,
      callCost: Math.min(hero.stack, Math.max(0, s.currentBet - hero.bet)),
      minRaiseTo: s.minRaiseTo ?? null,
      maxRaiseTo,
      stackRaiseTo,
      noLimit: structure === 'no_limit' ? { wagerCap } : null,
      potLimit: structure === 'pot_limit' ? { wagerCap } : null,
      fixedLimit:
        structure === 'fixed_limit'
          ? { fixedBetSize: s.fixedBetSize ?? null, wagersCapped: s.wagersCapped === true }
          : null,
      rake: {
        percent: rake.percent,
        cap: rake.cap,
        noFlopNoDrop: rake.noFlopNoDrop === true,
        playerCountCaps: rake.playerCountCaps?.length
          ? rake.playerCountCaps.map((tier) => ({ players: tier.players, cap: tier.cap }))
          : null,
        timed: Boolean(rake.timedRake),
        dealtCount: dealt.length,
      },
      bbj: s.bbjConfig !== null && s.bbjConfig !== undefined,
    },
    depth: {
      effectiveBB: Math.min(heroCoverBB, deepestOpponentCoverBB),
      heroCoverBB,
      deepestOpponentCoverBB,
      maxStackBB:
        structure === 'fixed_limit'
          ? JOINT_LIVE_DOMAIN.fixedLimitMaxStackBB
          : JOINT_LIVE_DOMAIN.maxStackBB,
      basis: 'stack_plus_street_bet_vs_deepest_contesting_opponent',
    },
    boards: {
      street,
      count: boardCount,
      cardsPerBoard: ({ preflop: 0, flop: 3, turn: 4, river: 5 } as const)[street],
      cardValues: 'not_recorded',
    },
    ranges: {
      status: input.consumed ? 'consumed' : 'unavailable',
      acquisition: input.reused ? 'reused_phase7' : 'fresh',
      provenance: {
        requested: input.requestedSamples,
        completed: evidence?.samples.length ?? 0,
        sampleBudgetExhausted: evidence?.sampleBudgetExhausted ?? false,
        uniformEscapes: evidence?.uniformEscapes ?? 0,
        opponents: (evidence?.ranges ?? []).map((r) => ({
          seat: r.seat,
          folded: r.folded,
          live: r.live,
          allIn: r.allIn,
          raises: r.raises,
          calls: r.calls,
          checks: r.checks,
          prior: r.prior,
        })),
      },
    },
    objective: {
      kind: tournament ? 'tournament_phase7_utility' : 'cash_net_chips',
      asset,
    },
  } satisfies JointInputBinding);
}

/**
 * Worker-boundary shape check of a returned Phase 13 binding. It does not
 * recompute the proposal; the journal reviewer binds it to the original
 * request. Positions must be the controller order of the recorded button,
 * census and posted blind seats, and the betting geometry the one the
 * variant's structure defines.
 */
export function jointInputBindingIsValid(value: unknown): value is JointInputBinding {
  if (
    !exact(value, [
      'version',
      'variant',
      'mode',
      'packs',
      'approximation',
      'census',
      'positions',
      'geometry',
      'depth',
      'boards',
      'ranges',
      'objective',
    ]) ||
    value.version !== 'joint-input-binding-v1' ||
    !isJointVariant(value.variant) ||
    (value.mode !== 'cash' && value.mode !== 'tournament')
  )
    return false;
  const { packs, approximation, census, positions, geometry, depth, boards, ranges, objective } =
    value;
  const tournament = value.mode === 'tournament';
  if (
    !exact(packs, ['domain', 'range', 'action']) ||
    packs.domain !== JOINT_LIVE_DOMAIN.version ||
    packs.range !== JOINT_RANGE_PACK.version ||
    packs.action !== JOINT_ACTION_PACK.version ||
    !exact(approximation, [
      'status',
      'rangeSource',
      'rangeConfidence',
      'calibratedConfidence',
      'solverInput',
    ]) ||
    approximation.status !== 'explicit_joint_heuristic' ||
    approximation.rangeSource !== JOINT_RANGE_PACK.source ||
    approximation.rangeConfidence !== JOINT_RANGE_PACK.confidence ||
    approximation.calibratedConfidence !== null ||
    approximation.solverInput !== false ||
    !exact(objective, ['kind', 'asset']) ||
    objective.kind !== (tournament ? 'tournament_phase7_utility' : 'cash_net_chips') ||
    (objective.asset !== 'chips' && objective.asset !== 'diamonds') ||
    (objective.asset === 'diamonds' && (tournament || value.variant !== 'nlh'))
  )
    return false;
  if (
    !exact(census, [
      'dealerSeat',
      'heroSeat',
      'dealtSeats',
      'dealtPlayers',
      'liveOpponents',
      'contestingOpponentSeats',
      'foldedSeats',
      'awaySeats',
      'allInSeats',
      'foldedCount',
      'awayCount',
      'boardCount',
      'bombPot',
      'physicalCardsPerSample',
      'unknownDealtCardsPerSample',
    ]) ||
    !physicalSeat(census.dealerSeat) ||
    !seatList(census.dealtSeats) ||
    census.dealtSeats.length < 2 ||
    !census.dealtSeats.includes(census.heroSeat as number) ||
    census.dealtPlayers !== census.dealtSeats.length ||
    !(['contestingOpponentSeats', 'foldedSeats', 'awaySeats', 'allInSeats'] as const).every(
      (key) => seatList(census[key]) && subset(census[key], census.dealtSeats as number[])
    )
  )
    return false;
  const dealt = census.dealtSeats as number[];
  const contesting = census.contestingOpponentSeats as number[];
  const folded = census.foldedSeats as number[];
  if (
    census.liveOpponents !== contesting.length ||
    contesting.length < 1 ||
    contesting.includes(census.heroSeat as number) ||
    folded.includes(census.heroSeat as number) ||
    contesting.some((seat) => folded.includes(seat)) ||
    census.foldedCount !== folded.length ||
    census.awayCount !== (census.awaySeats as number[]).length ||
    ![1, 2, 3].includes(census.boardCount as number) ||
    typeof census.bombPot !== 'boolean' ||
    (census.physicalCardsPerSample === null) !== (census.unknownDealtCardsPerSample === null) ||
    (census.physicalCardsPerSample !== null &&
      (!count(census.physicalCardsPerSample, 52) || !count(census.unknownDealtCardsPerSample, 52)))
  )
    return false;
  if (
    !exact(positions, [
      'blindSeats',
      'actionOrder',
      'firstToActSeat',
      'heroOffset',
      'playersBehindSeats',
      'straddle',
    ]) ||
    !Array.isArray(positions.actionOrder) ||
    positions.actionOrder.length !== dealt.length ||
    [...(positions.actionOrder as number[])].sort((a, b) => a - b).join() !== dealt.join() ||
    positions.firstToActSeat !== (positions.actionOrder as number[])[0] ||
    positions.heroOffset !==
      plo4ButtonOffset(census.heroSeat as number, census.dealerSeat as number, dealt) ||
    !Array.isArray(positions.playersBehindSeats) ||
    !(positions.playersBehindSeats as unknown[]).every(
      (seat) => physicalSeat(seat) && contesting.includes(seat)
    ) ||
    new Set(positions.playersBehindSeats as number[]).size !==
      (positions.playersBehindSeats as number[]).length ||
    !['table_enabled_utg_2bb', 'none'].includes(positions.straddle as string) ||
    !(
      positions.blindSeats === null ||
      plo4BlindSeatsStatus(census.dealerSeat, dealt, positions.blindSeats, tournament) === 'valid'
    )
  )
    return false;
  // The action order runs clockwise from its first seat around the button's
  // ring; only the first seat (the street's opener) is free.
  const ring = [
    ...dealt.filter((s) => s > (census.dealerSeat as number)),
    ...dealt.filter((s) => s <= (census.dealerSeat as number)),
  ];
  const start = ring.indexOf(positions.firstToActSeat as number);
  if (
    (positions.actionOrder as number[]).some((seat, i) => ring[(start + i) % ring.length] !== seat)
  )
    return false;
  const structure = bettingStructureFor(value.variant);
  if (
    !exact(geometry, [
      'bettingStructure',
      'settlementUnit',
      'legalChipStep',
      'legalForm',
      'bigBlind',
      'pot',
      'currentBet',
      'heroBet',
      'heroStack',
      'callCost',
      'minRaiseTo',
      'maxRaiseTo',
      'stackRaiseTo',
      'noLimit',
      'potLimit',
      'fixedLimit',
      'rake',
      'bbj',
    ]) ||
    geometry.bettingStructure !== structure ||
    geometry.settlementUnit !== (tournament || objective.asset === 'diamonds' ? 1 : 0.01) ||
    ![
      geometry.bigBlind,
      geometry.pot,
      geometry.currentBet,
      geometry.heroBet,
      geometry.heroStack,
      geometry.callCost,
      geometry.stackRaiseTo,
    ].every(finite) ||
    !(geometry.bigBlind as number) ||
    !(geometry.heroStack as number) ||
    geometry.legalChipStep !== remainingVariantChipUnit(geometry.bigBlind as number) ||
    !['horse_legalizer', 'not_supplied'].includes(geometry.legalForm as string) ||
    ![geometry.minRaiseTo, geometry.maxRaiseTo].every(nullableFinite) ||
    (geometry.minRaiseTo === null) !== (geometry.maxRaiseTo === null) ||
    !near(
      geometry.callCost,
      Math.min(
        geometry.heroStack as number,
        Math.max(0, (geometry.currentBet as number) - (geometry.heroBet as number))
      )
    ) ||
    !near(geometry.stackRaiseTo, (geometry.heroBet as number) + (geometry.heroStack as number)) ||
    typeof geometry.bbj !== 'boolean' ||
    !exact(geometry.rake, [
      'percent',
      'cap',
      'noFlopNoDrop',
      'playerCountCaps',
      'timed',
      'dealtCount',
    ]) ||
    !finite(geometry.rake.percent) ||
    !finite(geometry.rake.cap) ||
    typeof geometry.rake.noFlopNoDrop !== 'boolean' ||
    typeof geometry.rake.timed !== 'boolean' ||
    geometry.rake.dealtCount !== dealt.length ||
    !(
      geometry.rake.playerCountCaps === null ||
      (Array.isArray(geometry.rake.playerCountCaps) &&
        geometry.rake.playerCountCaps.length >= 1 &&
        geometry.rake.playerCountCaps.length <= 16 &&
        geometry.rake.playerCountCaps.every(
          (tier) =>
            exact(tier, ['players', 'cap']) &&
            Number.isSafeInteger(tier.players) &&
            finite(tier.cap)
        ))
    )
  )
    return false;
  const wagerCap =
    geometry.maxRaiseTo === null
      ? null
      : Math.min(geometry.maxRaiseTo as number, geometry.stackRaiseTo as number);
  const capIsValid = (block: unknown) =>
    exact(block, ['wagerCap']) &&
    (wagerCap === null ? block.wagerCap === null : near(block.wagerCap, wagerCap));
  if (
    structure === 'no_limit'
      ? !capIsValid(geometry.noLimit) || geometry.potLimit !== null || geometry.fixedLimit !== null
      : structure === 'pot_limit'
        ? !capIsValid(geometry.potLimit) ||
          geometry.noLimit !== null ||
          geometry.fixedLimit !== null
        : geometry.noLimit !== null ||
          geometry.potLimit !== null ||
          !exact(geometry.fixedLimit, ['fixedBetSize', 'wagersCapped']) ||
          !nullableFinite(geometry.fixedLimit.fixedBetSize) ||
          typeof geometry.fixedLimit.wagersCapped !== 'boolean'
  )
    return false;
  const maxStackBB =
    structure === 'fixed_limit'
      ? JOINT_LIVE_DOMAIN.fixedLimitMaxStackBB
      : JOINT_LIVE_DOMAIN.maxStackBB;
  if (
    !exact(depth, [
      'effectiveBB',
      'heroCoverBB',
      'deepestOpponentCoverBB',
      'maxStackBB',
      'basis',
    ]) ||
    ![depth.effectiveBB, depth.heroCoverBB, depth.deepestOpponentCoverBB].every(finite) ||
    depth.maxStackBB !== maxStackBB ||
    (depth.effectiveBB as number) > maxStackBB ||
    !near(
      depth.effectiveBB,
      Math.min(depth.heroCoverBB as number, depth.deepestOpponentCoverBB as number)
    ) ||
    !near(depth.heroCoverBB, (geometry.stackRaiseTo as number) / (geometry.bigBlind as number)) ||
    depth.basis !== 'stack_plus_street_bet_vs_deepest_contesting_opponent'
  )
    return false;
  if (
    !exact(boards, ['street', 'count', 'cardsPerBoard', 'cardValues']) ||
    !['preflop', 'flop', 'turn', 'river'].includes(boards.street as string) ||
    boards.count !== census.boardCount ||
    boards.cardsPerBoard !==
      ({ preflop: 0, flop: 3, turn: 4, river: 5 } as Record<string, number>)[
        boards.street as string
      ] ||
    boards.cardValues !== 'not_recorded' ||
    // A bomb or multi-board hand has no preflop decision.
    (boards.street === 'preflop' && (census.bombPot || census.boardCount !== 1)) ||
    (boards.street !== 'preflop' && positions.blindSeats !== null) ||
    (value.variant === 'pineapple' && tournament)
  )
    return false;
  if (
    !exact(ranges, ['status', 'acquisition', 'provenance']) ||
    !RANGE_STATUSES.includes(ranges.status as JointRangeStatus) ||
    !['fresh', 'reused_phase7'].includes(ranges.acquisition as string) ||
    !exact(ranges.provenance, [
      'requested',
      'completed',
      'sampleBudgetExhausted',
      'uniformEscapes',
      'opponents',
    ])
  )
    return false;
  const p = ranges.provenance;
  if (
    !count(p.requested, JOINT_RANGE_PACK.maxSamples) ||
    !count(p.completed, p.requested as number) ||
    typeof p.sampleBudgetExhausted !== 'boolean' ||
    // A sample cut by the budget may have counted escapes before it stopped.
    !count(p.uniformEscapes, ((p.completed as number) + 1) * dealt.length) ||
    !Array.isArray(p.opponents) ||
    (census.physicalCardsPerSample === null) !== (p.completed === 0) ||
    (ranges.status === 'consumed' &&
      ((p.completed as number) < JOINT_LIVE_DOMAIN.minSamples ||
        p.opponents.length !== dealt.length - 1))
  )
    return false;
  const seen = new Set<number>();
  for (const row of p.opponents as unknown[]) {
    if (
      !exact(row, ['seat', 'folded', 'live', 'allIn', 'raises', 'calls', 'checks', 'prior']) ||
      !physicalSeat(row.seat) ||
      !dealt.includes(row.seat) ||
      row.seat === census.heroSeat ||
      seen.has(row.seat) ||
      ![row.folded, row.live, row.allIn].every((flag) => typeof flag === 'boolean') ||
      (row.live && !contesting.includes(row.seat)) ||
      row.folded !== folded.includes(row.seat) ||
      !count(row.raises, JOINT_LIVE_DOMAIN.maxActions) ||
      !count(row.calls, JOINT_LIVE_DOMAIN.maxActions) ||
      !count(row.checks, JOINT_LIVE_DOMAIN.maxActions) ||
      !['uniform_bomb_deal', 'structural_variant_prior'].includes(row.prior as string)
    )
      return false;
    seen.add(row.seat);
  }
  return true;
}

/** Canonical private commitment carried by the execution witness. */
export function jointInputBindingSha256(binding: JointInputBinding): string {
  return horseCanonicalMaterialSha256(binding);
}
