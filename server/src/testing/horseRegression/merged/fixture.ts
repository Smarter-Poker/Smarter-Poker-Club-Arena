/** Synthetic inputs, not controller-produced betting-history evidence. */
import type { HorseDecideOpts, HorseGameStateV2 } from '../../../engine/HorseLogic.js';
import type { SeatPlayer, GameVariant } from '../../../types.js';
import { horseVariantRulesFor } from '../../../engine/VariantRules.js';
import { bettingStructureFor } from '../../../engine/BettingStructure.js';
import { buildTournamentMState } from '../../../engine/HorseTournamentPreflop.js';
import { calculatePots, calculateContestablePot } from '../../../engine/PokerEngine.js';
import {
  buildHorseDecisionKey,
  type LiveHorseDecisionSnapshot,
} from '../../../engine/horseDecision/protocol.js';
import { captureHorseHandJournalContext } from '../../../engine/HorseDecisionHandBinding.js';
export const TABLE = '10000000-0000-4000-8000-000000000001';
export const HAND = '30000000-0000-4000-8000-000000000001';
export const options: HorseDecideOpts = {
  mind: false,
  observeMind: false,
  telemetry: true,
  decisionTimeMs: 1000,
  v27GtoCharts: false,
  phase7Utility: false,
  phase8Postflop: 'off',
  phase10Plo4: 'off',
  phase11Omaha: 'off',
  phase12Remaining: 'off',
  phase13Joint: 'off',
};
export function fixture(depth = 7, seats = 3, variant: GameVariant = 'nlh') {
  const cards = [
    { rank: 'A', suit: 'spades' },
    { rank: 'K', suit: 'spades' },
    { rank: 'Q', suit: 'hearts' },
    { rank: 'J', suit: 'hearts' },
    { rank: 'T', suit: 'clubs' },
    { rank: '9', suit: 'clubs' },
  ] as SeatPlayer['cards'];
  const players: SeatPlayer[] = Array.from({ length: seats }, (_, index) => {
    const seat = index + 1;
    const bet = seat === seats ? 100 : seat === seats - 1 ? 50 : 0;
    return {
      seat,
      user_id: `20000000-0000-4000-8000-${String(seat).padStart(12, '0')}`,
      username: `synthetic-${seat}`,
      stack: depth * 100 - bet,
      bet,
      totalInvested: bet,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    };
  });
  const hero = {
    ...players[0],
    cards: cards.slice(0, horseVariantRulesFor(variant).holeCardsDealt),
  };
  const state: HorseGameStateV2 = {
    stateSchemaVersion: 1,
    players,
    dealtSeatIds: players.map((p) => p.seat),
    heroSeat: hero.seat,
    currentPlayerSeat: hero.seat,
    communityCards: [],
    communityCards2: [],
    communityCards3: [],
    boardCount: 1,
    stage: 'preflop',
    gameVariant: variant,
    gameMode: 'tournament',
    format: 'mtt',
    bigBlind: 100,
    ante: 0,
    bigBlindAnte: false,
    dealerSeat: 1,
    actionHistory: [],
    currentBet: 100,
    minRaise: 100,
    pot: 150,
    toCall: Math.max(0, 100 - hero.bet),
    legalActions: ['fold', 'call', 'raise', 'all_in'],
    minRaiseTo: 200,
    maxRaiseTo: depth * 100,
    bettingStructure: bettingStructureFor(variant),
    fixedBetSize: null,
    wagersCapped: false,
    commitmentCapRemaining: null,
    variantRules: horseVariantRulesFor(variant),
    asset: 'chips',
    chipUnit: 1,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    bbjConfig: null,
    tournament: {
      schemaVersion: 1,
      contextStatus: 'complete',
      contextIssues: [],
      playersAtTable: seats,
      playersLeft: seats + 20,
      spotsPaid: 3,
      avgStackChips: depth * 100,
      currentSmallBlind: 50,
      currentBigBlind: 100,
      currentAnte: 0,
      anteType: 'none',
      nextSmallBlind: 75,
      nextBigBlind: 150,
      nextAnte: 0,
      nextBlindInMin: 5,
      nextBlindMult: 1.5,
      m: buildTournamentMState({
        stackChips: hero.stack,
        smallBlind: 50,
        bigBlind: 100,
        ante: 0,
        anteType: 'none',
        playersAtTable: seats,
        nextSmallBlind: 75,
        nextBigBlind: 150,
        nextAnte: 0,
        minutesToNextLevel: 5,
      }),
      stacks: players.map((p) => p.stack + p.bet),
      stackByUser: Object.fromEntries(players.map((p) => [p.user_id, p.stack + p.bet])),
      payoutPct: [50, 30, 20],
      satellite: false,
    },
  } as HorseGameStateV2;
  if (state.bettingStructure === 'fixed_limit') {
    state.fixedBetSize = 100;
    state.minRaiseTo = 200;
    state.maxRaiseTo = 200;
    state.legalActions = ['fold', 'call', 'raise'];
  } else if (state.bettingStructure === 'pot_limit') {
    state.maxRaiseTo = Math.min(depth * 100, state.pot + 2 * state.toCall! + hero.bet);
    state.legalActions = ['fold', 'call', 'raise'];
  }
  state.pots = calculatePots(players);
  state.contestablePot = calculateContestablePot(players, hero.user_id, state.toCall!);
  return { hero, state, opts: { ...options } };
}
export function request(f = fixture()) {
  const actionHistory = f.state.actionHistory;
  if (!Array.isArray(actionHistory)) {
    throw new Error('The request fixture requires an explicit action-history array');
  }
  const {
    telemetry,
    observeMind,
    decisionTimeMs,
    deepEquity,
    gtoV31DatasetChecksum,
    onGtoV31Decision,
    ...liveOpts
  } = f.opts;
  const value = {
    type: 'DECIDE_FAST' as const,
    requestId: 1,
    generation: 7,
    fence: `${TABLE}:12:${f.hero.seat}:9:7`,
    decisionTimeMs: 1000,
    decisionKey: '',
    player: f.hero,
    gameState: f.state,
    style: 'balanced' as const,
    opts: liveOpts,
    handJournalContext: captureHorseHandJournalContext(actionHistory),
  };
  value.decisionKey = buildHorseDecisionKey(value);
  return value;
}
export function bbDefend(variant: GameVariant = 'nlh') {
  const f = fixture(7, 2, variant),
    sb = f.state.players[0],
    bb = f.state.players[1];
  f.hero = { ...bb, cards: f.hero.cards };
  Object.assign(sb, { stack: 0, bet: 700, totalInvested: 700, is_all_in: true });
  Object.assign(f.state, {
    heroSeat: bb.seat,
    currentPlayerSeat: bb.seat,
    currentBet: 700,
    toCall: 600,
    pot: 800,
    minRaise: 600,
    minRaiseTo: null,
    maxRaiseTo: null,
    legalActions: ['fold', 'call'],
  });
  f.state.actionHistory = [
    {
      seat: sb.seat,
      userId: sb.user_id,
      stage: 'preflop',
      action: 'all_in',
      amount: 700,
      isFullRaise: true,
      timestamp: 10,
    },
  ];
  f.state.pots = calculatePots(f.state.players);
  f.state.contestablePot = calculateContestablePot(f.state.players, bb.user_id, 600);
  return f;
}

