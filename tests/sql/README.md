# The Diamond SQL acceptance runners

`tests/sql/run-*diamond*.py` certify the Diamond Arena's money doors against a
real PostgreSQL 17. They are the only proof in this repository that the custody,
admission, transfer, top-up, straddle, run-it-twice, bomb pot, plain-cash,
accepted-hand, controlled-play, tournament-door, tournament-lifecycle and
statistics doors behave as production has them installed, that the transfer
door gets past the production profile guard and the deposit door consults DR16,
and that the Diamond health watches resolve the incidents they filed.

They run in CI. Until 2026-09-19 they did not: each one was written for the
owner's Mac and ran only when somebody remembered to run it, so a Diamond
custody regression could merge with every required check green.

## How they run

`scripts/ci/run-diamond-sql-acceptance.py` is the wrapper, and
`.github/workflows/ci.yml` runs it in the `Accounting transactions
(PostgreSQL 17)` job, unguarded and without `continue-on-error`. It builds an
empty cluster behind the exact Unix socket the runners expect, runs each runner
once, requires each one to print its own closing line, keeps every runner's
stdout and stderr as an artifact, and tears the cluster down.

`node scripts/ci/check-diamond-runners-listed.mjs` runs in the same job, before
the wrapper, and fails the job when the directory holds a runner the wrapper
does not name. `tests/unit/diamondAcceptanceCi.test.ts` applies the same rules
statically, in the client unit suite, where they are cheap.

Run everything locally with:

```
python3 scripts/ci/run-diamond-sql-acceptance.py
```

One runner, without the rest:

```
python3 scripts/ci/run-diamond-sql-acceptance.py --only run-diamond-top-up.py
```

## ADDING A RUNNER MOVES THREE PLACES IN THE SAME COMMIT

The list rotted the day after it was written. Three runners landed on `main`
from three other pull requests, and each of them moved one place instead of
three, so the wrapper certified eleven runners while the directory held
fourteen. Do all three:

1. **`RUNNERS` in `scripts/ci/run-diamond-sql-acceptance.py`**: the file name
   and the exact line the runner's own body prints when it reaches its end. Exit
   0 is not proof: a runner whose fixture loaded nothing exits 0 as well, so the
   wrapper fails the step when that line is missing from the output. Add the
   runner to `PRIVATE_CLUSTER_RUNNERS` in the same file if it builds its own
   cluster (see below).
2. **The explicit name list in `tests/unit/diamondAcceptanceCi.test.ts`**
   (`EVERY_DIAMOND_RUNNER`, and `A_PRIVATE_CLUSTER` if it owns its cluster).
3. **The counts in that same test file** (`HOW_MANY_RUNNERS`,
   `HOW_MANY_ON_A_PRIVATE_CLUSTER`, `HOW_MANY_ON_THE_WRAPPER_CLUSTER`). They are
   deliberately literal so that a list and a number cannot quietly disagree.

Do not delete the explicit list, and do not make the counts derived so they can
never disagree. Deriving both halves from the same directory read means a runner
deleted together with its wrapper entry leaves every check green, which is the
failure mode CLAUDE.md sections 8 and 10.11 forbid. If a runner is genuinely
retired, remove it from all three places and say so in the pull request.

A change to a fixture file a runner loads also has to reach the job that
executes the runner. `scripts/ci/classify-ci-changes.mjs` routes them
(`diamondSqlAcceptance`), and the routing table in
`tests/unit/diamondAcceptanceCi.test.ts` names each path; a new fixture goes in
both.

## The two shapes of runner, and why neither can become the other

**Most runners share the wrapper's cluster.** They hard-wire the socket
directory `/tmp/codex-diamond-phase2-pg` and port `55472` into their own source,
read `PG_BIN` for the PostgreSQL 17 binaries and nothing else from the
environment, and never name `PGHOST`, `PGPORT`, `PGDATABASE`, `DATABASE_URL`,
`SUPABASE` or `PG17_BINDIR`. That is the property that keeps a runner off
production: there is no variable to set that would point one at a real database,
and the cluster has no TCP listener to reach it through.

Two of them, `run-diamond-incident-resolution.py` and
`run-diamond-transfer-door-and-dr16.py`, start a cluster on that same socket
and port, and stop it again, when nothing answers there, so they can be run by
hand without the wrapper. Under the wrapper something always answers, and they
use its cluster like the rest; they never make a temporary socket of their own,
which is why they are not private-cluster runners.

**Three runners build a cluster of their own**, because they load the estate's
historical schema base and pin the installed doors against it, so they need a
cluster nothing else has written to. Two postmasters cannot own one socket and
one port, so these cannot be moved onto the shared cluster. They hold the same
property by the same means: `PG_BIN` and nothing else from the environment, a
socket inside a temporary directory the run creates and destroys, and
`listen_addresses` empty.

Which shape a runner has is declared in `PRIVATE_CLUSTER_RUNNERS`, not guessed.
The wrapper uses the declaration to decide whether a shared cluster is needed at
all, and the unit test holds each shape to its own complete contract: a
private-cluster runner is forbidden from naming the shared socket or port, and
the two lists must partition the directory. A runner therefore cannot escape a
check or be relabelled into a weaker one.

## What these runners never do

They never connect to production, never require a credential, and never open
`cash_games_enabled` or `tournaments_enabled`. A fixture that opened an arena
switch to make a case pass would be a fixture certifying something nobody
shipped; two of the runners assert both switches are still closed when they
finish, and `tests/the-diamond-tournament-lifecycle-runs-the-installed-doors.law.test.ts`
refuses a fixture file that writes either one true.

The base and doors for the tournament fixture have their own longer notes in
[`diamond-tournament-doors.README.md`](./diamond-tournament-doors.README.md).
