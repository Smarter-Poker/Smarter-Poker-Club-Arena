import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { blankNonCode } from '../testHelpers/sourceWindow.js';

const repoRoot = join(process.cwd(), '..');
const migrationDir = join(repoRoot, 'supabase', 'migrations');
const matches = readdirSync(migrationDir).filter((name) =>
  name.endsWith('_hand_projection_takes_post_commit_lock_first.sql')
);
const migration = matches.length === 1 ? readFileSync(join(migrationDir, matches[0]), 'utf8') : '';
const pg17Runner = readFileSync(
  join(repoRoot, 'scripts', 'dev', 'probe-hand-projection-lock-order-pg17.sh'),
  'utf8'
);
const pg17Probe = readFileSync(
  join(repoRoot, 'scripts', 'dev', 'probe-hand-projection-lock-order-pg17.sql'),
  'utf8'
);

describe('hand projection and post-commit use one per-table lock order', () => {
  it('has exactly one reserved forward migration', () => {
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/^\d{14}_hand_projection_takes_post_commit_lock_first\.sql$/);
    expect(migration).toContain('BEGIN;');
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('reads exact immutable scope before either claim or side effect', () => {
    const scope = migration.indexOf('FROM public.hand_projection_outbox o');
    const history = migration.indexOf('FROM public.hand_history h');
    const receipt = migration.indexOf('FROM public.hand_atomic_commits c');
    const scopeMismatch = migration.indexOf(
      'pending hand projection scope disagrees with immutable hand receipt'
    );
    const postLock = migration.indexOf("hashtextextended('hand-post-commit:'");

    expect(scope).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(scope);
    expect(receipt).toBeGreaterThan(history);
    expect(scopeMismatch).toBeGreaterThan(receipt);
    expect(postLock).toBeGreaterThan(scopeMismatch);
    expect(migration.slice(scope, postLock)).not.toContain('FOR UPDATE');
  });

  it('completes or refuses post-commit before projection and exact claim', () => {
    const postLock = migration.indexOf("hashtextextended('hand-post-commit:'");
    const processor = migration.indexOf('fn_ca_process_hand_post_commit_obligations');
    const failClosed = migration.indexOf("'projection_applied', false");
    const projectionLock = migration.indexOf("hashtextextended('hand-projection:'");
    const coreCall = migration.indexOf(
      'RETURN public.fn_project_hand_side_effects_after_post_commit_20260908('
    );

    expect(processor).toBeGreaterThan(postLock);
    expect(failClosed).toBeGreaterThan(processor);
    expect(projectionLock).toBeGreaterThan(failClosed);
    expect(coreCall).toBeGreaterThan(projectionLock);
    expect(migration).toContain(
      "COALESCE(v_post_commit->>'reason', '') <> 'legacy_no_obligations'"
    );
  });

  it('preserves exact claim, predecessor order, and delete-trigger defense privately', () => {
    expect(migration).toContain('FOR UPDATE OF o');
    expect(migration).toContain('predecessor_pending');
    expect(migration).toContain('DELETE FROM public.hand_projection_outbox');
    expect(migration).toContain("t.tgname = 'a0_finish_hand_post_commit_obligations'");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION\n  public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)\n  FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_project_hand_side_effects(uuid)\n  TO service_role;'
    );
  });

  it('adds no retry, timer, cron, or exception-swallowing substitute', () => {
    const executable = blankNonCode(migration);
    expect(executable).not.toMatch(/\bLOOP\b|pg_cron|cron\.schedule|pg_sleep/i);
    expect(executable).not.toMatch(/EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+(?:NULL|RETURN)/i);
  });

  it('reproduces the original PG17 cycle and reruns the same fixed schedule', () => {
    expect(pg17Runner).toContain('-c deadlock_timeout=100ms');
    expect(pg17Runner).toContain('-v ORIGINAL=1');
    expect(pg17Runner).toContain('-v FIXED=1');
    expect(pg17Runner.match(/"\$\{psql_cmd\[@\]\}" -f "\$lock_order_migration"/g)).toHaveLength(2);
    expect(pg17Probe).toContain('expected one original deadlock victim');
    expect(pg17Probe).toContain('FOR UPDATE NOWAIT');
    expect(pg17Probe).toContain('fixed projector claimed outbox before post-commit completed');
    expect(pg17Probe).toContain('fixed concurrent calls did not both complete');
    expect(pg17Probe).toContain('(SELECT count(*) FROM public.probe_rake_receipts) <> 2');
  });
});
