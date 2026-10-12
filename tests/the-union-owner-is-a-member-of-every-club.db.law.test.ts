/**
 * ===========================================================================
 *  LAW - THE UNION OWNER IS A MEMBER OF EVERY CLUB IN THE UNION
 * ===========================================================================
 *
 * Dan, 2026-10-12: "union owner MUST BE A MEMBER OF EVERY CLUB THAT JOINS."
 *
 * Every way a club reaches a union ends in a union_clubs INSERT or a
 * reassigning UPDATE, so migration 20261012112707 puts the rule there: the
 * union's owner becomes an active member of the club in the same transaction
 * (a new row is an ordinary zero-chip 'player' row; a pending, inactive or
 * departed row is activated; an active row is left alone), a change of union
 * owner adds the new owner to every club, and while the club is in the union
 * the owner's membership cannot be removed, banned, suspended, left,
 * deactivated or deleted. A union owner banned or suspended in the club
 * refuses the join instead of being silently reinstated.
 *
 * scripts/ci/test-union-owner-membership-db-postgres.py qualifies it on
 * PostgreSQL 17 against the two gates it edits, rebuilt byte for byte from
 * main's migrations (22 of 35 cases fail before, 35 pass after). This law pins
 * the shapes that would quietly undo it: a guard narrowed to one removal door,
 * a new row given a staff role or chips, a ban lifted by the join, the cap
 * bypass widened past the system source, and the refusal reaching a club
 * owner as a generic error.
 *
 * Registry: docs/laws.d/the-union-owner-is-a-member-of-every-club.md
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
import { migrationText } from './helpers/migrationCorpus';

const FILE = '20261012112707_the_union_owner_is_a_member_of_every_club.sql';
const MIG = migrationText(FILE);
const read = (p: string): string => readFileSync(p, 'utf8');
const proof = (sig: string) =>
  new RegExp(
    `-- @live-proof: \\(SELECT md5\\(pg_get_functiondef\\('${sig.replace(/[()]/g, '\\$&')}'::regprocedure\\)\\) = '([0-9a-f]{32})'\\)`
  ).exec(MIG)?.[1];

describe('the union owner is a member of every club in the union', () => {
  it('edits the two membership gates by counted substitution, pinned before and after', () => {
    const source = proof('public.fn_require_explicit_club_membership_source()');
    const cap = proof('public.fn_enforce_four_club_limit()');
    for (const [pre, post] of [
      ['3c4e9aa515a8b8c8226fdf18332156a3', source],
      ['6df4cf3478e10b3f108357567c25c98b', cap],
    ] as const) {
      expect(post).toMatch(/^[0-9a-f]{32}$/);
      expect(MIG).toContain(`IF md5(v_def) <> '${pre}' THEN`);
      expect(MIG.split(post!).length - 1).toBe(3);
    }
    expect(MIG).toContain('UNION_OWNER_MEMBERSHIP_METADATA');
    expect(MIG).toContain(
      "IF v_source NOT IN ('join_club', 'club_owner_create', 'union_owner_membership') THEN"
    );
    // The cap is lifted for the platform's own membership only.
    expect(MIG).toContain(
      "IF COALESCE(current_setting('app.club_membership_source', true), '') = 'union_owner_membership' THEN"
    );
  });

  it('runs on every join path and on a change of union owner', () => {
    expect(MIG).toMatch(
      /CREATE OR REPLACE TRIGGER trg_union_owner_joins_every_club\s+AFTER INSERT OR UPDATE OF union_id, club_id ON public\.union_clubs/
    );
    expect(MIG).toMatch(
      /CREATE OR REPLACE TRIGGER trg_union_new_owner_joins_every_club\s+AFTER UPDATE OF owner_id ON public\.unions/
    );
  });

  it('makes an ordinary zero-chip player membership and never lifts club discipline', () => {
    expect(MIG).toContain("VALUES (p_club_id, v_owner, 'player', 'active', true, 0);");
    expect(MIG).toContain('UNION_OWNER_BANNED_IN_CLUB');
    expect(MIG).toContain('UNION_OWNER_SUSPENDED_IN_CLUB');
    expect(MIG).not.toMatch(/SET\s+role\s*=/);
    expect(MIG).not.toMatch(/chip_balance\s*=\s*[^0]/);
  });

  it('guards every removal door with one trigger, and lets the club go once it leaves the union', () => {
    expect(MIG).toMatch(
      /CREATE OR REPLACE TRIGGER trg_union_owner_membership_is_kept\s+BEFORE UPDATE OR DELETE ON public\.club_members/
    );
    expect(MIG).toContain('UNION_OWNER_MEMBERSHIP_REQUIRED');
    expect(MIG).toMatch(/WHERE uc\.club_id = OLD\.club_id\s+AND u\.owner_id = OLD\.user_id/);
    expect(MIG).toMatch(/VALUES \('club_members', 'trg_union_owner_membership_is_kept',/);
  });

  it('is one transaction, closed to browser roles', () => {
    expect(MIG).toMatch(/^BEGIN;$/m);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const fn of [
      'fn_union_owner_holds_membership(uuid, uuid)',
      'fn_union_clubs_owner_joins_the_club()',
      'fn_unions_new_owner_joins_every_club()',
      'fn_union_owner_membership_is_kept()',
    ])
      expect(MIG).toContain(
        `REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`
      );
  });

  it('registers only the zero-chip membership writer before its creation', () => {
    const registry = MIG.indexOf('INSERT INTO public.ca_money_rpc_registry (proname,status,notes)');
    expect(registry).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(
      MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_owner_holds_membership(')
    );
    expect(MIG).toContain("VALUES ('fn_union_owner_holds_membership','approved',");
    expect(MIG).toContain('ON CONFLICT (proname) DO NOTHING;');
    expect(MIG).toContain('UNION_OWNER_MEMBERSHIP_REGISTRY_CHANGED');
    expect(MIG.match(/INSERT INTO public\.ca_money_rpc_registry/g)).toHaveLength(1);
    const runner = read('scripts/ci/test-stranded-satellite-part2-postgres.py');
    expect(runner).toContain(
      'REFUSED: fn_union_owner_holds_membership writes balance columns and is not in ca_money_rpc_registry'
    );
  });

  it('shows a club owner the refusal in words', () => {
    const errors = read('src/utils/safeErrorMessage.ts');
    expect(errors).toContain("'The Union Owner Must Stay A Member Of Every Club In The Union.'");
    expect(errors).toContain('const refusal = serverRefusalMessage(raw);');
    expect(read('src/services/ClubsService.ts')).toContain(
      "throw new Error(serverRefusalMessage(leaveErr) ?? 'Failed to leave club - please try again');"
    );
  });

  it('an edit to the qualification alone still runs it', () => {
    for (const path of [
      'scripts/ci/test-union-owner-membership-db-postgres.py',
      'tests/fixtures/union-owner-membership-db/fixture.sql',
    ])
      expect(classifyChangedPaths([path]), path).toMatchObject({ server: true, tests: true });
  });
});
