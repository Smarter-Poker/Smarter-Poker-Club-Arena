/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TYPED DOORS TO THE LIGHTNING SQL (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The matcher is SQL. This file is the only place the engine calls it, and
 * the only place the jsonb it returns becomes a TypeScript type: every shape
 * is VALIDATED at runtime before anything reads it, because a jsonb column
 * can say anything and a cast would only move the crash somewhere harder to
 * find.
 *
 * THE CONTRACT (written by the SQL side; this code honours it and nothing more):
 *
 *   fn_lightning_match(p_cluster_id uuid, p_now timestamptz,
 *                      p_disconnected uuid[], p_matcher_version text) -> jsonb
 *     STABLE, writes nothing. Returns
 *       { matcher_version, groups: [{ players: uuid[], bb: uuid, keys: {...} }],
 *         diagnosis: [{ player_id, state, reason_code }],
 *         pool_diversity_score, legal_count, generated_at }
 *     state is one of MATCHED, WAITING_FOR_PLAYERS, WAITING_FOR_BB,
 *     WAITING_FOR_FORMATION, WAITING_FOR_RECONNECT, BLOCKED_WITH_REASON.
 *
 *   fn_lightning_match_and_form(p_cluster_id uuid, p_now timestamptz,
 *                               p_disconnected uuid[], p_max_hands integer,
 *                               p_request_id uuid) -> jsonb
 *     The WRITER. Typed here so there is exactly one door when a dealing host
 *     exists; nothing calls it yet (see LightningClusterWorker, 'form' mode).
 *
 *   fn_lightning_config(p_cluster_id uuid) -> jsonb   (see LightningConfig.ts)
 *
 * NOT YET DEPLOYED IS NOT AN ERROR. The engine ships ahead of the migration,
 * so every wrapper turns "function not found" (PGRST202 / 42883) into a typed
 * `unavailable` outcome. A caller decides what unavailable means; none of
 * them treats it as a fault.
 */
import { parseLightningConfig, type LightningConfig } from './LightningConfig.js';
import { isMissingFunctionError } from './rpcErrors.js';

/** The minimal slice of `supabase.rpc` these doors need; injected for tests. */
export type LightningRpcClient = (
  fn: string,
  args: Record<string, unknown>
) => PromiseLike<{ data: unknown; error: unknown }>;

export type LightningRpcOutcome<T> =
  | { status: 'ok'; value: T }
  /** The function is not deployed yet. Not a fault. */
  | { status: 'unavailable'; reason: string }
  /** It answered, and the answer does not satisfy the contract above. */
  | { status: 'invalid'; reason: string }
  /** Transport or database failure. */
  | { status: 'error'; error: unknown };

export const LIGHTNING_PLAYER_STATES = [
  'MATCHED',
  'WAITING_FOR_PLAYERS',
  'WAITING_FOR_BB',
  'WAITING_FOR_FORMATION',
  'WAITING_FOR_RECONNECT',
  'BLOCKED_WITH_REASON',
] as const;
export type LightningPlayerState = (typeof LIGHTNING_PLAYER_STATES)[number];

export interface LightningMatchGroup {
  players: string[];
  bb: string;
  keys: Record<string, unknown>;
}

export interface LightningDiagnosisEntry {
  playerId: string;
  state: LightningPlayerState;
  reasonCode: string | null;
}

export interface LightningMatchResult {
  matcherVersion: string | null;
  groups: LightningMatchGroup[];
  diagnosis: LightningDiagnosisEntry[];
  poolDiversityScore: number | null;
  legalCount: number;
  generatedAt: string | null;
}

export interface LightningMatchArgs {
  clusterId: string;
  now: Date;
  disconnected: readonly string[];
  matcherVersion: string | null;
}

export interface LightningFormArgs {
  clusterId: string;
  now: Date;
  disconnected: readonly string[];
  maxHands: number;
  requestId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return undefined; // present and not a number: invalid
}

type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Validate `fn_lightning_match`'s jsonb against the contract. Never throws. */
export function validateLightningMatchResult(raw: unknown): Validation<LightningMatchResult> {
  if (!isPlainObject(raw)) return { ok: false, reason: 'result_not_object' };

  if (!Array.isArray(raw.groups)) return { ok: false, reason: 'groups_not_array' };
  const groups: LightningMatchGroup[] = [];
  for (const [i, g] of raw.groups.entries()) {
    if (!isPlainObject(g)) return { ok: false, reason: `group_${i}_not_object` };
    if (!Array.isArray(g.players) || g.players.length === 0 || !g.players.every(isUuid))
      return { ok: false, reason: `group_${i}_players_invalid` };
    if (new Set(g.players).size !== g.players.length)
      return { ok: false, reason: `group_${i}_players_repeated` };
    if (!isUuid(g.bb)) return { ok: false, reason: `group_${i}_bb_invalid` };
    if (!g.players.includes(g.bb)) return { ok: false, reason: `group_${i}_bb_not_in_group` };
    if (g.keys !== undefined && g.keys !== null && !isPlainObject(g.keys))
      return { ok: false, reason: `group_${i}_keys_not_object` };
    groups.push({
      players: [...g.players],
      bb: g.bb,
      keys: isPlainObject(g.keys) ? { ...g.keys } : {},
    });
  }
  // A player may be in at most one group.
  const grouped = new Set<string>();
  for (const g of groups) {
    for (const p of g.players) {
      if (grouped.has(p)) return { ok: false, reason: 'player_in_two_groups' };
      grouped.add(p);
    }
  }

  if (!Array.isArray(raw.diagnosis)) return { ok: false, reason: 'diagnosis_not_array' };
  const diagnosis: LightningDiagnosisEntry[] = [];
  const diagnosed = new Set<string>();
  for (const [i, d] of raw.diagnosis.entries()) {
    if (!isPlainObject(d)) return { ok: false, reason: `diagnosis_${i}_not_object` };
    if (!isUuid(d.player_id)) return { ok: false, reason: `diagnosis_${i}_player_invalid` };
    if (
      typeof d.state !== 'string' ||
      !(LIGHTNING_PLAYER_STATES as readonly string[]).includes(d.state)
    )
      return { ok: false, reason: `diagnosis_${i}_state_invalid` };
    if (d.reason_code !== undefined && d.reason_code !== null && typeof d.reason_code !== 'string')
      return { ok: false, reason: `diagnosis_${i}_reason_invalid` };
    if (diagnosed.has(d.player_id)) return { ok: false, reason: 'player_diagnosed_twice' };
    diagnosed.add(d.player_id);
    diagnosis.push({
      playerId: d.player_id,
      state: d.state as LightningPlayerState,
      reasonCode: typeof d.reason_code === 'string' ? d.reason_code : null,
    });
  }
  // Every grouped player is diagnosed MATCHED, and nobody else is.
  for (const d of diagnosis) {
    if ((d.state === 'MATCHED') !== grouped.has(d.playerId))
      return { ok: false, reason: 'matched_state_disagrees_with_groups' };
  }
  for (const p of grouped) {
    if (!diagnosed.has(p)) return { ok: false, reason: 'grouped_player_not_diagnosed' };
  }

  const legal = optionalNumber(raw.legal_count);
  if (legal === undefined || legal === null || !Number.isInteger(legal) || legal < 0)
    return { ok: false, reason: 'legal_count_invalid' };
  const diversity = optionalNumber(raw.pool_diversity_score);
  if (diversity === undefined) return { ok: false, reason: 'pool_diversity_score_invalid' };
  if (
    raw.matcher_version !== undefined &&
    raw.matcher_version !== null &&
    typeof raw.matcher_version !== 'string'
  )
    return { ok: false, reason: 'matcher_version_invalid' };
  if (
    raw.generated_at !== undefined &&
    raw.generated_at !== null &&
    (typeof raw.generated_at !== 'string' || Number.isNaN(Date.parse(raw.generated_at)))
  )
    return { ok: false, reason: 'generated_at_invalid' };

  return {
    ok: true,
    value: {
      matcherVersion: typeof raw.matcher_version === 'string' ? raw.matcher_version : null,
      groups,
      diagnosis,
      poolDiversityScore: diversity,
      legalCount: legal,
      generatedAt: typeof raw.generated_at === 'string' ? raw.generated_at : null,
    },
  };
}

async function call(
  rpc: LightningRpcClient,
  fn: string,
  args: Record<string, unknown>
): Promise<LightningRpcOutcome<unknown>> {
  try {
    const { data, error } = await rpc(fn, args);
    if (error) {
      if (isMissingFunctionError(error))
        return { status: 'unavailable', reason: `${fn}_not_found` };
      return { status: 'error', error };
    }
    return { status: 'ok', value: data };
  } catch (error) {
    if (isMissingFunctionError(error)) return { status: 'unavailable', reason: `${fn}_not_found` };
    return { status: 'error', error };
  }
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isUuid))].sort();
}

