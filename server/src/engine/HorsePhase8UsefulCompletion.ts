/**
 * P8.1 equivalence digest for the frozen useful-completion population
 * (docs/evidence/phase8/). Runs each frozen live-worker request through the
 * real HorseLogic.decide with the clock frozen at zero, so no deadline can stop
 * work, and digests the complete decision: selected action and amount, every
 * Phase 7 and Phase 8 candidate distribution, utility moment, continuation
 * work counter and receipt. Timing fields are the only exclusions. Two source
 * trees with equal digests produce identical selected actions, distributions,
 * sample orders (every order-dependent floating sum is part of the digest)
 * and receipts for the population.
 *
 * Shared by scripts/phase8-useful-completion.mjs (compiled) and
 * HorsePhase8UsefulCompletion.test.ts (source). Offline only: the caller
 * owns the clock substitution; no network, filesystem or live state.
 */
import { createHash } from 'node:crypto';
import { HorseLogic, type HorseGameStateV2 } from './HorseLogic.js';
import { seedFastRandom } from './HorseEval.js';
import type { SeatPlayer } from '../types.js';

export const PHASE8_USEFUL_COMPLETION_DIGEST_SCHEMA = 'horse-phase8-useful-completion-digest-v1';
const TIMING_FIELDS = new Set([
  'latencyMs',
  'simulationMs',
  'policyMs',
  'thinkTime',
  'computeMs',
  'elapsedMs',
]);
const DIGEST_SEED = 8101101;

export interface Phase8UsefulCompletionRequest {
  player: SeatPlayer;
  gameState: HorseGameStateV2;
  style?: string;
  mods?: Record<string, unknown>;
  opts?: Record<string, unknown>;
  decisionTimeMs: number;
}
export interface Phase8UsefulCompletionDigestRow {
  index: number;
  action: string;
  amount: number | null;
  reason: string | null;
  completed: boolean | null;
  sha256: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export function canonicalPhase8Value(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalPhase8Value);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonicalPhase8Value((v as Record<string, unknown>)[k])])
    );
  return v;
}

/** The caller must have frozen performance.now() before calling. `order`
 * visits the requests in another sequence; each decision's seed and row stay
 * bound to its population index, so any order must yield the same rows. */
export function digestPhase8UsefulCompletion(
  requests: readonly Phase8UsefulCompletionRequest[],
  order?: readonly number[]
): { rows: Phase8UsefulCompletionDigestRow[]; sha256: string } {
  const rows: Phase8UsefulCompletionDigestRow[] = new Array(requests.length);
  const visit = order ?? requests.map((_, index) => index);
  for (const index of visit) {
    const r = requests[index];
    seedFastRandom((DIGEST_SEED ^ Math.imul(index + 1, 2654435761)) >>> 0);
    const decision = HorseLogic.decide(
      structuredClone(r.player),
      structuredClone(r.gameState),
      (r.style ?? 'balanced') as Parameters<typeof HorseLogic.decide>[2],
      (r.mods ?? {}) as Parameters<typeof HorseLogic.decide>[3],
      {
        ...(r.opts ?? {}),
        phase8Postflop: 'candidate',
        decisionTimeMs: r.decisionTimeMs,
        telemetry: false,
      }
    );
    const stripped = JSON.parse(
      JSON.stringify(decision, (k, v) => (TIMING_FIELDS.has(k) ? undefined : v))
    );
    rows[index] = {
      index,
      action: stripped.action,
      amount: stripped.amount ?? null,
      reason: stripped.tournamentPostflop?.reason ?? null,
      completed: stripped.tournamentPostflop?.completed ?? null,
      sha256: sha256(JSON.stringify(canonicalPhase8Value(stripped))),
    };
  }
  return { rows, sha256: sha256(JSON.stringify(rows)) };
}
