/**
 * UNION CREATION IS AN ALLOWLIST (Dan 2026-09-04, binding)
 *
 * "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL ACCOUNTS EXCEPT FOR
 * MINE."
 *
 * Hiding links is not a permission. Three things have to hold together, and
 * the first is the only one that actually decides:
 *
 *   1. THE DATABASE REFUSES IT. `trg_union_creation_is_allowlisted` on
 *      public.unions calls fn_can_create_union(NEW.owner_id). The API route
 *      behind the form runs as the service role and bypasses RLS, so a policy
 *      would not have been enough and an if-statement in one Node handler is
 *      not either.
 *   2. THE ROUTE IS CLOSED. /unions/create is a URL anyone can type.
 *   3. NOTHING OFFERS IT. The menu, the directory page and the section rail
 *      ask first, and fail closed.
 *
 * Nobody's identity is compiled into the app or named in the migration: the
 * allowlist is a table, seeded from who already owned a union.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const MIGRATION = 'supabase/migrations/20260904223000_union_creation_is_an_allowlist.sql';

describe('union creation is an allowlist', () => {
  it('the database is what refuses it, on INSERT, for every caller', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('CREATE TRIGGER trg_union_creation_is_allowlisted');
    expect(sql).toContain('BEFORE INSERT ON public.unions');
    expect(sql).toContain('fn_can_create_union(NEW.owner_id)');
    // The list is a table, not a constant, and it is read-your-own-row only.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.union_creators');
    expect(sql).toContain('ALTER TABLE public.union_creators ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('USING (user_id = (select auth.uid()))');
    // One transaction: ten statements outside one is ten schema reloads.
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('the uuid-taking check is not reachable from a browser', () => {
    // check-definer-authorization blocked the first cut of this and was right:
    // a SECURITY DEFINER function that takes the account to test as an
    // argument, executable by anon, enumerates who holds the privilege.
    const sql = read(MIGRATION);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_can_create_union(uuid) FROM PUBLIC, anon, authenticated'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_can_create_union(uuid) TO service_role'
    );
    // What a browser may ask instead: about itself, with no argument.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_can_i_create_a_union()');
    expect(sql).toContain('SELECT auth.uid() IS NOT NULL');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_can_i_create_a_union() TO authenticated'
    );
  });

  it('names no person - the seed is whoever already owned a union', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('FROM public.unions u');
    expect(sql.toLowerCase()).not.toContain('@');
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('the route itself is guarded, not just the links to it', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/<UnionCreationGuard>[\s\S]*<CreateUnionPage \/>/);
    const guard = read('src/components/auth/UnionCreationGuard.tsx');
    // Fails closed: still checking, or not allowed, means no page.
    expect(guard).toContain('if (checking)');
    expect(guard).toContain('if (!canCreateUnion) return <Navigate to="/unions" replace />');
  });

  it('nothing offers the door it cannot open', () => {
    for (const file of [
      'src/pages/UnionsPage.tsx',
      'src/components/navigation/HamburgerMenu.tsx',
      'src/components/navigation/ArenaSectionRail.tsx',
    ]) {
      expect(read(file), file).toContain('canCreateUnion');
    }
    // The rail is a pure function of the path, so it is TOLD; absent an
    // explicit yes it does not list the entry.
    const nav = read('src/config/arenaSectionNavigation.ts');
    expect(nav).toContain('...(opts?.canCreateUnion ?');
  });

  it('the hook fails closed and asks the database, not a local list', () => {
    const hook = read('src/hooks/useCanCreateUnion.ts');
    expect(hook).toContain("rpc('fn_can_i_create_a_union')");
    // A client may never ask about an account other than its own.
    expect(hook).not.toContain('p_user_id');
    expect(hook).toContain('setState({ allowed: false, checking: false })');
    expect(hook).toContain('allowed: data === true');
  });
});
