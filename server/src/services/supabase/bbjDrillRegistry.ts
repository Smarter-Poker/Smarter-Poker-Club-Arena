/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH TABLES ARE ARMED, WITHOUT ASKING ON EVERY HAND
 *  BBJ build plan phase 4.1 (docs/BBJ-BUILD-PLAN.md), 2026-09-07
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE DEFECT THIS EXISTS TO FIX, found in the phase-4 deep dive before it
 * could ship. The drill claim was written straight into the settlement path:
 * every contested showdown with no jackpot asked the database whether a drill
 * was armed. Measured on production, that is **137,923 round trips in
 * twenty-four hours** - about 1.6 every second, sustained, for ever - and
 * every single one of them would answer "no", because a table is armed only
 * during a drill that somebody is watching.
 *
 * The engine is ONE core and horse Monte Carlo is already 90% of it
 * (CLAUDE.md section 2). Putting a database round trip on the settlement path
 * of every showdown to support a feature used a handful of times a month is
 * the wrong trade by about five orders of magnitude.
 *
 * SO THE ENGINE STOPS ASKING A QUESTION WHOSE ANSWER IS ALMOST ALWAYS NO. One
 * query a minute per process reads the short list of armed tables; the
 * per-hand cost becomes a Set lookup. The authoritative claim is unchanged -
 * this only decides whether it is worth making.
 *
 * WHY A STALE CACHE IS SAFE HERE, which is the whole reason a cache is
 * allowed on a money-adjacent path at all:
 *
 *   - It can never CAUSE a drill. The claim in the database is still the only
 *     thing that fires one, and it is atomic and single-shot. A cache that
 *     wrongly believes a table is armed costs one wasted round trip and
 *     nothing else.
 *   - It can only ever DELAY one, by at most the refresh interval, on a
 *     feature where an operator arms a table and then goes and plays a hand.
 *   - "I could not tell" is not "armed" (CLAUDE.md 10.86). A failed refresh
 *     keeps the last known list; a process that has never managed to read one
 *     treats every table as unarmed and reports why.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * Sixty seconds, and the reasoning rather than the number.
 *
 * The cost is one query per engine process per minute against 137,923 per day
 * without it. The only thing the interval buys an operator is how long after
 * arming they must wait before the next hand can be the drill, and a minute is
 * shorter than it takes to sit down. Longer saves nothing measurable; shorter
 * pays for a question nobody is asking.
 */
export const DRILL_REGISTRY_TTL_MS = 60_000;

let armed: Set<string> = new Set();
let lastReadAt = 0;
/** Until the first successful read, no table is armed. Silence is not consent. */
let everRead = false;
let inFlight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('bbj_drill_arms')
      .select('table_id')
      .is('fired_at', null);
    if (error) {
      /* Keep the previous list. A refresh that failed says nothing about
         whether a table is armed, and pretending it says "no" would make a
         drill silently impossible during a database blip. */
      reportError(error, 'bbjDrillRegistry.refresh_failed');
      return;
    }
    armed = new Set((data || []).map((r) => String(r.table_id)));
    everRead = true;
    lastReadAt = Date.now();
  } catch (e) {
    reportError(e, 'bbjDrillRegistry.refresh_threw');
  } finally {
    inFlight = null;
  }
}

/**
 * Might this table have a drill armed on it?
 *
 * A cheap, deliberately approximate yes. Only `fn_bbj_claim_drill` can answer
 * it authoritatively, and only it can fire one.
 */
export async function maybeArmed(tableId: string): Promise<boolean> {
  const stale = Date.now() - lastReadAt > DRILL_REGISTRY_TTL_MS;
  if (stale) {
    /* One refresh at a time. Forty tables settling in the same second must not
       become forty identical queries. */
    inFlight = inFlight ?? refresh();
    await inFlight;
  }
  if (!everRead) return false;
  return armed.has(tableId);
}

/** Test-only. Never called by the app. */
export function __resetBbjDrillRegistryForTests(): void {
  armed = new Set();
  lastReadAt = 0;
  everRead = false;
  inFlight = null;
}
