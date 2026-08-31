/**
 * THE STATS ROLLUP'S LOAD-BEARING PROPERTIES.
 *
 * ca_player_stats_full measured 15,071 ms cold against an 8,000 ms
 * statement_timeout, which meant the Stats page was being CANCELLED on heavy
 * accounts rather than merely being slow. The fix was ca_hand_player_stat, a
 * narrow per-(player,hand) rollup. Four things about it are easy to undo by
 * accident and expensive to notice, so they are pinned here.
 *
 * These assert on the migration text rather than on behaviour because CI has no
 * database. That is a real limitation: they cannot prove the SQL is correct.
 * They can prove nobody quietly removed the parts whose absence would not fail
 * anything until production was already slow or already leaking.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '../supabase/migrations');
const ROLLUP = readFileSync(resolve(DIR, '20260825400000_stats_hand_rollup.sql'), 'utf8');
const RPC = readFileSync(resolve(DIR, '20260825410000_stats_rpc_reads_the_rollup.sql'), 'utf8');
const FWDPRUNE = readFileSync(
  resolve(DIR, '20260825440000_forward_roll_prunes_what_it_touched.sql'),
  'utf8'
);
const VACUUM = readFileSync(
  resolve(DIR, '20260825430000_ca_hand_player_idx_gets_autovacuum_settings.sql'),
  'utf8'
);
const V2 = readFileSync(resolve(DIR, '20260831235995_stats_v2_foundation.sql'), 'utf8');
const BOUNDED_V2 = readFileSync(
  resolve(DIR, '20260831235998_stats_v2_reads_bounded_rollup.sql'),
  'utf8'
);
const LOCKED_ROLLUPS = readFileSync(
  resolve(DIR, '20260901000005_stats_rollups_bounded_locked.sql'),
  'utf8'
);
const RECOVERY_BATCH = readFileSync(
  resolve(DIR, '20260901000006_stats_rollup_recovery_batch.sql'),
  'utf8'
);
const MAINTENANCE_PROBES = readFileSync(
  resolve(DIR, '20260901000007_stats_maintenance_probes_bounded.sql'),
  'utf8'
);

describe('recoverable Stats rollup operations', () => {
  it('serializes, bounds, and monotonically checkpoints the stat rollup', () => {
    expect(LOCKED_ROLLUPS).toContain(
      "pg_try_advisory_xact_lock(hashtext('ca_roll_hand_stats_forward'))"
    );
    expect(LOCKED_ROLLUPS).toContain('v_max_hands constant int := 15000');
    expect(LOCKED_ROLLUPS).toContain('LIMIT v_max_hands');
    expect(LOCKED_ROLLUPS).toContain('rolled_ceil = greatest');
    expect(LOCKED_ROLLUPS).toMatch(/ca_hand_player_stat_state[\s\S]{0,100}FOR UPDATE/);
  });

  it('bounds both directions of the player-hand index refresh and validates UUIDs', () => {
    expect(LOCKED_ROLLUPS.match(/LIMIT v_limit/g) ?? []).toHaveLength(2);
    expect(LOCKED_ROLLUPS).toContain('idx_ceil = greatest');
    expect(LOCKED_ROLLUPS).toContain('idx_floor = least');
    expect(LOCKED_ROLLUPS).not.toContain('[0-9a-fA-F-]{36}');
  });

  it('removes the raw-history tail from notable-hand reads', () => {
    expect(LOCKED_ROLLUPS).toContain("position('h.created_at > v_ceil' IN v_source)");
    expect(LOCKED_ROLLUPS).toContain(
      'Stats notable-hand path can still scan unbounded live history'
    );
  });

  it('keeps outage recovery inside the proven checkpointing batch', () => {
    expect(RECOVERY_BATCH).toContain('v_max_hands constant int := 3000');
    expect(RECOVERY_BATCH).toContain('coalesce(p_max_hands, 3000), 1), 3000');
  });
});

describe('scheduled Stats maintenance probes stay bounded', () => {
  it('indexes and reads the live daily ledger instead of 103k table records', () => {
    expect(MAINTENANCE_PROBES).toContain('idx_cmds_stat_date_table_club');
    expect(MAINTENANCE_PROBES).toMatch(
      /ca_clubs_with_rebuild_backlog[\s\S]*?FROM public\.club_member_daily_stats/
    );
    expect(MAINTENANCE_PROBES).toMatch(
      /ca_clubs_missing_hand_daily[\s\S]*?FROM public\.club_member_daily_stats/
    );
  });

  it('checks the daily shard directly and preserves service-only execution', () => {
    expect(MAINTENANCE_PROBES).toContain('FROM public.club_hand_daily_shard');
    expect(MAINTENANCE_PROBES).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_clubs_with_rebuild_backlog[\s\S]*?authenticated/
    );
    expect(MAINTENANCE_PROBES).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_clubs_missing_hand_daily\(date\)[\s\S]*?service_role/
    );
  });
});

describe('the read path does not touch hand_history for its window', () => {
  it('reads the analysis window from ca_hand_player_stat', () => {
    expect(RPC).toMatch(/FROM ca_hand_player_stat s\b/);
  });

  it('never selects hand_history directly', () => {
    /**
     * This is the whole optimisation. hand_history is 6.4 KB a row because the
     * JSONB is stored inline, so 750 of them is ~3,730 random page reads. If a
     * future edit reaches back into it "just for one more column", the page
     * returns to being cancelled and no test but this one will say so.
     */
    expect(RPC).not.toMatch(/\bFROM\s+hand_history\b/);
  });

  it('removes the unbounded live tail from the browser path', () => {
    expect(BOUNDED_V2).toContain("v_source := replace(v_source, v_tail, '')");
    expect(BOUNDED_V2).toContain('Stats page path can still open live hand history');
    expect(BOUNDED_V2).toContain("'live_tail_included', false");
    expect(BOUNDED_V2).toContain("'rollup_covered_through', to_jsonb(v_rollup_ceil)");
  });

  it('still reports lifetime from the index, not from the 750-hand window', () => {
    // Otherwise "hands played" silently becomes 750 for everyone above the cap.
    expect(RPC).toMatch(/FROM ca_hand_player_idx WHERE user_id = p_user/);
    expect(RPC).toMatch(/'hands', v_life_hands/);
  });
});

