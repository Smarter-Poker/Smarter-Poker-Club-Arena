/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  GTO SOLVER CLIENT: interface, test stub, and local artifact adapter
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Production policy lookup uses the versioned local artifact loader and never
 * performs network I/O on an action clock. World Hub owns artifact production;
 * this module adapts those canonical policies for PostSessionAnalyzer.
 *
 * The analyzer looks up strategies by `scenario_hash`. `computeScenarioHash`
 * produces a stable hash from a normalized Scenario so the same decision maps to
 * the same solved node on both sides of the pipeline.
 */

import { lookupSolverPolicy } from './SolverPolicyArtifactLoader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

/** One action option at a solved node with its GTO frequency + EV (in big blinds). */
export interface SolverActionStrategy {
  action: string; // 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all_in' | sizing-tagged e.g. 'bet_50'
  frequency: number; // 0..1
  ev: number; // expected value in big blinds
}

export interface SolverStrategy {
  scenarioHash: string;
  /** Normalized so frequencies sum to ~1 (solver mixed strategy). */
  actions: SolverActionStrategy[];
  /** Optional metadata from the solve (grid, iterations, exploitability). */
  meta?: Record<string, unknown>;
}

/** A normalized decision point. Keep fields coarse/bucketed so hashes are stable. */
export interface Scenario {
  gameVariant: string;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  /** Position label if known, else 'unknown'. */
  position: string;
  /** Bucketed effective stack depth in bb (e.g. '100bb', '50bb', '20bb'). */
  stackBucket: string;
  /** Bucketed pot-odds / pot size context, or 'na'. */
  potBucket: string;
  /** Canonical board key ('' preflop, else sorted ranks+suit pattern). */
  boardKey: string;
  /** Canonical hero holding class (e.g. 'AKs', 'QQ', 'T9o', or 'unknown'). */
  heroHoleClass: string;
  /** What the hero is facing: 'unopened' | 'facing_bet' | 'facing_raise'. */
  facing: string;
}

/** The lookup contract implemented by every solver source. */
export interface GtoSolverClient {
  lookup(scenarioHash: string): Promise<SolverStrategy | null>;
  /** Optional batch optimization; default impls may map over lookup. */
  lookupBatch?(scenarioHashes: string[]): Promise<Map<string, SolverStrategy | null>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario hashing (FNV-1a, dependency-free, stable across processes)
// ─────────────────────────────────────────────────────────────────────────────

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in 32-bit range
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ('00000000' + hash.toString(16)).slice(-8);
}

