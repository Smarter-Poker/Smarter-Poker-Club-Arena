/**
 * EVERY RPC THE ENGINE CALLS IS ONE THE ENGINE MAY EXECUTE (2026-09-27)
 *
 * #5466 taught the bust sweep to read public.fn_ca_tournament_rebuy_window
 * once per batch so a closed rebuy window stops sending every busted horse to
 * the purchase door. Its tests mocked the transport, and nothing ever asked
 * whether the role the engine runs as may call the function at all. It may
 * not: 20260909014433 created it owner-only (REVOKE ALL ... FROM PUBLIC,
 * anon, authenticated, service_role) and no later migration granted it back.
 * In production every call answered 42501, the manager read the error as
 * "unknown - keep the purchase path", and the fix never ran. One refused
 * purchase took 24.9 s holding the tournament's settlement lane, each bust
 * sweep of a closed-window Free Buy event recorded about one finish, and three
 * $100 Freeroll / Free Buy fields drained to one live player per table.
 *
 * So the rule, stated over the whole engine rather than this one function:
 * every name the engine passes to `supabase.rpc('...')` must not end its
 * migration history with service_role's EXECUTE revoked. Read statically -
 * the engine source for the names, supabase/migrations in version order for
 * the GRANT / REVOKE / DROP statements that touch each one - so it runs in
 * every CI without a database. On origin/main a1077c7c0c it fails naming
 * fn_ca_tournament_rebuy_window and nothing else (measured against production
 * the same evening: of 217 engine RPC names, that one is the only function
 * service_role cannot execute).
 *
 * docs/changelog/2026-09-27-the-engine-can-read-the-rebuy-window.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const ENGINE = join(ROOT, 'server', 'src');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FIX = '20260927222130_the_engine_reads_the_rebuy_window_it_asks.sql';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name))
      out.push(full);
  }
  return out;
}

/** Every literal name the engine hands to PostgREST as an RPC, with where. */
function engineRpcNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of sourceFiles(ENGINE)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)) {
      if (!names.has(m[1])) names.set(m[1], relative(ROOT, file));
    }
  }
  return names;
}

type Verdict = { kind: 'GRANT' | 'REVOKE' | 'DROP'; file: string };

/**
 * For each name, the last statement in migration order that decides whether
 * service_role may execute it. A DROP FUNCTION resets the question: the
 * replacement is created under the schema's default privileges, which grant
 * service_role. CREATE OR REPLACE keeps the existing ACL and decides nothing.
 */
function lastServiceRoleVerdicts(names: Iterable<string>): Map<string, Verdict> {
  const wanted = [...names];
  const verdicts = new Map<string, Verdict>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/\b(GRANT|REVOKE|DROP\s+FUNCTION)\b([\s\S]*?);/gi)) {
      const verb = m[1].toUpperCase().startsWith('DROP')
        ? 'DROP'
        : (m[1].toUpperCase() as Verdict['kind']);
      const body = m[2];
      if (verb !== 'DROP') {
        if (!/\bON\s+FUNCTION\b/i.test(body) || !/\bservice_role\b/i.test(body)) continue;
      }
      for (const name of wanted) {
        if (
          new RegExp(`(?:^|[\\s,.(])${name}\\s*\\(`, 'i').test(body) ||
          (verb === 'DROP' && new RegExp(`(?:^|[\\s,.])${name}\\s*(?:[;(,]|$)`, 'i').test(body))
        )
          verdicts.set(name, { kind: verb, file });
      }
    }
  }
  return verdicts;
}

describe('every rpc the engine calls is one the engine may execute', () => {
  const names = engineRpcNames();
  const verdicts = lastServiceRoleVerdicts(names.keys());

  it('reads a real inventory of engine rpc names', () => {
    // The bust sweep's own calls must be in it, or this law checks nothing.
    for (const name of [
      'fn_ca_tournament_rebuy_window',
      'process_tournament_rebuy',
      'fn_open_tournament_rebuy_decisions',
      'fn_eliminate_tournament_player_atomic',
      'fn_f06_admit_parked_movement',
    ])
      expect(names.has(name), name).toBe(true);
    expect(names.size).toBeGreaterThan(150);
  });

  it('leaves no engine rpc with service_role revoked as its last word', () => {
    const revoked = [...verdicts.entries()]
      .filter(([, v]) => v.kind === 'REVOKE')
      .map(([name, v]) => `${name} (revoked in ${v.file}; called from ${names.get(name)})`);
    expect(
      revoked,
      'The engine runs as service_role. A function it calls whose migration history ends in ' +
        'REVOKE ... FROM service_role answers 42501 on every call in production, which the ' +
        'caller sees only as an error it may treat as "unknown". Grant EXECUTE to service_role ' +
        'in a migration, or stop calling it from the engine.'
    ).toEqual([]);
  });

  it('grants the rebuy window to service_role alone, over the owner-only pre-image', () => {
    const sql = readFileSync(join(MIGRATIONS, FIX), 'utf8');
    const code = sql.replace(/--[^\n]*/g, '');
    expect(verdicts.get('fn_ca_tournament_rebuy_window')).toEqual({ kind: 'GRANT', file: FIX });
    const grants = [...code.matchAll(/\bGRANT\b[\s\S]*?;/gi)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(grants).toEqual([
      'GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_rebuy_window(uuid) TO service_role;',
    ]);
    expect(code).not.toMatch(/\bREVOKE\b/i);
    expect(code).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
    expect(code).toContain("md5(p.prosrc) = 'b9b7ba44728a4f9a72a0c8f77934dbc3'");
    expect(code).toContain("p.proacl::text = '{postgres=X/postgres}'");
    expect(code).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    expect(code).toMatch(/has_function_privilege\('anon'/);
    expect(code).toMatch(/has_function_privilege\('authenticated'/);
    expect(sql).toMatch(/^-- @live-proof: .*has_function_privilege\('service_role'/m);
    expect(code.trim().startsWith('BEGIN;')).toBe(true);
    expect(code.trim().endsWith('COMMIT;')).toBe(true);
  });
});
