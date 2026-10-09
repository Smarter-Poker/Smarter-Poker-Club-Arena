/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MATCHER SIMULATOR (Lightning Phase 11, 2026-10-08)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Spec "MATCHER SIMULATOR": drive the matcher - the SAME pure plans the
 * shadow runner uses (LightningMatcherModel: `m1`, the live SQL plan's port,
 * and `m2`, the candidate) - over a synthetic population, and measure what
 * players would live through: hands per hour, waits (avg / P95 / P99), big
 * blind, small blind and button counts per player, the longest gap between
 * a player's big blinds and the spread of those gaps, the position
 * distribution, how often an opponent repeats from a player's previous hand
 * and how often a whole table repeats, instance utilisation, and how often
 * the pool would cross the Cluster's conversion thresholds.
 *
 * DETERMINISTIC. Every random draw comes from one seeded generator
 * (mulberry32), in a fixed order, so a seed reproduces a run exactly.
 *
 * NOTHING HERE TOUCHES A DATABASE. The CLI is src/scripts/lightningMatcherSim.ts;
 * CI runs only a small smoke (LightningMatcherSim.test.ts).
 */
import {
  LIGHTNING_MATCHER_PARAM_DEFAULTS,
  lightningMatcherModel,
  type LightningMatcherParams,
  type LightningPoolPlayer,
  type LightningRecentHand,
} from './LightningMatcherModel.js';
import { quantileSorted } from './LightningTelemetry.js';

export interface LightningSimOptions {
  /** Players at the start (and the steady-state target). */
  players: number;
  /** Stop after this many hands have been formed. */
  hands: number;
  seed: number;
  /** matcher_version to drive (LightningMatcherModel). */
  version: string;
  instanceMin: number;
  instanceTarget: number;
  instanceMax: number;
  /** New players per minute (default: replaces departures at the target size). */
  arrivalsPerMin: number | null;
  /** Chance per idle player-hour of leaving the pool. */
  departuresPerHour: number;
  /** Share of dealt players who fast-fold early (the rest play to the hand's end). */
  foldRate: number;
  /** Chance per idle player-hour of sitting out (for 30 s to 3 min). */
  sitOutsPerHour: number;
  /** Chance per idle player-hour of a disconnect (for 5 s to 2 min). */
  disconnectsPerHour: number;
  /** Share of disconnects that come back (the rest leave). */
  reconnectShare: number;
  /** Conversion thresholds (the Cluster's on / off, by active players). */
  onThreshold: number;
  offThreshold: number;
  /** Matcher pass interval. */
  passIntervalMs: number;
  firstEntryRule: 'any_seat' | 'big_blind';
  positionFairness: boolean;
  /** The candidate's knobs (m2): P5 thin-band weight (null = half the medium) and diversity scale. */
  candidateThinWeight: number | null;
  candidateDiversityScale: number;
  /** Safety stop. */
  maxSimHours: number;
}

export const LIGHTNING_SIM_DEFAULTS: Readonly<LightningSimOptions> = Object.freeze({
  players: 50,
  hands: 10_000,
  seed: 1,
  version: 'm1',
  instanceMin: 2,
  instanceTarget: 9,
  instanceMax: 9,
  arrivalsPerMin: null,
  departuresPerHour: 1,
  foldRate: 0.75,
  sitOutsPerHour: 0.5,
  disconnectsPerHour: 0.3,
  reconnectShare: 0.8,
  onThreshold: 27,
  offThreshold: 18,
  passIntervalMs: 1_000,
  firstEntryRule: 'any_seat',
  positionFairness: true,
  candidateThinWeight: null,
  candidateDiversityScale: 1,
  maxSimHours: 2_000,
});

export interface LightningSimResult {
  version: string;
  options: LightningSimOptions;
  sim_hours: number;
  passes: number;
  hands: number;
  hands_per_hour: number;
  wait_ms: { avg: number | null; p50: number | null; p95: number | null; p99: number | null };
  bb_per_player: { mean: number | null; min: number | null; max: number | null };
  sb_per_player: { mean: number | null; min: number | null; max: number | null };
  btn_per_player: { mean: number | null; min: number | null; max: number | null };
  /** Big blinds per 100 hands played, std dev across players with 20+ hands. */
  bb_per_100_std_dev: number | null;
  /** Hands dealt to a player between two of their big blinds. */
  max_bb_gap: number | null;
  bb_gap_std_dev: number | null;
  position_distribution: Record<string, number>;
  repeat_opponent_rate: number | null;
  repeat_group_rate: number | null;
  instance_utilization: number | null;
  avg_instance_size: number | null;
  conversions: number;
  conversions_per_hour: number;
  players_seen: number;
}

