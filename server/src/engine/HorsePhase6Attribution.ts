/** Private observational Phase6 receipt. No policy call, I/O, RNG or clock read.
 * Captures the lookup actually performed; does not certify causal influence. */
import type { HorseDecision, SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import {
  TOURNAMENT_POSITIONS,
  TOURNAMENT_PREFLOP_BRANCHES,
  interpolateTournamentDepth,
  tournamentPositionsForTable,
  tournamentPositionForSeat,
  classifyTournamentPreflopBranch,
  tournamentMZone,
  type TournamentPreflopPolicy,
  type TournamentPreflopPolicyInput,
} from './HorseTournamentPreflop.js';
import { horsePolicyDealtPlayers } from './multiway/DealtSeatCensus.js';
import { holeCardCount, isOmahaVariant, isShortDeckVariant } from './VariantRules.js';
import { isFixedLimitVariant } from './BettingStructure.js';

export type Phase6ReferenceRoute =
  | 'legacy_preflop'
  | 'chart_open_jam'
  | 'chart_bb_defend'
  | 'variant_price'
  | 'intent_engine';
export interface Phase6LookupObservation {
  coordinate: Omit<TournamentPreflopPolicyInput, 'm'> & { mVelocityMPerMinute: number };
  policy: TournamentPreflopPolicy;
}
export interface HorsePhase6Attribution {
  version: 'horse-phase6-attribution-v1';
  status: 'bypassed' | 'unavailable' | 'atlas_evaluated';
  route: Phase6ReferenceRoute;
  reason:
    | 'legacy_preflop_owner'
    | 'outside_tournament'
    | 'tournament_schema_unavailable'
    | 'm_unavailable'
    | 'lookup_unavailable'
    | 'chart_return'
    | 'variant_price_return'
    | 'atlas_forwarded'
    | 'unsupported_variant'
    | 'incomplete_context'
    | 'invalid_coordinate';
  inputSource: {
    basis: 'provided_decision_snapshot';
    stateSchemaVersion: number | null;
    tournamentSchemaVersion: number | null;
    tournamentMode: boolean;
  };
  atlasEvaluated: boolean;
  forwardedToIntentEngine: boolean;
  lookup: Phase6LookupObservation | null;
  referenceProposal: { action: HorseDecision['action']; amount: number | null };
  causalInfluence: 'not_established';
  gtoOptimality: 'not_established';
}
type Phase6Snapshot = {
  gameState: HorseGameStateV2;
  player: SeatPlayer;
  opts?: {
    v7?: boolean;
    v7Preflop?: boolean;
    v13?: boolean;
    v18Squeeze?: boolean;
    v18Straddle?: boolean;
    v27GtoCharts?: boolean;
    v38Ev?: boolean;
  };
};
export interface Phase6ReferenceObservation {
  route: Phase6ReferenceRoute;
  lookup: Phase6LookupObservation | null;
}
const routes = [
  'legacy_preflop',
  'chart_open_jam',
  'chart_bb_defend',
  'variant_price',
  'intent_engine',
];
const actions = ['fold', 'check', 'call', 'bet', 'raise', 'all_in'];
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  obj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const schema = (v: unknown) => v === null || (Number.isSafeInteger(v) && Number(v) >= 0);
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

/** The worker transport removes Object.freeze. Own and freeze the receipt again
 * before an executor witness can outlive the returned decision object. */
export function copyPhase6Attribution(value: HorsePhase6Attribution): HorsePhase6Attribution {
  return freeze(structuredClone(value));
}

/** Own only the finite public coordinate and already-computed policy fields.
 * M covering-opponent arrays and private cards are deliberately not copied. */
export function observePhase6Lookup(
  input: TournamentPreflopPolicyInput,
  policy: TournamentPreflopPolicy
): Phase6LookupObservation {
  return freeze({
    coordinate: {
      gameFamily: input.gameFamily,
      contextStatus: input.contextStatus,
      tableSize: input.tableSize,
      heroPosition: input.heroPosition,
      raiserPosition: input.raiserPosition,
      anteType: input.anteType,
      branch: input.branch,
      stackBB: input.stackBB,
      mVelocityMPerMinute: input.m?.velocityMPerMinute ?? 0,
    },
    policy: {
      schemaVersion: policy.schemaVersion,
      cell: policy.cell,
      source: policy.source,
      fallbackReason: policy.fallbackReason,
      branch: policy.branch,
      depth: { ...policy.depth },
      shifts: { ...policy.shifts },
    },
  });
}
function expectedStatus(
  route: Phase6ReferenceRoute,
  lookup: Phase6LookupObservation | null
): HorsePhase6Attribution['status'] {
  if (route !== 'intent_engine') return 'bypassed';
  return lookup?.policy.source === 'deterministic_baseline' ? 'atlas_evaluated' : 'unavailable';
}
function expectedReason(
  r: Pick<HorsePhase6Attribution, 'route' | 'lookup' | 'inputSource'>,
  mPresent?: boolean
): HorsePhase6Attribution['reason'] {
  if (r.route === 'legacy_preflop') return 'legacy_preflop_owner';
  if (r.route === 'chart_open_jam' || r.route === 'chart_bb_defend') return 'chart_return';
  if (r.route === 'variant_price') return 'variant_price_return';
  if (!r.inputSource.tournamentMode) return 'outside_tournament';
  if (r.inputSource.tournamentSchemaVersion !== 1) return 'tournament_schema_unavailable';
  if (!r.lookup) return mPresent === false ? 'm_unavailable' : 'lookup_unavailable';
  return r.lookup.policy.fallbackReason ?? 'atlas_forwarded';
}
export function createPhase6Attribution(
  observation: Phase6ReferenceObservation,
  gs: HorseGameStateV2,
  tournamentMode: boolean,
  reference: HorseDecision
): HorsePhase6Attribution | undefined {
  // Diagnostics cannot turn a successful reference decision into an exception.
  try {
    const receipt: HorsePhase6Attribution = {
      version: 'horse-phase6-attribution-v1',
      status: expectedStatus(observation.route, observation.lookup),
      route: observation.route,
      reason: 'lookup_unavailable',
      inputSource: {
        basis: 'provided_decision_snapshot',
        stateSchemaVersion: gs.stateSchemaVersion ?? null,
        tournamentSchemaVersion: gs.tournament?.schemaVersion ?? null,
        tournamentMode,
      },
      atlasEvaluated: observation.lookup !== null,
      forwardedToIntentEngine: observation.route === 'intent_engine' && observation.lookup !== null,
      lookup: observation.lookup,
      referenceProposal: { action: reference.action, amount: reference.amount ?? null },
      causalInfluence: 'not_established',
      gtoOptimality: 'not_established',
    };
    receipt.reason = expectedReason(receipt, !!gs.tournament?.m);
    return horsePhase6AttributionIsValid(receipt) ? freeze(receipt) : undefined;
  } catch {
    return undefined;
  }
}
export function horsePhase6AttributionIsValid(value: unknown): value is HorsePhase6Attribution {
  try {
    if (
      !exact(value, [
        'version',
        'status',
        'route',
        'reason',
        'inputSource',
        'atlasEvaluated',
        'forwardedToIntentEngine',
        'lookup',
        'referenceProposal',
        'causalInfluence',
        'gtoOptimality',
      ]) ||
      value.version !== 'horse-phase6-attribution-v1' ||
      !routes.includes(value.route as string) ||
      value.causalInfluence !== 'not_established' ||
      value.gtoOptimality !== 'not_established' ||
      !exact(value.inputSource, [
        'basis',
        'stateSchemaVersion',
        'tournamentSchemaVersion',
        'tournamentMode',
      ]) ||
      value.inputSource.basis !== 'provided_decision_snapshot' ||
      !schema(value.inputSource.stateSchemaVersion) ||
      !schema(value.inputSource.tournamentSchemaVersion) ||
      typeof value.inputSource.tournamentMode !== 'boolean' ||
      !exact(value.referenceProposal, ['action', 'amount']) ||
      !actions.includes(value.referenceProposal.action as string) ||
      !(
        value.referenceProposal.amount === null ||
        (finite(value.referenceProposal.amount) && value.referenceProposal.amount >= 0)
      )
    )
      return false;
    const r = value as unknown as HorsePhase6Attribution;
    if (
      r.atlasEvaluated !== (r.lookup !== null) ||
      r.forwardedToIntentEngine !== (r.route === 'intent_engine' && r.lookup !== null) ||
      r.status !== expectedStatus(r.route, r.lookup)
    )
      return false;
    if (r.lookup !== null) {
      if (!exact(r.lookup, ['coordinate', 'policy'])) return false;
      const c = r.lookup.coordinate,
        p = r.lookup.policy;
      if (
        !exact(c, [
          'gameFamily',
          'contextStatus',
          'tableSize',
          'heroPosition',
          'raiserPosition',
          'anteType',
          'branch',
          'stackBB',
          'mVelocityMPerMinute',
        ]) ||
        !['nlh', 'omaha', 'other'].includes(c.gameFamily) ||
        !['complete', 'incomplete', 'warming', 'stale'].includes(c.contextStatus) ||
        !finite(c.tableSize) ||
        !finite(c.stackBB) ||
        c.stackBB < 0 ||
        !finite(c.mVelocityMPerMinute) ||
        !TOURNAMENT_POSITIONS.includes(c.heroPosition) ||
        !(c.raiserPosition === null || TOURNAMENT_POSITIONS.includes(c.raiserPosition)) ||
        !['none', 'per_player', 'big_blind'].includes(c.anteType) ||
        !TOURNAMENT_PREFLOP_BRANCHES.includes(c.branch) ||
        !exact(p, [
          'schemaVersion',
          'cell',
          'source',
          'fallbackReason',
          'branch',
          'depth',
          'shifts',
        ]) ||
        p.schemaVersion !== 1 ||
        typeof p.cell !== 'string' ||
        p.cell.length > 512 ||
        p.branch !== c.branch ||
        !['deterministic_baseline', 'labeled_fallback'].includes(p.source) ||
        ![null, 'unsupported_variant', 'incomplete_context', 'invalid_coordinate'].includes(
          p.fallbackReason
        ) ||
        (p.source === 'deterministic_baseline') !== (p.fallbackReason === null) ||
        !exact(p.depth, ['lower', 'upper', 'weight']) ||
        !exact(p.shifts, ['open', 'jam', 'call', 'threeBet', 'fourBet']) ||
        Object.values(p.shifts).some((x) => !finite(x) || Math.abs(x) > 1)
      )
        return false;
      const positions = tournamentPositionsForTable(c.tableSize);
      const validCoordinate =
        Number.isSafeInteger(c.tableSize) &&
        c.tableSize >= 2 &&
        c.tableSize <= 10 &&
        positions.includes(c.heroPosition) &&
        (c.raiserPosition === null ||
          (c.raiserPosition !== c.heroPosition && positions.includes(c.raiserPosition)));
      const expectedFallback = !validCoordinate
        ? 'invalid_coordinate'
        : c.gameFamily !== 'nlh'
          ? 'unsupported_variant'
          : c.contextStatus !== 'complete'
            ? 'incomplete_context'
            : null;
      if (p.fallbackReason !== expectedFallback) return false;
      const depth = interpolateTournamentDepth(c.stackBB);
      if (
        p.depth.lower !== depth.lower ||
        p.depth.upper !== depth.upper ||
        p.depth.weight !== depth.weight ||
        (p.source === 'labeled_fallback' && Object.values(p.shifts).some((x) => x !== 0))
      )
        return false;
      // Cell is the exact source format, not a parsed string used as authority.
      const velocity =
        Math.round(Math.max(0, Math.min(1, c.mVelocityMPerMinute / 2)) * 1000) / 1000;
      const cell = [
        'phase6-v1',
        c.gameFamily,
        p.source,
        p.fallbackReason === 'invalid_coordinate' ? `invalid-${String(c.tableSize)}` : c.tableSize,
        c.heroPosition,
        c.raiserPosition ?? 'NONE',
        c.anteType,
        c.branch,
        `${depth.lower}-${depth.upper}@${depth.weight}`,
        `velocity=${velocity}`,
      ].join(':');
      if (
        p.cell !== cell ||
        !r.inputSource.tournamentMode ||
        r.inputSource.tournamentSchemaVersion !== 1 ||
        r.route === 'legacy_preflop'
      )
        return false;
    }
    const reason = expectedReason(r);
    return r.reason === reason || (reason === 'lookup_unavailable' && r.reason === 'm_unavailable');
  } catch {
    return false;
  }
}
/** Exactly the four variant facts used by the source preflop route. Importing
 * the pure rule modules avoids HorseEval's RNG/governor initialization closure. */
function sourceVariantFacts(s: HorseGameStateV2) {
  const v = (s.gameVariant || 'nlh').toLowerCase(),
    rules = s.variantRules;
  return {
    omaha: rules
      ? rules.holeCardsUse === 'exactly_two' && rules.boardCardsUse === 'exactly_three'
      : isOmahaVariant(v),
    short: rules ? rules.deckSize === 36 : isShortDeckVariant(v),
    holes: rules ? rules.holeCardsDealt : holeCardCount(v),
    fixed:
      rules && s.bettingStructure !== undefined
        ? s.bettingStructure === 'fixed_limit'
        : isFixedLimitVariant(v),
  };
}
/** Source classifier's public-census path. Null is a legacy cash ring whose
 * old classifier may depend on private card presence; do not read or infer it.
 * This duplicates routing, not strategy thresholds or atlas shift arithmetic. */
function publicReferencePosition(heroSeat: number, snapshot: Phase6Snapshot) {
  const s = snapshot.gameState,
    v13 = snapshot.opts?.v13 !== false;
  const hasCensus = s.dealtSeatIds !== undefined;
  const allPlayersDealt = hasCensus || s.tournament?.schemaVersion === 1;
  if (v13 && !allPlayersDealt) return null;
  const players = hasCensus
    ? horsePolicyDealtPlayers(s.players, heroSeat, s.dealtSeatIds)
    : s.players;
  const inHand = players
    .filter((p) => v13 || !p.is_folded || p.seat === heroSeat)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  if (s.dealerSeat === undefined || inHand.length < 2) return 'middle';
  const order: number[] = [];
  let cursor = s.dealerSeat;
  for (let i = 0; i < inHand.length; i++) {
    const next = inHand.find((seat) => seat > cursor) ?? inHand[0];
    order.push(next);
    cursor = next;
    if (order.length > 1 && next === order[0]) break;
  }
  const index = order.indexOf(heroSeat),
    n = order.length;
  if (index === -1) return 'middle';
  if (n === 2) return heroSeat === s.dealerSeat ? 'sb' : 'bb';
  if (index === 0) return 'sb';
  if (index === 1) return 'bb';
  const nonBlind = n - 2,
    position = index - 2;
  if (position >= nonBlind - 2) return 'late';
  return position < Math.max(1, Math.ceil((nonBlind - 2) / 2)) ? 'early' : 'middle';
}
/** Necessary source-input gates only. Chart hydration, adherence/mixed draws
 * and successful equity work remain worker observations, never replayed here. */
function necessaryReferenceRouteGates(
  route: Phase6ReferenceRoute,
  snapshot: Phase6Snapshot
): boolean {
  if (route === 'legacy_preflop' || route === 'intent_engine') return true;
  const s = snapshot.gameState,
    p = snapshot.player,
    o = snapshot.opts ?? {};
  const { omaha, short, holes, fixed } = sourceVariantFacts(s);
  const bb = s.bigBlind > 0 ? s.bigBlind : 2,
    toCall = Math.max(0, s.currentBet - p.bet);
  const history = (s.actionHistory || []).filter((a) => a.stage === 'preflop');
  let raises = 0,
    limpers = 0,
    callers = 0,
    last = -1;
  for (const a of history) {
    if (
      a.action === 'raise' ||
      a.action === 'bet' ||
      (a.action === 'all_in' && a.isFullRaise !== undefined)
    ) {
      raises++;
      callers = 0;
      last = a.seat;
    } else if (a.action === 'call' || a.action === 'all_in') {
      if (raises === 0) limpers++;
      else callers++;
    }
  }
  const straddle =
    (o.v18Straddle ?? true) !== false &&
    s.straddleActive === true &&
    raises === 0 &&
    s.currentBet > bb * 1.05 &&
    s.currentBet <= bb * 2.2;
  if (!straddle && history.length === 0 && s.currentBet > bb * 1.05)
    raises = s.currentBet > bb * 4.5 ? 2 : 1;
  if (route === 'variant_price') {
    if (
      (o.v38Ev ?? true) === false ||
      toCall <= 0 ||
      !(omaha || short || holes !== 2 || fixed) ||
      last < 0 ||
      s.allInOrFold === true
    )
      return false;
    const raiser = s.players.find((x) => x.seat === last),
      call = Math.min(toCall, p.stack);
    if (!raiser || !(raiser.is_all_in === true || call >= p.stack * 0.4)) return false;
    const committed = s.players.filter(
      (x) =>
        !x.is_folded &&
        (!x.is_sitting_out || x.is_all_in) &&
        x.seat !== p.seat &&
        (x.is_all_in || (Number.isFinite(x.bet) && x.bet >= s.currentBet - 0.005))
    );
    const perOpponent = omaha ? holes : p.cards.length;
    return (
      committed.length > 0 &&
      perOpponent >= 2 &&
      committed.length * perOpponent <=
        (short ? 36 : 52) - p.cards.length - (p.knownDeadCards?.length ?? 0) - 5
    );
  }
  if (
    (o.v27GtoCharts ?? true) === false ||
    p.cards.length !== 2 ||
    omaha ||
    short ||
    fixed ||
    s.straddleActive === true
  )
    return false;
  const position = publicReferencePosition(p.seat, snapshot),
    depth = (p.stack + p.bet) / bb;
  if (route === 'chart_open_jam')
    return (
      raises === 0 &&
      limpers === 0 &&
      callers === 0 &&
      !history.some((a) => a.action === 'all_in') &&
      position !== 'bb' &&
      toCall <= bb &&
      depth > 0 &&
      depth <= 15
    );
  const raiserPosition = last >= 0 ? publicReferencePosition(last, snapshot) : null;
  const opponents = s.players.filter(
    (x) =>
      !x.is_folded && x.seat !== p.seat && (o.v13 === false || !x.is_sitting_out || x.is_all_in)
  ).length;
  const effective = Math.min(depth, s.currentBet / bb);
  return (
    (position === null || position === 'bb') &&
    raises === 1 &&
    (raiserPosition === null || raiserPosition === 'sb') &&
    opponents === 1 &&
    history.some((a) => a.seat === last && a.action === 'all_in') &&
    toCall > 0 &&
    effective > 0 &&
    effective <= 25
  );
}
/** Check only literal returns of the named source route; no equity or draw
 * is repeated. These are raw reference proposals, before legalizer/controller. */
function referenceReturnShape(r: HorsePhase6Attribution, snapshot: Phase6Snapshot): boolean {
  if (r.route === 'intent_engine' || r.route === 'legacy_preflop') return true;
  const s = snapshot.gameState,
    p = snapshot.player,
    { action, amount } = r.referenceProposal;
  const toCall = Math.max(0, s.currentBet - p.bet),
    call = Math.min(toCall, p.stack);
  if (r.route === 'chart_open_jam')
    return (
      amount === null &&
      (action === 'all_in' ||
        (action === 'check' && toCall <= 0) ||
        (action === 'fold' && toCall > 0))
    );
  if (action === 'fold') return amount === null;
  if (action === 'call') return amount === call;
  if (r.route === 'chart_bb_defend') return false;
  const last = (s.actionHistory || [])
    .filter(
      (a) =>
        a.stage === 'preflop' &&
        (a.action === 'raise' ||
          a.action === 'bet' ||
          (a.action === 'all_in' && a.isFullRaise !== undefined))
    )
    .at(-1)?.seat;
  return (
    action === 'all_in' &&
    amount === null &&
    p.stack > call * 1.5 &&
    s.players.some(
      (x) =>
        !x.is_folded &&
        !x.is_sitting_out &&
        !x.is_all_in &&
        x.stack > 0 &&
        x.seat !== p.seat &&
        x.seat !== last
    )
  );
}
/** Structural/source-input binding only. This does not rerun a mixed strategy
 * or certify each shift's economic correctness or final causal influence. */
export function horsePhase6AttributionMatchesSnapshot(
  decision: HorseDecision,
  snapshot: Phase6Snapshot
): boolean {
  try {
    const r = decision.tournamentPreflopAttribution;
    if (r === undefined) return true; // legacy/missing evidence remains absent
    if (!horsePhase6AttributionIsValid(r) || decision.policyFallback !== undefined) return false;
    const usesIntentReference = snapshot.opts?.v7Preflop ?? snapshot.opts?.v7 !== false;
    if ((r.route === 'legacy_preflop') === usesIntentReference) return false;
    const s = snapshot.gameState;
    if (!necessaryReferenceRouteGates(r.route, snapshot) || !referenceReturnShape(r, snapshot))
      return false;
    if (
      s.stage !== 'preflop' ||
      r.inputSource.stateSchemaVersion !== (s.stateSchemaVersion ?? null) ||
      r.inputSource.tournamentSchemaVersion !== (s.tournament?.schemaVersion ?? null) ||
      r.inputSource.tournamentMode !==
        (s.gameMode ? s.gameMode === 'tournament' : s.tournament != null || (s.bigBlind ?? 0) >= 10)
    )
      return false;
    if (
      r.lookup &&
      (r.lookup.coordinate.contextStatus !== (s.tournament?.contextStatus ?? 'incomplete') ||
        r.lookup.coordinate.mVelocityMPerMinute !== (s.tournament?.m?.velocityMPerMinute ?? 0))
    )
      return false;
    if (!r.lookup && r.reason === 'm_unavailable' && !!s.tournament?.m) return false;
    if (r.lookup) {
      if (!s.tournament?.m) return false;
      const hero = snapshot.player,
        options = snapshot.opts ?? {},
        c = r.lookup.coordinate;
      const bb = s.bigBlind > 0 ? s.bigBlind : 2;
      const seats =
        s.dealtSeatIds === undefined
          ? s.players.map((p) => p.seat)
          : horsePolicyDealtPlayers(s.players, hero.seat, s.dealtSeatIds).map((p) => p.seat);
      const history = (s.actionHistory ?? []).filter((a) => a.stage === 'preflop');
      let raises = 0,
        limpers = 0,
        callers = 0,
        priorCallers = 0,
        last = -1,
        first = -1;
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
        (options.v18Straddle ?? true) !== false &&
        s.straddleActive === true &&
        raises === 0 &&
        s.currentBet > bb * 1.05 &&
        s.currentBet <= bb * 2.2;
      if (!straddle && history.length === 0 && s.currentBet > bb * 1.05)
        raises = s.currentBet > bb * 4.5 ? 2 : 1;
      const heroPosition = tournamentPositionForSeat(hero.seat, s.dealerSeat, seats);
      const raiserPosition =
        last >= 0 ? tournamentPositionForSeat(last, s.dealerSeat, seats) : null;
      const opponent =
        last >= 0
          ? s.players.find(
              (p) => p.seat === last && !p.is_folded && (!p.is_sitting_out || p.is_all_in)
            )
          : undefined;
      const heroDepth = Math.max(0, hero.stack + hero.bet);
      const depth = opponent
        ? Math.min(heroDepth, Math.max(0, opponent.stack + opponent.bet)) / bb
        : heroDepth / bb;
      const m = s.tournament.m,
        imminent =
          typeof s.tournament.nextBlindInMin === 'number' &&
          s.tournament.nextBlindInMin <= 3 &&
          (s.tournament.nextBlindMult ?? 1) > 1.15;
      const priorActed = history.some(
        (a) => a.seat === hero.seat && a.action !== 'fold' && a.action !== 'check'
      );
      const voluntaryAllIn = new Set(
        history.filter((a) => a.action === 'all_in').map((a) => a.seat)
      );
      const branch = classifyTournamentPreflopBranch({
        raises,
        limpers,
        callers,
        callersOfPreviousRaise: priorCallers,
        opponentsAllIn: s.players.filter(
          (p) => p.seat !== hero.seat && !p.is_folded && p.is_all_in && voluntaryAllIn.has(p.seat)
        ).length,
        opponentsLeft: s.players.filter(
          (p) =>
            !p.is_folded &&
            p.seat !== hero.seat &&
            (options.v13 === false || !p.is_sitting_out || p.is_all_in)
        ).length,
        stackBB: hero.stack / bb,
        mZone: imminent
          ? tournamentMZone(Math.min(m.effectiveM, m.projectedEffectiveM), m.zone)
          : m.zone,
        heroPosition,
        raiserPosition,
        heroPreviouslyActed: priorActed,
        heroWasInitialRaiser: first === hero.seat,
        squeezed:
          (options.v18Squeeze ?? true) !== false &&
          raises === 2 &&
          priorCallers >= 1 &&
          first === hero.seat,
      });
      const { omaha, short, holes, fixed } = sourceVariantFacts(s);
      const family = omaha ? 'omaha' : !short && holes === 2 && !fixed ? 'nlh' : 'other';
      if (
        c.tableSize !== (s.tournament.playersAtTable ?? seats.length) ||
        c.heroPosition !== heroPosition ||
        c.raiserPosition !== raiserPosition ||
        c.stackBB !== depth ||
        c.branch !== branch ||
        c.gameFamily !== family ||
        c.anteType !==
          (s.tournament.anteType ??
            (s.bigBlindAnte === true ? 'big_blind' : (s.ante ?? 0) > 0 ? 'per_player' : 'none'))
      )
        return false;
    }
    // New producer receipts are attached immediately before graph.finish. A
    // missing reference graph is not a legacy receipt when attribution exists.
    const graph = decision.policyGraph,
      first = graph?.transitions?.[0];
    if (
      graph?.version !== 'horse-policy-order-v1' ||
      !Array.isArray(graph.transitions) ||
      !exact(first, ['node', 'before', 'after', 'changed', 'elapsedMs']) ||
      first.node !== 'reference' ||
      first.before !== null ||
      first.changed !== false ||
      !finite(first.elapsedMs) ||
      first.elapsedMs < 0 ||
      !exact(first.after, ['action', 'amount'])
    )
      return false;
    return (
      first.after.action === r.referenceProposal.action &&
      first.after.amount === r.referenceProposal.amount
    );
  } catch {
    return false;
  }
}