/** Synthetic source observation for boundary tests; no database authority claim. */
export function withPhase6Provenance<T extends LiveHorseDecisionSnapshot>(input: T): T {
  const out = structuredClone(input);
  const t = out.gameState.tournament!;
  const [tableId, hand] = out.fence.split(':');
  t.tournamentId ??= 'synthetic-tournament';
  t.sourceAgeMs = 100;
  t.contextProvenance = {
    version: 1,
    readAtMs: 1000,
    status: 'complete',
    issues: [],
    ageMs: 100,
    source: {
      version: 1,
      tournamentId: t.tournamentId,
      cacheId: '50000000-0000-4000-8000-000000000001',
      generation: 1,
      readStartedAtMs: 850,
      readCompletedAtMs: 900,
      contextDigest: 'a'.repeat(64),
      contextStatus: 'complete',
      contextIssues: [],
    },
    projection: {
      tableId,
      handNumber: Number(hand),
      actorId: out.player.user_id,
      actorSeat: out.player.seat,
      dealerSeat: out.gameState.dealerSeat ?? null,
      dealtSeatIds: out.gameState.players.map((p) => p.seat),
      smallBlind: t.currentSmallBlind!,
      bigBlind: out.gameState.bigBlind,
      ante: out.gameState.ante ?? 0,
      gameVariant: out.gameState.gameVariant!,
    },
  };
  out.decisionKey = buildHorseDecisionKey(out);
  return out;
}
