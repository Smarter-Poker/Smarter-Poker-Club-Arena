/**
 * The engine records `unstarted_hand_permit_released` (#6957), and the
 * recovery-event CHECK must admit it or the record is silently refused
 * (19 refusals in the 24 hours to 2026-10-17).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261017010023_an_unstarted_hand_permit_release_is_a_recovery_event.sql'
  ),
  'utf8'
);
const ENGINE = readFileSync(
  resolve(process.cwd(), 'server/src/engine/ServerTableEngineDealing.ts'),
  'utf8'
);

describe('an unstarted hand permit release is a recovery event', () => {
  it('the engine still records the event this CHECK admits', () => {
    expect(ENGINE).toContain("'unstarted_hand_permit_released'");
  });

  it('extends the CHECK by exactly that value, from a pinned preimage, in one transaction', () => {
    expect(SQL).toContain("'unstarted_hand_permit_released'::text");
    for (const v of [
      'watchdog_rearm_clock',
      'watchdog_forced_action',
      'watchdog_kill_rebuild',
      'paused_too_long',
      'table_closed_under_live_tournament',
    ])
      expect(SQL).toContain(`'${v}'::text`);
    expect(SQL).toContain('RECOVERY_EVENT_CHECK_PREIMAGE');
    expect(SQL).toContain('RECOVERY_EVENT_CHECK_POSTIMAGE');
    expect(SQL).toContain('NOT VALID;');
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL.match(/^-- @live-proof:/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '2s';");
  });
});
