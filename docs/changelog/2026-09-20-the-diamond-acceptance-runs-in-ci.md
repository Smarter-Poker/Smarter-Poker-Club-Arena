# 2026-09-20 The Diamond acceptance runs in CI

## What was wrong

Eleven Python runners under `tests/sql/` certify the Diamond Arena's money
doors against a real PostgreSQL 17: custody reserve and release, the wallet
transfer, the cash buy-in, the top-up, the straddle, run it twice, the bomb pot,
the one plain-cash rule, the accepted hand, and a full controlled hand driven
through the real shared `HandController`. `tests/sql/poker-arena-access.sql`
certifies the arena's access rules beside them. Together they are the only
executed proof that the Diamond money doors behave, and until today **not one of
them ran in CI**. They ran when somebody remembered to run them by hand on the
owner's Mac, because each one had `/opt/homebrew/opt/postgresql@17/bin/psql`
written into it as a literal path.

That is the shape this estate has been bitten by repeatedly: a check nobody can
see is not a check. A Diamond custody regression could merge with every required
check green, and the thing that would have caught it was a command in somebody's
shell history.

Three smaller gaps sat next to it. `server/src/services/tableLease.test.ts`
pinned the lease that stops two engine containers dealing one table, but no case
in it was a Diamond cash table, where a double-dealt hand settles twice against
one `poker_diamond_custody` row. Nothing at the engine level asserted what
happens when a browser posts `club_id`, `asset`, `role`, `user_id` or `arena` in
a request body at a Diamond door. And `/hub/club-arena/clubs/diamond-arena`, the
one light room in a black app, had no phone-width route spec.

## What changed

**The eleven runners and the access script now run in the required
"Accounting transactions (PostgreSQL 17)" job.** A new wrapper,
`scripts/ci/run-diamond-sql-acceptance.py`, brings the exact Unix socket the
runners are hard-wired to (`/tmp/codex-diamond-phase2-pg`, port 55472) into
existence on the hosted runner, builds an empty cluster behind it with
`listen_addresses=` so nothing it starts can be reached over TCP, creates the
fixture databases, runs the runners one after another and tears the cluster
down. It publishes its evidence to `artifacts/diamond-sql-acceptance` and that
artifact is uploaded whether the step passed or failed.

Each runner now reads `PG_BIN` with the Homebrew path as its default, and that
is the only thing any of them takes from the environment. The socket directory,
the port and the database names stay written into each file, so no environment
variable can point a runner at a real database. `tests/unit/diamondAcceptanceCi.test.ts`
asserts that for every runner, including the absence of `PGHOST`, `PGPORT`,
`PGDATABASE`, `DATABASE_URL` and `SUPABASE`.

**The runner list cannot rot.** The wrapper names every runner explicitly
rather than globbing, so adding one is a decision;
`scripts/ci/check-diamond-runners-listed.mjs` runs in the same job, before the
runners, and fails the build when `tests/sql/` holds a runner the wrapper does
not name, when the wrapper names one that is not on disk, when the wrapper stops
running `poker-arena-access.sql`, or when the accounting job stops invoking the
wrapper in exactly one step unguarded by `if:` and without `continue-on-error`.

**Exit status alone is not accepted as proof.** A runner whose fixture silently
loaded nothing, or whose body was commented out, exits 0, and as a CI step that
reads as green. Each runner is therefore listed with its own terminal print, and
the wrapper fails the step when that line is absent from the output. Two of the
proofs carry the runner's own assertion count, so a change in what a runner
asserts is a deliberate edit rather than a silent loss of coverage. The gate was
proved to fire: with one proof string replaced by a line the runner never
prints, the step failed with `proof ABSENT` while the runner itself still exited 0.

**`scripts/ci/classify-ci-changes.mjs` routes the inputs to that job.** A change
to any `tests/sql/run-*diamond*.py`, any `tests/sql/poker-diamond-*.sql`,
`poker-arena-access.sql`, the controlled-play driver, the session and transfer
cap fixtures, the wrapper or the list check now selects the PostgreSQL
accounting job and its routing tests. The routing is additive: no existing
branch, accounting component, assertion or fixture changed.

**A Diamond cash table now has lease cases** in
`server/src/services/tableLease.test.ts`, driven against a fake
`claim_table_lease_v2`, `release_table_leases_v2` and
`heartbeat_table_leases_v4` that apply the rules the real functions apply,
including the stale window the client sends. Five cases: one owner at a time and
the loser deals nothing; the claim names only the table id, so no Diamond
specific lease path exists to get wrong; an exact release frees the table at
once and a late duplicate release from the previous owner evicts nobody; a
holder that goes stale is recovered by a new instance with a new generation, and
staleness is counted as reclaimable rather than raised as a split brain; and an
unreadable database answer is never read as "this Diamond table is free".

