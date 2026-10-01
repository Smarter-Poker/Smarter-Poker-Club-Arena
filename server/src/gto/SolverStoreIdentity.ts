/**
 * Immutable identity of an in-memory solver store (Phase 6C G4, 2026-09-27).
 *
 * A row count says how big a store is, not which store it is: two chart sets
 * of 240 rows with one different frequency have the same count and decide
 * differently. The identity is a content digest over exactly what the brain
 * reads (every lookup key and its hand matrix, in key order, with object keys
 * sorted), the number of entries, and the source's own build revision.
 *
 * The digest is computed by the store module when it swaps a store in, from
 * the validated Map it will read, so live decisions, the worker's journal
 * receipt and an offline replay that loads the same rows through the same
 * store reader all compute it the same way. Nothing here changes a lookup.
 */
import { createHash } from 'node:crypto';

export const SOLVER_STORE_IDENTITY_VERSION = 'solver-store-identity-v1' as const;

export interface SolverStoreIdentity {
  version: typeof SOLVER_STORE_IDENTITY_VERSION;
  /** Entries the brain can read (lookup keys), not source rows fetched. */
  rows: number;
  /** SHA-256 over the keyed content, hex. */
  digest: string;
  /** The source's own build watermark (latest created_at / built_at), or null. */
  revision: string | null;
}

/** The identities the decision worker reports beside every decision. */
export interface HorseSolverStoreIdentity {
  charts: SolverStoreIdentity;
  postflop: SolverStoreIdentity;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    // undefined, functions and symbols are not store content.
    if (text === undefined) throw new Error('solver_store_identity_unserializable');
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** Digest a keyed store. Insertion order does not matter; content does. */
export function solverStoreIdentity(
  entries: ReadonlyMap<string, unknown>,
  revision: string | null
): SolverStoreIdentity {
  const hash = createHash('sha256');
  hash.update(`${SOLVER_STORE_IDENTITY_VERSION}\n`);
  for (const key of [...entries.keys()].sort()) {
    hash.update(`${JSON.stringify(key)}\n${canonical(entries.get(key))}\n`);
  }
  return Object.freeze({
    version: SOLVER_STORE_IDENTITY_VERSION,
    rows: entries.size,
    digest: hash.digest('hex'),
    revision,
  });
}

/** Latest ISO timestamp in a column, compared as instants; null when none parse. */
export function latestRevision(values: Iterable<unknown>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isSolverStoreIdentity(value: unknown): value is SolverStoreIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === SOLVER_STORE_IDENTITY_VERSION &&
    Number.isSafeInteger(v.rows) &&
    (v.rows as number) >= 0 &&
    typeof v.digest === 'string' &&
    HEX64.test(v.digest) &&
    (v.revision === null || typeof v.revision === 'string')
  );
}

export function isHorseSolverStoreIdentity(value: unknown): value is HorseSolverStoreIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isSolverStoreIdentity(v.charts) && isSolverStoreIdentity(v.postflop);
}

/** Same store: same digest over the same number of entries (and revision when both know it). */
export function sameSolverStoreIdentity(a: SolverStoreIdentity, b: SolverStoreIdentity): boolean {
  return (
    a.version === b.version &&
    a.rows === b.rows &&
    a.digest === b.digest &&
    (a.revision === null || b.revision === null || a.revision === b.revision)
  );
}
