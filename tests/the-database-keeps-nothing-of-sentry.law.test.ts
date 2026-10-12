/**
 * THE DATABASE KEEPS NOTHING OF SENTRY (2026-09-27)
 *
 * 20260927212653 drops the archived telemetry schema, the retired autofix
 * audit table and the signup_errors forwarding columns and index, and
 * rewrites the last three function bodies and two comments that named
 * Sentry. Each function is replaced over its exact production pre-image and
 * changes only the words that named Sentry (bodies checked byte for byte
 * against a local PostgreSQL 17 replay of the production definitions).
 *
 * docs/changelog/2026-09-27-sentry-is-gone.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260927212653_the_database_keeps_nothing_of_sentry.sql'
  ),
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');
const CODE = SQL.split('\n')
  .filter((l) => !l.startsWith('--'))
  .join('\n');

function body(name: string): string {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `the file defines ${name}`).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$function$', start) + '$function$'.length;
  return SQL.slice(open, SQL.indexOf('$function$', open));
}

const REWRITES: Record<string, [pre: string, post: string]> = {
  orb1_buyin_transaction: ['0ad2f87690f8582a991fc9ed4fd349e5', 'a6bea96676ecab034f1d0464c01748d3'],
  fn_ca_stranded_completing_tournaments: [
    '5573dc0a1189f790e2dd0389b52dc4df',
    'fcf298b575c81d03249c74c93030bb2f',
  ],
  archive_signup_errors: ['97dfc291e85719410a9a42e8b2f8571b', '57f561df4f3f3c932bcc1b72982dd308'],
};

describe('the database keeps nothing of Sentry', () => {
  it('is one transaction', () => {
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(CODE).not.toMatch(/CONCURRENTLY|VACUUM/i);
  });

  it.each(Object.entries(REWRITES))(
    '%s is replaced over its production pre-image and asserted after',
    (name, [pre, post]) => {
      const b = body(name);
      expect(md5(b)).toBe(post);
      expect(b.toLowerCase()).not.toContain('sentry');
      expect(SQL).toContain(`md5(p.prosrc) = '${pre}'`);
      expect(SQL).toContain(`md5(p.prosrc) = '${post}'`);
      expect(SQL).toContain(
        `RAISE EXCEPTION 'PREIMAGE: ${name} is not the definition read 2026-09-27'`
      );
    }
  );

  it('keeps the buy-in stub a stub and the archiver moving the same rows', () => {
    expect(body('orb1_buyin_transaction')).toMatch(
      /^\s*BEGIN[\s\S]*RAISE EXCEPTION 'orb1_buyin_transaction is deprecated[^']*';\s*END;\s*$/
    );
    const archive = body('archive_signup_errors');
    expect(archive).toContain(
      '(original_id, user_id, email, trigger_name, error_code, error_msg,\n             raw_meta, occurred_at)'
    );
    expect(archive).toContain(
      'SELECT id, user_id, email, trigger_name, error_code, error_msg,\n               raw_meta, occurred_at\n'
    );
    expect(CODE.indexOf('CREATE OR REPLACE FUNCTION public.archive_signup_errors(')).toBeLessThan(
      CODE.indexOf('ALTER TABLE public.signup_errors DROP COLUMN forwarded_to_sentry;')
    );
  });

  it('drops every remaining Sentry relation and column without CASCADE', () => {
    expect(CODE).not.toMatch(/\bCASCADE\b/);
    for (const stmt of [
      "EXECUTE 'DROP TABLE retired_error_telemetry_20260916.sentry_error_log, '",
      "|| 'retired_error_telemetry_20260916.sentry_event_budget, '",
      "|| 'retired_error_telemetry_20260916.sentry_event_fingerprints';",
      "EXECUTE 'DROP SCHEMA retired_error_telemetry_20260916';",
      "EXECUTE 'DROP TABLE ca_archive.autofix_attempts';",
      'DROP INDEX public.signup_errors_pending_forward_idx;',
      'ALTER TABLE public.signup_errors DROP COLUMN forwarded_to_sentry;',
      'ALTER TABLE public.signup_errors_archive DROP COLUMN forwarded_to_sentry;',
    ]) {
      expect(CODE).toContain(stmt);
    }
    expect(CODE).toContain("RAISE EXCEPTION 'POSTIMAGE: the database still names Sentry'");
  });

  it('keeps all three functions service_role only', () => {
    for (const sig of [
      'orb1_buyin_transaction(uuid,uuid,uuid,numeric,text)',
      'fn_ca_stranded_completing_tournaments(integer)',
      'archive_signup_errors(integer)',
    ]) {
      expect(CODE).toContain(
        `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`
      );
      expect(CODE).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });
});

/**
 * A catalog sweep cannot see a row. 20260927224816 deletes the one row of
 * data that still named Sentry: the retired autofix loop's archived daily
 * cap in ca_archive.autofix_budget. The table and its other two rows stay.
 */
const CAP_SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260927224816_the_archive_keeps_no_sentry_cap.sql'
  ),
  'utf8'
);
const CAP_CODE = CAP_SQL.split('\n')
  .filter((l) => !l.startsWith('--'))
  .join('\n');

describe('the archive keeps no Sentry cap', () => {
  it('is one transaction with a lock timeout and no DDL', () => {
    expect(CAP_CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CAP_CODE.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(CAP_CODE).toMatch(/^SET LOCAL lock_timeout = '5s';$/m);
    expect(CAP_CODE).not.toMatch(/\b(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE|TRUNCATE)\b/);
  });

  it('deletes exactly the sentry row, asserted before and after', () => {
    // The only top-level row write in the file, and it carries its WHERE.
    expect(CAP_CODE.match(/^(DELETE|UPDATE|INSERT)\b.*$/gm)).toEqual([
      "DELETE FROM ca_archive.autofix_budget WHERE source = 'sentry';",
    ]);
    expect(CAP_CODE).toContain(
      "RAISE EXCEPTION 'PREIMAGE: ca_archive.autofix_budget is not the three-row table read 2026-09-27'"
    );
    expect(CAP_CODE).toContain("WHERE source = 'sentry' AND daily_cap_usd = 1.0000");
    expect(CAP_CODE).toContain("WHERE source IN ('_global', 'vercel')) <> 2");
    expect(CAP_CODE).toContain(
      "RAISE EXCEPTION 'POSTIMAGE: the autofix archive still names Sentry'"
    );
    expect(CAP_CODE.indexOf('$pre$')).toBeLessThan(CAP_CODE.indexOf('DELETE FROM'));
    expect(CAP_CODE.indexOf('DELETE FROM')).toBeLessThan(CAP_CODE.indexOf('$post$'));
  });
});
