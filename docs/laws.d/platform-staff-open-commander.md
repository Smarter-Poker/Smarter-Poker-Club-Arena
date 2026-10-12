# tests/platform-staff-open-commander.law.test.ts

Platform staff open Club Commander (an amendment to Ruling 22, 2026-10-01).
`get_commander_access_details`, which is what the World Hub's check-access route
asks, and `has_commander_access` admit platform staff by Commander's existing
staff rule, `fn_is_platform_admin()` (admin, superadmin, god). The rule is read
for the user being asked about, because the World Hub asks as the server, and
the answer says why with `isPlatformStaff`.

The migration refuses to apply if `fn_is_platform_admin()`'s role list has
moved. It keeps every other way in. It holds every caller to their own
account, makes up no venue row or subscription, gives no club an owner back,
and asserts that the arena is still the system account's.

The law holds the migration to that shape, and keeps the rolled-back production
rehearsal that proves three things: the god account is admitted, an ordinary
player is not, and no other account changes.
