# One level reaches the whole tournament

A level transition previously updated every engine-owned table separately and
then saved the tournament level. A second table or parent write could fail
after earlier tables changed, leaving different stakes across the field.
Acknowledgment retries prevented a false announcement but did not make those
writes atomic. A table created concurrently could also insert cached blinds.

The Club Arena manager now calls one service-only, generation-fenced database
function. It locks the maintenance barrier, scoped settlement lane, current
lease, parent and open tables; publishes all table blinds, stakes, the level
and its clock in one transaction; and verifies the actual written state.
Exceptions and suppressed or altered writes roll back the whole publication.
The successful clock comes from database time after the field writes, so a
failed request does not consume an unplayed level. A lost-response retry
returns the current committed clock, including any intervening break shift.

A committed blind snapshot belongs to the parent. New table inserts serialize
with that parent and inherit the snapshot, including when their proposed
configuration came from an older cache. Resume uses committed amounts before
dealer admission. Existing hands keep their captured blinds; later hands read
the newly committed configuration. Existing advertised structures, economic
contracts and balances are not rewritten.

## Evidence and rollout

- Service and tournament suites plus the actual hand snapshot suite: **5,171
  tests in 340 files**. Final changed-method and hand-boundary set: **100 tests
  in four files**. Server TypeScript and migration-version checks pass.
- Private PostgreSQL 17: **33 groups**, including MVCC visibility, write
  exceptions and silent suppression, lost responses, break clock shifts,
  concurrent table birth, heartbeat renewal, the actual generation-claim
  function, stale ownership and the maintenance barrier. Evidence is retained
  at `/tmp/ca-ab-hr0ntx2g/results.json` for this run.
- These native fixtures use synthetic rows and direct trusted request context.
  Maintenance is an explicit boolean fixture. They do not certify PostgREST
  authentication, all production trigger combinations, financial settlement
  or full MTT gameplay. Actual BEFORE INSERT trigger definitions were read
  separately; subsequent triggers do not rewrite blind amounts.
- An initial combined DDL attempt deadlocked at 20:07 UTC and rolled back:
  readback confirmed no column, functions or migration history. Splitting the
  additive parent schema change from table-trigger installation removes that
  lock cycle. The native reproduction now passes. Both migrations applied
  successfully at **20:10 UTC**, outside the protected DDL window.
- Repository migration20260913195404 is history20260913201030. Authority
  migration20260913200859 is history20260913201037. Installed source MD5s:
  initial publication `4d74d457a6883d4c7786caa0301a9028`, inheritance
  `41f697318d50d409770ca36e289406b4`. Both match the candidate; owner is postgres,
  search path public/pg_temp, browser execution denied, service execution
  allowed. No historical snapshot was backfilled.

A final review found that add-on breaks use their own persisted window, not
`on_break`. Source-guarded migration20260913201306 applied at20:14UTC as history 20260913201436. It blocks the final configured1..10minutes of an active add-on
window while allowing the earlier purchase/play interval and expired or
finalized windows. Nine native cases cover those boundaries. Current publication
source MD5 is `ea893550ec280993c522bb8dfb78fcd3`; metadata and grants remain verified.

The database is installed before the engine caller. Engine publication and
live atomic-transition acceptance remain separate. Once snapshots are in use,
returning to an older sequential writer is not a certified rollback: it can
advance the parent without updating the snapshot and safely refuse later table
births. Preserve the ordinary forward release ancestry policy and review any
exception against these state contracts.

Run `TMPDIR=/tmp python3 scripts/dev/probe-atomic-tournament-blinds-pg17.py`
from the repository root. The probe takes no production URL and cleans up its
own cluster. The separate native registration/funding probe and the broader
MTT blueprint retain their existing, distinct proof limits.
