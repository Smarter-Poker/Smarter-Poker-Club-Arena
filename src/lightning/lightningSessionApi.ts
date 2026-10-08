/**
 * LIGHTNING PHASE 8: THE PLAYER'S OWN LIGHTNING NUMBERS, READ FROM THE DATABASE.
 *
 * Five browser RPCs (granted to `authenticated`, each answering for the
 * caller only):
 *
 *   fn_lightning_my_sessions()                    every open pool session
 *   fn_lightning_session_stats(p_pool_session_id)  the running session
 *   fn_lightning_session_summary(p_pool_session_id) the same, plus how it ended
 *   fn_lightning_pool_status(p_cluster_id)         BUILDING / ACTIVE / HOT / THIN
 *   fn_lightning_recent_hands(p_limit, p_pool_session_id)  the last hands
 *
 * LIGHTNING PHASE 10 adds two more:
 *
 *   fn_lightning_stop_playing(p_cluster_id)  the responsible-gaming door: the
 *     caller stops after the current hand; the database ends the session
 *   fn_lightning_config(p_cluster_id)        read here only for the
 *     auto-rebuy keys the operator configured (a read-only status line)
 *
 * Every answer is parsed defensively here: a field that is missing or not a
 * number is "not known" (null), never a guess and never a zero that would
 * print as a real result. Nothing in this file moves money: STOP PLAYING
 * asks the database to stop dealing, and the database does the rest.
 */
import { supabase } from '../lib/supabase';
import { isUUID } from '../utils/clubIdResolver';
import type { LightningPoolStatus } from './lightningLobby';
import type { LightningMultiTableLimits } from './lightningCapabilities';

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function rowsOf(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { rows?: unknown }).rows)
      ? (raw as { rows: unknown[] }).rows
      : [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
}

function objectOf(raw: unknown): Record<string, unknown> | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  return row && typeof row === 'object' && !Array.isArray(row)
    ? (row as Record<string, unknown>)
    : null;
}

// ─── fn_lightning_my_sessions ──────────────────────────────────────────────

export interface LightningMySessionRow {
  poolSessionId: string;
  clusterId: string;
  name: string;
  /** "1/2" when the blinds are known, otherwise null. */
  stakes: string | null;
  bigBlind: number | null;
  variant: string | null;
  stack: number | null;
  inHand: boolean;
}

function stakesText(row: Record<string, unknown>): { stakes: string | null; bb: number | null } {
  /* The database sends `stakes: {sb, bb}` (Phase 8 migration); flat
     small_blind / big_blind or a "1/2" string are read too. */
  const nested =
    row.stakes && typeof row.stakes === 'object' && !Array.isArray(row.stakes)
      ? (row.stakes as Record<string, unknown>)
      : null;
  const sb = num(row.small_blind ?? row.sb ?? nested?.sb ?? nested?.small_blind);
  const bb = num(row.big_blind ?? row.bb ?? nested?.bb ?? nested?.big_blind);
  if (sb !== null && bb !== null && sb > 0 && bb > 0) return { stakes: `${sb}/${bb}`, bb };
  const s = text(row.stakes);
  const m = s ? /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(s) : null;
  return { stakes: s, bb: m ? Number(m[2]) : bb };
}

export function parseLightningMySessions(raw: unknown): LightningMySessionRow[] {
  const out: LightningMySessionRow[] = [];
  const seen = new Set<string>();
  for (const row of rowsOf(raw)) {
    const id = text(row.pool_session_id);
    const cluster = text(row.cluster_id);
    if (!id || !cluster || !isUUID(id) || !isUUID(cluster) || seen.has(id)) continue;
    seen.add(id);
    const { stakes, bb } = stakesText(row);
    out.push({
      poolSessionId: id,
      clusterId: cluster,
      name: text(row.name) ?? 'Lightning',
      stakes,
      bigBlind: bb,
      variant: text(row.variant),
      stack: num(row.stack),
      inHand: row.in_hand === true,
    });
  }
  return out;
}

export async function fetchLightningMySessions(): Promise<LightningMySessionRow[]> {
  const { data, error } = await supabase.rpc('fn_lightning_my_sessions');
  if (error) throw error;
  return parseLightningMySessions(data);
}

// ─── fn_lightning_session_stats / _summary ─────────────────────────────────

