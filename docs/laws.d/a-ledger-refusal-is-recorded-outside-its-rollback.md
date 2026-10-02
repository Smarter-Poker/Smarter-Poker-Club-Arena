# tests/a-ledger-refusal-is-recorded-outside-its-rollback.law.test.ts

A ledger-invariant refusal never fails silently. fn_ca_balance_has_its_ledger_row
refuses a transaction at COMMIT (SQLSTATE 23514, `REFUSED:
balance_moved_without_its_ledger_row` / `REFUSED:
balance_moved_against_settlement_suspense`) and the refusal rolls the whole
transaction back, so anything written inside it is lost. Migration
20261002135708 makes the refusing session record the refusal before it raises,
on a loopback dblink connection that commits on its own, so the record survives
the rollback for every caller at once (engine, World Hub, pg_cron, client RPC).

The law reads the LATEST body of each function across every migration: every
REFUSED raise is preceded in its own branch by an isolated call to
fn_ca_ledger_refusal_record; the recorder takes nextval of
ca_ledger_invariant_refusal_counter before it connects (a refusal whose record
cannot be written is still counted), reads its connection string from Vault,
never uses dblink_connect_u, never raises, and raises the incident in a separate
remote statement after the record; no migration carries the recorder's
password (only a format() placeholder fed by a generated value); and
fn_ca_cron_failure_watch runs fn_ca_ledger_invariant_refusal_watch, which turns
every counted refusal without a record into an explicit `unrecorded` row and a
critical incident. Every record raises or folds into one critical
ca_drift_incidents row per kind, function and account (source
`ledger_invariant.refused`).

The executable proof is scripts/dev/test-ledger-invariant.sh, which applies the
migration on PostgreSQL 17 and runs
tests/fixtures/ledger-invariant/refusal-regression.sql: a real top-level
transaction refused at COMMIT and rolled back, then its row, counter and
critical incident read afterwards; a repeat folding into the same incident; the
caller still seeing 23514 and the same message; a suspense refusal; a recorder
whose login is refused (the refusal is unchanged and the watch files it as
unrecorded); and a recorder login that can reach nothing but its two doors.
