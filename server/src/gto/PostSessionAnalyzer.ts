/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  POST-SESSION ANALYZER — GTO leak report vs a solver baseline
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — pure analysis on top of the GtoSolverClient contract.
 * Given a player's session hands, it walks every voluntary hero decision, builds
 * a normalized Scenario, looks up the solver strategy by scenario_hash, scores
 * the decision by EV loss (bb), then aggregates into ranked "leaks" by category.
 *
 * Reuses the NormalizedHand shape from the integrity module (single source of
 * truth for hand data) via HandEventAdapter — the same rows persisted to
 * `hand_history` feed both anti-cheat and GTO analysis.
 *
 * The solver source is injected: pass StubGtoSolverClient for tests/dev, or
 * WorldHubGtoSolverClient in production (see GtoSolverClient.ts seam).
 */

import type { NormalizedAction, NormalizedHand } from '../integrity/types.js';
import {
  type GtoSolverClient,
  type Scenario,
  type SolverStrategy,
  computeScenarioHash,
} from './GtoSolverClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// Holding / board canonicalization
// ─────────────────────────────────────────────────────────────────────────────

const RANK_ORDER = '23456789TJQKA';

function parseCard(card: string): { rank: string; suit: string } | null {
  if (!card || card.length < 2) return null;
  const rank = card
    .slice(0, card.length - 1)
    .toUpperCase()
    .replace('10', 'T');
  const suit = card.slice(-1).toLowerCase();
  if (!RANK_ORDER.includes(rank)) return null;
  return { rank, suit };
}

/** Canonical 2-card holding class: 'AKs' | 'AKo' | 'QQ' | 'unknown'. */
export function heroHoleClass(cards: string[]): string {
  if (cards.length < 2) return 'unknown';
  const c1 = parseCard(cards[0]);
  const c2 = parseCard(cards[1]);
  if (!c1 || !c2) return 'unknown';
  const hi = RANK_ORDER.indexOf(c1.rank) >= RANK_ORDER.indexOf(c2.rank) ? c1 : c2;
  const lo = hi === c1 ? c2 : c1;
  if (hi.rank === lo.rank) return `${hi.rank}${lo.rank}`;
  return `${hi.rank}${lo.rank}${hi.suit === lo.suit ? 's' : 'o'}`;
}

/** Coarse board key: sorted ranks + suitedness pattern for the visible board. */
export function boardKey(cards: string[]): string {
  const parsed = cards
    .map(parseCard)
    .filter((c): c is { rank: string; suit: string } => c !== null);
  if (parsed.length === 0) return '';
  const ranks = parsed
    .map((c) => c.rank)
    .sort((a, b) => RANK_ORDER.indexOf(b) - RANK_ORDER.indexOf(a))
    .join('');
  // suit pattern: number of distinct suits (rainbow/two-tone/mono proxy)
  const suits = new Set(parsed.map((c) => c.suit)).size;
  return `${ranks}-${suits}s`;
}

function boardForStreet(community: string[], street: Scenario['street']): string[] {
  switch (street) {
    case 'preflop':
      return [];
    case 'flop':
      return community.slice(0, 3);
    case 'turn':
      return community.slice(0, 4);
    case 'river':
      return community.slice(0, 5);
  }
}

