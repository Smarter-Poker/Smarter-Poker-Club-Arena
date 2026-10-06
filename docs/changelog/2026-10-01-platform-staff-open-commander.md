# Platform Staff Open Club Commander (A Follow-Up To Ruling 22)

2026-10-01. Ruling 22 gave the Diamond Arena to the system account.
`daniel@smarter.poker`, the god admin account Dan and the scripts use, had Club
Commander access only because it owned the arena, so it lost it. It now opens
Commander again, as platform staff, the way Commander already admits staff.

## What changed

Migration `20261001125101_platform_staff_open_commander` changes the two doors
the World Hub reads:

- `get_commander_access_details`, behind the World Hub's check-access route:
  the Club Commander orb, and "Host A Home Game";
- `has_commander_access`, behind profile summaries.

Both now admit platform staff by Commander's existing staff rule,
`fn_is_platform_admin()` (admin, superadmin, god). That rule already gates
Commander's activity log, leads, rate limits and tournament points. It is read
for the user being asked about, because the World Hub asks as the server, and
the answer says why with `isPlatformStaff`.

## What did not change

- No venue row was made up and no subscription was invented.
- No club, the arena least of all, got an owner back.
- An ordinary player is still refused, and cannot borrow a staff account's
  answer by asking about it.
- Every account that is not platform staff answers exactly as before. The
  rehearsal checked all 1,484.
- The two admins already had Commander through their own venues, so only
  `daniel@smarter.poker` changes.
- The Commander app's own staff check reads venue staff rows and subscriptions.
  It never admitted this account, so it is unchanged.

## Evidence

- `docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md`, the
  follow-up section: before, with the migration, and after apply.
- `docs/evidence/diamond-phase-11/platform-staff-open-commander-rehearsal.sql`:
  the re-runnable rehearsal.
- `tests/platform-staff-open-commander.law.test.ts`: the law on the migration
  text.
