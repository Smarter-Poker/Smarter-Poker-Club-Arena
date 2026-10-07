/**
 * LAW - A SEAT IS READ WITH ITS TABLE, AND A COMMANDER WALK-IN IS ENTERED BY STAFF
 *
 * table_seats answered every signed-in account with every seat on the platform
 * ("Public read access", FOR SELECT TO PUBLIC USING (true)); #6303 had closed it
 * only to a browser with no account. Migration
 * 20261007034527_seat_map_in_scope_and_walk_ins_need_staff replaces that policy
 * with one that follows public.tables' own row security - a seat is readable
 * where its table is - plus the caller's own seats.
 *
 * The Commander insert policies admitted any row whose player_id was NULL (a
 * walk-in), to PUBLIC, and anon held INSERT: a browser with no account could
 * write a walk-in into any venue's waitlist. The same migration moves both
 * insert policies to authenticated without that branch (a walk-in is entered
 * by active staff of the venue) and revokes anon's writes on both tables.
 *
 * The forward guards below are the regressions this expects: a later policy
 * that opens table_seats to every reader again, or a Commander policy that
 * admits a row by its NULL owner, or a grant that hands anon a write back.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');
const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const statements = (f: string) => strip(read(f)).split(';');
const FIX = '20261007034527_seat_map_in_scope_and_walk_ins_need_staff.sql';
const later = () => files.filter((f) => f > FIX);

/** A CREATE/ALTER POLICY on table_seats whose USING is (true), for anyone but service_role. */
const opensEverySeat = (stmt: string) =>
  /\b(CREATE|ALTER)\s+POLICY\b[\s\S]*\bON\s+(public\.)?table_seats\b/i.test(stmt) &&
  /\bUSING\s*\(\s*true\s*\)/i.test(stmt) &&
  !/\bTO\s+"?service_role"?\s+USING\b/i.test(stmt);

const COMMANDER = /\bON\s+(TABLE\s+)?(public\.)?commander_(waitlist|tournament_entries)\b/i;
/** `player_id IS NULL` standing alone as one branch of an OR: a row admitted by its NULL owner. */
const NULL_OWNER_BRANCH =
  /\bOR\s+\(?\s*player_id\s+IS\s+NULL\s*\)?\s*(\bOR\b|\))|\(\s*\(?\s*player_id\s+IS\s+NULL\s*\)?\s+OR\b/i;

describe('LAW: a seat is read with its table', () => {
  it('the fix replaces the open policy with the table-scoped one and asserts it', () => {
    expect(files).toContain(FIX);
    const sql = strip(read(FIX));
    expect(sql).toMatch(/DROP POLICY "Public read access" ON public\.table_seats;/);
    expect(sql).toMatch(
      /CREATE POLICY "seat_read_with_table_or_own" ON public\.table_seats\s+AS PERMISSIVE FOR SELECT TO authenticated\s+USING \(\s*user_id = \(SELECT auth\.uid\(\)\)\s+OR EXISTS \(SELECT 1 FROM public\.tables t WHERE t\.id = table_seats\.table_id\)\s*\);/
    );
    // It asserts its end state rather than trusting the statements ran.
    expect(sql).toContain('a SELECT policy on table_seats is still USING (true)');
    expect(sql).toContain('seat_read_with_table_or_own lost its readable-table branch');
    // It leaves the two policies beside it alone.
    expect(sql).not.toMatch(/DROP POLICY "?union_overseer_read"?/);
    expect(sql).not.toMatch(/DROP POLICY "Service role manages"/);
  });

  it('nothing after the fix opens table_seats to every reader again', () => {
    const offenders = later().filter((f) => statements(f).some(opensEverySeat));
    expect(offenders, 'a seat is readable where its table is, never by every account').toEqual([]);
  });

  it('the guard recognises the policy it replaced', () => {
    expect(
      opensEverySeat(
        'CREATE POLICY "Public read access" ON public.table_seats FOR SELECT USING (true)'
      )
    ).toBe(true);
    expect(
      opensEverySeat(
        'CREATE POLICY x ON public.table_seats FOR SELECT TO authenticated USING (true)'
      )
    ).toBe(true);
    expect(
      opensEverySeat(
        'CREATE POLICY "Service role manages" ON public.table_seats TO service_role USING (true)'
      )
    ).toBe(false);
  });
});

describe('LAW: a Commander walk-in is entered by venue staff', () => {
  it('the fix narrows both insert policies and revokes anon writes', () => {
    const sql = strip(read(FIX));
    const alters = [
      ...sql.matchAll(
        /ALTER POLICY "captain_(entries|waitlist)_insert" ON public\.commander_\w+\s+TO authenticated\s+WITH CHECK[\s\S]*?;/g
      ),
    ].map((m) => m[0]);
    expect(alters).toHaveLength(2);
    for (const a of alters) {
      expect(a).not.toMatch(/player_id\s+IS\s+NULL/i);
      expect(a).toMatch(/player_id = \(SELECT auth\.uid\(\)\)/);
      expect(a).toMatch(/commander_staff cs[\s\S]*cs\.is_active = true/);
    }
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.commander_tournament_entries FROM anon, PUBLIC;/
    );
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.commander_waitlist FROM anon, PUBLIC;/
    );
    expect(sql).toContain('still admits a row by its NULL owner');
  });

  it('nothing after the fix admits a row by its NULL owner or gives anon a write back', () => {
    const offenders = later().filter((f) =>
      statements(f).some(
        (s) =>
          (/\b(CREATE|ALTER)\s+POLICY\b/i.test(s) &&
            COMMANDER.test(s) &&
            NULL_OWNER_BRANCH.test(s)) ||
          (/\bGRANT\b[\s\S]*\b(INSERT|UPDATE|DELETE|ALL)\b/i.test(s) &&
            COMMANDER.test(s) &&
            /\bTO\b[\s\S]*\b(anon|PUBLIC)\b/i.test(s))
      )
    );
    expect(offenders, 'a walk-in is written by venue staff; anon writes nothing here').toEqual([]);
  });

  it('the guard recognises the branch it removed and spares a staff-scoped one', () => {
    expect(
      NULL_OWNER_BRANCH.test('(player_id = auth.uid() OR player_id IS NULL OR venue_id IN (x))')
    ).toBe(true);
    expect(
      NULL_OWNER_BRANCH.test('((player_id = ( SELECT auth.uid() AS uid)) OR (player_id IS NULL))')
    ).toBe(true);
    expect(NULL_OWNER_BRANCH.test('(player_id IS NULL OR player_id = auth.uid())')).toBe(true);
    expect(
      NULL_OWNER_BRANCH.test(
        '(player_id IS NULL AND venue_id IN (SELECT venue_id FROM commander_staff))'
      )
    ).toBe(false);
  });
});