/** The read-only matcher. One RPC, validated. */
export async function lightningMatch(
  rpc: LightningRpcClient,
  args: LightningMatchArgs
): Promise<LightningRpcOutcome<LightningMatchResult>> {
  if (!isUuid(args.clusterId)) return { status: 'invalid', reason: 'cluster_id_invalid' };
  const out = await call(rpc, 'fn_lightning_match', {
    p_cluster_id: args.clusterId,
    p_now: args.now.toISOString(),
    p_disconnected: sortedUnique(args.disconnected),
    p_matcher_version: args.matcherVersion,
  });
  if (out.status !== 'ok') return out;
  const checked = validateLightningMatchResult(out.value);
  return checked.ok
    ? { status: 'ok', value: checked.value }
    : { status: 'invalid', reason: checked.reason };
}

/** The Cluster's worker configuration. Unavailable when the function is not deployed. */
export async function lightningConfig(
  rpc: LightningRpcClient,
  clusterId: string
): Promise<LightningRpcOutcome<LightningConfig>> {
  if (!isUuid(clusterId)) return { status: 'invalid', reason: 'cluster_id_invalid' };
  const out = await call(rpc, 'fn_lightning_config', { p_cluster_id: clusterId });
  if (out.status !== 'ok') return out;
  if (!isPlainObject(out.value)) return { status: 'invalid', reason: 'config_not_object' };
  return { status: 'ok', value: parseLightningConfig(out.value) };
}

