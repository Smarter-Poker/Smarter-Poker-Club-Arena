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
let lastAuditedDay = '';

const yesterdayUTC = (): string => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function alreadyRan(day: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('horse_daily_audit')
      .select('day')
      .eq('day', day)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data != null;
  } catch (err) {
    // Never let a failed lookup skip the day; the run itself is idempotent.
    reportError(err, 'HorseDailyAudit.alreadyRan');
    return false;
  }
}

export async function runDailyAudit(day?: string): Promise<void> {
  if (running) return;
  running = true;
  const target = day ?? yesterdayUTC();
  console.log(`[HorseDailyAudit] audit for ${target} starting`);
  try {
    const { data, error } = await supabase.rpc('fn_run_horse_daily_audit', { p_day: target });
    if (error) throw new Error(error.message);
    const findings = (data as { findings?: number } | null)?.findings ?? '?';
    console.log(`[HorseDailyAudit] audit for ${target} complete: ${findings} finding(s)`);
  } catch (err) {
    reportError(err, 'HorseDailyAudit.run');
  } finally {
    running = false;
  }
}

async function maybeRun(): Promise<void> {
  const now = new Date();
  const hour = now.getUTCHours();
  const target = yesterdayUTC();
  const inWindow = hour >= AUDIT_HOUR_UTC && hour < AUDIT_HOUR_UTC + AUDIT_CATCHUP_HOURS;
  if (!inWindow || running || lastAuditedDay === target) return;
  if (await alreadyRan(target)) {
    lastAuditedDay = target;
    return;
  }
  if (!(await claimNightlyJob('daily_audit', target))) {
    lastAuditedDay = target;
    console.log(`[HorseDailyAudit] ${target} claimed by another instance - standing down`);
    return;
  }
  lastAuditedDay = target;
  await runDailyAudit(target);
}

export function startHorseDailyAudit(): void {
  if (timer) return;
  timer = setInterval(() => void maybeRun(), CHECK_MS);
  timer.unref?.();
  bootTimer = setTimeout(() => void maybeRun(), BOOT_DELAY_MS);
  bootTimer.unref?.();
}

export function stopHorseDailyAudit(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}
