/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLATFORM ROLES — one answer to "is this person platform staff?"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE DATABASE AND THE APP DISAGREED, AND THE APP WAS WRONG.
 *
 * `public.fn_is_platform_admin()` is the estate's authority — it gates RLS
 * policies and admin RPCs — and it answers:
 *
 *     RETURN v_role IN ('admin', 'superadmin', 'god');
 *
 * Six places in this client instead asked `role === 'admin' || role ===
 * 'super_admin'`. Compare the two lists:
 *
 *   | role         | DB says staff | client said staff | rows in production |
 *   | ------------ | ------------- | ----------------- | ------------------ |
 *   | admin        | yes           | yes               | 1                  |
 *   | god          | yes           | NO                | 2                  |
 *   | superadmin   | yes           | NO                | 0                  |
 *   | super_admin  | NO            | yes               | 0                  |
 *
 * So the client's extra spelling matched nobody, and the two `god` accounts —
 * the highest privilege the platform issues — were treated as ordinary players
 * by every platform-staff surface in Club Arena: no Platform Operations group
 * in the command drawer, no Administration link, no House Ads. They could
 * still call the admin RPCs, because the database knew who they were. Only the
 * navigation didn't, which is the most confusing possible split: the tools
 * work, but there is no door to them.
 *
 * This module is that single answer. It deliberately mirrors the SQL function
 * rather than improving on it — if the two disagree again, the disagreement is
 * the bug, and one file is where you fix it.
 *
 * `super_admin` is KEPT, even though it currently matches no row, because six
 * call sites believed in it and something outside this repo may yet write it.
 * Accepting a spelling nobody uses costs nothing; rejecting one somebody does
 * use costs an operator their tools. This module is navigation-level trust —
 * the route guards, the RLS policies and `fn_is_platform_admin` remain the
 * enforcement boundary, so a generous match here cannot grant real access.
 */

/**
 * Every role string that counts as platform staff.
 *
 * The first three are exactly `fn_is_platform_admin()`'s list. The fourth is
 * the client's historical spelling, retained for the reason above.
 */
export const PLATFORM_STAFF_ROLES: readonly string[] = [
  'admin',
  'superadmin',
  'god',
  'super_admin',
];

/**
 * Is this `profiles.role` value platform staff?
 *
 * Tolerates null/undefined (a profile row that failed to load is not staff)
 * and trims/lowercases, because a role is an identifier and not a sentence.
 */
export function isPlatformStaffRole(role: string | null | undefined): boolean {
  if (!role) return false;
  return PLATFORM_STAFF_ROLES.includes(role.trim().toLowerCase());
}
