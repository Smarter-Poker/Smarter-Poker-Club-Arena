/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE LADDER IS COMPLETE, AND PEOPLE ARE TOLD (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 5 of 7 of the agent credit and promotion lifecycle work.
 *
 * The promotion ladder worked and said nothing. The only announcement was
 * masterBus.emit('MEMBER_ROLE_CHANGED'), a browser-local event: it reaches the
 * tabs of whoever PERFORMED the change and nobody else. The person whose role
 * actually changed found out when a button appeared or vanished.
 *
 * public.notifications is the estate's real channel - 11,362 rows, four RLS
 * policies, rendered by NotificationDropdown, the header store and
 * NotificationsPage - and nothing in the promotion path wrote to it.
 *
 * THE SECOND HALF. transfer_club_ownership is the largest thing that happens to
 * a club and it was the least recorded: one role_changes row with member_id
 * NULL (the column that says WHO), written inside EXCEPTION WHEN OTHERS THEN
 * NULL, so a failed insert meant a club changed hands leaving no trace at all.
 *
 * WHAT MAY AND MAY NOT BE SWALLOWED. The notice is a courtesy and may fail
 * silently: a courtesy that can roll back a promotion is worse than no
 * courtesy. The BOOKS may not. These pins hold that line in both directions,
 * because the failure mode is a later edit widening the swallow back up over
 * the insert, which is invisible in review and silent in production.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const MIGRATION = read(
  'supabase/migrations/20260901000010_the_ladder_is_complete_and_people_are_told.sql'
);
const SQL = codeOnly(MIGRATION);

/** Everything from the start of one function body to the start of the next. */
const setRoleBody = SQL.slice(
  SQL.indexOf('fn_club_set_member_role'),
  SQL.indexOf('transfer_club_ownership')
);
/**
 * Bounded at the closing $function$ on purpose. Slicing to end-of-file swept in
 * the self-assertion block, whose RAISE strings mention the same identifiers,
 * and a count pin that reads its own assertions proves nothing.
 */
const transferStart = SQL.indexOf('CREATE OR REPLACE FUNCTION public.transfer_club_ownership');
const transferBody = SQL.slice(
  transferStart,
  SQL.indexOf('$function$', SQL.indexOf('$function$', transferStart) + 1)
);

describe('a role change tells the person it happened', () => {
  it('raises a notification on the estate channel, not a browser-local event', () => {
    expect(setRoleBody).toMatch(/fn_raise_notification/);
    expect(setRoleBody).toMatch(/'club_role_changed'/);
  });

  it('names the role in words a person reads, not the enum', () => {
    for (const label of ['Co Owner', 'Admin', 'Super Agent', 'Agent', 'Sub Agent', 'Player']) {
      expect(setRoleBody).toContain(`'${label}'`);
    }
    expect(setRoleBody).toMatch(/WHEN 'co_owner' THEN 'Co Owner'/);
  });

  it('tells an agent the terms that came with the role', () => {
    expect(setRoleBody).toMatch(/Your Commission Is/);
    expect(setRoleBody).toMatch(/Your Player Rakeback Is/);
    expect(setRoleBody).toMatch(/You Are Prepaid\./);
    expect(setRoleBody).toMatch(/Your Credit Line Is/);
  });

  it('carries the machine-readable terms in the payload as well as the prose', () => {
    expect(setRoleBody).toMatch(/'old_role', v_old_role/);
    expect(setRoleBody).toMatch(/'new_role', p_role/);
    expect(setRoleBody).toMatch(/'commission_rate', v_comm/);
    expect(setRoleBody).toMatch(/'credit_limit', v_limit/);
  });

  it('links to the club, so the notice is actionable', () => {
    expect(setRoleBody).toMatch(/'\/clubs\/' \|\| p_club_id::text/);
  });

  it('cannot fail the role change it is announcing', () => {
    // The notify sits in its own BEGIN/EXCEPTION block, AFTER the audit write.
    const notifyAt = setRoleBody.indexOf('fn_raise_notification');
    const auditAt = setRoleBody.indexOf('INSERT INTO audit_trail');
    expect(auditAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeGreaterThan(auditAt);
    expect(setRoleBody).toMatch(/EXCEPTION WHEN OTHERS THEN/);
  });
});

describe('a club changing hands closes the books on both people', () => {
  it('writes a complete role_changes row for BOTH parties', () => {
    const rows = transferBody.match(/INSERT INTO role_changes/g) ?? [];
    expect(rows).toHaveLength(2);
    // member_id is the column that says WHO. It was NULL before.
    expect(transferBody).toMatch(
      /INSERT INTO role_changes \(member_id, old_role, new_role, changed_by, reason\)/
    );
    expect(transferBody).toMatch(/VALUES \(p_new_owner_id, 'admin', 'owner'/);
    expect(transferBody).toMatch(/VALUES \(v_old, 'owner', 'admin'/);
  });

  it('writes an audit_trail row naming the club and both owners', () => {
    expect(transferBody).toMatch(/INSERT INTO audit_trail/);
    expect(transferBody).toMatch(/'transfer_club_ownership'/);
    expect(transferBody).toMatch(/jsonb_build_object\('owner_id', v_old\)/);
    expect(transferBody).toMatch(/'owner_id', p_new_owner_id/);
  });

  it('tells both parties, including the one who is no longer an owner', () => {
    const notices = transferBody.match(/fn_raise_notification/g) ?? [];
    expect(notices).toHaveLength(2);
    expect(transferBody).toMatch(/You Now Own /);
    expect(transferBody).toMatch(/You Handed Over /);
  });

  it('swallows the courtesy and never the record', () => {
    // Exactly one handler, and it comes after BOTH writes. A later edit that
    // moves it back up over an insert fails here rather than in production.
    const handlers = transferBody.match(/EXCEPTION WHEN OTHERS THEN/g) ?? [];
    expect(handlers).toHaveLength(1);
    const swallowAt = transferBody.indexOf('EXCEPTION WHEN OTHERS THEN');
    expect(swallowAt).toBeGreaterThan(transferBody.lastIndexOf('INSERT INTO role_changes'));
    expect(swallowAt).toBeGreaterThan(transferBody.lastIndexOf('INSERT INTO audit_trail'));
  });
});

describe('neither function is reachable without a session', () => {
  it('revokes PUBLIC and anon, and grants only the two real callers', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_club_set_member_role\([^)]*\) FROM PUBLIC, anon;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_club_set_member_role\([^)]*\) TO authenticated, service_role;/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.transfer_club_ownership\(uuid, uuid\) FROM PUBLIC, anon;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.transfer_club_ownership\(uuid, uuid\) TO authenticated, service_role;/
    );
  });

  it('asserts its own authorization rather than trusting the grant above it', () => {
    expect(SQL).toMatch(/has_function_privilege\('anon'/);
    expect(SQL).toMatch(/RAISE EXCEPTION 'anon can promote club members'/);
    expect(SQL).toMatch(/RAISE EXCEPTION 'anon can hand over a club'/);
  });
});
