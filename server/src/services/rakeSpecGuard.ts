/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKE SPEC GUARD - the engine proves, at boot, that the database holds the
 *  rake specification it was compiled with; a mismatch is LOUD, never a stop
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Chip Accounting Standard R7 (2026-09-02). The engine ships with one rake
 * specification compiled in (config/rakeSpec.ts) and the database holds the
 * same one (ca_rake_schedule, ca_rake_schedule_caps, ca_rake_tier,
 * ca_rake_rules). Each side can produce an md5 of the canonical text -
 * `rakeSpecChecksum()` here, `fn_rake_spec_checksum()` there. At boot, and
 * every minute after, this compares the two.
 *
 * THREE OUTCOMES:
 *
 *   match       -> nothing to do; /health publishes both checksums.
 *   mismatch    -> CRITICAL financial alert `RakeSpec.drift` with both
 *                  checksums AND both canonical texts (so the diff is in the
 *                  alert, not a debugging session), a console error, and the
 *                  drift published on /health. Raised ONCE PER BOOT: the
 *                  minute tick keeps logging while the drift persists but does
 *                  not re-file the alert, and a later agreement files an info
 *                  `RakeSpec.drift_resolved`. DEALING CONTINUES on the
 *                  compiled-in spec.
 *   unavailable -> WARNING `RakeSpec.checksum_unavailable`; retried next tick.
 *
 * WHY IT DOES NOT REFUSE TO DEAL. An earlier draft of this file held every
 * cash table at its next hand boundary until the two checksums agreed. Dan's
 * ruling (2026-09-02, binding): anything that is high risk for live play is
 * not enforced. A guard that can stop the whole cash fleet over a hash - for
 * a migration that changed a comment, a deploy that raced a migration by a
 * minute, or a bug in the canonicalisation itself - is a larger live-play
 * risk than the one-cent-per-hand drift it would catch. The engine prices
 * every hand from its compiled spec either way; what the alert buys is that
 * a disagreement is seen within a minute instead of at the next audit.
 */
import { supabase } from './supabase.js';
import { raiseFinancialAlert } from './financialAlerts.js';
import { reportError } from './errorReporter.js';
import {
  rakeSpecCanonical,
  rakeSpecChecksum,
  rakeSpecDriftState,
  setRakeSpecDriftState,
} from '../config/rakeSpec.js';

export const RAKE_SPEC_RECHECK_MS = 60_000;

let recheckTimer: NodeJS.Timeout | null = null;
let lifecycleGeneration = 0;
const lifecycleJobs = new Set<Promise<void>>();
/** The dedupe: the drift alert is filed at most once per process. */
let driftAlertedThisBoot = false;