**A forgery suite, `server/src/http/aForgedArenaRequestIsRefused.test.ts`,**
posts `club_id`, `clubId`, `asset`, `role`, `user_id`, `userId`, `is_platform`,
`union_id`, `tournament_id` and a whole forged `arena` object at every door a
browser can reach, for a Diamond table and for a chip table: `POST /action`,
`POST /timebank`, `POST /addchips`, `POST /leave-occupancy`, the retired
`POST /leave`, and each of them again with no JWT. It asserts twice over: that
no forged word reaches the engine or the RPC, and that when the actor behind the
JWT holds no seat nothing moves. The engine doors are then driven with a real
`ServerTableEngine` whose table is loaded as the arena says, proving the money
door is chosen by the table (`fn_poker_diamond_top_up` for a Diamond table,
`atomic_table_addon` for a chip table, never the other) and that the cash-out
RPC carries only the actor and the occupancy.

Buy-in and tournament entry have no engine HTTP door: the browser calls the SQL
doors directly. Those are covered where they live.
`tests/sql/poker-diamond-forged-arena-acceptance.sql`, now run by the
cash-admission runner, presents a real chip club as the paying club on a
Diamond table's `atomic_table_buyin` and proves the refusal is
`diamond_purchase_arena_mismatch` for either player, with no wallet, custody,
seat, membership or receipt row written, while the honest shape from the same
session still seats through Diamond custody. At the engine, `assertDiamondTable`
is shown to refuse a forged `tournament_id` on a Diamond cash row and to refuse
a Diamond tournament row at the cash door, so a forged register cannot make one
shape answer as the other.

One thing was measured while writing that suite and is written down so nobody
hardens the wrong file: the tournament boundary refuses a union scope itself,
and the cash boundary does not look at `union_id` at all. That is not a hole,
because every table reaches the engine through `loadTable`, which runs
`parseTableArenaIdentity` on the row first and refuses a Diamond row carrying a
union before either boundary sees it. Both facts are now pinned, so removing the
parser's check cannot be excused by a belief that the cash boundary repeats it.

**`tests/e2e/diamond-arena-route.spec.ts`** opens the arena route at 375 CSS
pixels in portrait and in landscape. `ci.yml` runs the e2e suite against
production signed out and holds no credentials by design, and signed out this
route answers `/auth/login?redirect=%2Fhub%2Fclub-arena%2Fclubs%2Fdiamond-arena`,
which is the World Hub's sign-in page and not this app. The spec is therefore
split honestly: the no sideways overflow cases and a case proving the sign-in
bounce carries the arena route back rather than losing the selection run on
every run, plus a static case proving the published scheme block keys on the
same `data-arena-scheme` attribute the spec reads. The light scheme, the closed
arena copy, the refresh and the back navigation each skip with the missing
session named, rather than asserting something a login page would also satisfy.
The scheme logic itself is already pinned by
`tests/diamond-arena-is-the-light-room.law.test.ts`.

The spec is named in `post-deploy-e2e.yml`'s read-only sweep rather than
declared in `scripts/ci/e2e-not-in-post-deploy.json`, so the ratchet
`tests/unit/everyProductionSpecIsWiredOrDeclared.test.ts` holds stays at 18 and
the session gated cases run in the one place that has a session: the isolated
production account that job creates for its certification. The cases that need
to be standing on the arena report a third outcome rather than two, naming why
the browser is not there, so a run against an account that cannot open the arena
says so instead of failing or passing.

**Four pinned hashes were re-recorded.** `scripts/ci/classify-ci-changes.mjs` is
pinned by `tests/fixtures/full-weekly-accounting/source-binding.json` under
`repository_fixtures`, and by `tests/fixtures/legacy-fee-finality/source-binding.json`
and `tests/fixtures/sep8-spin-custody/source-binding.json` under
`repository_files`, which the weekly accounting activation script verifies
before it installs anything. Refreshing those two nested bindings changes their
own sha256, which the outer binding also pins, so four hashes move together.
`scripts/qualification/cash-native-hosted.manifest.json` pins both the
classifier and `.github/workflows/ci.yml` by size and sha256, and the pre-push
hook runs `scripts/ci/test_cash_native_pgcron.py` against it whenever a pinned
path changes, so those two entries were refreshed as well. The reason is
recorded in the binding under `diamond_sql_acceptance_ci_binding_20260920`: the
classifier gained additive Diamond SQL acceptance routing and no accounting
component, assertion or fixture changed.

## How it was verified

Every runner was executed on the owner's Mac against an isolated
`postgresql@17` cluster on the socket the runners expect, through the same
wrapper CI invokes. The six fixture databases were dropped beforehand, so each
run below started from a database the wrapper had just created empty, which is
the state a hosted runner gives it. All twelve runs passed, each proving its own
terminal line:

