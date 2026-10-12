/**
 * ===========================================================================
 *  LAW - ONLY CLUB STAFF CAN REMOVE A MEMBER, AND ONLY A SETTLED ONE
 * ===========================================================================
 *
 * fn_remove_settled_club_member is SECURITY DEFINER and every signed-in
 * player may call it. On launch day (2026-10-12) production held a body that
 * no migration wrote: a signed-out caller became the all-zero user ("Allow
 * system bypass"), the caller check was gone and every settlement check was
 * dropped ("BYPASSED SEAT CHECKS FOR BOT RETIREMENT!"). Any signed-in player
 * could mark any member of any club departed - the owner, a seated player, a
 * player holding chips. Nothing used the bypass: no caller in the database,
 * the engine or the scripts, no call in pg_stat_statements, and no membership
 * has ever departed.
 *
 * Migration 20261012132509 reinstates 20260929062121's reviewed function
 * byte for byte (with 20261012061427's 55000), md5-pinned before
 * (acdfe7bc...) and after. scripts/ci/test-only-staff-remove-member-db-postgres.py
 * installs production's drifted body byte for byte on PostgreSQL 17 and shows
 * 16 of 23 cases fail before and 23 pass after. This law pins the shapes that
 * would quietly reopen it: a bypass or a zero user, a missing caller check,
 * a dropped settlement check, a grant to anon, and a refusal that reaches the
 * club owner as a generic error.
 *
 * Registry: docs/laws.d/only-staff-can-remove-a-member.md
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
import { safeErrorMessage } from '../src/utils/safeErrorMessage';
import { migrationText } from './helpers/migrationCorpus';

const FILE = '20261012132509_only_staff_can_remove_a_member.sql';
const MIG = migrationText(FILE);
const REVIEWED = migrationText('20260929062121_staff_can_remove_a_settled_member_again.sql');
const read = (p: string): string => readFileSync(p, 'utf8');
const SIG = 'public.fn_remove_settled_club_member(uuid,uuid)';
const BODY = /c_body constant text := \$body\$\n([\s\S]*?)\n\$body\$;/.exec(MIG)?.[1] ?? '';

const reviewed = (): string => {
  const i = REVIEWED.indexOf('CREATE OR REPLACE FUNCTION public.fn_remove_settled_club_member(');
  const j =
    REVIEWED.indexOf('$function$;', REVIEWED.indexOf('AS $function$', i)) + '$function$;'.length;
  return REVIEWED.slice(i, j).replace("USING ERRCODE = '40001'", "USING ERRCODE = '55000'");
};

const REFUSALS = [
  'Authentication Required',
  'Only Club Staff Can Remove A Member',
  'The Club Owner Cannot Be Removed',
  'Demote Club Staff To Player Before Marking The Membership Departed',
  'Settle Every Member Balance, Credit Line And Diamond Balance Before Removing Them',
  'Remove This Member From Live Tables First',
  "Settle This Member''s Tournament Entry First",
  "Release This Member''s Escrow First",
  "Resolve This Member''s Chip Requests First",
  "Reassign This Member''s Downline Before Removing Them",
];

describe('only club staff can remove a member, and only a settled one', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reinstates the reviewed function byte for byte, pinned before and after', () => {
    expect(BODY.length).toBeGreaterThan(1000);
    expect(BODY).toBe(reviewed());
    const post = new RegExp(
      `-- @live-proof: \\(SELECT md5\\(pg_get_functiondef\\('${SIG.replace(/[()]/g, '\\$&')}'::regprocedure\\)\\) = '([0-9a-f]{32})'\\)`
    ).exec(MIG)?.[1];
    expect(post).toMatch(/^[0-9a-f]{32}$/);
    expect(MIG).toContain(`c_post constant text := '${post}';`);
    expect(MIG).toContain("c_pre_def constant text := 'acdfe7bc5b3138c9c188cdf1e8e24f22';");
    expect(MIG).toContain("c_pre_src constant text := '081b54ee2f9dd672bc1c7deee24a8119';");
    expect(MIG).toContain('ONLY_STAFF_REMOVE_PREIMAGE_CHANGED');
    expect(MIG).toContain('ONLY_STAFF_REMOVE_METADATA_CHANGED');
  });

  it('keeps no system bypass: a signed-out caller is refused, never a zero user', () => {
    expect(BODY).not.toMatch(/bypass/i);
    expect(BODY).not.toContain('00000000-0000-0000-0000-000000000000');
    expect(BODY).toMatch(
      /IF v_me IS NULL THEN\s+RETURN jsonb_build_object\('success', false, 'error', 'Authentication Required'\);/
    );
  });

  it('checks the caller is the owner or club staff before anything else is read', () => {
    expect(BODY).toContain(
      "coalesce(v_caller_role, '') NOT IN ('owner', 'club_owner', 'co_owner', 'admin', 'club_admin')"
    );
    expect(BODY.indexOf('Only Club Staff Can Remove A Member')).toBeLessThan(
      BODY.indexOf('SELECT * INTO v_target')
    );
  });

  it('refuses the owner, staff and every unsettled member with the reviewed words', () => {
    for (const words of REFUSALS) expect(BODY).toContain(`'${words}'`);
    expect(BODY).toContain("'depart_club_member', 'membership'");
  });

  it('is one transaction and never opens the door to anon', () => {
    expect(MIG).toMatch(/^BEGIN;$/m);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN");
    expect(MIG).not.toMatch(/^\s*GRANT\b[^;]*\banon\b/im);
    expect(BODY).toContain('SECURITY DEFINER');
    expect(BODY).toContain("SET search_path TO 'public', 'pg_temp'");
  });

  it('shows the club owner each refusal in words', () => {
    vi.stubEnv('DEV', false);
    for (const raw of REFUSALS.map((w) => w.replace("''", "'"))) {
      const shown = safeErrorMessage(new Error(raw), 'Failed To Mark Member Departed');
      expect(shown, raw).not.toMatch(/\$|—/);
      expect(shown, raw).not.toBe('Failed To Mark Member Departed');
    }
    expect(read('src/services/MembershipService.ts')).toContain(
      "throw new Error(result?.error || 'The Club Did Not Accept The Membership Departure');"
    );
  });

  it('an edit to the qualification alone still runs it', () => {
    for (const path of [
      'scripts/ci/test-only-staff-remove-member-db-postgres.py',
      'tests/fixtures/only-staff-remove-member-db/fixture.sql',
    ])
      expect(classifyChangedPaths([path]), path).toMatchObject({ server: true, tests: true });
  });
});
