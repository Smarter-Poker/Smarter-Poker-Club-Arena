/**
 * HORSE TABLE TALK GATE (Phase 10, "Table talk at the felt", 2026-10-06)
 *
 * The two switches the owner holds over anything a horse says, read by the
 * engine for the first time:
 *
 *   content_settings.engine_enabled      the whole fleet content programme
 *   horse_post_modes.mode = 'table_talk' this one way of posting
 *
 * Both are data, not deploys (20260906122535: "the flag is data, so approving
 * costs him one UPDATE and no deploy"), and the rollback note on
 * 20260930032343 promises that a change "takes effect within 30 seconds on
 * every fleet route". This file is what makes that promise true for the felt:
 * one read, cached for TABLE_TALK_GATE_TTL_MS, and the writer never acts on a
 * verdict older than that.
 *
 * THE SHAPE OF THE ANSWER (CLAUDE.md 10.86). "I could not tell" is its own
 * outcome and is never folded into "no":
 *
 *   allowed            both switches on
 *   engine_off         content_settings.engine_enabled is not true
 *   mode_off           the table_talk row exists and enabled is not true
 *   mode_missing       the table_talk row does not exist (migration not applied)
 *   unreadable         an error, a timeout, zero or two content_settings rows
 *
 * A definite answer, on or off, is cached for the TTL; `unreadable` is NEVER
 * cached and is asked again on the next hand, the way getFleetPolicy retries
 * a failed policy read (HorseFleetPolicy.ts). Unlike getFleetPolicy, this
 * fails CLOSED: a read that cannot be trusted is a "no", and nothing in this
 * file ever answers `allowed: true` from a catch.
 *
 * Reads go through the bounded service client (services/supabase/client.ts):
 * both tables are service-role only since 2026-10-06, which is right, because
 * a browser must not learn how the fleet is switched.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';

/** "Within 30 seconds": the longest a verdict may be acted on after it was read. */
export const TABLE_TALK_GATE_TTL_MS = 30_000;

export const TABLE_TALK_MODE = 'table_talk';

/** One report per five minutes while the switches cannot be read. */
const REPORT_EVERY_MS = 5 * 60_000;

export type TableTalkGateRefusal = 'unreadable' | 'engine_off' | 'mode_off' | 'mode_missing';

export type TableTalkGateVerdict =
  | { allowed: true; reason: 'on'; readAt: number }
  | { allowed: false; reason: TableTalkGateRefusal; readAt: number };

let cached: TableTalkGateVerdict | null = null;
let inFlight: Promise<TableTalkGateVerdict> | null = null;
let lastReportedAt = 0;

/**
 * The verdict, no older than the TTL. Concurrent callers (every table on the
 * box settles a hand at roughly the same cadence) share one read in flight
 * rather than each asking the database at the moment the cache expires.
 */
export async function readTableTalkGate(now: number = Date.now()): Promise<TableTalkGateVerdict> {
  if (cached && now - cached.readAt >= 0 && now - cached.readAt < TABLE_TALK_GATE_TTL_MS) {
    return cached;
  }
  if (!inFlight) {
    inFlight = readOnce().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function readOnce(): Promise<TableTalkGateVerdict> {
  const readAt = Date.now();
  try {
    const [settings, mode] = await Promise.all([
      supabase.from('content_settings').select('engine_enabled'),
      supabase
        .from('horse_post_modes')
        .select('mode, enabled')
        .eq('mode', TABLE_TALK_MODE)
        .maybeSingle(),
    ]);
    if (settings.error) {
      return unreadable(readAt, `content_settings: ${settings.error.message}`);
    }
    if (mode.error) {
      return unreadable(readAt, `horse_post_modes: ${mode.error.message}`);
    }
    const rows = Array.isArray(settings.data) ? settings.data : null;
    if (!rows || rows.length !== 1) {
      return unreadable(
        readAt,
        `content_settings must be exactly one row, read ${rows ? rows.length : 'none'}`
      );
    }
    const engineOn = (rows[0] as { engine_enabled?: unknown }).engine_enabled === true;
    if (!engineOn) return remember({ allowed: false, reason: 'engine_off', readAt });
    const modeRow = mode.data as { mode?: unknown; enabled?: unknown } | null;
    if (!modeRow) return remember({ allowed: false, reason: 'mode_missing', readAt });
    if (modeRow.enabled !== true) return remember({ allowed: false, reason: 'mode_off', readAt });
    return remember({ allowed: true, reason: 'on', readAt });
  } catch (err) {
    // A thrown read is a read that did not happen. Closed, and not remembered.
    return unreadable(readAt, err instanceof Error ? err.message : String(err));
  }
}

function remember(verdict: TableTalkGateVerdict): TableTalkGateVerdict {
  cached = verdict;
  return verdict;
}

/** Closed and NOT remembered: the next hand asks again. */
function unreadable(readAt: number, detail: string): TableTalkGateVerdict {
  const now = Date.now();
  if (now - lastReportedAt >= REPORT_EVERY_MS) {
    lastReportedAt = now;
    reportError(new Error(detail), 'HorseTableTalkGate.unreadable');
  }
  return { allowed: false, reason: 'unreadable', readAt };
}

/** Test hook: forget the cached verdict, the shared read and the report throttle. */
export function _resetTableTalkGateForTests(): void {
  cached = null;
  inFlight = null;
  lastReportedAt = 0;
}