| Run                              | Time | Proof line                                                                                       |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `run-poker-diamond-custody.py`   | 4.3s | `69 additional assertions passed` (69 PASS lines)                                                |
| `run-diamond-wallet-transfer.py` | 1.0s | `37 Phase 4 assertions passed` (37 PASS lines)                                                   |
| `run-diamond-cash-custody.py`    | 0.2s | `Diamond custody contract passed; this is not full gameplay certification.`                      |
| `run-diamond-cash-admission.py`  | 0.4s | `forgery case leaves the fixture settled again`                                                  |
| `run-diamond-top-up.py`          | 0.4s | `Diamond top-up door certified in the isolated fixture; this is not public release.`             |
| `run-diamond-straddle.py`        | 0.3s | `Diamond straddle admission certified in the isolated fixture; this is not public release.`      |
| `run-diamond-run-it-twice.py`    | 0.3s | `Diamond run-it-twice admission certified in the isolated fixture; this is not public release.`  |
| `run-diamond-bomb-pot.py`        | 0.3s | `Diamond bomb pot admission certified in the isolated fixture; this is not public release.`      |
| `run-diamond-plain-cash-rule.py` | 0.1s | `One plain-cash rule certified in the isolated fixture; this is not public release.` (63 checks) |
| `run-diamond-accepted-hand.py`   | 0.3s | `Diamond accepted-hand integration passed; public gameplay remains gated.`                       |
| `run-diamond-controlled-play.py` | 1.4s | `CONTROLLED PLAY PASSED:` (9 PASS lines)                                                         |
| `poker-arena-access.sql`         | 0.0s | `PHASE2_LOCAL_SQL_PASS_39_ASSERTIONS`                                                            |

`node scripts/ci/check-diamond-runners-listed.mjs` reports all eleven runners
run by CI. The proof requirement was proved to fail closed: a copy of the
wrapper carrying one proof string the runner never prints reported
`run-diamond-plain-cash-rule.py: FAIL after 0.1s (exit 0, proof ABSENT)` and
exited 1, while the runner itself still exited 0. The forgery SQL was confirmed
to have executed inside the cash-admission runner's output, refusing both forged
purchases with `diamond_purchase_arena_mismatch` and then settling the fixture
back with every Diamond in a wallet and zero custody.

`server/src/services/tableLease.test.ts` passes with 38 tests and
`server/src/http/aForgedArenaRequestIsRefused.test.ts` with 30, 68 together.
`tests/unit/diamondAcceptanceCi.test.ts` passes with 63.
`tests/e2e/diamond-arena-route.spec.ts` was run against production signed out,
exactly as `ci.yml` runs it (`BASE_URL=https://smarter.poker/hub/club-arena`):
5 passed, 6 skipped with the missing session named.

Every `repository_fixtures` and `repository_files` map in every
`source-binding.json` in the tree was re-verified against the bytes on disk:
619 pinned paths, the four refreshed here included, all agree. The only two that
do not are `tests/unit/FinancialCronService.test.ts` and
`tests/unit/discardedErrorReadRatchet.test.ts`, which arrived on main with
#4943 and which this branch does not touch or re-record.
`python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py`
accepts the refreshed cash manifest, 6 tests. `npx tsc --noEmit` is clean at the
root and in `server/`, and `check-title-case`, `check-ui-text` and
`check-painted-text-case` all report OK.

**Full suites on this exact candidate.**

Server, `cd server && npx vitest run --reporter=dot`: 971 test files, 968
passed, 1 skipped, 2 failed; 16,902 tests, 16,720 passed, 166 skipped, 16
failed. The two failing files are
`src/benchmark/HorseLeagueProcessPriority.test.ts` and
`src/benchmark/HorseLeagueProcessPriority.integration.test.ts`, and every one of
the 16 failures reads `expected 'darwin' to be 'linux'`: they assert a Linux
inherited-priority boundary and cannot pass on macOS. CI runs `ubuntu-latest`.

Root, `npx vitest run --reporter=dot`: 1,661 test files, 1,656 passed, 5 failed;
23,692 tests, 23,674 passed, 1 skipped, 17 failed. Re-running those five files
on their own reproduces one failing file and twelve failures:
`tests/legacyEngineCheckpointTransport.test.ts`, which asserts
`/^v(?:20|22)\./` against the running Node and gets `v26.3.0` from this Mac. CI
runs Node 20 and 22, where it passes. The other four files
(`a-tournament-prize-knows-its-unit.law`, `stamp-build-provenance`,
`the-arena-sitemap-lists-what-it-prerenders.law` and
`unit/nativePublishOriginGate`) pass in isolation with these changes in the
tree, so their five failures under the full parallel run are load related on
this machine rather than regressions. Nothing in this change goes near the
legacy checkpoint transport, process priority, build provenance, the sitemap or
the publish origin gate.

## What this does not claim

No production database object was created or changed, and neither arena switch
was touched: `cash_games_enabled` and `tournaments_enabled` stay off. The
runners execute against an isolated fixture, so they certify the doors as the
repository records them, not the live installation. The six session gated
cases in the route spec are skipped rather than passing, and the arena's
rendered light scheme and closed-arena copy remain unproved by an executed
browser run until that suite is given a session.
