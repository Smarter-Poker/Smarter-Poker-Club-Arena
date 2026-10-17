/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE BRAIN PHASE 15: DAILY REFERENCE-AGREEMENT REPORT (2026-10-16)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The playbook's Phase 15 requires "daily reference-agreement reporting"
 * (docs/horse-brain-round1-playbook.md). This is the product job that writes
 * it: one row per completed UTC day in horse_reference_agreement_daily,
 * computed in SQL by fn_run_horse_reference_agreement (migration
 * 20261016192158) from that day's horse_brain_telemetry counters, which
 * HorsePolicyLedgerObserver, HorseLogic and HorseExecutionWitness fire.
 *
 * Scheduling follows the house nightly-job contract exactly as
 * HorseDailyAudit does, and for the same reasons:
 *  - a boot check plus a 10-minute tick, so a deploy never skips the window;
 *  - a catch-up window (07:00-10:00 UTC, after the 06:00 daily audit);
 *  - leader and standby both run this path, so the day is CLAIMED through
 *    horse_job_runs ('reference_agreement'); a lost claim stands down, and
 *    claimNightlyJob alone decides when a dead holder's day may be taken over;
 *  - every path logs, so "ran" and "never fired" are distinguishable;
 *  - a day is closed only by a row generated after the day ended
 *    (complete = true); a failed run leaves it open for the next tick.
 */
import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { claimNightlyJob } from '../benchmark/HorseLeague.js';

export const REFERENCE_AGREEMENT_JOB = 'reference_agreement';
const REPORT_HOUR_UTC = 7;
const REPORT_CATCHUP_HOURS = 3;
const CHECK_MS = 10 * 60 * 1000;
const BOOT_DELAY_MS = 3 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightRuns = new Set<Promise<void>>();
let lastReportedDay = '';
let lastStandDownDay = '';

const yesterdayUTC = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** True only for a row the writer marked complete (generated after the day closed). */
async function alreadyReported(day: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('horse_reference_agreement_daily')
      .select('day, complete')
      .eq('day', day)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { complete?: boolean } | null)?.complete === true;
  } catch (err) {
    // A failed lookup never skips the day; the writer is idempotent.
    reportError(err, 'HorseReferenceAgreementReport.alreadyReported');
    return false;
  }
}

/** Write the report for one day (default yesterday, UTC). Only `true` closes the day. */
export async function runReferenceAgreementReport(day?: string): Promise<boolean> {
  if (running) return false;
  running = true;
  const target = day ?? yesterdayUTC();
  console.log(`[HorseReferenceAgreement] report for ${target} starting`);
  try {
    const { data, error } = await supabase.rpc('fn_run_horse_reference_agreement', {
      p_day: target,
    });
    if (error) throw new Error(error.message);
    const result = (data ?? {}) as { decisions?: number; findings?: number; complete?: boolean };
    console.log(
      `[HorseReferenceAgreement] report for ${target} written: ${result.decisions ?? '?'} decision(s), ` +
        `${result.findings ?? '?'} finding(s), complete=${String(result.complete)}`
    );
    return result.complete === true;
  } catch (err) {
    reportError(err, 'HorseReferenceAgreementReport.run');
    return false;
  } finally {
    running = false;
  }
}

const lifecycleIsCurrent = (generation: number): boolean =>
  lifecycleActive && lifecycleGeneration === generation;

async function maybeRun(generation: number, now: Date = new Date()): Promise<void> {
  if (!lifecycleIsCurrent(generation)) return;
  const hour = now.getUTCHours();
  const target = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const inWindow = hour >= REPORT_HOUR_UTC && hour < REPORT_HOUR_UTC + REPORT_CATCHUP_HOURS;
  if (!inWindow || running || lastReportedDay === target) return;
  const done = await alreadyReported(target);
  if (!lifecycleIsCurrent(generation)) return;
  if (done) {
    lastReportedDay = target;
    console.log(`[HorseReferenceAgreement] ${target} already reported after the day closed`);
    return;
  }
  const claimed = await claimNightlyJob(REFERENCE_AGREEMENT_JOB, target);
  if (!lifecycleIsCurrent(generation)) return;
  if (!claimed) {
    if (lastStandDownDay !== target) {
      lastStandDownDay = target;
      console.log(
        `[HorseReferenceAgreement] ${target} claimed by another instance - standing down`
      );
    }
    return;
  }
  if (await runReferenceAgreementReport(target)) {
    lastReportedDay = target;
    return;
  }
  console.warn(
    `[HorseReferenceAgreement] ${target} FAILED and the day stays OPEN - a later tick inside the ` +
      `window will re-ask claimNightlyJob`
  );
}

/** Test seam: one scheduler tick at a chosen time. */
export function referenceAgreementTickForTest(now: Date): Promise<void> {
  return maybeRun(lifecycleGeneration, now);
}

function launchMaybeRun(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightRuns.size > 0) return;
  let tracked!: Promise<void>;
  tracked = maybeRun(generation)
    .catch((err) => reportError(err, 'HorseReferenceAgreementReport.tick'))
    .finally(() => inFlightRuns.delete(tracked));
  inFlightRuns.add(tracked);
}

export function startHorseReferenceAgreementReport(): void {
  if (timer) return;
  lifecycleActive = true;
  lifecycleGeneration += 1;
  stopOperation = null;
  timer = setInterval(launchMaybeRun, CHECK_MS);
  timer.unref?.();
  bootTimer = setTimeout(() => {
    bootTimer = null;
    launchMaybeRun();
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();
}

export function stopHorseReferenceAgreementReport(): Promise<void> {
  if (stopOperation) return stopOperation;
  lifecycleActive = false;
  lifecycleGeneration += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  stopOperation = (async () => {
    while (inFlightRuns.size > 0) await Promise.allSettled([...inFlightRuns]);
  })();
  return stopOperation;
}
