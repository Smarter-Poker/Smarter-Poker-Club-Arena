/**
 * ===========================================================================
 *  LAW - A LAUNCH DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT
 * ===========================================================================
 *
 * "Engine Restart Storm", 2026-10-25 13:27:10 UTC: 41 watchdog_kill_rebuild
 * rows in 140 ms, all `tournament_lease_lost`, all tables of one tournament
 * whose launch had just completed. Twice more the same day on one table each
 * (18:25:35, 19:27:30), every time the ONE tournament that was launching while
 * the rest of the fleet renewed normally, every time preceded by the
 * tournament heartbeat answering `busy` for that row.
 *
 * fn_begin_tournament_launch_atomic and fn_complete_tournament_launch_atomic
 * held FOR UPDATE on the event's engine_tournament_leases row for the life of
 * the launch transaction. heartbeat_tournament_leases_v4 locks FOR NO KEY
 * UPDATE ... SKIP LOCKED and answers `busy` for a row it cannot lock; `busy`
 * extends nothing. So the launching manager could not renew through its own
 * launch, its 20 s proof ran out, and it fenced every table it owned. The
 * lease never moved. The hand-commit path had the same defect fixed on
 * 2026-09-10 (20260910064701); the launch path never got the correction.
 *
 * Migration 20261025200555 rewrites all six launch overloads to FOR KEY SHARE,
 * which blocks a takeover (FOR UPDATE) and a release (DELETE) exactly as
 * before and nothing else. scripts/ci/test-launch-lease-key-share-postgres.py
 * proves it on native PostgreSQL with two sessions: busy before, kept after,
 * takeover still blocked.
 *
 * This holds the pieces together: the migration carries the anchor, the KEY
 * SHARE clause and its post-conditions; no later migration re-defines a launch
 * overload with FOR UPDATE on the lease row; the heartbeat still skips a locked
 * row instead of queueing behind it; and the native proof stays wired into CI.
 *
 * Registry: docs/laws.d/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.md
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationCorpus, migrationText } from './helpers/migrationCorpus';

const FILE = '20261025200555_a_launch_does_not_hold_the_lease_against_its_own_heartbeat.sql';
const VERSION = FILE.slice(0, 14);
const LAUNCH_FUNCTIONS = [
  'fn_begin_tournament_launch_atomic',
  'fn_complete_tournament_launch_atomic',
] as const;
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

/** Each CREATE [OR REPLACE] FUNCTION body for one of the launch overloads in a file. */
function launchFunctionBodies(sql: string): string[] {
  const bodies: string[] = [];
  const heads =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(fn_begin_tournament_launch_atomic|fn_complete_tournament_launch_atomic)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = heads.exec(sql)) !== null) {
    const rest = sql.slice(match.index);
    const open = rest.match(/\$([A-Za-z_]*)\$/);
    if (!open) continue;
    const tag = open[0];
    const start = rest.indexOf(tag) + tag.length;
    const end = rest.indexOf(tag, start);
    bodies.push(end === -1 ? rest.slice(start) : rest.slice(start, end));
  }
  return bodies;
}

const LEASE_FOR_UPDATE = /engine_tournament_leases\s+l\s[^;]*FOR UPDATE;/;
const LEASE_KEY_SHARE = /engine_tournament_leases\s+l\s[^;]*FOR KEY SHARE;/;

describe('a launch does not hold the lease against its own heartbeat', () => {
  it('rewrites the lease-row lock of every launch overload from FOR UPDATE to FOR KEY SHARE, by exact anchor', () => {
    const sql = migrationText(FILE);
    expect(sql).toContain(
      "v_anchor text := E'   WHERE l.tournament_id = p_tournament_id\\n   FOR UPDATE;'"
    );
    expect(sql).toContain('A LAUNCH DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT');
    expect(sql).toContain("|| E'   FOR KEY SHARE;'");
    for (const fn of LAUNCH_FUNCTIONS) expect(sql).toContain(`'${fn}'`);
    // Exactly one anchor per overload, all six overloads, or the whole thing aborts.
    expect(sql).toMatch(/IF v_n <> 1 THEN\s*RAISE EXCEPTION 'launch lease anchor appears % times/);
    expect(sql).toMatch(/IF v_done <> 6 THEN/);
    // One transaction (production DDL policy), with a lock timeout.
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('DO $body$'));
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('asserts afterwards that no launch overload locks the lease row FOR UPDATE and the takeover still does', () => {
    const sql = migrationText(FILE);
    expect(sql).toContain("p.prosrc ~ 'engine_tournament_leases l\\s[^;]*FOR UPDATE;'");
    expect(sql).toContain('still take FOR UPDATE on engine_tournament_leases');
    expect(sql).toContain("p.prosrc ~ 'engine_tournament_leases l\\s[^;]*FOR KEY SHARE;'");
    expect(sql).toContain('IF v_n <> 6 THEN');
    expect(sql).toContain("proname = 'claim_tournament_lease_v2'");
    expect(sql).toContain('FOR KEY SHARE would fence nothing');
    expect(sql).toContain("'FOR NO KEY UPDATE OF l SKIP LOCKED'");
  });

  it('is not undone by a later migration that re-defines a launch overload with FOR UPDATE on the lease row', () => {
    const later = migrationCorpus().filter((m) => m.name.slice(0, 14) > VERSION);
    const offenders: string[] = [];
    for (const m of later) {
      for (const body of launchFunctionBodies(m.sql)) {
        if (LEASE_FOR_UPDATE.test(body) || !LEASE_KEY_SHARE.test(body)) offenders.push(m.name);
      }
    }
    expect(
      offenders,
      'a launch overload re-defined after 20261025200555 must lock engine_tournament_leases FOR KEY SHARE, never FOR UPDATE: ' +
        'the heartbeat answers busy for a FOR UPDATE row and the launching manager fences every table it owns'
    ).toEqual([]);
  });

  it('keeps the heartbeat skipping a locked row rather than queueing behind it', () => {
    // The fix relies on this lock being FOR NO KEY UPDATE (not blocked by KEY SHARE)
    // and SKIP LOCKED (never queued behind a settlement).
    const heartbeat = migrationCorpus()
      .filter((m) =>
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.heartbeat_tournament_leases_v4\s*\(/.test(
          m.sql
        )
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(heartbeat.length).toBeGreaterThan(0);
    const latest = heartbeat[heartbeat.length - 1];
    expect(latest.sql).toContain('FOR NO KEY UPDATE OF l SKIP LOCKED');
  });

  it('keeps its native two-session PostgreSQL proof in CI', () => {
    // Its own workflow, like the other native proofs: ci.yml's bytes are
    // pinned by the financial source bindings, so a proof never edits it.
    const workflow = read(
      '.github/workflows/a-launch-does-not-hold-the-lease-against-its-own-heartbeat.yml'
    );
    expect(workflow).toContain('python3 scripts/ci/test-launch-lease-key-share-postgres.py');
    expect(workflow).toContain('pull_request:');
    expect(workflow).not.toContain('schedule:');
    for (const path of [
      `supabase/migrations/${FILE}`,
      'scripts/qualification/fixtures/launch-lease-key-share/**',
      'scripts/ci/test-launch-lease-key-share-postgres.py',
    ]) {
      expect(workflow).toContain(path);
    }
    const proof = read('scripts/ci/test-launch-lease-key-share-postgres.py');
    expect(proof).toContain("assert state == 'busy'");
    expect(proof).toContain("assert state == 'kept'");
    expect(proof).toContain('the takeover was not blocked by a launch in flight');
    expect(proof).toContain(FILE);
  });
});