/** Deterministic scenario hash. Field order is fixed and canonicalized. */
export function computeScenarioHash(s: Scenario): string {
  const canonical = [
    s.gameVariant,
    s.street,
    s.position,
    s.stackBucket,
    s.potBucket,
    s.boardKey,
    s.heroHoleClass,
    s.facing,
  ]
    .map((v) => String(v).toLowerCase().trim())
    .join('|');
  return `${s.gameVariant.toLowerCase()}:${s.street}:${fnv1a(canonical)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory test/local-development client
// ─────────────────────────────────────────────────────────────────────────────

export class StubGtoSolverClient implements GtoSolverClient {
  private table = new Map<string, SolverStrategy>();
  private fallback?: (scenarioHash: string) => SolverStrategy | null;

  constructor(
    entries: SolverStrategy[] = [],
    fallback?: (scenarioHash: string) => SolverStrategy | null
  ) {
    for (const e of entries) this.table.set(e.scenarioHash, e);
    this.fallback = fallback;
  }

  register(strategy: SolverStrategy): void {
    this.table.set(strategy.scenarioHash, strategy);
  }

  async lookup(scenarioHash: string): Promise<SolverStrategy | null> {
    return this.table.get(scenarioHash) ?? this.fallback?.(scenarioHash) ?? null;
  }

  async lookupBatch(scenarioHashes: string[]): Promise<Map<string, SolverStrategy | null>> {
    const out = new Map<string, SolverStrategy | null>();
    for (const h of scenarioHashes) out.set(h, await this.lookup(h));
    return out;
  }
}

/**
 * Reads the immutable artifact map. A policy without measured per-action EV
 * cannot feed an EV-loss analyzer and fails closed instead of inventing EV.
 */
export class ArtifactGtoSolverClient implements GtoSolverClient {
  async lookup(scenarioHash: string): Promise<SolverStrategy | null> {
    const policy = lookupSolverPolicy({ scenarioHash });
    if (!policy || policy.kind === 'unavailable' || policy.chipEv.measuredByAction !== true)
      return null;
    const actions = policy.actions.map((action) => ({
      action: action.family,
      frequency: action.frequency,
      ev: action.chipEvBb,
    }));
    if (actions.some((action) => !Number.isFinite(action.ev))) return null;
    // PostSessionAnalyzer currently observes action families but not the exact
    // wager size. Two canonical actions in one family would make its fallback
    // match arbitrary, so withhold the policy rather than mis-score a hand.
    if (new Set(actions.map((action) => action.action)).size !== actions.length) return null;
    return {
      scenarioHash,
      actions: actions as SolverActionStrategy[],
      meta: {
        contractVersion: policy.contractVersion,
        policyVersion: policy.policyVersion,
        qualitySeal: policy.qualitySeal,
        sourceArtifact: policy.sourceArtifact,
      },
    };
  }

  async lookupBatch(scenarioHashes: string[]): Promise<Map<string, SolverStrategy | null>> {
    const result = new Map<string, SolverStrategy | null>();
    for (const hash of scenarioHashes) result.set(hash, await this.lookup(hash));
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional off-clock fetch adapter. Never use this from HorseLogic.decide().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches a solved strategy for a scenario hash. In production this is backed by
 * the World Hub ScenarioDatabase (Supabase table produced by the solver
 * pipeline). Supply an implementation that queries by scenario_hash, e.g.:
 *
 *   const fetcher: SolverFetcher = async (hash) => {
 *     const { data } = await worldHubSupabase
 *       .from('solver_strategies')          // <-- table owned by World Hub pipeline
 *       .select('scenario_hash, actions, meta')
 *       .eq('scenario_hash', hash)
 *       .maybeSingle();
 *     return data ? { scenarioHash: data.scenario_hash, actions: data.actions, meta: data.meta } : null;
 *   };
 *
 * This adapter is only for explicit off-clock workflows. Production action
 * decisions and post-session analysis use ArtifactGtoSolverClient so a remote
 * fetch can never leak into HorseLogic.decide().
 */
export type SolverFetcher = (scenarioHash: string) => Promise<SolverStrategy | null>;

export interface WorldHubClientOptions {
  /** In-process LRU-ish cache size (0 disables). */
  cacheSize?: number;
}

export class WorldHubGtoSolverClient implements GtoSolverClient {
  private cache = new Map<string, SolverStrategy | null>();
  private readonly cacheSize: number;

  constructor(
    private readonly fetcher: SolverFetcher,
    opts: WorldHubClientOptions = {}
  ) {
    this.cacheSize = opts.cacheSize ?? 5000;
  }

  async lookup(scenarioHash: string): Promise<SolverStrategy | null> {
    if (this.cache.has(scenarioHash)) return this.cache.get(scenarioHash) ?? null;
    const result = await this.fetcher(scenarioHash);
    if (this.cacheSize > 0) {
      if (this.cache.size >= this.cacheSize) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
      this.cache.set(scenarioHash, result);
    }
    return result;
  }

  async lookupBatch(scenarioHashes: string[]): Promise<Map<string, SolverStrategy | null>> {
    const out = new Map<string, SolverStrategy | null>();
    for (const h of scenarioHashes) out.set(h, await this.lookup(h));
    return out;
  }
}
