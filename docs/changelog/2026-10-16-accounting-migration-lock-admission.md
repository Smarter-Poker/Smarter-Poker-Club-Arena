# An accounting migration waits inside its original transaction

The proving-window migration was refused three times after provider queueing:
accounting owned its required scheduler lock twice, and the maintenance clock
refused the other attempt. A free lane at dispatch cannot predict execution.

The existing recorded-migration installer now admits three exact source-bound
accounting migrations with one bounded transaction advisory-lock wait. It adds
no dispatcher, retry, session lock, schedule or migration body change. The raw
file and its atomic recorded history remain identical. All other files retain
their existing installation path.

Admission refuses overrides and checks current freeze, maintenance boundary and
the database's DDL authority before and after waiting. It reserves 310 seconds
only when the scheduler lock is occupied, before waiting (245 seconds of lock budget plus the migration's existing 60
second statement budget and margin), then rechecks 60 seconds of runway. The
original migrations retain their operator, source/history, ownership and DDL
guards, including their original short DDL timeouts. A refusal or interrupted
connection retains the installer's original REFUSED/UNKNOWN outcomes.

The required native TLS installer driver invokes the new regression against
its isolated PostgreSQL 17 database. It reproduces the old reader-owned refusal
with the exact migration, then checks the actual CLI waits and commits exact
source/history and postimages. Concurrent freeze, boundary and DDL refusal,
waiter cancellation, history failure, changed source, lock release and duplicate
readback are covered. Existing TLS, atomic-history, rollback and unknown-outcome
cases remain required. Fixture maintenance time and dependencies are controlled;
this does not qualify production weekly payment performance.

Changes: `apply-recorded-migration.mjs` calls the source-bound admission wrapper
before its existing single send; `test_launch_reset_installer.py` copies the
module and invokes the native child. No migration, shared CI job, money rule,
scheduler, production freeze or engine component changes.
