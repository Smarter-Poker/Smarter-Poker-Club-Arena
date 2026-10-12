/**
 * A FINISH WAITS ONLY FOR WHAT IT SHARES (2026-10-03).
 *
 * Pinned on migration 20261003164157_a_finish_waits_only_for_what_it_shares.sql.
 * Production 15:30-16:35 UTC: 312 of 315 exclusive requests for
 * ca:tournament-finish-lane:v1 were satellite qualifier ASKS, and each one
 * drained and then blocked every ordinary finish on the platform (569 s of
 * finish waits on F shared). The ask now takes F shared and both T keys
 * exclusively, so the satellite's payer (F exclusive, both T keys) is still
 * waited for and unrelated finishes are not. Every finish also closed its
 * table through fn_refresh_club_activity_counts, which walked every table the
 * club ever had and rewrote the clubs row unconditionally; it now reads a
 * partial index and writes only a changed count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261003164157_a_finish_waits_only_for_what_it_shares.sql'
  ),
  'utf8'
);
const lane = sql.slice(
  sql.indexOf('CREATE FUNCTION public.fn_ca_lock_satellite_answer_lane('),
  sql.indexOf('$function$;')
);

describe('a finish waits only for what it shares', () => {
  it('is one index preamble and one transaction with a live proof', () => {
    const split = splitConcurrentPreamble(sql);
    expect(split.ok).toBe(true);
    if (split.ok)
      expect(split.indexes.map((i) => i.name)).toEqual(['idx_tables_club_activity_live']);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toMatch(/^-- @live-proof: /m);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('builds the index on exactly the refresh filter and refuses anything else by name', () => {
    expect(sql).toContain(
      "WHERE (lower(COALESCE(status, ''::text)) <> ALL (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text]));"
    );
    expect(sql).toContain('AND i.indisvalid AND i.indisready AND i.indislive');
  });

  it('the answer-only lane takes G, F and T(first) through the finish re-entry, then T(second), in uuid order', () => {
    const scope = lane.indexOf("PERFORM set_config('ca.finish_lane_scope', '', true);");
    const name = lane.indexOf(
      "PERFORM set_config('ca.finish_lane_tournament', v_first::text, true);"
    );
    const reentry = lane.lastIndexOf('PERFORM public.fn_ca_lock_settlement_lane_for_finish(NULL);');
    const second = lane.indexOf("'ca:tournament-terminal-settlement:v1:' || v_second::text");
    const satellite = lane.indexOf(
      "PERFORM set_config('ca.finish_lane_tournament', p_satellite_id::text, true);"
    );
    expect(scope).toBeGreaterThan(0);
    expect(name).toBeGreaterThan(scope);
    expect(reentry).toBeGreaterThan(name);
    expect(second).toBeGreaterThan(reentry);
    expect(satellite).toBeGreaterThan(second);
    expect(lane).toContain('IF p_satellite_id::text < v_target_id::text THEN');
  });

  it('never names F or G itself, so the lane doctrine still sees only its three F helpers', () => {
    expect(lane).not.toContain('ca:tournament-finish-lane');
    expect(lane).not.toMatch(/'ca:tournament-terminal-settlement:v1'/);
    expect(lane).not.toContain('fn_ca_lock_settlement_lane_global');
  });

  it('no target, or a re-entry, keeps the lane it always had', () => {
    expect(lane).toContain(
      'PERFORM public.fn_ca_lock_settlement_lane_for_satellite_finish(p_satellite_id);'
    );
    expect(
      lane.match(/PERFORM public\.fn_ca_lock_settlement_lane_for_finish\(NULL\);/g)?.length
    ).toBe(2);
  });

  it('only the qualifier ask moves to it, edited from its exact preimage', () => {
    expect(sql).toContain("IF md5(d) <> 'c98348c74d821296e277f94b2987bdec' THEN");
    expect(sql).toContain(
      "E' PERFORM public.fn_ca_lock_satellite_answer_lane(p_tournament_id);\\n'"
    );
    expect(sql).toContain(
      "RAISE EXCEPTION 'qualifier ask postimage differs from the substituted text'"
    );
  });

  it('the club refresh writes only a changed count, edited from its exact preimage', () => {
    expect(sql).toContain("IF md5(d) <> '6d1c533f259826f0c9c3424b1b3737b7' THEN");
    expect(sql).toContain("AND (c.active_players IS DISTINCT FROM coalesce(p.n, 0)\\n'");
    expect(sql).toContain("OR c.active_tables IS DISTINCT FROM coalesce(t.n, 0));\\n'");
  });

  it('asks the lane doctrine in the same transaction and grants nothing to browsers', () => {
    expect(sql).toContain('public.fn_ca_settlement_lane_doctrine()');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.fn_ca_lock_satellite_answer_lane(uuid)');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(sql).toContain("IS DISTINCT FROM '{postgres=X/postgres}' THEN");
    expect(sql).not.toMatch(/GRANT[^;]*\b(anon|authenticated)\b/);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
    expect(sql).not.toMatch(/cron\.(schedule|alter_job|unschedule)\(/);
  });
});
