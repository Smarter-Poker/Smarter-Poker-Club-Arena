/**
 * A TOURNAMENT HEARTBEAT WALKS EACH LEASE ONCE (2026-10-03).
 *
 * 09:34-09:38 UTC: 470 tournament_lease_proof_expired + 333
 * tournament_lease_lost while one back-office transaction (cron job 407,
 * 09:25-09:40) pinned the xmin horizon. Every tournament-manager write locks
 * its lease row FOR KEY SHARE and the heartbeat updates that row every 5 s,
 * so each superseded version carries a MultiXact xmax that no pruning can
 * remove while the horizon is pinned. heartbeat_tournament_leases_v4 probed
 * every claimed row three times and each probe walked the whole chain; the
 * dedicated heartbeat hit its 8 s statement_timeout five times.
 *
 * These assertions pin the narrow shape of the cure: the UPDATE reaches the
 * exact locked version by ctid, the answer reads the row only for claims
 * that were not renewed, every renewal predicate and the classification
 * rules stay, and the edit refuses a function it has not measured.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const SLUG = 'a_tournament_heartbeat_walks_each_lease_once';
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const FIX = migrationNamed(SLUG);
const between = (from: string, to: string): string => {
  const start = FIX.indexOf(from);
  expect(start, `missing ${from}`).toBeGreaterThan(-1);
  const end = FIX.indexOf(to, start + from.length);
  expect(end, `missing ${to} after ${from}`).toBeGreaterThan(start);
  return FIX.slice(start, end);
};
const EDITS = between('v_edits := jsonb_build_array(', 'v_new := v_src;');
const PROOF = between('DO $prove$', '$prove$;');

describe('a tournament heartbeat walks each lease once', () => {
  it('is one transaction that edits only the tournament heartbeat, by measured anchors', () => {
    expect(FIX.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(FIX.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(FIX).toContain("SET LOCAL lock_timeout = '2s';");
    expect(FIX).toMatch(/^-- @live-proof: .+$/m);
    expect(FIX).toContain(
      "'public.heartbeat_tournament_leases_v4(text,jsonb,integer)'::regprocedure"
    );
    expect(FIX).not.toMatch(/heartbeat_table_leases_v4\(text/);
    expect(FIX).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    // Refuses a definition it has not read, and is a no-op once applied.
    expect(FIX).toContain("IF md5(v_src) <> '01fa17de7097d3c42748e6879b478411' THEN");
    expect(FIX).toContain('IF position(v_marker in v_src) > 0 THEN');
    expect(FIX).toContain('IF v_n <> 1 THEN');
    expect(EDITS.match(/'anchor', \$a\$/g)).toHaveLength(3);
  });

  it('renews only the exact version the lockable CTE locked, with every predicate kept', () => {
    expect(EDITS).toContain('SELECT l.tournament_id, l.ctid AS row_ctid');
    expect(EDITS).toContain(
      '     WHERE l.ctid = k.row_ctid\n       AND l.tournament_id = k.tournament_id\n       AND l.tournament_id = a.id\n'
    );
    // The lock mode and the renewal predicates (instance, protocol,
    // generation, abort fence, 30 s staleness) are outside every anchor, so
    // the measured function keeps them verbatim in the lockable CTE and the
    // UPDATE.
    const anchors = [...EDITS.matchAll(/'anchor', \$a\$([\s\S]*?)\$a\$/g)].map((m) => m[1]);
    expect(anchors).toHaveLength(3);
    for (const untouched of [
      'FOR NO KEY UPDATE OF l SKIP LOCKED',
      'AND l.instance_id = p_instance_id',
      "AND l.heartbeat_at >= clock_timestamp() - interval '30 seconds'",
      'AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation)\n',
      'SET heartbeat_at = clock_timestamp()',
    ]) {
      for (const anchor of anchors) expect(anchor).not.toContain(untouched);
    }
  });

  it('answers a renewed claim from the UPDATE and reads the row only for the others', () => {
    const answer = EDITS.slice(EDITS.lastIndexOf("'with', $w$"));
    expect(answer).toContain("WHEN r.tournament_id IS NOT NULL THEN 'kept'");
    expect(answer).toContain('WHEN r.tournament_id IS NOT NULL THEN r.lease_generation');
    expect(answer).toContain("WHERE l.tournament_id = a.id), 'missing')");
    expect(answer).not.toContain('LEFT JOIN public.engine_tournament_leases');
    // The classification rules for a claim that was not renewed are unchanged.
    for (const rule of [
      "WHEN l.heartbeat_at < clock_timestamp() - interval '30 seconds' THEN 'stale'",
      'WHEN l.instance_id = p_instance_id',
      'AND l.protocol_version = 2',
      'AND l.lease_generation = a.requested_generation',
      "AND NOT smarter_private.f06_generation_aborted(l.tournament_id,a.requested_generation) THEN 'busy'",
      "ELSE 'taken'",
    ]) {
      expect(answer).toContain(rule);
    }
  });

  it('proves the live function without renewing anything', () => {
    expect(PROOF).toContain(
      "p.acl <> '{postgres=X/postgres,service_role=X/postgres,engine_lease_heartbeat=X/postgres}'"
    );
    expect(PROOF).toContain("'migration-proof'");
    expect(PROOF).toContain("v_state IS DISTINCT FROM 'missing' OR v_gen IS NOT NULL");
    expect(PROOF).not.toMatch(/\b(UPDATE|DELETE|INSERT)\s+(INTO\s+)?public\./);
  });
});