/**
 * The WRITER. Present so the door exists in one place with one validation;
 * NOT called by the shadow worker, which refuses 'form' mode outright (a
 * formed hand with no dealing host would sit until reaped). The result is
 * returned as a validated plain object: its inner shape belongs to the
 * dealing host that will consume it.
 */
export async function lightningMatchAndForm(
  rpc: LightningRpcClient,
  args: LightningFormArgs
): Promise<LightningRpcOutcome<Record<string, unknown>>> {
  if (!isUuid(args.clusterId)) return { status: 'invalid', reason: 'cluster_id_invalid' };
  if (!isUuid(args.requestId)) return { status: 'invalid', reason: 'request_id_invalid' };
  if (!Number.isInteger(args.maxHands) || args.maxHands < 1)
    return { status: 'invalid', reason: 'max_hands_invalid' };
  const out = await call(rpc, 'fn_lightning_match_and_form', {
    p_cluster_id: args.clusterId,
    p_now: args.now.toISOString(),
    p_disconnected: sortedUnique(args.disconnected),
    p_max_hands: args.maxHands,
    p_request_id: args.requestId,
  });
  if (out.status !== 'ok') return out;
  if (!isPlainObject(out.value)) return { status: 'invalid', reason: 'form_result_not_object' };
  return { status: 'ok', value: { ...out.value } };
}

/** Counts by state and the most frequent block reasons: what a shadow pass records. */
export interface LightningDiagnosisSummary {
  players: number;
  groups: number;
  legalCount: number;
  poolDiversityScore: number | null;
  byState: Record<LightningPlayerState, number>;
  /** reason_code -> count, for BLOCKED_WITH_REASON and any state that carries one. */
  byReason: Record<string, number>;
}

/** Reasons beyond this many distinct codes fold into `other`, so a log line stays bounded. */
export const LIGHTNING_SUMMARY_MAX_REASONS = 16;

export function summarizeLightningMatch(result: LightningMatchResult): LightningDiagnosisSummary {
  const byState = Object.fromEntries(LIGHTNING_PLAYER_STATES.map((s) => [s, 0])) as Record<
    LightningPlayerState,
    number
  >;
  const byReason: Record<string, number> = {};
  for (const d of result.diagnosis) {
    byState[d.state]++;
    if (d.reasonCode) {
      const known = Object.keys(byReason).length;
      const key =
        d.reasonCode in byReason || known < LIGHTNING_SUMMARY_MAX_REASONS ? d.reasonCode : 'other';
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
  }
  return {
    players: result.diagnosis.length,
    groups: result.groups.length,
    legalCount: result.legalCount,
    poolDiversityScore: result.poolDiversityScore,
    byState,
    byReason,
  };
}
