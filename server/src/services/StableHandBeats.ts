/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPERATION STABLE HAND - the heartbeat, and the two things that watch it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `GET /stable-hand` answers "what is the floor doing right now". Once a curve
 * is actually being ENFORCED, that stops being the interesting question. The
 * two that matter are:
 *
 *   1. is the curve being HELD, or does it drift back every hour;
 *   2. is the controller running AT ALL.
 *
 * A snapshot endpoint cannot answer either, and the second one is the
 * dangerous one. This estate has already paid for it: the Open Claw fleet
 * returned 401 for every job after a secret rotation and nothing noticed,
 * because a job that stops does not fill a log with errors - it stops filling
 * one. Silence is the only observable, so silence is what gets measured.
 *
 * ── THE WATCHER DOES NOT SHARE THE WATCHED THING'S FAILURE DOMAIN, MOSTLY ──
 *
 * The heartbeat is written by the EXECUTOR and read by the SEEDING CYCLE,
 * which is a different interval on a different service. So an executor that
 * throws every cycle, or one switched off by STABLE_HAND_CONTROLLER while
 * everyone forgets, is caught. An engine that is dead entirely is NOT caught
 * here and is not meant to be. The Club Arena release workflow and read-only
 * production audit independently prove engine health and exact-SHA adoption.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import { dailyGuaranteePerHost } from './FreeBuy.js';
import type { FloorPlan, FloorSnapshot } from './StableHandController.js';

/** How long the beat may go quiet before the fleet cycle complains. */
export const BEAT_STALE_MS = 10 * 60_000;
/** Beats older than this are pruned by the writer. */
export const BEAT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Roughly one prune an hour at a 30-second cycle. */
export const PRUNE_EVERY_BEATS = 120;

export interface BeatRow {
  host_id: string;
  chicago_hour: number;
  eligible_bodies: number;
  unique_live: number;
  live_seats: number;
  tables_open: number;
  full_tables: number;
  one_open_tables: number;
  joinable_tables: number;
  humans_waiting: number;
  target: number;
  cap_max: number;
  yields_planned: number;
  yields_executed: number;
  winddowns_planned: number;
  winddowns_executed: number;
  close_pending: number;
  park_pending: number;
  alerts: string[];
}

export interface ExecutedCounts {
  yieldsByHost: ReadonlyMap<string, number>;
  windDownsByHost: ReadonlyMap<string, number>;
}

/**
 * PURE. One row per host, from the snapshot the executor just acted on and
 * the orders it actually managed to carry out.
 *
 * PLANNED AND EXECUTED ARE BOTH RECORDED, because the gap between them is the
 * only way to see a controller that is deciding correctly and failing to act -
 * an engine missing for a table, a cooldown holding everything, a per-cycle
 * ceiling that is set too low. A beat with plans and no executions for an hour
 * is a different fault from a beat with neither.
 */
export function buildBeats(
  snap: FloorSnapshot,
  plan: FloorPlan,
  executed: ExecutedCounts
): BeatRow[] {
  const hostOfTable = new Map<string, string>();
  for (const h of snap.hosts) for (const t of h.tables) hostOfTable.set(t.tableId, h.hostId);
  const countByHost = (ids: readonly string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const id of ids) {
      const host = hostOfTable.get(id);
      if (host) m.set(host, (m.get(host) ?? 0) + 1);
    }
    return m;
  };
  const closeByHost = countByHost(plan.close);
  const parkByHost = countByHost(plan.park);
  const standsByHost = (reason: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const o of plan.stand) {
      if (o.reason !== reason) continue;
      const host = hostOfTable.get(o.tableId);
      if (host) m.set(host, (m.get(host) ?? 0) + 1);
    }
    return m;
  };
  const yieldPlan = standsByHost('human_yield');
  const windPlan = standsByHost('occupancy_wind_down');

  return plan.metrics.map((m) => ({
    host_id: m.hostId,
    chicago_hour: snap.chicagoHour,
    eligible_bodies: m.n,
    unique_live: m.uniqueLive,
    live_seats: m.liveSeats,
    tables_open: snap.hosts.find((h) => h.hostId === m.hostId)?.tables.length ?? 0,
    full_tables: m.full,
    one_open_tables: m.oneOpen,
    joinable_tables: m.joinable,
    humans_waiting: m.humansWaiting,
    target: m.target,
    cap_max: m.max,
    yields_planned: yieldPlan.get(m.hostId) ?? 0,
    yields_executed: executed.yieldsByHost.get(m.hostId) ?? 0,
    winddowns_planned: windPlan.get(m.hostId) ?? 0,
    winddowns_executed: executed.windDownsByHost.get(m.hostId) ?? 0,
    close_pending: closeByHost.get(m.hostId) ?? 0,
    park_pending: parkByHost.get(m.hostId) ?? 0,
    // Only this host's alerts, so a Deep Stack problem does not read as a
    // Midway one on a chart.
    alerts: plan.alerts.filter((a) => a.includes(m.hostId)),
  }));
}

