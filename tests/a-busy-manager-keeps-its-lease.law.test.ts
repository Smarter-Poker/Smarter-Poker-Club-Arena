/**
 * A BUSY MANAGER KEEPS ITS LEASE (2026-09-10).
 *
 * 649 tournament lease losses in 30 minutes on a single engine instance whose
 * every lease row was heartbeated within 5 seconds. Nobody took the leases:
 * the PostgREST pre-request hook held FOR SHARE on the lease row for every
 * in-flight manager write, the heartbeat renews with FOR NO KEY UPDATE ...
 * SKIP LOCKED, FOR SHARE conflicts with FOR NO KEY UPDATE, and the engine
 * treats a 'busy' reply as extending nothing - so a busy event expired its
 * own manager every 20 seconds and no table of it was ever balanced.
 *
 * The hook takes FOR KEY SHARE (conflicts with FOR UPDATE only); the takeover
 * (claim_tournament_lease_v2) locks FOR UPDATE before its upsert so it still
 * waits for every in-flight manager transaction. The engine's 'busy' rule is
 * unchanged and pinned here so nobody "fixes" the symptom by extending
 * authority on a locked row.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const LEASE = migrationNamed('a_busy_manager_keeps_its_lease');
const ENGINE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/services/tournamentLease.ts'),
  'utf8'
);

describe('a busy manager keeps its lease', () => {
  it('the hook takes FOR KEY SHARE, never FOR SHARE, on the lease row', () => {
    expect(LEASE).toContain("FOR KEY SHARE;\\n  END IF;'");
    expect(LEASE).toContain('post-condition: the hook still takes FOR SHARE');
  });

  it('the takeover locks FOR UPDATE before its upsert so it still waits for in-flight manager writes', () => {
    expect(LEASE).toContain('PERFORM 1 FROM public.engine_tournament_leases l');
    expect(LEASE).toContain("FOR UPDATE;\\n\\n'");
    expect(LEASE).toContain(
      'post-condition: the takeover does not lock FOR UPDATE before its upsert'
    );
  });

  it('is an asserted substitution on both definitions and re-reads the heartbeat shape', () => {
    expect(LEASE).toContain('hook anchor appears % times, expected 1');
    expect(LEASE).toContain('claim anchor appears % times, expected 1');
    expect(LEASE).toContain('FOR NO KEY UPDATE OF l SKIP LOCKED');
  });

  it('the engine still treats a busy exact generation as UNKNOWN - authority is never extended on a locked row', () => {
    expect(ENGINE).toContain("if (row.state === 'busy' && exactGeneration) continue;");
    expect(ENGINE).toContain('A busy exact generation extends');
  });

  it('records the lock matrix it relies on', () => {
    expect(LEASE).toContain('FOR KEY SHARE   conflicts with FOR UPDATE only');
    expect(LEASE).toContain('FOR SHARE       conflicts with FOR NO KEY UPDATE, FOR UPDATE');
  });
});
