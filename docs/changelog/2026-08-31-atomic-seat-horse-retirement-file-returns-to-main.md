# 2026-08-31 — The atomic_seat_horse retirement file returns to main

The retirement of `public.atomic_seat_horse` was applied to production on
2026-08-31 and is recorded in `supabase_migrations.schema_migrations` as
version `20260831104745`, name
`20260831_retire_atomic_seat_horse_the_dead_minting_path`. Verified again
before this change: the recorded row is present and
`pg_proc` holds zero functions named `atomic_seat_horse`.

The migration file itself, however, was carried out of `main` by the revert of
PR #2143 during the cash-floor incident. Production and the repository
disagreed: a from-scratch replay of `supabase/migrations` would have re-created
the function.

That matters because `atomic_seat_horse` debits `public.wallets` — the pool
frozen since 2026-08-21 that nothing reads, and that holds 718,146,564 chips in
horse hands (average 1,229,703 each). A seat path reading that pool would seat
a "10,000-chip" horse in any game on the board, making the bankroll reset
invisible to it.

Restored byte-identical from `6eae5e2b90` (sha256
`775867addebe9ce0442ab686661f5f673946e80765e1d36280e0bd18b609678d`, confirmed
against the blob). No SQL was written or re-applied; production already carries
this migration and was not touched by this change.

Filename kept as `20260831_retire_atomic_seat_horse_the_dead_minting_path.sql`
rather than renamed to the generated version. That matches how every other
MCP-applied migration in this tree is stored: the file carries the date-plus-slug
name and the database records a generated timestamp against it (checked against
`20260831_aggression_factor_is_a_postflop_statistic`, recorded as
`20260831081851`).

New pin: `tests/unit/atomicSeatHorseStaysRetired.test.ts`. It fails if the file
leaves the tree again, if the `DROP FUNCTION` stops being live SQL, if either
pre-apply abort guard or the post-apply existence check is removed, or if the
commented rollback body is ever uncommented into executable SQL. All four
assertions were mutated and observed failing: file removed (4 failures), the
`DROP` commented out (1 failure, caught only after the first draft's plain
`toContain` was found to survive being commented out), and the rollback body
uncommented (1 failure).
