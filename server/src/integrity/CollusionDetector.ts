/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  COLLUSION DETECTOR — pairwise chip-transfer / soft-play / fold-to-player
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — pure, deterministic, unit-tested. Consumes a BATCH of
 * NormalizedHand[] and emits collusion IntegrityFlags (one per flagged cluster).
 *
 * Signals computed pairwise, then merged into clusters via union-find:
 *   1. CHIP TRANSFER (chip dumping): consistent one-directional net chip flow
 *      between a pair — a loser's contribution is attributed to winners
 *      proportionally; a strongly directional net flow across many hands is
 *      suspicious.
 *   2. FOLD-TO-PLAYER: one player folds to the other's aggression far above the
 *      pool baseline (never contests the partner's pots).
 *   3. SOFT PLAY: heads-up post-flop pots between the pair that get checked down
 *      with no aggression (declining to extract value from a partner).
 *
 * Heuristic scores feed human review via the AntiCheat seam (types.ts).
 */

import { type IntegrityFlag, type NormalizedHand, severityFromScore } from './types.js';

export interface CollusionDetectorOptions {
  /** Minimum hands a pair must share before it is scored. */
  minSharedHands?: number;
  /** Pair score threshold to include the edge in a cluster. */
  pairThreshold?: number;
  /** Baseline fold-to-aggression rate for the pool (above this is suspicious). */
  foldBaseline?: number;
  /** Weighting of the three sub-signals (normalized internally). */
  weights?: { chipTransfer: number; foldTo: number; softPlay: number };
}

const DEFAULTS: Required<CollusionDetectorOptions> = {
  minSharedHands: 20,
  pairThreshold: 0.55,
  foldBaseline: 0.45,
  weights: { chipTransfer: 0.4, foldTo: 0.35, softPlay: 0.25 },
};

const CHIP_IN_ACTIONS = new Set(['call', 'bet', 'raise', 'all_in', 'post_blind', 'post_ante']);

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/** Sum of chips each user put into a hand (contribution proxy). */
export function computeContributions(hand: NormalizedHand): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of hand.actions) {
    if (!a.userId) continue;
    if (CHIP_IN_ACTIONS.has(a.action) && a.amount > 0) {
      out.set(a.userId, (out.get(a.userId) ?? 0) + a.amount);
    }
  }
  return out;
}

interface PairAccum {
  a: string; // lexicographically-smaller user
  b: string;
  handsTogether: number;
  flowAtoB: number; // chips flowed a -> b
  flowBtoA: number;
  foldToAB: number; // a folded to b's aggression
  facedAB: number; // a faced b's aggression
  foldToBA: number;
  facedBA: number;
  headsUpPostflop: number;
  softPlayHands: number;
}

function ensurePair(map: Map<string, PairAccum>, x: string, y: string): PairAccum {
  const key = pairKey(x, y);
  let p = map.get(key);
  if (!p) {
    const [a, b] = x < y ? [x, y] : [y, x];
    p = {
      a,
      b,
      handsTogether: 0,
      flowAtoB: 0,
      flowBtoA: 0,
      foldToAB: 0,
      facedAB: 0,
      foldToBA: 0,
      facedBA: 0,
      headsUpPostflop: 0,
      softPlayHands: 0,
    };
    map.set(key, p);
  }
  return p;
}

/** Build the pairwise accumulator table across all hands. */
export function buildPairTable(hands: NormalizedHand[]): Map<string, PairAccum> {
  const pairs = new Map<string, PairAccum>();

  for (const hand of hands) {
    const participants = hand.players.map((p) => p.userId).filter(Boolean);
    if (participants.length < 2) continue;

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        ensurePair(pairs, participants[i], participants[j]).handsTogether++;
      }
    }

    // ── chip transfer: losers' contributions attributed to winners ──
    const contrib = computeContributions(hand);
    const totalWon = hand.winners.reduce((s, w) => s + Math.max(0, w.amount), 0);
    const winnerSet = new Set(hand.winners.map((w) => w.userId));
    if (totalWon > 0) {
      for (const [loser, amt] of contrib) {
        if (winnerSet.has(loser) || amt <= 0) continue;
        for (const w of hand.winners) {
          if (w.amount <= 0 || w.userId === loser) continue;
          const share = amt * (w.amount / totalWon);
          const p = ensurePair(pairs, loser, w.userId);
          if (loser === p.a) p.flowAtoB += share;
          else p.flowBtoA += share;
        }
      }
    }

    // ── per-street fold-to-aggression + soft-play (heads-up post-flop) ──
    const byStreet = new Map<string, typeof hand.actions>();
    for (const a of hand.actions) {
      const arr = byStreet.get(a.street) ?? [];
      arr.push(a);
      byStreet.set(a.street, arr);
    }

    for (const [street, actions] of byStreet) {
      let lastAggressor: string | null = null;
      for (const a of actions) {
        if (!a.userId) continue;
        if (a.action === 'fold' && lastAggressor && lastAggressor !== a.userId) {
          const p = ensurePair(pairs, a.userId, lastAggressor);
          if (a.userId === p.a) {
            p.foldToAB++;
            p.facedAB++;
          } else {
            p.foldToBA++;
            p.facedBA++;
          }
        } else if (
          (a.action === 'call' || a.action === 'check') &&
          lastAggressor &&
          lastAggressor !== a.userId
        ) {
          const p = ensurePair(pairs, a.userId, lastAggressor);
          if (a.userId === p.a) p.facedAB++;
          else p.facedBA++;
        }
        if ((a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') && a.amount > 0) {
          lastAggressor = a.userId;
        }
      }
      // soft play: post-flop street contested by EXACTLY two players, no aggression
      if (street !== 'preflop') {
        const actors = new Set(actions.filter((a) => a.userId).map((a) => a.userId));
        if (actors.size === 2) {
          const [x, y] = [...actors];
          const anyAggression = actions.some(
            (a) =>
              (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') && a.amount > 0
          );
          const anyFold = actions.some((a) => a.action === 'fold');
          const p = ensurePair(pairs, x, y);
          p.headsUpPostflop++;
          if (!anyAggression && !anyFold) p.softPlayHands++;
        }
      }
    }
  }

  return pairs;
}

