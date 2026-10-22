/**
 * LAW: A BOUNTY BUST WAITS FOR ITS TOURNAMENT LANE (2026-10-22).
 *
 * From 06:19 UTC every bust in Midnight Bounty 77c43fe1 and c97ae5a1 was
 * refused F06_RETRY_CANONICAL_LANE: the claim's tournament_players write is
 * checked by a guard that only TRIES the exclusive lane, and the event's
 * ~17 tables hold it shared on every hand commit. 130 busted players stayed
 * "playing" and 16 tables were refused re-admission after the next release.
 *
 * What this pins: fn_claim_tournament_bounty_elimination takes the lane
 * itself, shared global then exclusive per tournament, before its first row
 * lock, with a bounded wait that still answers with the named refusal.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261022063749_a_bounty_bust_waits_for_its_tournament_lane.sql'
  ),
  'utf8'
);

describe('a bounty bust waits for its tournament lane', () => {
  it('is one guarded transaction', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain('BOUNTY_LANE_PREIMAGE_CHANGED');
    expect(MIG).toContain('BOUNTY_LANE_RESULT_CHANGED');
  });

  it('takes the lane before the first row lock, with a bounded wait', () => {
    const shared = MIG.indexOf(
      "pg_advisory_xact_lock_shared(\n      hashtextextended('ca:tournament-terminal-settlement:v1', 0))"
    );
    const exclusive = MIG.indexOf(
      "pg_advisory_xact_lock(\n      hashtextextended('ca:tournament-terminal-settlement:v1:' || p_tournament_id::text, 0))"
    );
    const firstRowLock = MIG.indexOf('WHERE t.id=p_tournament_id FOR UPDATE');
    expect(shared).toBeGreaterThan(0);
    expect(exclusive).toBeGreaterThan(shared);
    expect(firstRowLock).toBeGreaterThan(exclusive);
    expect(MIG).toContain("PERFORM set_config('lock_timeout', '4s', true);");
    expect(MIG).toContain("RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE = '55P03';");
  });
});
