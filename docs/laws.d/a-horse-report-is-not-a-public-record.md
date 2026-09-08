# tests/a-horse-report-is-not-a-public-record.law.test.ts

Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE OR
USE A DEVELOPER TOOL AND FIND THIS OUT." A 2026-09-07 sweep of every relation
and function a player may read found three doors the 2026-09-02 closure did
not reach, each measured as a real non-staff player in a rolled-back probe:
`horse_bug_reports` carried the policy "Anyone can read bug reports" (16,101
rows naming 202 horses, readable signed out); `club_memberships` is a
security_invoker view over `club_members` that nothing reads and that exposes
`is_bot`, which is `is_horse` mirrored by trigger; and
`fn_club_union_join_blockers` returned `horse_count` for any club to any
authenticated caller with no guard and no client caller. The closing migration
makes the report table admin-read (`fn_is_horse_admin`), revokes the dead view
and the function from players (the union-join trigger that really calls it is
SECURITY DEFINER and unaffected), and asserts all three with
`has_table_privilege` / `has_function_privilege`. The law pins that text and
that no later migration reopens any of the three.