/** Minimal shape of the client this guard needs; tests pass a stub. */
export interface RakeSpecRpcClient {
  rpc: (
    fn: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}

export type RakeSpecVerdict = 'match' | 'mismatch' | 'unavailable';

/** Test seam: forget that this boot already alerted. */
export function resetRakeSpecGuardForTests(): void {
  driftAlertedThisBoot = false;
  setRakeSpecDriftState({
    drifted: false,
    databaseChecksum: null,
    detail: 'not yet verified against the database',
    checkedAt: 0,
  });
}

/**
 * One comparison. Publishes the state, raises the CRITICAL alert on the
 * first mismatch of this boot, logs every mismatch tick, and files an info
 * alert when the two sides agree again. Never throws; never blocks dealing.
 */
export async function verifyRakeSpecAgainstDatabase(
  client: RakeSpecRpcClient = supabase as unknown as RakeSpecRpcClient
): Promise<RakeSpecVerdict> {
  const compiled = rakeSpecChecksum();
  const before = rakeSpecDriftState();
  let databaseChecksum: string | null = null;
  let databaseCanonical: string | null = null;

  try {
    const { data, error } = await client.rpc('fn_rake_spec_checksum');
    if (error) throw error;
    if (typeof data === 'string' && /^[0-9a-f]{32}$/.test(data)) databaseChecksum = data;
  } catch (err) {
    reportError(err, 'rakeSpecGuard.checksum_rpc_failed');
  }

  if (databaseChecksum === null) {
    // An unreadable database neither proves drift nor clears it.
    setRakeSpecDriftState({
      drifted: before.drifted,
      databaseChecksum: before.databaseChecksum,
      detail: 'fn_rake_spec_checksum() unavailable; last verdict kept',
      checkedAt: Date.now(),
    });
    await raiseFinancialAlert(
      'warning',
      'RakeSpec.checksum_unavailable',
      'The engine could not read fn_rake_spec_checksum(); the rake spec is unverified this tick',
      { compiledChecksum: compiled, previouslyDrifted: before.drifted }
    ).catch((err) => reportError(err, 'rakeSpecGuard.unavailable_alert_failed'));
    return 'unavailable';
  }

  if (databaseChecksum === compiled) {
    setRakeSpecDriftState({
      drifted: false,
      databaseChecksum,
      detail: 'database and engine agree',
      checkedAt: Date.now(),
    });
    if (before.drifted) {
      console.log(`[RakeSpec] drift resolved: database and engine agree on ${compiled}`);
      await raiseFinancialAlert(
        'info',
        'RakeSpec.drift_resolved',
        'The rake spec in the database matches the engine again',
        { checksum: compiled }
      ).catch((err) => reportError(err, 'rakeSpecGuard.resolved_alert_failed'));
    }
    return 'match';
  }

  // Mismatch. Fetch the database's canonical text for the alert so the
  // operator sees the DIFF, not just two hashes.
  try {
    const { data } = await client.rpc('fn_rake_spec_canonical');
    if (typeof data === 'string') databaseCanonical = data;
  } catch {
    /* the checksum alone still tells the story */
  }

  setRakeSpecDriftState({
    drifted: true,
    databaseChecksum,
    detail: `rake spec drift: engine ${compiled} vs database ${databaseChecksum}; dealing continues on the compiled spec`,
    checkedAt: Date.now(),
  });
  console.error(
    `[RakeSpec] DRIFT: engine ${compiled} vs database ${databaseChecksum} - dealing continues on the compiled-in spec` +
      (driftAlertedThisBoot ? ' (alert already filed this boot)' : '')
  );

  if (!driftAlertedThisBoot) {
    driftAlertedThisBoot = true;
    await raiseFinancialAlert(
      'critical',
      'RakeSpec.drift',
      'RAKE SPEC DRIFT: the database and the engine disagree on the rake specification. ' +
        'Dealing continues on the compiled-in spec; the database audit is pricing against a different one.',
      {
        compiledChecksum: compiled,
        databaseChecksum,
        compiledCanonical: rakeSpecCanonical(),
        databaseCanonical,
        howToFix:
          'Either deploy the engine whose rakeSpec.ts matches the applied migration, or apply ' +
          'the migration whose ca_rake_* rows match the deployed engine. This alert is filed once per boot.',
      }
    );
  }
  return 'mismatch';
}

/**
 * Boot entry point: verify once now, then keep verifying. Never throws and
 * never delays the boot beyond the one RPC. Called by GameServer.start()
 * before the table engines boot so the first line of the log says whether
 * the two sides agree.
 */
export async function startRakeSpecGuard(
  client: RakeSpecRpcClient = supabase as unknown as RakeSpecRpcClient,
  intervalMs: number = RAKE_SPEC_RECHECK_MS
): Promise<RakeSpecVerdict> {
  const generation = ++lifecycleGeneration;
  const verdict = await verifyRakeSpecAgainstDatabase(client);
  const s = rakeSpecDriftState();
  console.log(
    `[RakeSpec] ${verdict}: engine ${s.compiledChecksum} database ${s.databaseChecksum ?? 'n/a'}`
  );
  if (generation !== lifecycleGeneration) return verdict;
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = setInterval(() => {
    let tracked!: Promise<void>;
    tracked = verifyRakeSpecAgainstDatabase(client)
      .then(() => undefined)
      .catch((err) => reportError(err, 'rakeSpecGuard.interval_check_failed'))
      .finally(() => lifecycleJobs.delete(tracked));
    lifecycleJobs.add(tracked);
  }, intervalMs);
  recheckTimer.unref?.();
  return verdict;
}

export async function stopRakeSpecGuard(): Promise<void> {
  lifecycleGeneration += 1;
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
  while (lifecycleJobs.size > 0) {
    await Promise.allSettled([...lifecycleJobs]);
  }
}
