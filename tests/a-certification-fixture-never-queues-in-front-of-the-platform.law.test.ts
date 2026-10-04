/**
 * LAW: A CERTIFICATION FIXTURE NEVER QUEUES IN FRONT OF THE PLATFORM (2026-10-03).
 *
 * Advisory lock (530090,1) is the platform's entry and maintenance gate: every
 * purchase path takes it SHARED. Four production welcome-certification
 * fixtures took it EXCLUSIVE with pg_advisory_xact_lock, and a waiting
 * exclusive request makes every later shared request queue behind it, so each
 * fixture wait stalled every purchase on the platform (79 fixture waits of
 * 1 s or more, up to 7.6 s, in the 24 h to 00:30 UTC 2026-10-04). They now poll
 * pg_try_advisory_xact_lock every 50 ms for up to 30 s, which never joins the
 * queue, and still hold the gate exclusively to the end of their transaction.
 *
 * What this pins: exactly the four fixtures are substituted, each from its
 * md5-pinned live text to a pinned post-image; the replacement never calls the
 * queueing lock; it is bounded (600 tries x 50 ms) and refuses with 55P03; the
 * maintenance break functions are not touched; the proof ships.
 * scripts/ci/test-a-certification-fixture-never-queues-in-front-of-the-platform.py
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261004002615_a_certification_fixture_never_queues_in_front_of_the_platfor.sql';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE), 'utf8');

function assigned(name: string): string {
  const m = MIG.match(new RegExp(`  ${name} := ((?:E'(?:[^'\\\\]|\\\\.)*'\\s*(?:\\|\\|\\s*)?)+);`));
  expect(m, `${name} is assigned`).not.toBeNull();
  return [...m![1].matchAll(/E'((?:[^'\\]|\\.)*)'/g)]
    .map((p) => p[1].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .join('');
}

describe('a certification fixture never queues in front of the platform', () => {
  const OLD = assigned('v_old');
  const NEW = assigned('v_new');

  it('replaces exactly the queueing exclusive gate lock', () => {
    expect(OLD).toBe('  PERFORM pg_advisory_xact_lock(530090,1);\n');
    expect(NEW).not.toMatch(/(?<!try_)advisory_xact_lock\(530090,1\)/);
    expect(NEW).toContain('WHILE NOT pg_try_advisory_xact_lock(530090,1) LOOP');
    expect(NEW).toContain('IF v_gate_tries >= 600 THEN');
    expect(NEW).toContain('PERFORM pg_sleep(0.05);');
    expect(NEW).toContain("RAISE EXCEPTION 'CERTIFICATION_FIXTURE_GATE_BUSY' USING ERRCODE = '55P03';");
  });

  it('touches the four fixtures and nothing else, each pinned before and after', () => {
    const touched = [...MIG.matchAll(/v_sig := 'public\.([a-z0-9_]+)\(uuid\)'::regprocedure;/g)].map((m) => m[1]);
    expect(touched.sort()).toEqual(
      [
        'fn_ca_prepare_post_reset_welcome_certification_fixture',
        'fn_ca_prepare_unused_welcome_certification_board_games',
        'fn_ca_prepare_unused_welcome_certification_board_leases',
        'fn_ca_prepare_unused_welcome_certification_board_origins',
      ].sort()
    );
    expect(MIG.match(/v_pin := '[0-9a-f]{32}';/g)).toHaveLength(4);
    expect(MIG.match(/v_post := '[0-9a-f]{32}';/g)).toHaveLength(4);
    expect(MIG.match(/IF v_n <> 1 THEN/g)).toHaveLength(4);
    expect(MIG).not.toMatch(/engine_maintenance_break|fn_thaw_platform\(/);
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('ships the disposable-cluster proof', () => {
    expect(
      existsSync(resolve(process.cwd(), 'scripts/ci/test-a-certification-fixture-never-queues-in-front-of-the-platform.py'))
    ).toBe(true);
  });
});