describe('there is exactly one definition of the math', () => {
  it('defines ca_hand_player_facts once, in the rollup migration', () => {
    const defs = (ROLLUP + RPC).match(/CREATE OR REPLACE FUNCTION public\.ca_hand_player_facts/g);
    expect(defs).toHaveLength(1);
  });

  it('has the builder call the facts function rather than restate it', () => {
    /**
     * A rollup that computes its own version of VPIP is a rollup that will
     * eventually disagree with the page it feeds, and the disagreement shows up
     * as a number a player believes.
     */
    const builder = ROLLUP.slice(ROLLUP.indexOf('FUNCTION public.ca_roll_hand_stats'));
    expect(builder).toMatch(/FROM ca_hand_player_facts\(/);
  });

  it('takes a time range, not a list of hand ids', () => {
    // Measured 0.4 ms/hand by range against 25 ms/hand by id list: the table is
    // physically ordered by created_at, so a range is near-sequential and an id
    // list is thousands of independent random fetches.
    expect(ROLLUP).toMatch(/ca_hand_player_facts\(\s*\n?\s*p_from timestamptz/);
    expect(ROLLUP).not.toMatch(/h\.id = ANY\(p_hand_ids\)/);
    expect(ROLLUP).toMatch(/WHERE h\.created_at >= p_from AND h\.created_at < p_to/);
  });
});

describe('the rollup is not readable by a client', () => {
  it('revokes both tables from anon and authenticated', () => {
    for (const t of ['ca_hand_player_stat', 'ca_hand_player_stat_state']) {
      expect(ROLLUP).toContain(`REVOKE ALL ON TABLE public.${t} FROM anon;`);
      expect(ROLLUP).toContain(`REVOKE ALL ON TABLE public.${t} FROM authenticated;`);
    }
  });

  it('enables RLS on the payload table', () => {
    expect(ROLLUP).toMatch(/ALTER TABLE public\.ca_hand_player_stat ENABLE ROW LEVEL SECURITY/);
  });

  it('revokes the facts function from authenticated, not just from PUBLIC and anon', () => {
    /**
     * THE TRAP THIS DATABASE SETS. It carries
     *   ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role
     * so every new function is created with an EXPLICIT grant to `authenticated`.
     * REVOKE ... FROM PUBLIC does not touch an explicit grant. The original
     * migration revoked PUBLIC and anon, looked locked down, and left
     * ca_hand_player_facts - SECURITY DEFINER, arbitrary time range, one row per
     * player per hand for EVERY player - callable from any logged-in browser.
     */
    expect(ROLLUP).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_hand_player_facts\(timestamptz, timestamptz, uuid\) FROM authenticated;/
    );
  });

  it('has an assertion that can actually fail on an authenticated grant', () => {
    // The first version checked only grantee = 0 and anon, so the grant the
    // database itself hands out passed silently. An assertion that cannot fail
    // is worse than no assertion: it reads as a guarantee.
    expect(ROLLUP).toMatch(/a\.grantee = 'authenticated'::regrole/);
    expect(ROLLUP).toMatch(
      /RAISE EXCEPTION 'An internal rollup function is reachable from a browser/
    );
  });

  it('replaces the arbitrary-target browser grant with an owner-only versioned wrapper', () => {
    expect(V2).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_stats_full\(uuid, integer\)[\s\S]{0,100}authenticated;/
    );
    expect(V2).toMatch(/FUNCTION public\.ca_player_stats_overview_v2/);
    expect(V2).toMatch(/PERFORM public\.ca_assert_self\(p_user\)/);
    expect(V2).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ca_player_stats_overview_v2\(uuid, integer\)[\s\S]{0,80}authenticated, service_role;/
    );
  });

  it('asserts at apply time that no client role can reach them', () => {
    /**
     * The table holds EVERY player's results, so a stray GRANT is not a
     * performance bug, it is other people's numbers. The assertion uses
     * grantee = 0 because aclexplode reports PUBLIC as oid 0 and pg_roles has
     * no row with that oid - joining to pg_roles silently drops every PUBLIC
     * entry before the WHERE is evaluated, which is how the earlier version of
     * this check passed whether or not the REVOKE had worked.
     */
    expect(ROLLUP).toMatch(/a\.grantee = 0 OR a\.grantee = 'anon'::regrole/);
    expect(ROLLUP).toMatch(/RAISE EXCEPTION 'The rollup tables are readable by a client role/);
  });
});