function stackBucket(stackBb: number): string {
  if (stackBb >= 150) return '200bb';
  if (stackBb >= 75) return '100bb';
  if (stackBb >= 35) return '50bb';
  if (stackBb >= 15) return '20bb';
  return '10bb';
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario construction from a hero decision
// ─────────────────────────────────────────────────────────────────────────────

const AGGRESSIVE = new Set(['bet', 'raise', 'all_in']);

export interface HeroDecision {
  hand: NormalizedHand;
  actionIndex: number;
  action: NormalizedAction;
}

/** Extract the hero's voluntary decisions (excludes blinds/antes). */
export function extractHeroDecisions(hand: NormalizedHand, heroUserId: string): HeroDecision[] {
  const out: HeroDecision[] = [];
  hand.actions.forEach((action, actionIndex) => {
    if (action.userId === heroUserId && !action.forced) {
      out.push({ hand, actionIndex, action });
    }
  });
  return out;
}

/** Build the normalized Scenario for a single hero decision. */
export function buildHeroScenario(
  hand: NormalizedHand,
  actionIndex: number,
  ctx: { position?: string } = {}
): Scenario {
  const action = hand.actions[actionIndex];
  const street = action.street === 'showdown' ? 'river' : action.street;

  // What is the hero facing on this street prior to acting?
  let facing = 'unopened';
  for (let i = 0; i < actionIndex; i++) {
    const prev = hand.actions[i];
    if (prev.street !== action.street || prev.forced) continue;
    if (prev.action === 'raise' || prev.action === 'all_in') facing = 'facing_raise';
    else if (prev.action === 'bet' && facing === 'unopened') facing = 'facing_bet';
  }

  const heroPlayer = hand.players.find((p) => p.userId === action.userId);
  const stackBb = heroPlayer && hand.bigBlind > 0 ? heroPlayer.startingStack / hand.bigBlind : 0;

  return {
    gameVariant: hand.gameVariant,
    street,
    position: ctx.position ?? 'unknown',
    stackBucket: stackBucket(stackBb),
    potBucket: hand.bigBlind > 0 ? `${Math.round(hand.potSize / hand.bigBlind)}bb` : 'na',
    boardKey: boardKey(boardForStreet(hand.communityCards, street)),
    heroHoleClass: heroPlayer ? heroHoleClass(heroPlayer.cards) : 'unknown',
    facing,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision scoring
// ─────────────────────────────────────────────────────────────────────────────

function actionGroup(action: string): 'aggressive' | 'call' | 'check' | 'fold' | 'other' {
  if (AGGRESSIVE.has(action)) return 'aggressive';
  if (action === 'call') return 'call';
  if (action === 'check') return 'check';
  if (action === 'fold') return 'fold';
  return 'other';
}

/** Match the hero's chosen action to a solver action (exact, then by group). */
export function matchChosenAction(
  chosen: string,
  strategy: SolverStrategy
): { matched: import('./GtoSolverClient.js').SolverActionStrategy | null; offTree: boolean } {
  const exact = strategy.actions.find((a) => a.action === chosen);
  if (exact) return { matched: exact, offTree: false };
  const group = actionGroup(chosen);
  const byGroup = strategy.actions.find((a) => actionGroup(a.action) === group);
  if (byGroup) return { matched: byGroup, offTree: false };
  return { matched: null, offTree: true };
}

export interface DecisionEval {
  handId: string;
  street: Scenario['street'];
  category: string;
  scenarioHash: string;
  chosenAction: string;
  gtoBestAction: string;
  chosenEvBb: number;
  bestEvBb: number;
  evLossBb: number;
  chosenFrequency: number;
  offTree: boolean;
  isMistake: boolean;
}

export function decisionCategory(scenario: Scenario, chosen: string): string {
  return `${scenario.street}:${scenario.facing}:${actionGroup(chosen)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leak report
// ─────────────────────────────────────────────────────────────────────────────

export interface Leak {
  category: string;
  decisionsScored: number;
  mistakeCount: number;
  totalEvLostBb: number;
  avgEvLostBb: number;
  worstExample: DecisionEval | null;
}

export interface LeakReport {
  userId: string;
  handsAnalyzed: number;
  decisionsAnalyzed: number; // hero voluntary decisions seen
  decisionsScored: number; // decisions with solver coverage
  coverage: number; // decisionsScored / decisionsAnalyzed
  totalEvLostBb: number;
  evLostPer100Hands: number;
  /** Fraction of scored decisions within tolerance of optimal (0..1). */
  accuracy: number;
  leaks: Leak[]; // ranked by totalEvLostBb desc
  topMistakes: DecisionEval[]; // worst individual decisions
}

export interface AnalyzerOptions {
  /** EV loss (bb) above which a decision counts as a mistake. Default 0.05. */
  mistakeToleranceBb?: number;
  /** How many worst individual decisions to surface. Default 10. */
  topMistakes?: number;
  /** Optional seat->position resolver for richer scenarios. */
  positionResolver?: (hand: NormalizedHand, seat: number) => string;
}

const ANALYZER_DEFAULTS: Required<Omit<AnalyzerOptions, 'positionResolver'>> = {
  mistakeToleranceBb: 0.05,
  topMistakes: 10,
};

/**
 * Analyze one player's session. Pure aside from the injected solver client
 * (which may perform I/O in production).
 */
export async function analyzeSession(
  hands: NormalizedHand[],
  heroUserId: string,
  solver: GtoSolverClient,
  opts: AnalyzerOptions = {}
): Promise<LeakReport> {
  const tolerance = opts.mistakeToleranceBb ?? ANALYZER_DEFAULTS.mistakeToleranceBb;
  const topN = opts.topMistakes ?? ANALYZER_DEFAULTS.topMistakes;

  const evals: DecisionEval[] = [];
  let decisionsAnalyzed = 0;

  for (const hand of hands) {
    const decisions = extractHeroDecisions(hand, heroUserId);
    for (const d of decisions) {
      decisionsAnalyzed++;
      const heroSeat = hand.players.find((p) => p.userId === heroUserId)?.seat ?? d.action.seat;
      const position = opts.positionResolver ? opts.positionResolver(hand, heroSeat) : undefined;
      const scenario = buildHeroScenario(hand, d.actionIndex, { position });
      const hash = computeScenarioHash(scenario);
      const strategy = await solver.lookup(hash);
      if (!strategy || strategy.actions.length === 0) continue;

      const bestAction = strategy.actions.reduce((a, b) => (b.ev > a.ev ? b : a));
      const { matched, offTree } = matchChosenAction(d.action.action, strategy);
      const worstEv = strategy.actions.reduce((a, b) => (b.ev < a.ev ? b : a)).ev;
      const chosenEv = matched ? matched.ev : worstEv; // off-tree => conservative worst-case
      const evLoss = Math.max(0, bestAction.ev - chosenEv);

      evals.push({
        handId: hand.handId,
        street: scenario.street,
        category: decisionCategory(scenario, d.action.action),
        scenarioHash: hash,
        chosenAction: d.action.action,
        gtoBestAction: bestAction.action,
        chosenEvBb: chosenEv,
        bestEvBb: bestAction.ev,
        evLossBb: evLoss,
        chosenFrequency: matched ? matched.frequency : 0,
        offTree,
        isMistake: evLoss > tolerance,
      });
    }
  }

  // Aggregate by category.
  const byCategory = new Map<string, DecisionEval[]>();
  for (const e of evals) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }

  const leaks: Leak[] = [];
  for (const [category, es] of byCategory) {
    const totalEvLost = es.reduce((s, e) => s + e.evLossBb, 0);
    const worst = es.reduce<DecisionEval | null>(
      (w, e) => (!w || e.evLossBb > w.evLossBb ? e : w),
      null
    );
    leaks.push({
      category,
      decisionsScored: es.length,
      mistakeCount: es.filter((e) => e.isMistake).length,
      totalEvLostBb: round3(totalEvLost),
      avgEvLostBb: round3(totalEvLost / es.length),
      worstExample: worst,
    });
  }
  leaks.sort((a, b) => b.totalEvLostBb - a.totalEvLostBb);

  const decisionsScored = evals.length;
  const totalEvLost = evals.reduce((s, e) => s + e.evLossBb, 0);
  const accurate = evals.filter((e) => !e.isMistake).length;
  const topMistakes = [...evals].sort((a, b) => b.evLossBb - a.evLossBb).slice(0, topN);

  return {
    userId: heroUserId,
    handsAnalyzed: hands.length,
    decisionsAnalyzed,
    decisionsScored,
    coverage: decisionsAnalyzed > 0 ? round3(decisionsScored / decisionsAnalyzed) : 0,
    totalEvLostBb: round3(totalEvLost),
    evLostPer100Hands: hands.length > 0 ? round3((totalEvLost / hands.length) * 100) : 0,
    accuracy: decisionsScored > 0 ? round3(accurate / decisionsScored) : 0,
    leaks,
    topMistakes,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
