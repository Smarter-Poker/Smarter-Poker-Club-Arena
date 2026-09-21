/**
 * ===========================================================================
 *  LAW: A READ RECEIPT IS NOT PUBLIC
 * ===========================================================================
 *
 * `qual = true` on a PERMISSIVE SELECT policy granted to `public`, beside an
 * `anon` SELECT grant, is not row-level security. It is a table published to
 * anybody holding the publishable key that ships inside the browser bundle.
 *
 * .agent/audits/2026-08-26-anon-readable-tables.md found roughly 180 tables in
 * that state and deliberately shipped a triage list rather than a migration,
 * because most of them are a public poker-information site - `venues`,
 * `poker_news`, `training_*` - and revoking broadly would break the product on
 * the spot. Its second triage item was `social_message_reads`.
 *
 * MEASURED 2026-09-20, against production, inside BEGIN READ ONLY:
 *
 *   social_message_reads  "Users can view all read receipts"  qual = true   97 rows
 *   club_arena_messages   allow_read_messages                 qual = true    0 rows
 *   page_notifications    page_notifications_select           qual = true    0 rows
 *
 *   relacl on all three: anon=rxt/postgres  (r is SELECT)
 *   RESTRICTIVE policies on all three: none
 *
 * Ninety-seven of those rows were Messenger read-receipt metadata - which
 * `user_id` read which `message_id`, and when - readable with no session at
 * all. The conversation CONTENT beside it had already been closed by
 * 20260914163500_messenger_readers_preserve_private_invoices_and_weekly_summaries,
 * which put a restrictive anon deny and an authenticated visibility predicate
 * on `social_messages`, `notifications` and `accounting_invoice_deliveries`.
 * The receipts were simply left behind, and so were the two empty tables that
 * would have leaked every row the moment anything wrote to them.
 *
 * THE RULE, and why it is a law rather than one migration. Closing a hole
 * once is worth nothing if the next agent writes `USING (true)` on the same
 * table, which is exactly how all three got here - `page_notifications` was
 * given `FOR ALL USING (true) WITH CHECK (true)` by a file literally called
 * `20260211_security_remediation.sql`. So the shape is pinned going forward:
 * on these three tables no later migration may create a `USING (true)`
 * policy, grant SELECT back to `anon` or `PUBLIC`, or drop the restrictive
 * anon deny that stands whatever else permits.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { declaredProofs, code } from '../scripts/ci/check-migrations-are-live.mjs';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

const FIX =
  'supabase/migrations/20260920173943_anon_cannot_read_read_receipts_club_arena_messages_or_page_n.sql';

/** This law lands here; anything newer is bound by the forward guard. */
const THIS_VERSION = '20260920173943';

/** The three tables this law owns. It owns no others: the audit's remaining
 *  ~177 are a product decision, not this migration's business. */
const THREE = ['social_message_reads', 'club_arena_messages', 'page_notifications'];

/** The restrictive deny that must survive every later migration. */
const DENIALS: Record<string, string> = {
  social_message_reads: 'messenger_no_anonymous_read_receipts',
  club_arena_messages: 'club_arena_messages_no_anonymous_read',
  page_notifications: 'page_notifications_no_anonymous_read',
};

/** The `qual = true` policies as production actually named them. */
const REMOVED: Record<string, string> = {
  social_message_reads: 'Users can view all read receipts',
  club_arena_messages: 'allow_read_messages',
  page_notifications: 'page_notifications_select',
};

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SQL = read(FIX);

/** `code()` is the gate's own parser: it blanks `--` prose AND dollar-quoted
 *  bodies, so the guard below reads statements rather than the paragraphs that
 *  necessarily quote them. */
const DDL = code(SQL);

/** Every migration strictly newer than this law, as [file, stripped sql]. */
function laterMigrations(): Array<[string, string]> {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => f.slice(0, f.indexOf('_')) > THIS_VERSION)
    .sort()
    .map((f) => [f, code(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))]);
}

const statements = (sql: string, keyword: RegExp) => [...sql.matchAll(keyword)].map((m) => m[0]);

const CREATE_POLICY = /\bCREATE\s+POLICY\b[\s\S]*?;/gi;
const DROP_POLICY = /\bDROP\s+POLICY\b[\s\S]*?;/gi;
const GRANT = /\bGRANT\b[\s\S]*?;/gi;
const REVOKE = /\bREVOKE\b[\s\S]*?;/gi;

