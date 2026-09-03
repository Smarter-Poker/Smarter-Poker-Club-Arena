/**
 * A DEAD SESSION MOVES NO MONEY (binding)
 *
 * Dan, 2026-09-03: "I WAS LOGGED OUT, BUT SOMEHOW ABLE TO, SIT DOWN AND BUY
 * CHIPS AND GET DEALT A HAND. THAT CAN NEVER HAPPEN... EVER."
 *
 * It could, because the two halves of the platform asked different questions
 * of the same token. The engine verifies through GoTrue
 * (server/src/http/auth.ts -> supabase.auth.getUser), which checks that the
 * session behind the token still exists, so it refused his ACTION with a 401 -
 * the "server error notice" he saw. PostgREST cannot ask that question: it
 * verifies a JWT's signature and `exp` locally, and this project issues
 * SEVEN-DAY access tokens. So the database accepted the same signed-out token
 * and let him take a seat and buy chips with real money.
 *
 * The law: every door that seats a player or moves their chips must ask
 * whether the caller's session is still alive, and the helper that answers it
 * must not be weakened into something that can fail open.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');
const allSql = (): string =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
    .join('\n');

/** The doors Dan's report names: sit down, buy chips, and buy back in. */
const GUARDED_DOORS = ['atomic_table_buyin', 'atomic_table_rebuy', 'fn_take_seat_and_buy_in'];

/**
 * The LAST definition of a function across every migration is the one that is
 * live, so a later migration that drops the guard fails this law rather than
 * hiding behind an earlier one that still has it.
 */
function lastDefinitionOf(fn: string, sql: string): string | null {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${fn}\\s*\\(`, 'g');
  let last = -1;
  for (const m of sql.matchAll(re)) last = m.index ?? last;
  if (last < 0) return null;
  const next = sql.indexOf('CREATE OR REPLACE FUNCTION', last + 10);
  return sql.slice(last, next < 0 ? sql.length : next);
}

describe('a dead session moves no money', () => {
  const sql = allSql();

  it('ships the helper that asks whether the caller session still exists', () => {
    expect(sql).toContain('fn_caller_session_is_live');
    expect(sql).toMatch(/FROM auth\.sessions/);
  });

  it.each(GUARDED_DOORS)('%s refuses a signed-out token', (fn) => {
    const def = lastDefinitionOf(fn, sql);
    expect(def, `${fn} has no definition in any migration`).not.toBeNull();
    expect(def, `${fn} does not ask whether the session is live`).toContain(
      'fn_caller_session_is_live'
    );
    expect(def, `${fn} does not refuse a revoked session`).toContain('SESSION_REVOKED');
  });

  it('the helper is not readable as a way to enumerate other sessions', () => {
    // It answers one boolean about the CALLER. auth.sessions must never be
    // granted to the browser role to make that answer cheaper.
    expect(sql).not.toMatch(/GRANT\s+SELECT[^;]*ON\s+auth\.sessions\s+TO\s+authenticated/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.fn_caller_session_is_live\(\)/);
  });

  it('the service side is exempt, and only the service side', () => {
    const def = lastDefinitionOf('fn_caller_session_is_live', sql)!;
    // The engine / pg_cron / psql have no browser session and must not be asked.
    expect(def).toContain('fn_caller_is_engine');
    // A browser token that cannot name its session must FAIL, never pass.
    expect(def).toMatch(/RETURN false/);
    expect(def).not.toMatch(/RETURN true;\s*END;\s*\$function\$/);
  });
});
