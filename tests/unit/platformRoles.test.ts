/**
 * `isPlatformStaffRole` must agree with the DATABASE, which is the authority.
 *
 * `public.fn_is_platform_admin()` answers:
 *     RETURN v_role IN ('admin', 'superadmin', 'god');
 *
 * Six places in this client instead asked `role === 'admin' || role ===
 * 'super_admin'`. In production `role='god'` is held by 2 accounts — the
 * highest privilege the platform issues — and `super_admin` by none. So the
 * client's extra spelling matched nobody, and the two most privileged accounts
 * on the platform were shown no Platform Operations group, no Administration
 * link and no House Ads, while the database happily let them call the admin
 * RPCs. The tools worked; there was no door to them.
 */

import { describe, expect, it } from 'vitest';
import { isPlatformStaffRole, PLATFORM_STAFF_ROLES } from '../../src/utils/platformRoles';

describe('isPlatformStaffRole', () => {
  it('accepts every role the database calls a platform admin', () => {
    // Exactly fn_is_platform_admin()'s list. Do not shrink this without
    // changing that function in the same PR.
    for (const role of ['admin', 'superadmin', 'god']) {
      expect(isPlatformStaffRole(role), `${role} must be staff`).toBe(true);
    }
  });

  it("accepts 'god', the spelling the client used to miss", () => {
    expect(isPlatformStaffRole('god')).toBe(true);
  });

  it("keeps 'super_admin', the client's historical spelling", () => {
    // Matches no row today, but six call sites believed in it and something
    // outside this repo may yet write it. Accepting an unused spelling costs
    // nothing; rejecting a used one costs an operator their tools.
    expect(isPlatformStaffRole('super_admin')).toBe(true);
  });

  it('rejects ordinary players', () => {
    for (const role of ['user', 'player', 'venue_owner', 'owner', 'agent', 'manager']) {
      expect(isPlatformStaffRole(role), `${role} must not be staff`).toBe(false);
    }
  });

  it('treats a missing role as not staff, never as an error', () => {
    // A profile row that failed to load is not a promotion.
    expect(isPlatformStaffRole(null)).toBe(false);
    expect(isPlatformStaffRole(undefined)).toBe(false);
    expect(isPlatformStaffRole('')).toBe(false);
    expect(isPlatformStaffRole('   ')).toBe(false);
  });

  it('is case and whitespace tolerant, because a role is an identifier', () => {
    expect(isPlatformStaffRole(' Admin ')).toBe(true);
    expect(isPlatformStaffRole('GOD')).toBe(true);
  });

  it('exports the list so callers cannot re-derive a different one', () => {
    expect(PLATFORM_STAFF_ROLES).toContain('god');
    expect(PLATFORM_STAFF_ROLES).toContain('admin');
  });
});
