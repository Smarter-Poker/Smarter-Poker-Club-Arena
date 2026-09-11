/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A BROWSER NEVER WRITES THE WAITLIST ITSELF (2026-09-10, must-move audit
 *  lane B, finding F11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `table_waitlist` carried an RLS policy FOR ALL on one's own rows with
 * INSERT/UPDATE/DELETE granted to the browser roles, so a signed-in player
 * could write itself a `notified` hold at any table for any duration and
 * every reader on the platform - the buy-in gate, the open-seat count, the
 * census, the fleet - would honour it. The policy is SELECT-only now, the
 * write grants are revoked, and the two legitimate browser writes have their
 * own SECURITY DEFINER doors keyed on auth.uid().
 *
 * The client files that must move to the doors are named in the migration
 * (lane G's); this law pins that they are named, not that they were edited.
 * Behaviour proven rolled back on production as role authenticated
 * (scripts/dev/probe-join-door-hold.sql, S29-S36).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const MIG = read(
  'supabase/migrations/20260910184439_a_browser_never_writes_the_waitlist_itself.sql'
);

describe('a browser never writes the waitlist itself', () => {
  it('replaces the FOR ALL policy with a SELECT-only one', () => {
    expect(MIG).toMatch(/DROP POLICY IF EXISTS waitlist_user_own ON public\.table_waitlist;/);
    expect(MIG).toMatch(
      /CREATE POLICY waitlist_user_own_read ON public\.table_waitlist\s*\n\s*FOR SELECT TO authenticated/
    );
    expect(MIG).toMatch(/a write policy exists on table_waitlist for a browser role/);
  });

  it('revokes the write grants from the browser roles and keeps SELECT', () => {
    expect(MIG).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.table_waitlist FROM authenticated, anon;/
    );
    expect(MIG).toMatch(/GRANT SELECT ON public\.table_waitlist TO authenticated;/);
    expect(MIG).toMatch(/the read grant was revoked with the writes/);
    expect(MIG).toMatch(/the service lost its writes/);
  });

  it('gives the two legitimate browser writes SECURITY DEFINER doors keyed on auth.uid()', () => {
    for (const fn of ['fn_table_waitlist_join', 'fn_table_waitlist_leave']) {
      expect(MIG).toMatch(
        new RegExp(
          `CREATE OR REPLACE FUNCTION public\\.${fn}\\(p_table_id uuid\\)[\\s\\S]{0,200}SECURITY DEFINER`
        )
      );
      expect(MIG).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\) TO authenticated, service_role;`
        )
      );
      expect(MIG).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid\\) FROM PUBLIC, anon;`)
      );
    }
    expect(MIG).toMatch(/v_uid uuid := auth\.uid\(\);/);
    expect(MIG).not.toMatch(/fn_table_waitlist_(join|leave)\(p_table_id uuid, p_user_id/);
  });

  it('the join door refuses what the offer path refuses, and is idempotent', () => {
    expect(MIG).toMatch(/WAITLIST_TOURNAMENT_TABLE/);
    expect(MIG).toMatch(/WAITLIST_TABLE_CLOSED/);
    expect(MIG).toMatch(/'already_on_waitlist', true/);
    expect(MIG).toMatch(/'reason', 'already_seated'/);
  });

  it('names every client caller of a direct write, live and dead, before restricting', () => {
    expect(MIG).toMatch(/src\/services\/WaitlistService\.ts:208/);
    expect(MIG).toMatch(/src\/services\/WaitlistService\.ts:267/);
    expect(MIG).toMatch(/src\/services\/WaitlistService\.ts:522/);
    expect(MIG).toMatch(/src\/components\/waitlist\/WaitlistManager\.tsx:155/);
    expect(MIG).toMatch(/supabase\.rpc\('fn_table_waitlist_join', \{ p_table_id: tableId \}\)/);
    expect(MIG).toMatch(/supabase\.rpc\('fn_table_waitlist_leave', \{ p_table_id: tableId \}\)/);
    expect(MIG).toMatch(/pages\/api\/club-arena\/waitlist\.js/);
  });

  it('reads is_horse nowhere (CLAUDE.md 10.5)', () => {
    const doors = MIG.slice(
      MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_table_waitlist_join'),
      MIG.indexOf('-- A definer states who may call it')
    );
    expect(doors).not.toMatch(/is_horse/);
    expect(MIG).toMatch(/a waitlist door reads is_horse/);
  });

  it('is one transaction and asserts afterwards', () => {
    expect(MIG.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(MIG.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(MIG).toMatch(/\$assert\$/);
  });

  it('no em dashes anywhere (CLAUDE.md 10.7)', () => {
    // \u2014 by escape, never the literal: this file is code too.
    expect(MIG).not.toMatch(/\u2014/);
  });
});
