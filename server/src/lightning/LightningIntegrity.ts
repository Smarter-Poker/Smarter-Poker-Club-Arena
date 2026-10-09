/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INTEGRITY SIGNALS, ENGINE HALF (Lightning Phase 11, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One window's decision-timing evidence for one Cluster, aggregated in
 * memory and handed to `fn_lightning_integrity_report` once per window (the
 * database scores it and keeps the record; see LightningShadowRunner).
 *
 *   players: per player - decisions, timeouts, p50/p95/mean/stddev of the
 *            decision latency, its coefficient of variation (stddev / mean:
 *            a script's timing is abnormally CONSTANT) and the share of
 *            decisions under LIGHTNING_INTEGRITY_FAST_MS (abnormally FAST);
 *   pairs:   per pair of players dealt into the same instance - hands
 *            together, back-to-back actions (one straight after the other),
 *            how many of those came under the fast threshold, and the
 *            Pearson correlation of their per-hand mean decision times
 *            (two seats driven by one hand move together).
 *
 * WHAT IS NOT HERE: cards, boards, amounts, action types, stacks, and any
 * notion of who is a horse (CLAUDE.md 10.5: a horse is timed exactly as a
 * human is). Every structure is bounded; overflow is counted, not stored.
 */
import { BoundedSample, quantileSorted, round1, round4 } from './LightningTelemetry.js';

/** A decision under this many milliseconds counts as fast. */
export const LIGHTNING_INTEGRITY_FAST_MS = 500;
/** Players tracked per window (the rest are counted in dropped_players). */
export const LIGHTNING_INTEGRITY_MAX_PLAYERS = 2_000;
/** Pairs tracked per window (the rest are counted in dropped_pairs). */
export const LIGHTNING_INTEGRITY_MAX_PAIRS = 20_000;
/** Open hands remembered at once (an unfinished one is evicted oldest first). */
export const LIGHTNING_INTEGRITY_MAX_OPEN_HANDS = 1_000;
/** Latency samples kept per player for the quantiles. */
export const LIGHTNING_INTEGRITY_SAMPLES_PER_PLAYER = 256;
/** A pair is reported once it shared at least this many hands in the window. */
export const LIGHTNING_INTEGRITY_PAIR_MIN_HANDS = 3;
/** At most this many players / pairs go into one report (the busiest first). */
export const LIGHTNING_INTEGRITY_REPORT_MAX_PLAYERS = 500;
export const LIGHTNING_INTEGRITY_REPORT_MAX_PAIRS = 200;

interface PlayerAcc {
  decisions: number;
  timeouts: number;
  fast: number;
  sum: number;
  sumSq: number;
  sample: BoundedSample;
}

interface PairAcc {
  hands: number;
  sequential: number;
  fastFollows: number;
  /** Pearson accumulators over hands where both acted (x = the lower id). */
  n: number;
  sx: number;
  sy: number;
  sxx: number;
  syy: number;
  sxy: number;
}

interface OpenHand {
  players: string[];
  /** Per player: [sum of latencies, count] in this hand. */
  perPlayer: Map<string, [number, number]>;
  lastActor: string | null;
}

export interface LightningIntegrityPlayerSignal {
  player_id: string;
  decisions: number;
  timeouts: number;
  p50_ms: number | null;
  p95_ms: number | null;
  mean_ms: number | null;
  stddev_ms: number | null;
  cv: number | null;
  fast_share: number | null;
}

export interface LightningIntegrityPairSignal {
  player_a: string;
  player_b: string;
  hands_together: number;
  sequential_actions: number;
  fast_follows: number;
  latency_corr: number | null;
}

export interface LightningIntegritySignals {
  players: LightningIntegrityPlayerSignal[];
  pairs: LightningIntegrityPairSignal[];
  hands: number;
  decisions: number;
  fast_ms: number;
  dropped_players: number;
  dropped_pairs: number;
}

const pairKey = (a: string, b: string): [string, string, string] =>
  a < b ? [`${a}/${b}`, a, b] : [`${b}/${a}`, b, a];

export class LightningIntegrityWindow {
  private players = new Map<string, PlayerAcc>();
  private pairs = new Map<string, PairAcc>();
  private open = new Map<string, OpenHand>();
  private hands = 0;
  private decisions = 0;
  private droppedPlayers = 0;
  private droppedPairs = 0;

  get isEmpty(): boolean {
    return this.hands === 0 && this.decisions === 0 && this.players.size === 0;
  }

  handDealt(handId: string, players: readonly string[]): void {
    if (this.open.has(handId)) return;
    if (this.open.size >= LIGHTNING_INTEGRITY_MAX_OPEN_HANDS) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    const unique = [...new Set(players)];
    this.open.set(handId, { players: unique, perPlayer: new Map(), lastActor: null });
    this.hands++;
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++) {
        const acc = this.pair(unique[i], unique[j]);
        if (acc) acc.hands++;
      }
  }

  decision(handId: string, playerId: string, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const acc = this.player(playerId);
    if (!acc) return;
    this.decisions++;
    acc.decisions++;
    acc.sum += latencyMs;
    acc.sumSq += latencyMs * latencyMs;
    acc.sample.add(latencyMs);
    if (latencyMs < LIGHTNING_INTEGRITY_FAST_MS) acc.fast++;
    const hand = this.open.get(handId);
    if (!hand) return;
    const cur = hand.perPlayer.get(playerId) ?? [0, 0];
    cur[0] += latencyMs;
    cur[1] += 1;
    hand.perPlayer.set(playerId, cur);
    if (hand.lastActor && hand.lastActor !== playerId) {
      const pair = this.pair(hand.lastActor, playerId);
      if (pair) {
        pair.sequential++;
        if (latencyMs < LIGHTNING_INTEGRITY_FAST_MS) pair.fastFollows++;
      }
    }
    hand.lastActor = playerId;
  }

  timeout(handId: string, playerId: string): void {
    const acc = this.player(playerId);
    if (acc) acc.timeouts++;
    const hand = this.open.get(handId);
    if (hand) hand.lastActor = playerId;
  }

  handEnded(handId: string): void {
    const hand = this.open.get(handId);
    if (!hand) return;
    this.open.delete(handId);
    const acted = [...hand.perPlayer.entries()].map(([id, [s, c]]) => [id, s / c] as const);
    for (let i = 0; i < acted.length; i++)
      for (let j = i + 1; j < acted.length; j++) {
        const [key, a] = pairKey(acted[i][0], acted[j][0]);
        const pair = this.pairs.get(key);
        if (!pair) continue;
        const x = a === acted[i][0] ? acted[i][1] : acted[j][1];
        const y = a === acted[i][0] ? acted[j][1] : acted[i][1];
        pair.n++;
        pair.sx += x;
        pair.sy += y;
        pair.sxx += x * x;
        pair.syy += y * y;
        pair.sxy += x * y;
      }
  }

  /** The window's signals, in the shape fn_lightning_integrity_report takes. */
  signals(): LightningIntegritySignals {
    const players: LightningIntegrityPlayerSignal[] = [...this.players.entries()]
      .filter(([, a]) => a.decisions > 0 || a.timeouts > 0)
      .sort((x, y) => y[1].decisions - x[1].decisions || (x[0] < y[0] ? -1 : 1))
      .slice(0, LIGHTNING_INTEGRITY_REPORT_MAX_PLAYERS)
      .map(([id, a]) => {
        const sorted = a.sample.sortedValues();
        const mean = a.decisions > 0 ? a.sum / a.decisions : null;
        const variance =
          a.decisions > 1 && mean !== null
            ? Math.max(0, (a.sumSq - a.decisions * mean * mean) / (a.decisions - 1))
            : null;
        const sd = variance === null ? null : Math.sqrt(variance);
        return {
          player_id: id,
          decisions: a.decisions,
          timeouts: a.timeouts,
          p50_ms: round1(quantileSorted(sorted, 0.5)),
          p95_ms: round1(quantileSorted(sorted, 0.95)),
          mean_ms: round1(mean),
          stddev_ms: round1(sd),
          cv: sd !== null && mean !== null && mean > 0 ? round4(sd / mean) : null,
          fast_share: a.decisions > 0 ? round4(a.fast / a.decisions) : null,
        };
      });
    const pairs: LightningIntegrityPairSignal[] = [...this.pairs.entries()]
      .filter(([, p]) => p.hands >= LIGHTNING_INTEGRITY_PAIR_MIN_HANDS)
      .sort((x, y) => y[1].hands - x[1].hands || (x[0] < y[0] ? -1 : 1))
      .slice(0, LIGHTNING_INTEGRITY_REPORT_MAX_PAIRS)
      .map(([key, p]) => {
        const [a, b] = key.split('/');
        return {
          player_a: a,
          player_b: b,
          hands_together: p.hands,
          sequential_actions: p.sequential,
          fast_follows: p.fastFollows,
          latency_corr: pearson(p),
        };
      });
    return {
      players,
      pairs,
      hands: this.hands,
      decisions: this.decisions,
      fast_ms: LIGHTNING_INTEGRITY_FAST_MS,
      dropped_players: this.droppedPlayers,
      dropped_pairs: this.droppedPairs,
    };
  }

  /** A new window: the counts restart; hands still open carry over (their pairs restart). */
  reset(): void {
    this.players = new Map();
    this.pairs = new Map();
    this.hands = 0;
    this.decisions = 0;
    this.droppedPlayers = 0;
    this.droppedPairs = 0;
  }

  private player(id: string): PlayerAcc | null {
    let acc = this.players.get(id);
    if (acc) return acc;
    if (this.players.size >= LIGHTNING_INTEGRITY_MAX_PLAYERS) {
      this.droppedPlayers++;
      return null;
    }
    acc = {
      decisions: 0,
      timeouts: 0,
      fast: 0,
      sum: 0,
      sumSq: 0,
      sample: new BoundedSample(LIGHTNING_INTEGRITY_SAMPLES_PER_PLAYER, hashSeed(id)),
    };
    this.players.set(id, acc);
    return acc;
  }

  private pair(a: string, b: string): PairAcc | null {
    if (a === b) return null;
    const [key] = pairKey(a, b);
    let acc = this.pairs.get(key);
    if (acc) return acc;
    if (this.pairs.size >= LIGHTNING_INTEGRITY_MAX_PAIRS) {
      this.droppedPairs++;
      return null;
    }
    acc = { hands: 0, sequential: 0, fastFollows: 0, n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    this.pairs.set(key, acc);
    return acc;
  }
}

function pearson(p: PairAcc): number | null {
  if (p.n < LIGHTNING_INTEGRITY_PAIR_MIN_HANDS) return null;
  const cov = p.sxy - (p.sx * p.sy) / p.n;
  const vx = p.sxx - (p.sx * p.sx) / p.n;
  const vy = p.syy - (p.sy * p.sy) / p.n;
  if (vx <= 1e-9 || vy <= 1e-9) return null;
  return round4(Math.max(-1, Math.min(1, cov / Math.sqrt(vx * vy))));
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}
