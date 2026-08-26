/**
 * A PAGE VIEW MUST NOT TRIGGER A DATABASE MAINTENANCE JOB.
 *
 * PlayerStatsPage used to call ca_refresh_hand_player_index({p_max_hands:3000})
 * on every stats load, behind a 5-minute guard held in a component-instance
 * ref - so it throttled ONE TAB, not the platform.
 *
 * The source comment claimed the batch was "sized to finish inside the 8s
 * statement_timeout". Production disagreed, on 2026-08-24:
 *   - pg_stat_statements: 73,901 ms MEAN, 173,487 ms max for that RPC
 *   - pg_stat_activity: caught live at 26.9s in wait_event IO/DataFileRead,
 *     dragging the 10GB hand_history table off disk
 *   - a trivial PostgREST probe (profiles.select('id').limit(1)) was taking
 *     14,373 ms while raw Postgres answered the same shape in 0.17 ms
 *
 * The index is maintained properly by pages/api/cron/club-stats-maintenance.js
 * every 15 minutes under service_role with a far larger batch, off the request
 * path. The client call was redundant as well as harmful.
 *
 * Asserted at the source level because the regression being guarded is
 * "somebody re-adds a maintenance call to a render path" - a property of the
 * code, not of one call's return value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PAGE = readFileSync(resolve(__dirname, '../src/pages/PlayerStatsPage.tsx'), 'utf8');

describe('PlayerStatsPage does not run maintenance', () => {
  it('never calls ca_refresh_hand_player_index from the browser', () => {
    expect(PAGE).not.toMatch(/rpc\(\s*['"]ca_refresh_hand_player_index['"]/);
  });

  it('calls no *_refresh_* or *_reconcile_* maintenance RPC at all', () => {
    // Catches the whole family, not just the one that bit us.
    // `roll` was added 2026-08-25 with ca_roll_hand_stats / _forward. The
    // rollup builder is the same shape of hazard as the index refresh this file
    // was written for - a bulk job over hand_history, carrying its own 10-minute
    // statement_timeout - and the existing word list would not have caught it.
    const maintenanceRpc =
      /rpc\(\s*['"][a-z_]*(refresh|reconcile|rebuild|backfill|prune|roll)[a-z_]*['"]/i;
    expect(PAGE).not.toMatch(maintenanceRpc);
  });
});
