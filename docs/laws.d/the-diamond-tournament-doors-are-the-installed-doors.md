# tests/the-diamond-tournament-doors-are-the-installed-doors.law.test.ts

The Diamond tournament lifecycle fixture exercises the doors production runs,
proved from the repository alone. Every `-- @@PIN md5=` in
`tests/sql/diamond-tournament-doors-captured.sql` must equal the md5 of the
definition printed beneath it, the capture's manifest must name exactly those
doors, and every function the ten Phase 8 Diamond tournament migrations create
or edit in place must appear in the capture - minus the two closure members
the capture names as out of scope (the satellite-ticket admission path and
late-registration seating, neither of which a Diamond event reaches). The last
assertion is the one this law exists for: no migration anywhere in
`supabase/migrations/` may compare an md5 against NULL. On 2026-09-19 a lane
building this fixture tried exactly that across ten financial migrations to
make a replay succeed; an md5 pin is the only thing between an in-place edit
and a silently different money function, and it is never weakened to make a
fixture build.
