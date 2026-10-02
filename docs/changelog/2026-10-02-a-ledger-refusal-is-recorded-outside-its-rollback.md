# A ledger refusal is recorded outside its rollback

2026-10-02. Launch plan phase 1a: a ledger-invariant refusal must never fail
silently.

## The gap

All 16 chip stores refuse (`ca_ledger_invariant_store_mode`). The deferred
constraint triggers call `fn_ca_balance_has_its_ledger_row` at COMMIT, and a
disagreement raises SQLSTATE 23514 `REFUSED: balance_moved_without_its_ledger_row`
or `REFUSED: balance_moved_against_settlement_suspense`. The raise rolls the
whole transaction back, including anything the check could write, so a refused
hand, payout, cron job, World Hub route or client RPC left one Postgres log line
that nobody reads. "0 findings" could not tell "0 refusals" from "refusals
nobody recorded" (CLAUDE.md 10.83, 10.86 rule 1).

## The mechanism, and why it lives in the database

Four kinds of caller can be refused (the Hetzner engine, World Hub routes,
pg_cron, any client RPC), and only the database sees all four. So the refusing
session writes the record itself, immediately before it raises, on a second
connection that commits on its own.

- **dblink loopback, password authenticated.** dblink 1.2 is installed in
  `public`. `dblink_connect_u` is superuser-only and `dblink_fdw` belongs to
  supabase_admin, so there is no foreign server. Measured from the database at
  13:44 UTC, each in a rolled-back DO block: localhost, 127.0.0.1 and the unix
  socket are TRUST, which dblink refuses for a non-superuser. The project host
  `db.kuklfnapbkmacvwxktbh.supabase.co` reaches scram authentication in 54 ms.
- **No credential in source.** The migration creates the login
  `ca_ledger_refusal_recorder` and generates its password inside the
  transaction (two `gen_random_uuid()`). It sets the password with a nested
  EXECUTE: `log_statement=ddl` logs only top-level statements and `pgaudit.log`
  is `none`. The connection string goes into Supabase Vault
  (`ca_ledger_refusal_recorder_conninfo`), the project's existing secret store.
  Nobody, including the author, has seen the value.
- **The login can do two things.** It can EXECUTE `fn_ca_ledger_refusal_file`
  and `fn_ca_ledger_refusal_raise`, and it has USAGE on the schema. It has no
  table privilege and no role membership. CONNECTION LIMIT is 4,
  statement_timeout 3s, lock_timeout 1s. It is not granted to authenticator.
- **It never blocks or fails the refusal.** Every step is isolated, and the
  refusal raises with the same SQLSTATE, message, DETAIL and HINT as before.
  `connect_timeout=2` bounds the connect. The incident is raised in a separate
  remote statement after the record has committed.
- **"Could not tell" is not zero.** The refusing session takes `nextval` of
  `ca_ledger_invariant_refusal_counter` before it connects, and nextval is not
  rolled back. `fn_ca_ledger_invariant_refusal_census()` compares the counter
  with the records. `fn_ca_ledger_invariant_refusal_watch()` runs inside the
  existing `fn_ca_cron_failure_watch` (ca-cron-health-30m, no new schedule). It
  turns every counted number that still has no record one interval later into
  an explicit `unrecorded` row and a critical incident. If the record arrives
  late, it replaces the placeholder.

The caller-side alternative was rejected: it cannot cover a client RPC, it
needs four implementations, and each one fails silently in a new way.

## Where a refusal shows up, and who reads it

- `public.ca_ledger_invariant_refusals`: one row per refusal. Each row holds the
  kind, account, store, balance delta, ledger net, the moved list (suspense) and
  the function (PostgREST `request.path`, else the statement), plus the role,
  application, JWT role and subject, txid, backend pid, first writer and
  message.
- `ca_drift_incidents`: a CRITICAL incident through `fn_ca_raise_drift_incident`.
  Its source is `ledger_invariant.refused`, its classification
  ledger_imbalance, its layer ledger. It is registered in `ca_detector_registry`
  (owner chip standard, 4h SLA). The dedupe key is
  `ledger-invariant-refused:<kind>:<function>:<account>`, so a loop folds into
  one open incident whose occurrences climb, while every refusal keeps its own
  row.
- `fn_ca_ledger_invariant_refusal_census()`: counted, recorded, unrecorded,
  unraised.

## Proof

- `scripts/dev/test-ledger-invariant.sh` now listens on 127.0.0.1 and asks the
  recorder login for scram. It applies the migration after every earlier proof
  and runs `tests/fixtures/ledger-invariant/refusal-regression.sql`:
  - F1: a real top-level transaction is refused at COMMIT and rolled back. The
    stack is unchanged, and the row, counter 1 and a critical incident exist
    afterwards.
  - F2: a repeat refusal folds into one incident with 2 occurrences.
  - F3: the caller still sees `23514` and the identical message.
  - F4: a suspense refusal is recorded together with what it moved.
  - F5: the recorder's login is refused. The refusal is unchanged, the counter
    still counts it, and the watch files an explicit unrecorded row and a
    critical incident.
  - F6: a late record replaces the placeholder.
  - F7: the recorder login reaches nothing but its two doors.
- `tests/a-ledger-refusal-is-recorded-outside-its-rollback.law.test.ts` pins
  the latest bodies. Each REFUSED raise is recorded first. The recorder counts
  before it connects, uses Vault, never raises and never uses
  `dblink_connect_u`. No migration carries the password. The reader is wired
  in. Two negative proofs go red.

## Engine behaviour on a refused hand commit (read, not changed here)

A 23514 from `fn_ca_commit_hand_settlement` / `fn_ca_commit_hand_submission` is
not recognised by the engine today. `logHandHistory` treats it as ambiguous
transport and replays it 13 times over about 41 s, then terminates the
generation (`authoritative_hand_unreachable`, one deduped critical
financial_alert per table and hand). The successor's
`fn_ca_resume_hand_submission` replays the retained submission, gets the same
refusal, and is rebuilt about every 5 s, because `REFUSED:` is not one of
`RETAINED_HAND_STANDING_REFUSALS`. The rollback leaves the database at the
pre-hand stacks. That is a stall, and it is fixed in a separate engine change.
