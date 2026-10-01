# tests/a-club-day-rake-row-is-taken-at-commit.law.test.ts

A raked cash hand upserts its club's ca_club_rake_daily row at COMMIT (a DEFERRABLE INITIALLY DEFERRED row trigger calling the unchanged fn_ca_club_rake_daily_apply), never in the middle of atomic_distribute_rake: held there, the one per-club-per-day row queued every hand of the club behind the slowest one (67% of the post-commit obligations' statement timeouts, 2026-10-01). Same filter, same values, same never-fail-the-hand rule; the law pins the migration's pins, the deferred trigger, and the harness that runs the migration itself.
