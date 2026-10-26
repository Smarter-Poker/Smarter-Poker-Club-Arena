import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan, 2026-10-26: "REMOVE ANY AND ALL 'STAFF MEMBERS' I HAVEN'T CREATED ANY,
// ITS ONLY ME FOR KINGS CLUB".
//
// Every staff member in KINGS CLUB, Deep Stack Society and Midway Union was a
// post-deploy verification identity whose cleanup door had refused. When the
// join door began placing every new member under the club owner, that refusal
// would have stranded every future run's admin as well. This pins the two root
// fixes and the one removal of the identities already left behind.

const dir = 'supabase/migrations';
const found = readdirSync(dir).filter((name) =>
  name.endsWith('_test_staff_accounts_leave_the_real_clubs.sql')
);
if (found.length !== 1) throw new Error('Expected One Test Staff Removal Migration');
const sql = readFileSync(`${dir}/${found[0]}`, 'utf8');
const code = sql.replace(/^--[^\n]*$/gm, '');
const script = readFileSync('scripts/ci/production-e2e-account.mjs', 'utf8');

describe('test staff never stay in the real clubs', () => {
  it('the test admin is promoted with no agent, so staff sit under nobody', () => {
    expect(script).toContain(
      "? { role: memberRole, status: 'active', is_active: true, agent_id: null }"
    );
    expect(script).toContain("memberRole === 'admin'");
  });

  it('the cleanup door reads an owner upline as no authority, and still refuses a real agent', () => {
    expect(code.match(/OR \(agent_id IS NOT NULL AND agent_id IS DISTINCT FROM/g)).toHaveLength(2);
    expect(
      code.match(
        /\(SELECT c\.owner_id FROM public\.clubs c WHERE c\.id = club_members\.club_id\)\)/g
      )
    ).toHaveLength(2);
    expect(code.match(/OR parent_agent_id IS NOT NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const marker of [
      'TEST_STAFF_PREIMAGE_CHANGED',
      'TEST_STAFF_PATCH_MISMATCH',
      'TEST_STAFF_INSTALL_MISMATCH',
    ]) {
      expect(code).toContain(marker);
    }
  });

  it('the identities left behind leave through the door or the departure write, never by hand', () => {
    expect(code).toContain('public.cleanup_reserved_certification_account(r.id)');
    expect(code).toContain("set_config('app.club_membership_lifecycle_write', 'depart', true)");
    expect(code).toContain("p.email LIKE 'ca-customization-cert-postdeploy-%@example.invalid'");
    // Only test identities: never a horse, a platform admin, or a real member.
    expect(code).toContain('NOT coalesce(p.is_horse, false) AND NOT coalesce(p.is_admin, false)');
    expect(code).not.toMatch(/DELETE FROM public\.club_members/i);
    expect(code).not.toMatch(/SET\s+(chip_balance|promo_balance|agent_wallet_balance)\s*=/i);
    expect(code).toContain('TEST_STAFF_LEFT');
  });

  it('is one transaction', () => {
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