let beatsSincePrune = 0;

/** Write a cycle's beats. Never throws: a missing heartbeat must not stop the
 *  floor being managed, it only stops it being observed. */
export async function writeBeats(rows: readonly BeatRow[], nowMs = Date.now()): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    const { error } = await (supabase as any).from('stable_hand_beats').insert(rows);
    if (error) {
      reportError(error, 'StableHandBeats.write');
      return 0;
    }
    beatsSincePrune += rows.length;
    if (beatsSincePrune >= PRUNE_EVERY_BEATS) {
      beatsSincePrune = 0;
      const cutoff = new Date(nowMs - BEAT_RETENTION_MS).toISOString();
      const { error: pruneErr } = await (supabase as any)
        .from('stable_hand_beats')
        .delete()
        .lt('beat_at', cutoff);
      if (pruneErr) reportError(pruneErr, 'StableHandBeats.prune');
    }
    return rows.length;
  } catch (err) {
    reportError(err, 'StableHandBeats.write');
    return 0;
  }
}

/** The most recent beats, newest first. For the dashboard. */
export async function readRecentBeats(limit = 120): Promise<any[]> {
  const { data, error } = await (supabase as any)
    .from('stable_hand_beats')
    .select('*')
    .order('beat_at', { ascending: false })
    .limit(Math.max(1, Math.min(1000, limit)));
  if (error) {
    reportError(error, 'StableHandBeats.read');
    return [];
  }
  return (data ?? []) as any[];
}

/** When the controller last beat, or null when it never has. */
export async function lastBeatAt(): Promise<number | null> {
  const { data, error } = await (supabase as any)
    .from('stable_hand_beats')
    .select('beat_at')
    .order('beat_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const at = Date.parse(String((data as { beat_at?: string }).beat_at ?? ''));
  return Number.isFinite(at) ? at : null;
}

/* ------------------------------------------------------------------ */
/* THE TWO WATCHES, as pure decisions                                  */
/* ------------------------------------------------------------------ */

export type BeatVerdict = 'ok' | 'never_beat' | 'stale';

/**
 * PURE. Has the controller gone quiet?
 *
 * `never_beat` and `stale` are separated on purpose. Never having beaten is
 * an install that did not take - a flag left off, a deploy that did not
 * carry the new code. Going quiet after beating is something breaking. They
 * want different sentences in the log and they are found at different times.
 *
 * NOT STALE WHILE DISABLED: an operator who set STABLE_HAND_CONTROLLER=false
 * turned it off on purpose, and paging about a switch somebody chose to throw
 * is how alerts get muted for the ones nobody chose.
 */
export function beatVerdict(opts: {
  lastBeatAtMs: number | null;
  nowMs: number;
  enabled: boolean;
  staleMs?: number;
}): BeatVerdict {
  if (!opts.enabled) return 'ok';
  if (opts.lastBeatAtMs === null) return 'never_beat';
  return opts.nowMs - opts.lastBeatAtMs > (opts.staleMs ?? BEAT_STALE_MS) ? 'stale' : 'ok';
}

/** Days of guarantee the bank can still fund at the current daily exposure. */
export function bankRunwayDays(bank: number, dailyGuarantee: number): number {
  if (!(dailyGuarantee > 0)) return Number.POSITIVE_INFINITY;
  return bank / dailyGuarantee;
}

export const BANK_WARN_DAYS = 14;
export const BANK_CRITICAL_DAYS = 3;

export type BankVerdict = 'ok' | 'warning' | 'critical';

/**
 * PURE. How healthy is the bank that funds a host's guarantees?
 *
 * Measured in DAYS of the board's own exposure rather than in chips, because
 * a chip threshold has to be re-chosen every time the board changes and a
 * runway does not. The Free Buy board alone commits 1,500 a day per host.
 */
export function bankVerdict(opts: {
  bank: number;
  dailyGuarantee?: number;
  warnDays?: number;
  criticalDays?: number;
}): BankVerdict {
  const daily = opts.dailyGuarantee ?? dailyGuaranteePerHost();
  const days = bankRunwayDays(opts.bank, daily);
  if (days < (opts.criticalDays ?? BANK_CRITICAL_DAYS)) return 'critical';
  if (days < (opts.warnDays ?? BANK_WARN_DAYS)) return 'warning';
  return 'ok';
}
