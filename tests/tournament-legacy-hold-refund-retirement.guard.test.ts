import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runtimeFilesMatching } from './helpers/runtimeSourceSearch';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260910055955_stage_b_current_postimage_contraction.sql'
  ),
  'utf8'
);
const holdBoundaryStart = migration.indexOf(
  '-- FORWARD-COMPOSED BOUNDARY: LEGACY HOLD-REFUND DOOR RETIREMENT'
);
const holdBoundaryEnd = migration.indexOf(
  '-- FORWARD-COMPOSED BOUNDARY: DB-FIRST TERMINAL ROOTS',
  holdBoundaryStart
);
expect(holdBoundaryStart, 'legacy hold retirement boundary').toBeGreaterThan(-1);
expect(holdBoundaryEnd, 'terminal-root boundary').toBeGreaterThan(holdBoundaryStart);
const holdBoundary = migration.slice(holdBoundaryStart, holdBoundaryEnd);

const runtimeFiles = ['src', 'server/src', 'supabase/functions'] as const;

describe('the obsolete tournament-hold refund door is retired', () => {
  it('freezes the hold table, refuses unresolved tournament holds, and drops the function', () => {
    expect(migration).toMatch(/^BEGIN;$/m);
    expect(migration).toContain("SET LOCAL lock_timeout = '10s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '300s';");
    expect(migration).toContain("SET LOCAL transaction_timeout = '600s';");
    expect(holdBoundary).toContain('remained executable by service_role');
    expect(holdBoundary).not.toContain('retained PUBLIC execution through its default ACL');
    expect(holdBoundary).toContain(
      'LOCK TABLE public.chip_escrow_holds IN SHARE ROW EXCLUSIVE MODE'
    );
    expect(migration.indexOf("SET LOCAL statement_timeout = '300s';")).toBeLessThan(
      holdBoundaryStart
    );
    expect(holdBoundary).toContain("h.hold_type = 'tournament_register'");
    expect(holdBoundary).toContain(
      "p.oid <> 'public.fn_release_tournament_holds(uuid)'::regprocedure"
    );
    expect(holdBoundary).toContain("n.nspname <> 'information_schema'");
    expect(holdBoundary).toContain("n.nspname !~ '^pg_'");
    expect(holdBoundary).not.toContain("WHERE n.nspname = 'public'");
    expect(holdBoundary).toContain("p.prosrc ~* 'fn_release_tournament_holds[[:space:]]*\\('");
    expect(holdBoundary).toContain(
      'a stored function still calls fn_release_tournament_holds(uuid)'
    );
    expect(holdBoundary).toContain(
      'REVOKE ALL ON FUNCTION public.fn_release_tournament_holds(uuid)'
    );
    expect(holdBoundary).toContain(
      'DROP FUNCTION public.fn_release_tournament_holds(uuid) RESTRICT'
    );
    expect(holdBoundary).toContain(
      "to_regprocedure('public.fn_release_tournament_holds(uuid)') IS NOT NULL"
    );
    expect(migration).toMatch(/^COMMIT;$/m);
  });

  it('cannot silently settle or move legacy hold money during retirement', () => {
    expect(holdBoundary).not.toMatch(/UPDATE\s+public\.wallets/i);
    expect(holdBoundary).not.toMatch(/INSERT\s+INTO\s+public\.wallet_transactions/i);
    expect(holdBoundary).not.toMatch(/UPDATE\s+public\.chip_escrow_holds/i);
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
