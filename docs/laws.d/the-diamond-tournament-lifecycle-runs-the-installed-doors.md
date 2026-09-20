# tests/the-diamond-tournament-lifecycle-runs-the-installed-doors.law.test.ts

The Diamond tournament lifecycle cases run against production's own trigger
chain, and the fixture never opens an arena switch to make a case pass. Every
`-- @@PIN md5=` in `tests/sql/diamond-tournament-lifecycle-doors.sql` must
equal the md5 of the definition printed beneath it; the manifest must name
exactly those doors, where each one's bytes came from, the trigger definitions
the capture installs, and - with a reason each - every trigger production
carries that it does not install and every base trigger it drops. The runner
must load the historical base, both fixture deltas, both door captures, the
seed and the cases in that order. No fixture file it loads may set
`cash_games_enabled` or `tournaments_enabled` true, and the runner must refuse
to pass if either is open when the cases finish: the arena's release gate is
Dan's to open, never a fixture's, and the closed switch is itself what the
fixture's sixth case asserts. Finally, as in the first Diamond tournament law,
no md5 comparison in the capture may be turned into a comparison against NULL.

`tests/sql/run-diamond-tournament-lifecycle.py` runs in CI through
`scripts/ci/run-diamond-sql-acceptance.py`, so these cases are now certified on
every pull request that touches them rather than when somebody remembers. A new
runner under `tests/sql/` moves three places in the same commit: see
`tests/sql/README.md`.
