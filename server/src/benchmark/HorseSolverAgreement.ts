/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SOLVER AGREEMENT — the one number the league cannot produce (V47, 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From the deep audit, section 5.4: "The league proves better-than-yesterday's
 * self, not good." Self-play measures a DIFFERENCE between two configs. It can
 * never say whether either of them plays well, and after three runs
 * twenty-six of thirty-eight matchups were still inside their own error bars.
 *
 * TWO CORRECTIONS TO THAT AUDIT ENTRY, both found by reading the code rather
 * than trusting the note:
 *
 *   - MIRRORED DEALS ALREADY EXIST. The audit listed "duplicate deals so both
 *     configs see the same cards" as work to do. runMatchup has done exactly
 *     that since V12.2: `playHand` is called twice with the SAME `handSeed`
 *     and the seat assignment flipped (`evenIsA` / `evenIsB`), and the
 *     statistic is the per-pair DIFFERENCE. The card luck already cancels.
 *   - AN EXTERNAL SPARRING AGENT is not buildable here. There is no
 *     open-source CFR bot in this estate and fetching one is out of scope for
 *     an engine repository.
 *
 * What is genuinely missing is an ABSOLUTE score, and one is available from
 * data the platform already has: the hold'em push/fold solver charts in
 * `GtoCharts` (game_type x depth x position x hand -> the solver's frequency
 * for each action). For a fixed set of spots, ask the brain what it does and
 * look up how often the solver does that:
 *
 *     agreement = mean over spots of solverFrequency(action the horse chose)
 *
 * A horse that always takes the solver's pure line scores near 1. One that
 * folds hands the solver always jams scores near 0. A mixed spot caps at the
 * solver's own mix, which is correct: taking either side of a 50/50 is not a
 * mistake, and a scorer that punished it would be measuring conformity.
 *
 * IT IS NOT EXPLOITABILITY AND IS NOT CALLED THAT. True exploitability needs
 * a best-response calculation against the whole strategy. This is agreement
 * with a reference on the spots the reference covers, which is a real,
 * absolute, trendable number that moves on hundreds of spots rather than
 * millions of hands - and it is honest about its scope: hold'em push/fold
 * only, because that is the only reference in the building.
 *
 * NEVER refer to the horses as "bots" - they are HORSES only.
 */

import { createHash } from 'node:crypto';
import { GTO_BB_DEFEND_MAX_BB, GTO_OPEN_JAM_MAX_BB, snapDepth } from '../engine/GtoCharts.js';
import {
  lookupChartPolicyAdvice,
  solverPolicyArtifactStatus,
} from '../gto/SolverPolicyArtifactLoader.js';
import { stableSolverPolicyJson } from '../gto/SolverPolicyContract.js';
import { HorseLogic, type HorseGameStateV2 } from '../engine/HorseLogic.js';
import { HorseMind } from '../engine/HorseMind.js';
import { seedFastRandom, saveFastRandom, restoreFastRandom } from '../engine/HorseEval.js';
import { RANKS } from '../engine/PokerEngine.js';
import type { Card, SeatPlayer, HandStage } from '../types.js';

export interface AgreementSpot {
  /** 'open_jam' (hero first in, shove or fold) or 'bb_defend' (hero calls a jam). */
  kind: 'open_jam' | 'bb_defend';
  position: string;
  stackBB: number;
  /** the chart's hand key, e.g. 'AKs', 'QQ', 'T9o' */
  hand: string;
  isTournament: boolean;
}

export interface AgreementResult {
  /** spots the reference covered and the brain answered */
  spots: number;
  /** mean solver frequency of the action the horse chose, 0..1 */
  agreement: number;
  /** spots where the solver is effectively pure (>= 0.9) and the horse disagreed */
  pureMisses: number;
  /** null when the chart store is empty - no reference, so no score */
  reference: 'gto_charts' | null;
  /** reference-covered decisions before any scoring aggregate */
  eligibleSpots: number;
  /** decisions included in `decisions`; must equal eligibleSpots */
  reconciledSpots: number;
  /** mean measured EV regret where the reference has per-action EVs */
  actionRegretBb: number | null;
  regretEligibleSpots: number;
  /** checksum over the canonical ordered decision evidence */
  decisionChecksum: string | null;
  decisions: AgreementDecision[];
}

export interface AgreementSourceSeal {
  qualitySeal: string;
  policyVersion: string;
  policyChecksum: string;
  system: string;
  artifactId: string | null;
  scenarioHash: string | null;
  sourceArtifactChecksum: string | null;
  provenanceComplete: boolean;
  auditedAt: string | null;
}

export interface AgreementDecisionState {
  schemaVersion: 1;
  stage: 'preflop';
  gameVariant: 'nlh';
  gameType: 'Cash' | 'Tournament';
  format: 'cash' | 'mtt';
  kind: AgreementSpot['kind'];
  position: string;
  stackBb: number;
  hand: string;
  chart: string;
  villainAction: 'fold_to_hero' | 'sb_push';
  legalActions: ['push', 'fold'] | ['call', 'fold'];
}

export interface AgreementDecision {
  stateKey: string;
  /** Complete canonical input receipt used to recreate this deterministic probe. */
  decisionState: AgreementDecisionState;
  kind: AgreementSpot['kind'];
  gameType: 'Cash' | 'Tournament';
  position: string;
  stackBb: number;
  hand: string;
  finalAction: string;
  referenceDistribution: Record<string, number>;
  chosenProbability: number;
  actionRegretBb: number | null;
  regretEligible: boolean;
  pureMiss: boolean;
  sourceSeal: AgreementSourceSeal;
}

const SUITS_4 = ['spades', 'hearts', 'diamonds', 'clubs'] as const;

/** Turn a chart hand key ('AKs' / 'AKo' / 'QQ') into two real cards. */
export function cardsForHandKey(key: string): Card[] | null {
  if (!key || key.length < 2) return null;
  const r1 = key[0] as Card['rank'];
  const r2 = key[1] as Card['rank'];
  if (!RANKS.includes(r1) || !RANKS.includes(r2)) return null;
  const suited = key.length >= 3 && key[2] === 's';
  if (r1 === r2) {
    return [
      { rank: r1, suit: SUITS_4[0] },
      { rank: r2, suit: SUITS_4[1] },
    ];
  }
  return [
    { rank: r1, suit: SUITS_4[0] },
    { rank: r2, suit: suited ? SUITS_4[0] : SUITS_4[1] },
  ];
}

/**
 * The spot set. Deterministic and small: every hand key the charts use, at a
 * spread of depths, in the positions the push/fold charts cover. Cash and
 * tournament are separate references and both are probed.
 */
export function buildSpots(): AgreementSpot[] {
  const hands: string[] = [];
  for (let i = 0; i < RANKS.length; i++) {
    for (let j = i; j < RANKS.length; j++) {
      const hi = RANKS[RANKS.length - 1 - i];
      const lo = RANKS[RANKS.length - 1 - j];
      hands.push(hi === lo ? `${hi}${lo}` : `${hi}${lo}s`);
      if (hi !== lo) hands.push(`${hi}${lo}o`);
    }
  }
  const spots: AgreementSpot[] = [];
  for (const isTournament of [true, false]) {
    for (const stackBB of [8, 12, GTO_OPEN_JAM_MAX_BB]) {
      for (const position of ['UTG', 'CO', 'BTN', 'SB']) {
        for (const hand of hands) {
          spots.push({ kind: 'open_jam', position, stackBB, hand, isTournament });
        }
      }
      for (const hand of hands) {
        spots.push({ kind: 'bb_defend', position: 'BB', stackBB, hand, isTournament });
      }
    }
  }
  return spots;
}

function mkPlayer(seat: number, over: Partial<SeatPlayer> = {}): SeatPlayer {
  return {
    seat,
    user_id: `probe-${seat}`,
    username: `P${seat}`,
    stack: 100,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
    ...over,
  } as SeatPlayer;
}

/**
 * Build the game state for one spot. Six-handed, blinds 1/2, hero holding the
 * chart's hand at the chart's depth. For an open-jam spot everyone before
 * hero has folded; for a BB-defend spot the small blind is all in.
 */
export function stateForSpot(spot: AgreementSpot): { hero: SeatPlayer; gs: HorseGameStateV2 } {
  const bb = 2;
  const stack = spot.stackBB * bb;
  const cards = cardsForHandKey(spot.hand) ?? [];
  if (spot.kind === 'bb_defend') {
    const hero = mkPlayer(2, { cards, stack: stack - bb, bet: bb, totalInvested: bb });
    const sb = mkPlayer(1, { bet: stack, stack: 0, is_all_in: true, totalInvested: stack });
    return {
      hero,
      gs: {
        players: [sb, hero],
        communityCards: [],
        pot: stack + bb,
        currentBet: stack,
        minRaise: stack,
        stage: 'preflop' as HandStage,
        gameVariant: 'nlh',
        bigBlind: bb,
        dealerSeat: 1,
        gameMode: spot.isTournament ? ('tournament' as const) : ('cash' as const),
        format: spot.isTournament ? 'mtt' : 'cash',
        actionHistory: [
          {
            seat: 1,
            userId: 'probe-1',
            action: 'all_in',
            amount: stack,
            timestamp: 0,
            stage: 'preflop',
            isFullRaise: true,
          },
        ],
      } as unknown as HorseGameStateV2,
    };
  }
  // open jam: hero is first in, everyone before has folded
  const seatOf: Record<string, number> = { UTG: 3, CO: 4, BTN: 5, SB: 6 };
  const heroSeat = seatOf[spot.position] ?? 3;
  const hero = mkPlayer(heroSeat, { cards, stack, totalInvested: 0 });
  const players: SeatPlayer[] = [
    mkPlayer(1, { bet: bb / 2, totalInvested: bb / 2, stack: 100 }),
    mkPlayer(2, { bet: bb, totalInvested: bb, stack: 100 }),
  ];
  for (let s = 3; s <= 6; s++) {
    if (s === heroSeat) players.push(hero);
    else players.push(mkPlayer(s, { is_folded: s < heroSeat }));
  }
  return {
    hero,
    gs: {
      players,
      communityCards: [],
      pot: bb * 1.5,
      currentBet: bb,
      minRaise: bb,
      stage: 'preflop' as HandStage,
      gameVariant: 'nlh',
      bigBlind: bb,
      dealerSeat: 6,
      gameMode: spot.isTournament ? ('tournament' as const) : ('cash' as const),
      format: spot.isTournament ? 'mtt' : 'cash',
      actionHistory: [],
    } as unknown as HorseGameStateV2,
  };
}

/** What the solver says about this spot, or null when it has no cell. */
export function solverAdvice(spot: AgreementSpot): {
  action: string;
  freq: number;
  chart: string;
  distribution: Record<string, number>;
  sourceSeal: AgreementSourceSeal;
  actionEvBb: Record<string, number | null>;
} | null {
  if (!(spot.stackBB > 0)) return null;
  if (spot.kind === 'open_jam' && spot.stackBB > GTO_OPEN_JAM_MAX_BB) return null;
  if (spot.kind === 'bb_defend' && spot.stackBB > GTO_BB_DEFEND_MAX_BB) return null;
  const advice = lookupChartPolicyAdvice({
    gameType: spot.isTournament ? 'Tournament' : 'Cash',
    villainAction: spot.kind === 'open_jam' ? 'fold_to_hero' : 'sb_push',
    position: spot.position,
    depth: snapDepth(spot.stackBB),
    hand: spot.hand,
  });
  if (!advice) return null;
  const yes = spot.kind === 'open_jam' ? 'push' : 'call';
  const policyYes = spot.kind === 'open_jam' ? 'all_in' : 'call';
  const policyMix = advice.policy.rangeDistribution?.[spot.hand];
  if (!policyMix) return null;
  const distribution = {
    [yes]: Number(policyMix[policyYes]) || 0,
    fold: Number(policyMix.fold) || 0,
  };
  const source = advice.policy.sourceArtifact;
  return {
    action: advice.action,
    freq: advice.freq,
    chart: [
      spot.isTournament ? 'Tournament' : 'Cash',
      spot.kind === 'open_jam' ? 'fold_to_hero' : 'sb_push',
      spot.position,
      String(snapDepth(spot.stackBB)),
    ].join('|'),
    distribution,
    sourceSeal: {
      qualitySeal: advice.policy.qualitySeal,
      policyVersion: advice.policy.policyVersion,
      policyChecksum: createHash('sha256')
        .update(stableSolverPolicyJson(advice.policy))
        .digest('hex'),
      system: source.system,
      artifactId: source.artifactId,
      scenarioHash: source.scenarioHash,
      sourceArtifactChecksum: source.sourceArtifactChecksum,
      provenanceComplete: source.provenanceComplete,
      auditedAt: source.auditedAt,
    },
    actionEvBb: {
      [yes]: advice.policy.chipEv.byAction[policyYes] ?? null,
      fold: advice.policy.chipEv.byAction.fold ?? null,
    },
  };
}

/** Map a horse decision onto the solver's vocabulary. */
export function actionLabel(kind: AgreementSpot['kind'], action: string): string {
  if (action === 'fold') return 'fold';
  if (kind === 'open_jam') return action === 'all_in' || action === 'raise' ? 'push' : 'fold';
  return action === 'call' || action === 'all_in' ? 'call' : 'fold';
}

/**
 * Score the brain against the reference. Pure apart from the brain call, and
 * bracketed on the RNG for the same reason the league is: the probe runs
 * inside the live engine process and must not move the live stream.
 */
export function scoreSolverAgreement(maxSpots = 600): AgreementResult {
  if (solverPolicyArtifactStatus().charts.count === 0) {
    return {
      spots: 0,
      agreement: 0,
      pureMisses: 0,
      reference: null,
      eligibleSpots: 0,
      reconciledSpots: 0,
      actionRegretBb: null,
      regretEligibleSpots: 0,
      decisionChecksum: null,
      decisions: [],
    };
  }
  const all = buildSpots();
  const step = Math.max(1, Math.floor(all.length / maxSpots));
  const rngBefore = saveFastRandom();
  const sandbox = HorseMind.createSandbox();
  let scored = 0;
  let total = 0;
  let pureMisses = 0;
  let regretTotal = 0;
  let regretEligibleSpots = 0;
  const decisions: AgreementDecision[] = [];
  try {
    for (let i = 0; i < all.length; i += step) {
      const spot = all[i];
      const advice = solverAdvice(spot);
      if (!advice) continue;
      const { hero, gs } = stateForSpot(spot);
      seedFastRandom((i + 1) * 2654435761);
      const decision = HorseMind.runInSandbox(sandbox, () =>
        HorseLogic.decide(hero, gs, 'balanced', {}, { mind: false, telemetry: false })
      );
      const chose = actionLabel(spot.kind, decision.action);
      const freqOfChosen = advice.distribution[chose] ?? 0;
      const evs = Object.values(advice.actionEvBb).filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value)
      );
      const chosenEv = advice.actionEvBb[chose];
      const actionRegretBb =
        evs.length === Object.keys(advice.distribution).length &&
        typeof chosenEv === 'number' &&
        Number.isFinite(chosenEv)
          ? Math.max(0, Math.max(...evs) - chosenEv)
          : null;
      if (actionRegretBb !== null) {
        regretTotal += actionRegretBb;
        regretEligibleSpots++;
      }
      total += freqOfChosen;
      scored++;
      const pureMiss = advice.freq >= 0.9 && chose !== advice.action;
      if (pureMiss) pureMisses++;
      const gameType = spot.isTournament ? 'Tournament' : 'Cash';
      const stackBb = snapDepth(spot.stackBB);
      decisions.push({
        stateKey: [gameType, spot.kind, spot.position, String(stackBb), spot.hand].join('|'),
        decisionState: {
          schemaVersion: 1,
          stage: 'preflop',
          gameVariant: 'nlh',
          gameType,
          format: spot.isTournament ? 'mtt' : 'cash',
          kind: spot.kind,
          position: spot.position,
          stackBb,
          hand: spot.hand,
          chart: advice.chart,
          villainAction: spot.kind === 'open_jam' ? 'fold_to_hero' : 'sb_push',
          legalActions: spot.kind === 'open_jam' ? ['push', 'fold'] : ['call', 'fold'],
        },
        kind: spot.kind,
        gameType,
        position: spot.position,
        stackBb,
        hand: spot.hand,
        finalAction: chose,
        referenceDistribution: advice.distribution,
        chosenProbability: freqOfChosen,
        actionRegretBb,
        regretEligible: actionRegretBb !== null,
        pureMiss,
        sourceSeal: advice.sourceSeal,
      });
    }
  } finally {
    restoreFastRandom(rngBefore);
  }
  const decisionChecksum =
    decisions.length > 0
      ? createHash('sha256').update(stableSolverPolicyJson(decisions)).digest('hex')
      : null;
  return {
    spots: scored,
    agreement: scored > 0 ? total / scored : 0,
    pureMisses,
    reference: 'gto_charts',
    eligibleSpots: scored,
    reconciledSpots: decisions.length,
    actionRegretBb: regretEligibleSpots > 0 ? regretTotal / regretEligibleSpots : null,
    regretEligibleSpots,
    decisionChecksum,
    decisions,
  };
}