export interface PairScore {
  a: string;
  b: string;
  score: number;
  handsTogether: number;
  chipTransferScore: number;
  foldToScore: number;
  softPlayScore: number;
  netFlow: number;
}

/** Score a single pair from its accumulator. */
export function scorePair(p: PairAccum, opts: CollusionDetectorOptions = {}): PairScore {
  const o = { ...DEFAULTS, ...opts };

  const gross = p.flowAtoB + p.flowBtoA;
  const net = Math.abs(p.flowAtoB - p.flowBtoA);
  const directionality = gross > 0 ? net / gross : 0;
  const volumeFactor = Math.min(1, gross > 0 ? net / Math.max(1, p.handsTogether) : 0);
  const chipTransferScore = Math.min(1, directionality * (0.5 + 0.5 * volumeFactor));

  const rateAB = p.facedAB > 0 ? p.foldToAB / p.facedAB : 0;
  const rateBA = p.facedBA > 0 ? p.foldToBA / p.facedBA : 0;
  const worstRate = Math.max(rateAB, rateBA);
  const worstFaced = rateAB >= rateBA ? p.facedAB : p.facedBA;
  const excess = Math.max(0, (worstRate - o.foldBaseline) / (1 - o.foldBaseline));
  const sampleConfidence = Math.min(1, worstFaced / 10);
  const foldToScore = excess * sampleConfidence;

  const softPlayScore = p.headsUpPostflop > 0 ? p.softPlayHands / p.headsUpPostflop : 0;

  const w = o.weights;
  const wsum = w.chipTransfer + w.foldTo + w.softPlay;
  const score =
    (chipTransferScore * w.chipTransfer + foldToScore * w.foldTo + softPlayScore * w.softPlay) /
    wsum;

  return {
    a: p.a,
    b: p.b,
    score: Math.min(1, score),
    handsTogether: p.handsTogether,
    chipTransferScore,
    foldToScore,
    softPlayScore,
    netFlow: p.flowAtoB - p.flowBtoA,
  };
}

// ── union-find for clustering flagged edges ──
class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }
  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }
}

/** Main entry: score all pairs, cluster suspicious edges, emit one flag per cluster. */
export function detectCollusion(
  hands: NormalizedHand[],
  opts: CollusionDetectorOptions = {}
): IntegrityFlag[] {
  const o = { ...DEFAULTS, ...opts };
  const pairs = buildPairTable(hands);

  const flaggedEdges: PairScore[] = [];
  for (const p of pairs.values()) {
    if (p.handsTogether < o.minSharedHands) continue;
    const s = scorePair(p, o);
    if (s.score >= o.pairThreshold) flaggedEdges.push(s);
  }

  if (flaggedEdges.length === 0) return [];

  const uf = new UnionFind();
  for (const e of flaggedEdges) uf.union(e.a, e.b);

  const clusters = new Map<string, { users: Set<string>; edges: PairScore[] }>();
  for (const e of flaggedEdges) {
    const root = uf.find(e.a);
    const c = clusters.get(root) ?? { users: new Set<string>(), edges: [] };
    c.users.add(e.a);
    c.users.add(e.b);
    c.edges.push(e);
    clusters.set(root, c);
  }

  const flags: IntegrityFlag[] = [];
  for (const c of clusters.values()) {
    const maxScore = Math.max(...c.edges.map((e) => e.score));
    const handsAnalyzed = Math.max(...c.edges.map((e) => e.handsTogether));
    const maxChip = Math.max(...c.edges.map((e) => e.chipTransferScore));
    const maxFold = Math.max(...c.edges.map((e) => e.foldToScore));
    const maxSoft = Math.max(...c.edges.map((e) => e.softPlayScore));
    const reasons = [];
    if (maxChip > 0.1)
      reasons.push({
        code: 'chip_transfer',
        detail: `directional net chip flow (score ${maxChip.toFixed(2)})`,
        weight: maxChip * o.weights.chipTransfer,
      });
    if (maxFold > 0.1)
      reasons.push({
        code: 'fold_to_player',
        detail: `elevated fold-to-partner rate (score ${maxFold.toFixed(2)})`,
        weight: maxFold * o.weights.foldTo,
      });
    if (maxSoft > 0.1)
      reasons.push({
        code: 'soft_play',
        detail: `heads-up pots checked down (score ${maxSoft.toFixed(2)})`,
        weight: maxSoft * o.weights.softPlay,
      });

    flags.push({
      type: 'collusion',
      userIds: [...c.users].sort(),
      score: maxScore,
      severity: severityFromScore(maxScore),
      reasons,
      handsAnalyzed,
      evidence: {
        edges: c.edges.map((e) => ({
          pair: [e.a, e.b],
          score: Number(e.score.toFixed(3)),
          handsTogether: e.handsTogether,
          chipTransferScore: Number(e.chipTransferScore.toFixed(3)),
          foldToScore: Number(e.foldToScore.toFixed(3)),
          softPlayScore: Number(e.softPlayScore.toFixed(3)),
          netFlow: Math.round(e.netFlow),
        })),
      },
    });
  }
  return flags.sort((a, b) => b.score - a.score);
}
