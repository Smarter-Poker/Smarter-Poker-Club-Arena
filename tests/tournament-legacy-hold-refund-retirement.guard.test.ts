import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runtimeFilesMatching } from './helpers/runtimeSourceSearch';

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
    const root = resolve(__dirname, '..');
    const matches = runtimeFilesMatching(
      runtimeFiles.map((directory) => resolve(root, directory)),
      /fn_release_tournament_holds/
    );
    expect(matches).toEqual([]);
  });
});