/** mulberry32: small, fast, seedable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Status = 'idle' | 'in_hand' | 'sitting_out' | 'disconnected' | 'gone';

interface SimPlayer {
  id: string;
  status: Status;
  untilMs: number;
  idleSinceMs: number;
  enteredAtMs: number;
  lastBbAtMs: number | null;
  handsSinceBb: number | null;
  positions: { btn: number; co: number; hj: number; utg: number };
  seenInHand: boolean;
  hands: number;
  bb: number;
  sb: number;
  btn: number;
  lastHand: string[] | null;
  /** Reconnects when the disconnect ends (else leaves). */
  comesBack: boolean;
  /** Session-clock events, applied at the player's next idle moment (a hand boundary). */
  leaveAtMs: number;
  sitOutAtMs: number;
  disconnectAtMs: number;
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
const stdDev = (xs: number[]): number | null => {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};
const r2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);
const r4 = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10_000) / 10_000;

export function runLightningMatcherSim(partial: Partial<LightningSimOptions>): LightningSimResult {
  const o: LightningSimOptions = { ...LIGHTNING_SIM_DEFAULTS, ...partial };
  const model = lightningMatcherModel(o.version);
  if (!model) throw new Error(`unknown matcher version '${o.version}'`);
  const rand = seededRandom(o.seed);
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * rand();
  const params: LightningMatcherParams = {
    ...LIGHTNING_MATCHER_PARAM_DEFAULTS,
    instanceMin: o.instanceMin,
    instanceTarget: o.instanceTarget,
    instanceMax: o.instanceMax,
    firstEntryRule: o.firstEntryRule,
    positionFairness: o.positionFairness,
    candidate: { thinWeight: o.candidateThinWeight, diversityScale: o.candidateDiversityScale },
  };
  const dt = Math.max(100, o.passIntervalMs);
  // Exponential waiting time for a per-player-hour rate (Infinity when the rate is 0).
  const after = (perHour: number): number =>
    perHour > 0 ? (-Math.log(1 - rand()) / perHour) * 3_600_000 : Infinity;
  const arrivalsPerTick =
    ((o.arrivalsPerMin ?? (o.players * o.departuresPerHour) / 60) * dt) / 60_000;

  const players = new Map<string, SimPlayer>();
  let nextId = 0;
  const spawn = (atMs: number): void => {
    const id = `p${String(nextId++).padStart(7, '0')}`;
    players.set(id, {
      id,
      status: 'idle',
      untilMs: 0,
      idleSinceMs: atMs,
      enteredAtMs: atMs,
      lastBbAtMs: null,
      handsSinceBb: null,
      positions: { btn: 0, co: 0, hj: 0, utg: 0 },
      seenInHand: false,
      hands: 0,
      bb: 0,
      sb: 0,
      btn: 0,
      lastHand: null,
      comesBack: true,
      leaveAtMs: atMs + after(o.departuresPerHour),
      sitOutAtMs: atMs + after(o.sitOutsPerHour),
      disconnectAtMs: atMs + after(o.disconnectsPerHour),
    });
  };
  // Entries staggered over the first pass interval: a deterministic queue.
  for (let i = 0; i < o.players; i++) spawn(Math.floor((i * dt) / Math.max(1, o.players)) - dt);

  const recent: LightningRecentHand[] = [];
  const recentSets: string[] = [];
  const waits: number[] = [];
  const bbGaps: number[] = [];
  const positions: Record<string, number> = { bb: 0, sb: 0, utg: 0, mp: 0, hj: 0, co: 0, btn: 0 };
  let seats = 0;
  let repeatOpp = 0;
  let oppPairs = 0;
  let repeatGroups = 0;
  let hands = 0;
  let passes = 0;
  let conversions = 0;
  let nowMs = 0;
  const limitMs = o.maxSimHours * 3_600_000;
  let lightningOn = o.players >= o.onThreshold;

  while (hands < o.hands && nowMs < limitMs) {
    nowMs += dt;
    passes++;
    // 1. Life events, in id order (deterministic).
    for (const p of players.values()) {
      if (p.status === 'gone') continue;
      if (p.status === 'in_hand' && p.untilMs <= nowMs) {
        p.status = 'idle';
        p.idleSinceMs = p.untilMs;
      } else if (p.status === 'sitting_out' && p.untilMs <= nowMs) {
        p.status = 'idle';
        p.idleSinceMs = nowMs;
      } else if (p.status === 'disconnected' && p.untilMs <= nowMs) {
        if (p.comesBack) {
          p.status = 'idle';
          p.idleSinceMs = nowMs;
        } else p.status = 'gone';
      }
      if (p.status !== 'idle') continue;
      // Rates are per player-hour of SESSION, applied when the player is free.
      if (nowMs >= p.leaveAtMs) p.status = 'gone';
      else if (nowMs >= p.disconnectAtMs) {
        p.status = 'disconnected';
        p.untilMs = nowMs + uniform(5_000, 120_000);
        p.comesBack = rand() < o.reconnectShare;
        p.disconnectAtMs = nowMs + after(o.disconnectsPerHour);
      } else if (nowMs >= p.sitOutAtMs) {
        p.status = 'sitting_out';
        p.untilMs = nowMs + uniform(30_000, 180_000);
        p.sitOutAtMs = nowMs + after(o.sitOutsPerHour);
      }
    }
    for (const [id, p] of players)
      if (p.status === 'gone' && p.lastHand === null) players.delete(id);
    // Arrivals: the whole part every tick, the fraction as a Bernoulli draw.
    for (let k = 0; k < Math.floor(arrivalsPerTick); k++) spawn(nowMs);
    if (rand() < arrivalsPerTick - Math.floor(arrivalsPerTick)) spawn(nowMs);

    // 2. Conversion hysteresis on active players.
    let active = 0;
    for (const p of players.values()) if (p.status !== 'gone') active++;
    if (lightningOn && active < o.offThreshold) {
      lightningOn = false;
      conversions++;
    } else if (!lightningOn && active >= o.onThreshold) {
      lightningOn = true;
      conversions++;
    }

    // 3. The pass: the pool as the matcher sees it.
    const pool: LightningPoolPlayer[] = [];
    for (const p of players.values()) {
      if (p.status === 'idle' || p.status === 'sitting_out' || p.status === 'disconnected') {
        pool.push({
          playerId: p.id,
          legal: p.status === 'idle',
          reasonCode:
            p.status === 'idle'
              ? null
              : p.status === 'sitting_out'
                ? 'SITTING_OUT'
                : 'DISCONNECTED',
          idleSinceMs: p.idleSinceMs,
          enteredAtMs: p.enteredAtMs,
          lastBbAtMs: p.lastBbAtMs,
          bbUnresolved: false,
          debtSinceMs: p.enteredAtMs,
          handsSinceBb: p.handsSinceBb,
          newcomer: !p.seenInHand,
          positions: { ...p.positions },
        });
      }
    }
    const plan = model.plan({ nowMs, players: pool, recentHands: recent }, params);

    // 4. Deal what was planned.
    for (const g of plan.groups) {
      if (hands >= o.hands) break;
      hands++;
      const members = g.players;
      const size = members.length;
      const key = [...members].sort().join(',');
      if (recentSets.includes(key)) repeatGroups++;
      const handEnd = nowMs + uniform(20_000, 60_000);
      for (let i = 0; i < size; i++) {
        const p = players.get(members[i])!;
        waits.push(Math.max(0, nowMs - p.idleSinceMs));
        seats++;
        p.hands++;
        p.seenInHand = true;
        // Seat labels in matcher order: bb, sb, utg (seat 3) ... hj, co, btn.
        let label: string;
        if (i === 0) label = 'bb';
        else if (i === 1 && size > 2) label = 'sb';
        else if (i === size - 1) label = 'btn';
        else if (i === size - 2) label = 'co';
        else if (i === size - 3) label = 'hj';
        else if (i === 2) label = 'utg';
        else label = 'mp';
        if (size === 2 && i === 1) label = 'btn'; // heads-up: the small blind is the button
        positions[label]++;
        if (label === 'btn') {
          p.btn++;
          p.positions.btn++;
        }
        if (i === 1) p.sb++;
        if (label === 'co') p.positions.co++;
        if (label === 'hj') p.positions.hj++;
        if (label === 'utg') p.positions.utg++;
        if (i === 0) {
          if (p.handsSinceBb !== null) bbGaps.push(p.handsSinceBb);
          p.bb++;
          p.lastBbAtMs = nowMs;
          p.handsSinceBb = 0;
        } else if (p.handsSinceBb !== null) p.handsSinceBb++;
        if (p.lastHand) {
          const prev = new Set(p.lastHand);
          for (const other of members) {
            if (other === p.id) continue;
            oppPairs++;
            if (prev.has(other)) repeatOpp++;
          }
        } else oppPairs += size - 1;
        p.lastHand = [...members];
        p.status = 'in_hand';
        p.untilMs = rand() < o.foldRate ? nowMs + uniform(1_500, 6_000) : handEnd;
      }
      recent.push({ players: [...members], formedAtMs: nowMs });
      recentSets.push(key);
      if (recent.length > params.recentWindowHands) recent.shift();
      if (recentSets.length > params.recentWindowHands) recentSets.shift();
    }
  }

  const simHours = nowMs / 3_600_000;
  const sortedWaits = [...waits].sort((a, b) => a - b);
  const everyone = [...players.values()].filter((p) => p.hands > 0);
  const pick = (f: (p: SimPlayer) => number) => {
    const xs = everyone.map(f);
    return {
      mean: r2(mean(xs)),
      min: xs.length ? Math.min(...xs) : null,
      max: xs.length ? Math.max(...xs) : null,
    };
  };
  const per100 = everyone.filter((p) => p.hands >= 20).map((p) => (100 * p.bb) / p.hands);
  const dist: Record<string, number> = {};
  for (const [k, v] of Object.entries(positions)) dist[k] = r4(seats === 0 ? 0 : v / seats) ?? 0;
  return {
    version: o.version,
    options: o,
    sim_hours: r2(simHours) ?? 0,
    passes,
    hands,
    hands_per_hour: r2(simHours === 0 ? 0 : hands / simHours) ?? 0,
    wait_ms: {
      avg: r2(mean(waits)),
      p50: quantileSorted(sortedWaits, 0.5),
      p95: quantileSorted(sortedWaits, 0.95),
      p99: quantileSorted(sortedWaits, 0.99),
    },
    bb_per_player: pick((p) => p.bb),
    sb_per_player: pick((p) => p.sb),
    btn_per_player: pick((p) => p.btn),
    bb_per_100_std_dev: r2(stdDev(per100)),
    max_bb_gap: bbGaps.length ? Math.max(...bbGaps) : null,
    bb_gap_std_dev: r2(stdDev(bbGaps)),
    position_distribution: dist,
    repeat_opponent_rate: r4(oppPairs === 0 ? null : repeatOpp / oppPairs),
    repeat_group_rate: r4(hands === 0 ? null : repeatGroups / hands),
    instance_utilization: r4(hands === 0 ? null : seats / hands / o.instanceMax),
    avg_instance_size: r2(hands === 0 ? null : seats / hands),
    conversions,
    conversions_per_hour: r2(simHours === 0 ? 0 : conversions / simHours) ?? 0,
    players_seen: nextId,
  };
}

