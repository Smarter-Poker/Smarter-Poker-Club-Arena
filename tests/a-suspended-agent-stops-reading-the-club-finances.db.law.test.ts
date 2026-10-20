/**
 * ===========================================================================
 *  LAW - A SUSPENDED AGENT STOPS READING THE CLUB FINANCES
 * ===========================================================================
 *
 * Cashier launch audit C6-10, 2026-10-09. ca_can_view_club_finances, the gate
 * in front of eighteen finance reads and the rate-audit read policies,
 * admitted a staff role on its club_members row alone. The cashier calls a
 * member active only through fn_cashier_member_is_active (an active or
 * approved membership and, for an agent role, an active agents row in that
 * club), and fn_club_bank_role already asks it. So a super agent the club
 * suspended lost the cashier and kept reading the books. Migration
 * 20261010010632 makes the member branch ask the same question. Qualified by
 * scripts/ci/test-finance-gate-db-postgres.py on production's live gate, as
 * the session user PostgREST uses.
 *
 * Registry: docs/laws.d/a-suspended-agent-stops-reading-the-club-finances.md
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const FILE = '20261010010632_a_suspended_agent_stops_reading_the_club_finances.sql';
const DEFINES = /create\s+or\s+replace\s+function\s+public\.ca_can_view_club_finances\s*\(/i;
const squash = (s: string): string => s.replace(/\s+/g, ' ');

const NEWEST = migrationNames()
  .filter((n) => DEFINES.test(migrationText(n)))
  .at(-1)!;
const TEXT = migrationText(NEWEST);
const START = TEXT.search(DEFINES);
const BODY = squash(TEXT.slice(START, TEXT.indexOf('$function$;', START)));
const MEMBER_BRANCH = BODY.slice(
  BODY.indexOf('SELECT 1 FROM club_members cm'),
  BODY.indexOf('OR EXISTS (SELECT 1 FROM clubs c')
);

describe('a suspended agent stops reading the club finances', () => {
  it('is defined last by the migration that fixed it, or by one that keeps the fix', () => {
    expect(NEWEST >= FILE).toBe(true);
    expect(MEMBER_BRANCH.length).toBeGreaterThan(0);
  });

  it('admits a staff membership only when the cashier calls it active', () => {
    expect(MEMBER_BRANCH).toContain("cm.role IN ('owner', 'co_owner', 'admin', 'super_agent')");
    expect(MEMBER_BRANCH).toContain(
      'AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)'
    );
  });

  it('keeps ownership, platform admin, the service role and the database sessions', () => {
    expect(BODY).toContain(
      'OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid())'
    );
    expect(BODY).toContain(
      'OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false))'
    );
    expect(BODY).toContain("OR coalesce(auth.role(), '') = 'service_role'");
    expect(BODY).toContain("session_user IN ('postgres', 'supabase_admin')");
  });
});
