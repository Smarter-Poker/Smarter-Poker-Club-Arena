/**
 * A BARE PARK REQUEST IS NOT A MOVE IN FLIGHT
 *
 * smarter_private.f06_source_guard()'s `bound` check counted ANY
 * non-acknowledged/non-withdrawn smarter_private.f06_operations row as a live
 * move that must exclude every ordinary writer to its table - including a
 * bare `park_requested` row with no manifest, no admission, no member, no
 * attempt and no close/cleanup/abort evidence: a planned move whose table
 * concluded before the move could manifest. The function's own
 * elimination-dispatch fast path already treats exactly that shape as
 * unbound; `bound` never got the same nuance. Production tournament
 * bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f (Production Alerts board,
 * Smarter-Poker/Smarter-Poker-Club-Arena#5070) sat RUNNING for nine days
 * because its own terminal settlement could not flip its winner's status
 * past this guard, and 7 tables across the platform carried the same bare,
 * abandoned shape at the time this was written.
 *
 * The executable red-before/green-after proof is
 * scripts/dev/probe-f06-source-guard-unbinds-bare-park-request-pg16.sh,
 * which rebuilds the exact production pre-image (pinned by md5, read
 * 2026-09-27) against a throwaway PostgreSQL cluster, reproduces
 * F06_SOURCE_EXCLUDED on the pre-image, applies the migration, and proves
 * the same write now succeeds while a genuinely bound operation (a row with
 * a real manifest) still correctly refuses. This file pins the migration
 * text that proof depends on.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');

const migrationPath = (suffix: string): string => {
  const matches = readdirSync(migrations)
    .filter((name) => name.endsWith(`_${suffix}`) || name.endsWith(`_${suffix}.pending`))
    .map((name) => join(migrations, name));
  expect(matches, `expected exactly one staged-or-promoted ${suffix}`).toHaveLength(1);
  return matches[0] ?? '';
};

const path = migrationPath('f06_source_guard_unbinds_bare_park_requests.sql');
const SQL = readFileSync(path, 'utf8');

const PROBE_SCRIPT = readFileSync(
  join(repo, 'scripts', 'dev', 'probe-f06-source-guard-unbinds-bare-park-request-pg16.sh'),
  'utf8'
);
const PREIMAGE_FIXTURE = readFileSync(
  join(
    repo,
    'scripts',
    'dev',
    'fixtures',
    'f06-bare-park-request',
    'preimage-2026-09-27.prosrc.txt'
  ),
  'utf8'
);

const PREIMAGE_PROSRC_MD5 = 'be484837a5103b3c0ac78a1d6d5d0bf2';
const POSTIMAGE_PROSRC_MD5 = 'caf6acb7a30fbd6044c4262520e134ac';

/** The exact "genuinely bound" predicate, as it already exists lower in the
 * function's elimination-dispatch fast path. The fix gives `bound` the same
 * predicate; both occurrences must therefore agree byte-for-byte. */
const GENUINELY_BOUND_PREDICATE = [
  "AND (o.state<>'park_requested' OR o.manifest IS NOT NULL",
  '       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)',
  '       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL',
  "       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL",
  '       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)',
  '       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id)))',
].join('\n');

describe('a bare park request is not a move in flight', () => {
  it('is a single-transaction migration guarded by pinned pre/post image checks', () => {
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';");
    expect(SQL).toContain("SET LOCAL statement_timeout = '10s';");
    expect(SQL).toContain(`md5(p.prosrc) = '${PREIMAGE_PROSRC_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POSTIMAGE_PROSRC_MD5}'`);
    expect(SQL).toContain("pg_get_userbyid(p.proowner) = 'postgres'");
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres}'");
    expect(SQL).toContain(
      `p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'`
    );
  });

  it('matches the pinned production pre-image byte for byte', () => {
    // Guards against the fixture the executable probe uses drifting from
    // what this migration actually asserts as its own preimage.
    const md5 = require('node:crypto')
      .createHash('md5')
      .update(PREIMAGE_FIXTURE)
      .digest('hex');
    expect(md5).toBe(PREIMAGE_PROSRC_MD5);
  });

  it('touches exactly one function and no data', () => {
    expect(SQL.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()');
    // The function BODY legitimately contains DML keywords (its own
    // elimination-dispatch DELETE, for one) - those execute later, when the
    // trigger fires, not when this migration runs. The migration itself
    // issues no INSERT/UPDATE/DELETE outside the replaced function body.
    const outsideFunctionBody = SQL.replace(/AS \$function\$[\s\S]*?\$function\$;/, '');
    expect(outsideFunctionBody).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(outsideFunctionBody).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bGRANT\b/);
    expect(SQL).not.toMatch(/\bREVOKE\b/);
    // Postimage proves the specific row it was written for is unmutated.
    expect(SQL).toContain("state <> 'park_requested'");
  });

  it('gives `bound` the identical predicate the elimination fast path already trusts', () => {
    const occurrences = SQL.split(GENUINELY_BOUND_PREDICATE).length - 1;
    expect(occurrences).toBe(2);
    expect(SQL).toContain('bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations o');
    expect(SQL).toContain('WHERE o.source_table_id IN(src,dst)');
    // Nothing else in the ~7.8KB body moved: only `bound`'s own query grew a
    // table alias and the genuinely-bound predicate; every surrounding line
    // (locks, the elimination fast path, the moving/dispatch checks) is
    // present unchanged.
    expect(SQL).toContain("RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000';");
    expect(SQL).toContain('PERFORM smarter_private.f06_try_lane(t);');
    expect(SQL.match(/F06_RETRY_CANONICAL_LANE/g)).toHaveLength(2);
  });

  it('names the executable live proof and the tournament it was written for', () => {
    expect(SQL).toContain('bfcfaf17-2879-4e58-b8e1-1c749ceb3b2f');
    expect(SQL).toContain('544dc515-bbbf-4337-8622-e177139bc09a');
    expect(PROBE_SCRIPT).toContain(PREIMAGE_PROSRC_MD5);
    expect(PROBE_SCRIPT).toContain(POSTIMAGE_PROSRC_MD5);
    expect(PROBE_SCRIPT).toContain('F06_SOURCE_EXCLUDED');
    expect(PROBE_SCRIPT).toContain('a genuinely bound operation still refuses');
  });
});