export interface LightningSessionStats {
  hands: number;
  handsPerHour: number | null;
  durationS: number | null;
  startingStack: number | null;
  currentStack: number | null;
  net: number | null;
  bbPer100: number | null;
  /** Percent, when the database can say. */
  vpip: number | null;
  pfr: number | null;
  avgPot: number | null;
  showdowns: number | null;
  fastFolds: number | null;
  normalFolds: number | null;
  foldAndWatch: number | null;
  avgWaitMs: number | null;
  p95WaitMs: number | null;
  p99WaitMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface LightningSessionSummary extends LightningSessionStats {
  ended: boolean;
  exitReason: string | null;
}

export function parseLightningSessionStats(raw: unknown): LightningSessionStats | null {
  const row = objectOf(raw);
  if (!row) return null;
  const hands = num(row.hands);
  if (hands === null) return null;
  return {
    hands: Math.max(0, Math.round(hands)),
    handsPerHour: num(row.hands_per_hour),
    durationS: num(row.duration_s),
    startingStack: num(row.starting_stack),
    currentStack: num(row.current_stack),
    net: num(row.net),
    bbPer100: num(row.bb_per_100),
    vpip: num(row.vpip),
    pfr: num(row.pfr),
    avgPot: num(row.avg_pot),
    showdowns: num(row.showdowns),
    fastFolds: num(row.fast_folds),
    normalFolds: num(row.normal_folds),
    foldAndWatch: num(row.fold_and_watch),
    avgWaitMs: num(row.avg_wait_ms),
    p95WaitMs: num(row.p95_wait_ms),
    p99WaitMs: num(row.p99_wait_ms),
    startedAt: text(row.started_at),
    endedAt: text(row.ended_at),
  };
}

export function parseLightningSessionSummary(raw: unknown): LightningSessionSummary | null {
  const stats = parseLightningSessionStats(raw);
  if (!stats) return null;
  const row = objectOf(raw)!;
  return { ...stats, ended: row.ended === true, exitReason: text(row.exit_reason) };
}

export async function fetchLightningSessionStats(
  poolSessionId: string
): Promise<LightningSessionStats | null> {
  const { data, error } = await supabase.rpc('fn_lightning_session_stats', {
    p_pool_session_id: poolSessionId,
  });
  if (error) throw error;
  return parseLightningSessionStats(data);
}

export async function fetchLightningSessionSummary(
  poolSessionId: string
): Promise<LightningSessionSummary | null> {
  const { data, error } = await supabase.rpc('fn_lightning_session_summary', {
    p_pool_session_id: poolSessionId,
  });
  if (error) throw error;
  return parseLightningSessionSummary(data);
}

// ─── fn_lightning_pool_status ──────────────────────────────────────────────

export interface LightningPoolHealth {
  players: number | null;
  status: LightningPoolStatus;
  /**
   * The database's own door verdict. The migrated fn_lightning_pool_status
   * answers {players, status, joinable, multi_table_limit} and drops
   * cluster_mode; an old payload (cluster_mode present, these absent) reads
   * as null - unknown, never a refusal.
   */
  joinable: boolean | null;
  /** The Cluster's configured per-device limits; null when the payload has none. */
  multiTableLimit: LightningMultiTableLimits | null;
}

const POOL_STATUSES: readonly LightningPoolStatus[] = ['BUILDING', 'ACTIVE', 'HOT', 'THIN'];

const LIMIT_DEVICES = ['desktop', 'tablet', 'mobile'] as const;

function parseMultiTableLimit(raw: unknown): LightningMultiTableLimits | null {
  const row = objectOf(raw);
  if (!row) return null;
  const out: LightningMultiTableLimits = {};
  for (const device of LIMIT_DEVICES) {
    const n = num(row[device]);
    if (n !== null && Number.isInteger(n) && n >= 1) out[device] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseLightningPoolHealth(raw: unknown): LightningPoolHealth | null {
  const row = objectOf(raw);
  if (!row) return null;
  const status = text(row.status)?.toUpperCase() ?? null;
  if (!status || !(POOL_STATUSES as readonly string[]).includes(status)) return null;
  const players = num(row.players);
  return {
    players: players === null ? null : Math.max(0, Math.round(players)),
    status: status as LightningPoolStatus,
    joinable: typeof row.joinable === 'boolean' ? row.joinable : null,
    multiTableLimit: parseMultiTableLimit(row.multi_table_limit),
  };
}

export async function fetchLightningPoolHealth(
  clusterId: string
): Promise<LightningPoolHealth | null> {
  const { data, error } = await supabase.rpc('fn_lightning_pool_status', {
    p_cluster_id: clusterId,
  });
  if (error) throw error;
  return parseLightningPoolHealth(data);
}

// ─── fn_lightning_recent_hands ─────────────────────────────────────────────

export type LightningFoldKindPlayed = 'fast' | 'normal' | 'fold_watch' | null;

export interface LightningRecentHand {
  handId: string;
  /** The hand_histories row the existing replay opens; null when not written yet. */
  handHistoryId: string | null;
  handNumber: number | null;
  playedAt: string | null;
  clusterId: string | null;
  smallBlind: number | null;
  bigBlind: number | null;
  position: string | null;
  stackBefore: number | null;
  stackAfter: number | null;
  net: number | null;
  pot: number | null;
  foldType: LightningFoldKindPlayed;
  showdown: boolean;
  result: string | null;
}

/** The panel's page size, and the RPC's default. */
export const LIGHTNING_RECENT_HANDS_LIMIT = 50;

function foldTypeOf(value: unknown): LightningFoldKindPlayed {
  return value === 'fast' || value === 'normal' || value === 'fold_watch' ? value : null;
}

export function parseLightningRecentHands(raw: unknown): LightningRecentHand[] {
  const out: LightningRecentHand[] = [];
  const seen = new Set<string>();
  for (const row of rowsOf(raw)) {
    const handId = text(row.hand_id);
    if (!handId || seen.has(handId)) continue;
    seen.add(handId);
    const hh = text(row.hand_history_id);
    const handNumber = num(row.hand_number);
    out.push({
      handId,
      handHistoryId: hh && isUUID(hh) ? hh : null,
      handNumber: handNumber === null ? null : Math.round(handNumber),
      playedAt: text(row.played_at),
      clusterId: text(row.cluster_id),
      smallBlind: num(row.small_blind),
      bigBlind: num(row.big_blind),
      position: text(row.position),
      stackBefore: num(row.stack_before),
      stackAfter: num(row.stack_after),
      net: num(row.net),
      pot: num(row.pot),
      foldType: foldTypeOf(row.fold_type),
      showdown: row.showdown === true,
      result: text(row.result),
    });
  }
  return out;
}

export async function fetchLightningRecentHands(
  opts: { limit?: number; poolSessionId?: string | null } = {}
): Promise<LightningRecentHand[]> {
  const limit = Math.max(1, Math.min(LIGHTNING_RECENT_HANDS_LIMIT, opts.limit ?? 50));
  const { data, error } = await supabase.rpc('fn_lightning_recent_hands', {
    p_limit: limit,
    p_pool_session_id: opts.poolSessionId ?? null,
  });
  if (error) throw error;
  return parseLightningRecentHands(data);
}

// ─── fn_lightning_stop_playing (LIGHTNING PHASE 10) ────────────────────────

/**
 * PostgREST's "no such function": the Phase 10 migration has not landed yet.
 * A deploy window, never a fault.
 */
export function isLightningRpcMissing(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'PGRST202' || e.code === '42883') return true;
  const m = typeof e.message === 'string' ? e.message : '';
  return /could not find the function|does not exist/i.test(m) && /fn_lightning_/i.test(m);
}

export interface LightningStopPlayingResult {
  ok: boolean;
  /** The stop is standing: no new hand will be dealt (`ok` answers it). */
  stopping: boolean;
  /** The session already exited (no live hand stood in the way). */
  exited: boolean;
  /** A hand is still live; the session ends when it settles. */
  inHand: boolean;
  reason: string | null;
}

/**
 * The migration's answer: `{ok, pool_session_id, exited, in_hand,
 * stop_requested_at}`, or `{ok:false, reason:'NO_SESSION'}`. An accepted
 * call always means the stop is standing (idempotent; a repeat answers the
 * same), so `stopping` is `ok` itself.
 */
export function parseLightningStopPlaying(raw: unknown): LightningStopPlayingResult {
  const row = objectOf(raw);
  if (!row) return { ok: false, stopping: false, exited: false, inHand: false, reason: null };
  return {
    ok: row.ok === true,
    stopping: row.ok === true,
    exited: row.exited === true,
    inHand: row.in_hand === true,
    reason: text(row.reason),
  };
}

/**
 * Ask the database to stop dealing the caller in this Cluster. `null` means
 * the function is not deployed yet (the control says it is not available);
 * a read failure throws. Nothing here ends the session itself: the database
 * refuses new hands at once and exits the session when the live hand (if
 * any) settles - the room then closes and the Phase 9 ended flow takes over.
 */
export async function stopLightningPlaying(
  clusterId: string
): Promise<LightningStopPlayingResult | null> {
  const { data, error } = await supabase.rpc('fn_lightning_stop_playing', {
    p_cluster_id: clusterId,
  });
  if (error) {
    if (isLightningRpcMissing(error)) return null;
    throw error;
  }
  return parseLightningStopPlaying(data);
}

/** The control's words. Title Case, no em dashes. */
export const LIGHTNING_STOP_PLAYING_LABEL = 'Stop Playing';
export const LIGHTNING_STOP_FINISHING_TEXT = 'Finishing Current Hand...';
export const LIGHTNING_STOP_STOPPING_TEXT = 'Stopping...';
export const LIGHTNING_STOP_UNAVAILABLE_TEXT = 'Stop Playing Is Not Available Right Now.';

// ─── The auto-rebuy status (fn_lightning_config, read-only) ────────────────

export interface LightningAutoRebuyStatus {
  enabled: boolean;
  /** The migration's enum: when the stack is gone, under N BB, or under N%. */
  trigger: 'zero' | 'below_bb' | 'below_pct';
  thresholdBb: number | null;
  thresholdPct: number | null;
  /** Refill to the initial buy-in, or to the table maximum. */
  target: 'initial' | 'max';
  maxCount: number | null;
}

export function parseLightningAutoRebuyStatus(raw: unknown): LightningAutoRebuyStatus | null {
  const row = objectOf(raw);
  if (!row) return null;
  const rawTrigger =
    typeof row.auto_rebuy_trigger === 'string' ? row.auto_rebuy_trigger.trim().toLowerCase() : '';
  const trigger =
    rawTrigger === 'below_bb' || rawTrigger === 'below_pct'
      ? (rawTrigger as 'below_bb' | 'below_pct')
      : ('zero' as const);
  const target =
    typeof row.auto_rebuy_target === 'string' &&
    row.auto_rebuy_target.trim().toLowerCase() === 'max'
      ? ('max' as const)
      : ('initial' as const);
  const positive = (v: unknown) => {
    const n = num(v);
    return n !== null && n > 0 ? n : null;
  };
  return {
    enabled: row.auto_rebuy_enabled === true,
    trigger,
    thresholdBb: positive(row.auto_rebuy_threshold_bb),
    thresholdPct: positive(row.auto_rebuy_threshold_pct),
    target,
    maxCount: positive(row.auto_rebuy_max_count),
  };
}

/**
 * The Cluster's auto-rebuy configuration, for the read-only status line.
 * `null` means it cannot be said right now (function absent, not granted, or
 * unreadable) and the line is simply not shown; this read never throws.
 */
export async function fetchLightningAutoRebuyStatus(
  clusterId: string
): Promise<LightningAutoRebuyStatus | null> {
  try {
    const { data, error } = await supabase.rpc('fn_lightning_config', {
      p_cluster_id: clusterId,
    });
    if (error) return null;
    return parseLightningAutoRebuyStatus(data);
  } catch {
    return null;
  }
}

/** "Auto-Rebuy: Off", or the trigger and target in the player's own words. */
export function lightningAutoRebuyText(status: LightningAutoRebuyStatus): string {
  if (!status.enabled) return 'Auto-Rebuy: Off';
  const target = status.target === 'max' ? 'Max Buy-In' : 'Initial Buy-In';
  let when: string | null = null;
  if (status.trigger === 'below_pct' && status.thresholdPct !== null) {
    when = `Below ${Number(status.thresholdPct)}%`;
  } else if (status.trigger === 'below_bb' && status.thresholdBb !== null) {
    when = `Below ${Number(status.thresholdBb)} BB`;
  } else if (status.trigger === 'zero') {
    when = 'When Out Of Chips';
  }
  const detail = when ? ` (${when} → ${target})` : '';
  return `Auto-Rebuy: On${detail}`;
}

// ─── Words and numbers the panels print ────────────────────────────────────

/** "1h 05m", "12m", "45s"; a dash when unknown. */
export function lightningDurationText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m < 10 ? '0' : ''}${m.toLocaleString()}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** A chip figure; signed when asked; a dash when unknown. */
export function lightningChipsText(n: number | null, signed = false): string {
  if (n === null) return '-';
  const v = Math.round(n * 100) / 100;
  const body = Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!signed) return v < 0 ? `-${body}` : body;
  return v > 0 ? `+${body}` : v < 0 ? `-${body}` : '0';
}

export function lightningRateText(n: number | null, digits = 1, suffix = ''): string {
  if (n === null) return '-';
  return `${n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })}${suffix}`;
}

/** Wait time in seconds, from milliseconds. */
export function lightningWaitText(ms: number | null): string {
  if (ms === null || ms < 0) return '-';
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}s`;
}

/** The hand's result word for the list. */
export function lightningHandResultText(h: LightningRecentHand): string {
  if (h.foldType === 'fast') return 'LIGHTNING FOLD';
  if (h.foldType === 'fold_watch') return 'FOLD & WATCH';
  if (h.result) return h.result.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (h.net !== null) return h.net > 0 ? 'Won' : h.net < 0 ? 'Lost' : 'Even';
  return '-';
}
