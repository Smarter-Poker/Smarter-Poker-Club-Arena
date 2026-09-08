/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HORSE DAILY AUDIT — nightly findings run (Dan 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thin scheduler over fn_run_horse_daily_audit(p_day): the audit COMPUTATION
 * lives in SQL (migration 20260826151309) where it is auditable and cheap to
 * change; this service only decides WHEN it runs and WHICH instance runs it.
 *
 * All the 2026-08-23 nightly-job lessons apply and are copied from
 * HorseLeague, where they were learned the hard way:
 *  - a setInterval alone never survives this repo's deploy cadence, so a
 *    BOOT CHECK makes a restart trigger the run instead of preventing it;
 *  - a catch-up window picks up a missed slot;
 *  - leader/standby means TWO containers boot this path, so the run is
 *    CLAIMED via horse_job_runs (job 'daily_audit') — the INSERT is the
 *    lock, and a duplicate-key loss means the other instance owns today;
 *  - it LOGS THAT IT STARTED, so "ran" and "never fired" are
 *    distinguishable from the container logs.
 *
 * Audited day: YESTERDAY (UTC) — the last COMPLETE day of data. Window is
 * 06:00-09:00 UTC, safely after the 04:30 league run so the audit sees the
 * night's league results.
 */

import { supabase } from './supabase/client.js';
import { reportError } from './errorReporter.js';
import { claimNightlyJob } from '../benchmark/HorseLeague.js';

const AUDIT_HOUR_UTC = 6;
const AUDIT_CATCHUP_HOURS = 3;
const CHECK_MS = 10 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let running = false;
let lifecycleGeneration = 0;
let lifecycleActive = false;
let stopOperation: Promise<void> | null = null;
const inFlightRuns = new Set<Promise<void>>();
let lastAuditedDay = '';
/*
 * ── 2026-09-02: the memo that ate the retry ──
 * `lastAuditedDay` used to be set on the stand-down path too, which made it a
 * memo of "we looked at this day", not "this day is audited". A run that threw
 * therefore burned the whole window: the next tick saw the day memoised and
 * returned before it could reach claimNightlyJob, so the 30-minute
 * stale-claim takeover added on 2026-08-30 - built for exactly this - could
 * never engage. Measured: daily_audit claimed 2026-09-01 at 06:03 UTC, the RPC
 * hit a statement timeout, and the row did not exist until an agent generated
 * it 28 hours later. The stand-down gets its own memo now, and it only
 * suppresses the LOG LINE; it never suppresses the retry.
 */
let lastStandDownDay = '';

const yesterdayUTC = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function alreadyRan(day: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('horse_daily_audit')
      .select('day, generated_at')
      .eq('day', day)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data == null) return false;
    // ── 2026-08-27, found by its own silence ──
    // "A row exists" was the wrong question. A row can be generated DURING
    // the target day - by a manual run, by an agent, by an earlier catch-up -
    // and it then covers a partial day while permanently convincing this job
    // that its work is done. That is exactly what happened: an audit row
    // written at 20:37 on the 26th made the 06:00 window on the 27th stand
    // down, so the fleet's first full day of telemetry was never audited and
    // horse_job_runs never recorded a 'daily_audit' claim at all.
    // The real question is whether the row was generated AFTER the day it
    // describes had closed.
    const generatedAt = (data as { generated_at?: string }).generated_at;
    if (!generatedAt) return false;
    const dayClosedMs = Date.parse(day + 'T00:00:00Z') + 86_400_000;
    const staleRow = Date.parse(generatedAt) < dayClosedMs;
    if (staleRow) {
      console.log(
        `[HorseDailyAudit] ${day} has a row generated ${generatedAt}, BEFORE the day closed - ` +
          `regenerating over the complete day`
      );
      return false;
    }
    return true;
  } catch (err) {
    // Never let a failed lookup skip the day; the run itself is idempotent.
    reportError(err, 'HorseDailyAudit.alreadyRan');
    return false;
  }
}

export async function runDailyAudit(day?: string): Promise<boolean> {
  if (running) return false;
  running = true;
  const target = day ?? yesterdayUTC();
  console.log(`[HorseDailyAudit] audit for ${target} starting`);
  try {
    const { data, error } = await supabase.rpc('fn_run_horse_daily_audit', { p_day: target });
    if (error) throw new Error(error.message);
    const findings = (data as { findings?: number } | null)?.findings ?? '?';
    console.log(`[HorseDailyAudit] audit for ${target} complete: ${findings} finding(s)`);
    return true;
  } catch (err) {
    reportError(err, 'HorseDailyAudit.run');
    return false;
  } finally {
    running = false;
  }
}

const lifecycleIsCurrent = (generation: number): boolean =>
  lifecycleActive && lifecycleGeneration === generation;

async function maybeRun(generation: number): Promise<void> {
  if (!lifecycleIsCurrent(generation)) return;
  const now = new Date();
  const hour = now.getUTCHours();
  const target = yesterdayUTC();
  const inWindow = hour >= AUDIT_HOUR_UTC && hour < AUDIT_HOUR_UTC + AUDIT_CATCHUP_HOURS;
  if (!inWindow || running || lastAuditedDay === target) return;
  // ── 2026-08-27: EVERY stand-down path says so now. ──
  // This function had one silent `return` (the alreadyRan branch) and it cost
  // a day of audits with ZERO log lines in 20 hours of container output -
  // indistinguishable from the service not being deployed. The house rule is
  // that a job must never look the same whether or not it worked; this file
  // was violating the rule it was written to enforce.
  const alreadyAudited = await alreadyRan(target);
  if (!lifecycleIsCurrent(generation)) return;
  if (alreadyAudited) {
    lastAuditedDay = target;
    console.log(`[HorseDailyAudit] ${target} already audited after the day closed - nothing to do`);
    return;
  }
  const claimed = await claimNightlyJob('daily_audit', target);
  if (!lifecycleIsCurrent(generation)) return;
  if (!claimed) {
    // Say it once, then keep ticking. The claim holder may still die, and
    // claimNightlyJob is the only thing allowed to decide whether this
    // instance may take the day over.
    if (lastStandDownDay !== target) {
      lastStandDownDay = target;
      console.log(`[HorseDailyAudit] ${target} claimed by another instance - standing down`);
    }
    return;
  }
  const completed = await runDailyAudit(target);
  if (!lifecycleIsCurrent(generation)) return;
  if (completed) {
    lastAuditedDay = target;
    return;
  }
  console.warn(
    `[HorseDailyAudit] ${target} FAILED and the day stays OPEN - a later tick inside the ` +
      `window will re-ask claimNightlyJob, which takes a stale claim with no rows over`
  );
}

function launchMaybeRun(): void {
  const generation = lifecycleGeneration;
  if (!lifecycleIsCurrent(generation) || inFlightRuns.size > 0) return;
  let tracked!: Promise<void>;
  tracked = maybeRun(generation)
    .catch((err) => reportError(err, 'HorseDailyAudit.tick'))
    .finally(() => inFlightRuns.delete(tracked));
  inFlightRuns.add(tracked);
}

async function drainRuns(): Promise<void> {
  while (inFlightRuns.size > 0) await Promise.allSettled([...inFlightRuns]);
}

export function startHorseDailyAudit(): void {
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

export function stopHorseDailyAudit(): Promise<void> {
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
  stopOperation = drainRuns();
  return stopOperation;
}