/** A readable table, one row per result. */
export function formatLightningSimTable(results: readonly LightningSimResult[]): string {
  const cols: Array<[string, (r: LightningSimResult) => string]> = [
    ['Version', (r) => r.version],
    ['Players', (r) => String(r.options.players)],
    ['Hands', (r) => String(r.hands)],
    ['Hands/Hour', (r) => String(Math.round(r.hands_per_hour))],
    ['Avg Wait s', (r) => fmtS(r.wait_ms.avg)],
    ['P95 Wait s', (r) => fmtS(r.wait_ms.p95)],
    ['P99 Wait s', (r) => fmtS(r.wait_ms.p99)],
    ['BB/100 SD', (r) => fmt(r.bb_per_100_std_dev)],
    ['Max BB Gap', (r) => fmt(r.max_bb_gap)],
    ['BB Gap SD', (r) => fmt(r.bb_gap_std_dev)],
    ['BTN Share', (r) => pct(r.position_distribution.btn)],
    ['Repeat Opp', (r) => pct(r.repeat_opponent_rate)],
    ['Repeat Group', (r) => pct(r.repeat_group_rate)],
    ['Avg Size', (r) => fmt(r.avg_instance_size)],
    ['Utilization', (r) => pct(r.instance_utilization)],
    ['Conv/Hour', (r) => fmt(r.conversions_per_hour)],
  ];
  const rows = results.map((r) => cols.map(([, f]) => f(r)));
  const widths = cols.map(([h], i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  return [
    line(cols.map(([h]) => h)),
    '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|',
    ...rows.map(line),
  ].join('\n');
}

const fmt = (v: number | null): string => (v === null ? '-' : String(v));
const fmtS = (v: number | null): string => (v === null ? '-' : (v / 1000).toFixed(2));
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`;
