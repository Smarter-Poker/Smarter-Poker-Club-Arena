/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NO auth.users TIMESTAMP IS EVER INFINITE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-10-23, between 18:22Z and 18:38Z, a direct SQL write set one
 * certification fixture's auth.users.banned_until to 'infinity'. GoTrue scans
 * that column into a Go time.Time and cannot read the string "infinity", so
 * GET /admin/users returned HTTP 500 for every caller in the project for more
 * than a day ("Database error finding users"); Club Create Certification
 * failed 59 runs in a row. Repaired by
 * 20261024220826_an_infinite_ban_breaks_list_users, the same class of fault as
 * 20260901013451_20260831_the_system_row_breaks_list_users (a NULL GoTrue
 * could not scan).
 *
 * A permanent ban is GoTrue's own `ban_duration` (e.g. '876000h', as
 * operations/release/fixture/auth-fixture.mjs uses), which always writes a
 * finite time. Nothing tracked here may write 'infinity' or '-infinity' into
 * an auth.users column, whether as an UPDATE ... SET or an INSERT value.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

/** Tracked SQL and scripts that could write to the auth schema. */
function candidates(): string[] {
  return execSync(
    "git ls-files 'supabase/migrations/*.sql' 'scripts/**/*.sql' 'scripts/**/*.mjs' 'scripts/**/*.ts' 'operations/**/*.mjs' 'operations/**/*.sql' 'server/src/**/*.ts'",
    { cwd: ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.test\.|\/probes\//.test(f));
}

/** A statement that writes a non-finite time into auth.users. */
function writesInfiniteAuthTime(sql: string): boolean {
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const update = /update\s+auth\.users\b([\s\S]*?)(;|$)/gi;
  for (const m of code.matchAll(update)) {
    const set = m[1].split(/\bwhere\b/i)[0];
    if (/=\s*'-?infinity'/i.test(set)) return true;
  }
  const insert = /insert\s+into\s+auth\.users\b([\s\S]*?)(;|$)/gi;
  for (const m of code.matchAll(insert)) {
    if (/'-?infinity'/i.test(m[1])) return true;
  }
  return false;
}

describe('no auth.users timestamp is ever infinite', () => {
  it('recognises the write that broke listUsers, and not a read or a guard', () => {
    expect(
      writesInfiniteAuthTime("UPDATE auth.users SET banned_until = 'infinity' WHERE id = 'x';")
    ).toBe(true);
    expect(
      writesInfiniteAuthTime("update auth.users set email = 'a', banned_until='-infinity';")
    ).toBe(true);
    expect(
      writesInfiniteAuthTime("INSERT INTO auth.users (id, banned_until) VALUES ('x', 'infinity');")
    ).toBe(true);
    expect(
      writesInfiniteAuthTime(
        "UPDATE auth.users SET banned_until = now() + interval '876000 hours' WHERE NOT isfinite(banned_until);"
      )
    ).toBe(false);
    expect(
      writesInfiniteAuthTime(
        "UPDATE auth.users SET banned_until = NULL WHERE banned_until = 'infinity';"
      )
    ).toBe(false);
    expect(writesInfiniteAuthTime("UPDATE public.tournaments SET ends_at = 'infinity';")).toBe(
      false
    );
  });

  it('nothing tracked writes a non-finite time into auth.users', () => {
    const offenders = candidates().filter((f) =>
      writesInfiniteAuthTime(readFileSync(resolve(ROOT, f), 'utf8'))
    );
    expect(
      offenders,
      'GoTrue cannot scan a non-finite timestamp: one such row breaks GET /admin/users ' +
        "for the whole project. Ban with GoTrue's ban_duration (e.g. '876000h'), " +
        'never with banned_until = infinity.'
    ).toEqual([]);
  });

  it('the repair keeps the ban finite and asserts nothing non-finite is left', () => {
    const sql = readFileSync(
      resolve(ROOT, 'supabase/migrations/20261024220826_an_infinite_ban_breaks_list_users.sql'),
      'utf8'
    );
    expect(sql).toContain("SET banned_until = now() + interval '876000 hours'");
    expect(sql).toContain('NOT isfinite(banned_until)');
    expect(sql).toMatch(/^-- @live-proof: NOT EXISTS/m);
  });
});