describe('the builder can be looped safely', () => {
  it('returns hands consumed, not rows inserted', () => {
    /**
     * Returning the INSERT's row count made "this window was already rolled"
     * indistinguishable from "there is nothing older left", so a caller looping
     * until 0 stopped early and believed the backfill had finished.
     */
    expect(ROLLUP).toMatch(/RETURN v_hands;/);
    expect(ROLLUP).not.toMatch(/GET DIAGNOSTICS v_rows = ROW_COUNT;[\s\S]{0,400}RETURN v_rows;/);
  });

  it('cannot spin forever on a window where every hand shares a timestamp', () => {
    expect(ROLLUP).toMatch(/IF v_next >= v_floor THEN[\s\S]{0,120}interval '1 microsecond'/);
  });

  it('prunes to a bounded retention', () => {
    // Without this the rollup grows towards the 14.2m rows it exists to avoid.
    expect(ROLLUP).toMatch(/FUNCTION public\.ca_prune_hand_player_stat\(p_keep int DEFAULT 1000\)/);
  });
});

describe('the other half of the fix: the lifetime count', () => {
  it('gives ca_hand_player_idx insert-driven autovacuum', () => {
    /**
     * The rollup replaced 750 hand_history fetches. It did NOT touch the second
     * cost in the same RPC: "lifetime hands" is an index-only scan over
     * ca_hand_player_idx, and an index-only scan is only index-only where the
     * VISIBILITY MAP says a page is all-visible. That table had never been
     * vacuumed - last_vacuum, last_autovacuum and last_autoanalyze were all NULL
     * on 14,180,471 rows - so every tuple fell back to a heap fetch:
     *
     *   Index Only Scan ... Heap Fetches: 17308   Execution Time: 14,257 ms
     *
     * autovacuum_vacuum_insert_threshold is what makes autovacuum visit an
     * INSERT-only table at all. After one run: Heap Fetches 247, 698 ms.
     */
    expect(VACUUM).toMatch(/ALTER TABLE public\.ca_hand_player_idx SET \(/);
    expect(VACUUM).toMatch(/autovacuum_vacuum_insert_threshold = 20000/);
  });

  it('pins the scale factors to 0 so the thresholds stay absolute', () => {
    // A default scale factor of 0.2 on a 14m-row table means "wait for 2.8
    // million more rows", which is how it went unvacuumed indefinitely.
    expect(VACUUM).toMatch(/autovacuum_vacuum_scale_factor = 0\.0/);
    expect(VACUUM).toMatch(/autovacuum_vacuum_insert_scale_factor = 0\.0/);
  });

  it('also keeps the rollup itself vacuumed, since pruning churns it', () => {
    expect(VACUUM).toMatch(/ALTER TABLE public\.ca_hand_player_stat SET \(/);
  });
});

describe('the tail asks for one player', () => {
  it('passes p_user into the facts function rather than filtering after', () => {
    expect(RPC).toMatch(/ca_hand_player_facts\(coalesce\(v_ceil, now\(\)\), now\(\), p_user\)/);
  });

  it('keeps the redundant WHERE as a belt-and-braces', () => {
    // So a future change to the argument list cannot silently widen this branch.
    expect(RPC).toMatch(/WHERE f\.user_id = p_user/);
  });
});

describe('retention is self-enforcing', () => {
  it('prunes inside the forward roll, not in a second job somebody must remember', () => {
    /**
     * ca_prune_hand_player_stat existed and was called by the one-off backfill
     * runner and by nothing else, so the 15-minute cron only ever added rows.
     * Measured 25 minutes after the backfill: 584,887 rows had become 721,397.
     * At ~142,000 hands a day and ~13 seated players a hand that is ~1.85m rows
     * a day, and the table would have passed the 14.2m rows this design exists
     * to avoid inside a week - with nothing red to say so.
     */
    expect(FWDPRUNE).toMatch(/FUNCTION public\.ca_roll_hand_stats_forward\(\)/);
    expect(FWDPRUNE).toMatch(/DELETE FROM ca_hand_player_stat s/);
    expect(FWDPRUNE).toMatch(/WHERE r\.rn > 1000/);
  });

  it('scopes the prune to the players the roll just touched', () => {
    // A full-table sweep is a window function over every row and took 24-40s
    // during the backfill. This one is bounded by who actually played.
    expect(FWDPRUNE).toMatch(/RETURNING user_id/);
    expect(FWDPRUNE).toMatch(/WHERE user_id = ANY\(v_users\)/);
  });

  it('does not try to prune in the same statement as the insert', () => {
    /**
     * A DELETE in the same statement as the INSERT cannot see the rows that
     * INSERT is adding - they are not in its snapshot - so the row_number()
     * ranking would be computed without the newest hands and would delete
     * exactly the wrong ones. The array round-trip is the fix, not clumsiness.
     */
    expect(FWDPRUNE).toMatch(/SELECT array_agg\(DISTINCT user_id\) INTO v_users FROM ins;/);
    expect(FWDPRUNE).not.toMatch(/RETURNING user_id\s*\)\s*,\s*\w+\s+AS\s*\(\s*DELETE/i);
  });
});
