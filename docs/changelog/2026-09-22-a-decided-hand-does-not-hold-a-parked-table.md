# A Decided Hand Does Not Hold A Parked Table

Date: 2026-09-22. One migration
(`supabase/migrations/20260922152219_a_decided_hand_does_not_hold_a_parked_table.sql`),
its native PostgreSQL qualification (`scripts/ci/probes/f06-movement-admission.sql`,
`scripts/ci/test-f06-movement-admission.py`,
`tests/operations/f06-movement-results.test.py`). No engine change, no workflow
change, no row written, no chip moved.

## What was wrong

Multi-table tournaments stopped dealing at individual tables while the event
stayed RUNNING, and the players at those tables were never moved.

A tournament table break (F06) parks a source table: the park excludes it from
dealing (`fn_f06_hand_number_state` answers `source_excluded`) until its
players are moved. Moving them needs a movement proof
(`fn_f06_admit_parked_movement` -> `f06_movement_prior` ->
`f06_movement_permits`, and the same reader inside
`fn_f06_assert_drained_manager_custody`). That reader asks whether every hand
permit the table ever held is resolved, and it only knew one resolution:
`accepted` with its sealed atomic commit.

`smarter_private.f06_hand_permits` admits four states, and two of them are
decided outcomes the protocol's own doors write: `never_started`
(`fn_f06_cancel_prepared_hand`, `fn_f06_finish_hand('never_started')`, the
abandoned-generation door when no card was dealt) and `aborted_unsettled`
(every abort door, always with the receipt row the immutability trigger
demands). A decided permit is immutable (`F06_HAND_IDENTITY_IMMUTABLE`) and
fenced from dispatch and history (`F06_HAND_PERMIT_FENCED`,
`f06_aborted_hand_guard`), so nothing of that hand can ever reach a stack. The
drained-custody assert already accepts both as terminal evidence; the
movement reader did not.

So a table that had ever held one decided non-accepted permit could never
have its players moved. The first time the balancer parked it, it stopped
dealing for good, and the engine retried the refused admission every ~15 s
for ever (`f06_movement_admission_unproven`).

Measured on production 2026-09-22 (read-only):

| Measure                                                                               | Value                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Permits `aborted_unsettled` / `never_started`                                         | 525 on 498 tables / 298 on 292 tables                                                                   |
| Open parks on RUNNING events whose source holds a decided non-accepted permit         | 85 `park_requested` (25 events) and 5 `begun` (5 events), oldest 2026-09-18 05:17 UTC, newest 14:51 UTC |
| Engine log `f06_movement_admission_unproven`                                          | about 5,600 an hour since 13:23 UTC                                                                     |
| Postgres log `F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY` inside the drained-custody assert | 3,397 between 13:50 and 14:50 UTC                                                                       |

The 13:23 UTC abandoned-generation run turned many `reserved` permits into
`aborted_unsettled`/`never_started`, which is why the count jumped then: those
tables went from "blocked by an undecided hand" to "blocked by a decided hand
the movement reader did not recognise".

## What changed

`smarter_private.f06_movement_permits` (same signature, owner, ACL, SECURITY
DEFINER and search_path) now treats a permit as resolved when it is decided:

- `accepted`: exactly as before (same tournament, current lifecycle, at or
  below the boundary, exact sealed commit);
- `never_started` / `aborted_unsettled`: same tournament, current lifecycle,
  a non-null evidence id, and still visibly nothing of that hand on the table
  (no atomic commit, no `hand_history`, no private hand state at its
  `(table_id, hand_number)`). It may be above the boundary: it is the hand
  that never happened.

`reserved` and any dispatched permit still refuse. The returned permit list is
unchanged, so stored movement proofs still compare equal. Every roster, stack,
seal, elimination and custody check is untouched. The installer refuses unless
the replaced function is byte-for-byte the reasoned-about definition
(`2ddcf96913de8e87b858c1c207f57ed0`) and the state check, immutability trigger
and dispatch fence are the installed ones. A `@live-proof` line lets
`check-migrations-are-live.mjs` prove the installed body.

## Verification

Native PostgreSQL 17 qualification (`scripts/ci/test-f06-movement-admission.py`,
the existing required "Parked tables retain canonical movement custody" step),
run locally on the exact candidate:

- before the fix (migration not installed): the probe stops at its new first
  scenario with `F06_MOVEMENT_UNRESOLVED_HAND_CUSTODY`;
- after: passed, 139 assertions (73 before), both isolation races, six
  installer drift refusals including the new owner-drift refusal.

New assertions: a `never_started` and an `aborted_unsettled` hand above the
boundary each admit movement; a decided state without its receipt, a decided
hand that left private state, a dispatched decided hand and an undecided hand
above the boundary each still refuse; and the whole public flow (admission,
begin, both moves, close, ACK, exactly 200 chips on two players, financial
ledgers unchanged) runs with each decided state on the source table.
`scripts/ci/test-f06-drained-custody.py` still passes unchanged.

## Not in this change

The other stall causes found in the same investigation are separate work:
a successor generation still refuses a dead generation's `reserved` permit
until the abandoned-generation door is run; a manager that lost its lease
cannot finish stopping while it retains a break source; and the 13:53 UTC
lease expiry came from the database connection pool running out.