/** `USING (true)`, however it is spaced or cased. */
const usesTrue = (s: string) => /\bUSING\s*\(\s*true\s*\)/i.test(s);
const namesRole = (s: string, role: string) =>
  new RegExp(`(^|[\\s,(])${role}([\\s,;)]|$)`, 'i').test(s);

describe('a read receipt is not public', () => {
  it('is one transaction, with the lock and statement timeouts the DDL policy requires', () => {
    // Ten loose DDL statements are ten ~28s PostgREST schema reloads on this
    // database; one transaction coalesces them (CLAUDE.md, production DDL
    // policy, after the 2026-08-31 PGRST002 outage).
    expect((SQL.match(/^BEGIN;/gm) || []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) || []).length).toBe(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout\s*=/);
    expect(SQL).toMatch(/SET LOCAL statement_timeout\s*=/);
    expect(SQL.indexOf('BEGIN;')).toBeLessThan(SQL.indexOf('SET LOCAL lock_timeout'));
  });

  it.each(THREE)('%s loses its qual = true policy and gains a restrictive anon deny', (table) => {
    const dropped = statements(DDL, DROP_POLICY).filter((s) => s.includes(`public.${table}`));
    expect(
      dropped.some((s) => s.includes(REMOVED[table])),
      `${REMOVED[table]} must be dropped from ${table}`
    ).toBe(true);
    // IF EXISTS on every drop, or a second application of the file fails.
    for (const s of dropped) expect(s).toMatch(/DROP\s+POLICY\s+IF\s+EXISTS/i);

    const created = statements(DDL, CREATE_POLICY).filter((s) => s.includes(`public.${table}`));
    const deny = created.find((s) => s.includes(DENIALS[table]));
    expect(deny, `${DENIALS[table]} must be created on ${table}`).toBeDefined();
    expect(deny).toMatch(/AS\s+RESTRICTIVE/i);
    expect(deny).toMatch(/FOR\s+SELECT\s+TO\s+anon/i);
    expect(deny).toMatch(/USING\s*\(\s*false\s*\)/i);

    // And nothing this file creates on these tables is a `USING (true)` again.
    expect(created.filter(usesTrue)).toEqual([]);
  });

  it.each(THREE)('%s keeps a scoped authenticated reader, not a dropped one', (table) => {
    // Dropping the policy outright would have been the smaller diff and the
    // wrong answer: a table no authenticated caller can read is a different
    // outage, arriving the first time somebody wires the surface up.
    const created = statements(DDL, CREATE_POLICY).filter(
      (s) => s.includes(`public.${table}`) && !/AS\s+RESTRICTIVE/i.test(s)
    );
    expect(created, `${table} must still have a permissive reader`).toHaveLength(1);
    expect(created[0]).toMatch(/FOR\s+SELECT\s+TO\s+authenticated/i);
    expect(created[0]).toMatch(/auth\.uid\(\)/);
  });

  it('the predicates mirror the surface that already decides visibility', () => {
    const forTable = (table: string) =>
      statements(DDL, CREATE_POLICY).find(
        (s) => s.includes(`public.${table}`) && !/AS\s+RESTRICTIVE/i.test(s)
      )!;

    // A receipt is yours, or it is on a message in a conversation you are in -
    // the same EXISTS over social_conversation_participants that
    // social_messages' own "Users can view conversation messages" applies.
    const receipts = forTable('social_message_reads');
    expect(receipts).toMatch(/user_id\s*=\s*\(\s*SELECT\s+auth\.uid\(\)\s*\)/i);
    expect(receipts).toContain('public.social_conversation_participants');
    expect(receipts).toContain('public.social_messages');

    // A club message is yours, or your club's, or you are an admin.
    const arena = forTable('club_arena_messages');
    expect(arena).toContain('public.club_members');
    expect(arena).toContain('public.is_admin()');

    // page_notifications has no owner column at all; page_claims is the only
    // thing on this database that maps (page_type, page_id) to a user.
    const pages = forTable('page_notifications');
    expect(pages).toContain('public.page_claims');
    expect(pages).toMatch(/status\s*=\s*'approved'/i);
  });

  it.each(THREE)("%s's anon SELECT grant goes too, and PUBLIC is named with it", (table) => {
    // The restrictive policy already denies anon. Removing the privilege is
    // what accounting_invoice_deliveries looks like after the messenger
    // migration, and it means a permissive policy somebody writes later
    // cannot reach anon through `TO public`.
    const revokes = statements(DDL, REVOKE).filter((s) => s.includes(`public.${table}`));
    expect(revokes, `${table} must have its anon grant revoked`).toHaveLength(1);
    expect(revokes[0]).toMatch(/\bSELECT\b/i);
    expect(
      namesRole(revokes[0].slice(revokes[0].toUpperCase().lastIndexOf(' FROM ')), 'anon'),
      'the revoke must name anon'
    ).toBe(true);
    expect(
      namesRole(revokes[0].slice(revokes[0].toUpperCase().lastIndexOf(' FROM ')), 'PUBLIC'),
      'the revoke must name PUBLIC as well as anon - a no-op where there is no PUBLIC ' +
        'entry, and the whole fix where there is. See ' +
        'tests/a-revoke-from-anon-must-name-public.law.test.ts.'
    ).toBe(true);
  });

  it('proves its own outcome before COMMIT, and never at the cost of the roles that work', () => {
    // A migration that changes an ACL creates no catalogue object, so nothing
    // downstream can look it up by name. It has to state its claim.
    expect(SQL).toMatch(/anon still selects % of the three/);
    expect(SQL).toMatch(/authenticated lost SELECT on % of the three/);
    expect(SQL).toMatch(/service_role lost a privilege on % of the three/);
    expect(SQL).toMatch(/expected a restrictive anon deny on each of the three/);
  });

  it('declares live proof, because it creates nothing a catalogue lookup could find', () => {
    // Parsed with the gate's own function, not a lookalike regex.
    const proofs = declaredProofs(SQL);
    expect(proofs.length).toBeGreaterThanOrEqual(3);
    expect(proofs.some((p) => /qual\s*=\s*'true'/.test(p))).toBe(true);
    expect(proofs.some((p) => /has_table_privilege\('anon'/.test(p))).toBe(true);
    expect(proofs.some((p) => /has_table_privilege\('authenticated'/.test(p))).toBe(true);
    for (const p of proofs) expect(p.endsWith(';')).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS LATER. Every one of these three was opened by a
   * migration whose author thought `USING (true)` was a reasonable default -
   * one of them inside a file named `security_remediation`. Closing them once
   * buys a day unless the shape is pinned.
   */
  it('no later migration puts a USING (true) policy back on any of the three', () => {
    const offenders: string[] = [];
    for (const [file, sql] of laterMigrations()) {
      for (const stmt of statements(sql, CREATE_POLICY)) {
        if (!THREE.some((t) => stmt.includes(t))) continue;
        if (usesTrue(stmt)) offenders.push(`${file}: ${stmt.trim().replace(/\s+/g, ' ')}`);
      }
    }
    expect(
      offenders,
      'a migration creates a USING (true) policy on a table this law closed. ' +
        '`public` in Postgres includes `anon`, so that policy publishes the table to ' +
        'anybody holding the publishable key. Write the real predicate instead.'
    ).toEqual([]);
  });

  it('no later migration grants SELECT on any of the three back to anon or PUBLIC', () => {
    const offenders: string[] = [];
    for (const [file, sql] of laterMigrations()) {
      for (const stmt of statements(sql, GRANT)) {
        if (!THREE.some((t) => stmt.includes(t))) continue;
        if (!/\b(SELECT|ALL)\b/i.test(stmt)) continue;
        const to = stmt.slice(stmt.toUpperCase().lastIndexOf(' TO '));
        if (namesRole(to, 'anon') || namesRole(to, 'PUBLIC')) {
          offenders.push(`${file}: ${stmt.trim().replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(
      offenders,
      'a migration grants SELECT on a table this law closed back to anon or PUBLIC. The ' +
        'restrictive deny would still refuse the read, but the grant is half of the pair ' +
        'that made 97 read receipts anonymous in the first place.'
    ).toEqual([]);
  });

  it('no later migration drops the restrictive anon deny', () => {
    const offenders: string[] = [];
    for (const [file, sql] of laterMigrations()) {
      for (const stmt of statements(sql, DROP_POLICY)) {
        for (const [table, deny] of Object.entries(DENIALS)) {
          if (stmt.includes(deny) && stmt.includes(table)) {
            offenders.push(`${file}: ${stmt.trim().replace(/\s+/g, ' ')}`);
          }
        }
      }
    }
    expect(
      offenders,
      'a migration drops a restrictive anon deny. That policy is the half of the fix that ' +
        'survives somebody else adding a permissive policy TO public later, which is ' +
        'precisely how these three tables were opened.'
    ).toEqual([]);
  });
});
