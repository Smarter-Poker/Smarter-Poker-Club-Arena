/**
 * A PLAYER CANNOT NAME THEMSELVES THE BOUNTY COLLECTOR (issue #1634).
 *
 * `fn_collect_bounty` pays a knockout bounty. It shipped SECURITY DEFINER,
 * owned by postgres so it runs past RLS, executable by `authenticated`, and
 * with the person to be PAID supplied as a parameter - while the body mentions
 * neither `auth.uid()` nor `auth.role()` in 7,432 characters, so it cannot know
 * who is calling.
 *
 * That is the same shape as the club-role escalation closed earlier the same
 * day. This one pays chips.
 *
 * Established by reading pg_proc and the repository, NEVER by calling it:
 * CLAUDE.md 11.5 forbids probing a money path against production, and the
 * Phase 4 vulnerability was proven the same way.
 *
 * The only caller anywhere is the engine, through the service-role client. No
 * browser path calls it, so no browser needs the grant.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

/** Comments quote the vulnerable shape at length; they are not the statements. */
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

describe('the bounty payer is engine-only', () => {
  const sql = statements(migration('a_player_cannot_name_themselves_the_bounty_collector'));

  it('revokes PUBLIC as well as the roles', () => {
    // anon and authenticated both inherit whatever PUBLIC holds, so revoking a
    // role while PUBLIC still has EXECUTE reads as a fix and does nothing.
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.fn_collect_bounty/i);
    const revoke = sql.slice(sql.toLowerCase().indexOf('revoke all on function'));
    expect(revoke).toMatch(/from\s+public\s*,\s*anon\s*,\s*authenticated/i);
  });

  it('leaves the engine able to pay', () => {
    expect(sql).toMatch(/grant\s+execute\s+on\s+function[\s\S]{0,120}to\s+service_role/i);
  });

  it('asserts the outcome instead of trusting the statements', () => {
    // A migration that only issues DDL cannot tell you it worked.
    expect(sql).toMatch(/has_function_privilege\(\s*'anon'/);
    expect(sql).toMatch(/has_function_privilege\(\s*'authenticated'/);
    expect(sql).toMatch(/has_function_privilege\(\s*'service_role'/);
    expect(sql).toMatch(/raise exception/i);
  });

  it('names the exact signature, so an overload cannot slip past the revoke', () => {
    expect(sql).toMatch(/fn_collect_bounty\(uuid,\s*uuid,\s*uuid,\s*jsonb\)/i);
  });
});

describe('no browser path asks for a bounty to be paid', () => {
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
      return /rpc\(\s*['"`]fn_collect_bounty/.test(code);
    });
    expect(
      offenders.map((f) => f.replace(ROOT + '/', '')),
      'the browser must not call the bounty payer - it is engine-only now'
    ).toEqual([]);
  });
});
