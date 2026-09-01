/**
 * THE CLONE NOBODY REVOKED.
 *
 * `fn_seat_club_for_user_membership_unchecked` decides which club a player is
 * seated under. It arrived on 2026-09-01 SECURITY DEFINER, owned by postgres,
 * with EXECUTE held by PUBLIC, anon and authenticated, and with neither
 * auth.uid() nor auth.role() anywhere in its 2,779 character body. Handed any
 * user id and any table id it told a caller with NO ACCOUNT which club that
 * player was seated under, which clubs they belonged to, and in what order
 * they joined them. RLS was not standing behind any of it, because SECURITY
 * DEFINER runs as the owner.
 *
 * Nobody granted it anything. Its migration cloned three functions by
 * rewriting pg_get_functiondef output, revoked two of the clones in the same
 * file, and forgot the third -- and CREATE FUNCTION grants EXECUTE to PUBLIC
 * by default, so forgetting is the same as opening.
 *
 * Established by reading pg_proc, pg_policy, pg_constraint and pg_index, never
 * by calling it. The only caller anywhere is public.fn_seat_club_for_user,
 * itself SECURITY DEFINER owned by postgres, so it calls this one AS postgres
 * and the revoke cannot reach it.
 *
 * The gate that should have caught this before it merged learned to read a
 * clone in the same commit: scripts/ci/check-definer-authorization.mjs, pinned
 * by tests/definer-authorization-gate.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

/** The comment block quotes the vulnerable ACL at length. It is not a statement. */
const statements = (sql: string) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');

function migration(nameFragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(nameFragment));
  if (!file) throw new Error(`no migration matching "${nameFragment}"`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
}

describe('the seating clone answers nobody without an account', () => {
  const sql = statements(migration('the_seat_club_clone_is_not_an_anon_reader'));

  it('revokes PUBLIC as well as the two roles', () => {
    // anon and authenticated both inherit whatever PUBLIC holds, so revoking a
    // role while PUBLIC keeps EXECUTE reads as a fix and does nothing.
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.fn_seat_club_for_user_membership_unchecked/i
    );
    const revoke = sql.slice(sql.toLowerCase().indexOf('revoke all on function'));
    expect(revoke).toMatch(/from\s+public\s*,\s*anon\s*,\s*authenticated/i);
  });

  it('leaves the engine able to seat', () => {
    expect(sql).toMatch(/grant\s+execute\s+on\s+function[\s\S]{0,160}to\s+service_role/i);
  });

  it('asserts the outcome instead of trusting the statements', () => {
    expect(sql).toMatch(/has_function_privilege\(\s*\n?\s*'anon'/);
    expect(sql).toMatch(/has_function_privilege\(\s*\n?\s*'authenticated'/);
    expect(sql).toMatch(/has_function_privilege\(\s*\n?\s*'service_role'/);
    expect(sql).toMatch(/raise exception/i);
  });

  it('checks the wrapper still works, because that is the path a player uses', () => {
    // The revoke is safe only while fn_seat_club_for_user is SECURITY DEFINER
    // and still executable. A migration that closed the clone and broke seating
    // would be a worse outcome than the hole.
    expect(sql).toMatch(/prosecdef/);
    expect(sql).toMatch(/fn_seat_club_for_user\(uuid,\s*uuid,\s*uuid\)/i);
    expect(sql).toMatch(/seating is now broken/i);
  });

  it('names the exact signature, so an overload cannot slip past the revoke', () => {
    expect(sql).toMatch(/fn_seat_club_for_user_membership_unchecked\(uuid,\s*uuid,\s*uuid\)/i);
  });
});

describe('no browser path calls the clone directly', () => {
  it('has no caller in the client bundle', () => {
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, acc);
        else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(p);
      }
      return acc;
    };
    const offenders = walk(join(ROOT, 'src')).filter((f) => {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
      return /rpc\(\s*['"`]fn_seat_club_for_user_membership_unchecked/.test(code);
    });
    expect(
      offenders.map((f) => f.replace(ROOT + '/', '')),
      'the browser seats through fn_seat_club_for_user, never through the clone'
    ).toEqual([]);
  });
});
