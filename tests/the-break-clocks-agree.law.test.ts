/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BREAK CLOCKS AGREE (law, to-do #2563 item 12)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The :55 maintenance break is coordinated by constants that live in FIVE
 * places that cannot import each other: the engine (TypeScript), the deploy
 * workflow (cron), the engine watchdog (bash), two SQL migrations, and the
 * browser hook. Nothing but this file makes them agree.
 *
 * Each pin below is a real failure, not a hypothetical - the watchdog HAS
 * already desynchronised from the deploy once (2026-09-01: it still carried
 * the five Chicago windows after the deploy went hourly, stayed silent for
 * fourteen and a half hours of stranded code, and reported success the whole
 * time). This law is what makes that class of drift a red test instead of a
 * production incident.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

const ENGINE = read('server/src/maintenance/MaintenanceBreak.ts');
const WATCHDOG = read('.github/scripts/engine-watchdog.sh');
const DEPLOY = read('.github/workflows/auto-deploy-hetzner.yml');
const FREEZE_SQL = read(
  'supabase/migrations/20260902090000_the_platform_freezes_at_the_tables_not_the_functions.sql'
);
const THAW_SQL = read(
  'supabase/migrations/20260902091000_the_thaw_gives_back_every_frozen_minute.sql'
);
const BREAK_SQL = read(
  'supabase/migrations/20260902080000_maintenance_break_survives_the_restart.sql'
);
const HOOK = read('src/hooks/useMaintenanceBreak.ts');

describe('the break minute is the same minute everywhere', () => {
  const engineMinute = Number(ENGINE.match(/BREAK_START_MINUTE = (\d+)/)![1]);

  it('the engine parks at :55', () => {
    expect(engineMinute).toBe(55);
  });

  it('the watchdog waits for the same minute', () => {
    // 2026-09-01: these two disagreed (watchdog still on five Chicago hours)
    // and the engine served a 14.5-hour-old image behind green runs.
    const wd = Number(WATCHDOG.match(/RESTART_MINUTE="\$\{RESTART_MINUTE:-(\d+)\}"/)![1]);
    expect(wd).toBe(engineMinute);
  });

  it('every deploy cron tick lands before the break with time to build', () => {
    const minutes = DEPLOY.match(/cron: '([\d,]+) \* \* \* \*'/)![1]
      .split(',')
      .map(Number);
    for (const m of minutes) {
      // Late enough that the runner is fresh, early enough to check out,
      // test and build before the engine parks the platform at :55. A tick
      // AT or AFTER :55 would wait ~59 minutes for the next break.
      expect(m, `cron tick :${m}`).toBeGreaterThanOrEqual(35);
      expect(m, `cron tick :${m}`).toBeLessThanOrEqual(50);
      expect(m).toBeLessThan(engineMinute);
    }
  });
});

describe('the freeze ceiling is the same ceiling everywhere', () => {
  it('fn_platform_frozen refuses to honour a break longer than 15 minutes', () => {
    expect(FREEZE_SQL).toContain("INTERVAL '15 minutes'");
  });

  it('fn_thaw_platform refuses to shift by more than the same ceiling', () => {
    // 900 seconds = 15 minutes. A thaw that believed a 9-hour freeze would
    // shift every deadline on the platform by 9 hours.
    expect(THAW_SQL).toMatch(/p_frozen_seconds > 900/);
  });
});

describe('the last-hand window is the same window everywhere', () => {
  it('the engine announces two minutes before the break', () => {
    expect(ENGINE).toMatch(/LAST_HAND_LEAD_MS = 2 \* 60 \* 1000/);
  });

  it('the SQL fallback and the client fuse both allow four minutes, together', () => {
    // A last_hand phase has no end time, so both readers bound it by the
    // announcement instead: SQL stops reporting it after 4 minutes, and the
    // client stops believing it after the same 4. If these ever differ, one
    // surface shows a break the other has already dismissed.
    expect(BREAK_SQL).toContain("INTERVAL '4 minutes'");
    expect(HOOK).toMatch(/LAST_HAND_MAX_MS = 4 \* 60 \* 1000/);
  });
});

describe('the break duration is five minutes, once', () => {
  it('engine and tournament break agree at 5 minutes', () => {
    expect(ENGINE).toMatch(/BREAK_DURATION_MS = 5 \* 60 \* 1000/);
    const GS = read('server/src/GameServer.ts');
    expect(GS).toMatch(/BREAK_DURATION_MS = 5 \* 60 \* 1000/);
  });
});
