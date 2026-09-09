import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260909041438_retire_legacy_tournament_hold_refund_door.sql'
  ),
  'utf8'
);

const runtimeFiles = ['src', 'server/src', 'supabase/functions'] as const;

describe('the obsolete tournament-hold refund door is retired', () => {
  it('freezes the hold table, refuses unresolved tournament holds, and drops the function', () => {
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration).toContain("SET LOCAL lock_timeout = '8s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '120s';");
    expect(migration).toContain('remained executable by service_role');
    expect(migration).not.toContain('retained PUBLIC execution through its default ACL');
    expect(migration).toContain('LOCK TABLE public.chip_escrow_holds IN SHARE ROW EXCLUSIVE MODE');
    expect(migration.indexOf("SET LOCAL statement_timeout = '120s';")).toBeLessThan(
      migration.indexOf('LOCK TABLE public.chip_escrow_holds IN SHARE ROW EXCLUSIVE MODE')
    );
    expect(migration).toContain("h.hold_type = 'tournament_register'");
    expect(migration).toContain(
      "p.oid <> 'public.fn_release_tournament_holds(uuid)'::regprocedure"
    );
    expect(migration).toContain("n.nspname <> 'information_schema'");
    expect(migration).toContain("n.nspname !~ '^pg_'");
    expect(migration).not.toContain("WHERE n.nspname = 'public'");
    expect(migration).toContain("p.prosrc ~* 'fn_release_tournament_holds[[:space:]]*\\('");
    expect(migration).toContain('a stored function still calls fn_release_tournament_holds(uuid)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.fn_release_tournament_holds(uuid)');
    expect(migration).toContain('DROP FUNCTION public.fn_release_tournament_holds(uuid) RESTRICT');
    expect(migration).toContain(
      "to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NOT NULL"
    );
    expect(migration).toMatch(/^COMMIT;$/m);
  });

  it('cannot silently settle or move legacy hold money during retirement', () => {
    expect(migration).not.toMatch(/UPDATE\s+public\.wallets/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.wallet_transactions/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.chip_escrow_holds/i);
  });

  it('has no application or edge-function caller left behind', () => {
    for (const directory of runtimeFiles) {
      const result = spawnSync(
        'rg',
        [
          '-l',
          '--glob',
          '!**/*.test.ts',
          '--glob',
          '!**/*.test.tsx',
          '--glob',
          '!**/*.spec.ts',
          '--glob',
          '!**/*.spec.tsx',
          'fn_release_tournament_holds',
          directory,
        ],
        {
          cwd: resolve(__dirname, '..'),
          encoding: 'utf8',
        }
      );
      expect(result.error, directory).toBeUndefined();
      expect(result.status, directory).toBe(1);
      expect(result.stdout.trim(), directory).toBe('');
    }
  });
});
