# Entry close takes the tournament lane before its row (2026-10-24)

## What was wrong

`financial_alerts` held 14 `tournament.real_time_payout_refused` rows in
three days (9 still open). Every one said
`{"error":"deadlock detected","sqlstate":"40P01"}`, so a finisher in the money
was not paid when they should have been.

The deadlock never came from a bust. For all 14 alerts, the alert's
`created_at` (when its transaction started) falls 0.04 to 3.4 s before the
same event's `tournament_entry_close_receipts.entry_closed_at`, and that
receipt is written inside the same transaction. The close modes were
`levels`, `minutes`, `immediate` and `addon`. So every refusal came from the
transaction that closed the event's entry and finalized its prize pool.

The postgres log for 2026-10-24 22:31:42 UTC (Afternoon Free Buy, add-on
close) shows the cycle:

| process                                                  | holds                                                                                   | waits for                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 474478, the COMMIT of `fn_close_tournament_addon_period` | the `tournaments` row (tuple 168782,2), locked FOR UPDATE by the door's first statement | T(id) EXCLUSIVE. The deferred `zzz_pay_finishers_when_pool_finalizes` trigger runs `trg_ca_pay_tournament_finishers_at_commit`, which calls `fn_ca_pay_tournament_finishers_now`, which calls `fn_ca_lock_settlement_lane_for_tournament` |
| 474522, `process_tournament_rebuy` (an add-on)           | T(id), taken at its line 71 through the same helper                                     | that `tournaments` row, `FOR UPDATE` at its line 205                                                                                                                                                                                      |

The log shows the same cycle at 02:31, 06:04, 06:32, 18:31, 18:40, 19:34,
20:20 and 23:34 UTC, with other partners in the rebuy's place:
`fn_ca_retain_hand_submission` (`FOR SHARE`), `f06_prefix` through
`fn_f06_discover_breaks`, and `fn_ca_lock_tournament_seat_acquisition`. Hand
calls that queued shared behind the exclusive waiter (`fn_f06_hand_number_state`,
`fn_f06_begin_hand`, `fn_project_hand_side_effects`) were sometimes the ones
the detector killed.

## The root cause

The lane's order is G, then T(id), then rows. Every other writer of an event
follows it: `process_tournament_rebuy`, `fn_eliminate_tournament_player_atomic`,
the payer itself, `f06_prefix` and the F06 table lane. The two entry-close
doors were the exception. Each opened with `SELECT * FROM tournaments ... FOR
UPDATE` and took no lane. Finalizing the pool then made the payer ask for the
lane at COMMIT while the row was still held: row first, then lane.
20261022091134 had already shown that a retry cannot break this cycle.

## The fix

Migration `20261025030526_entry_close_takes_the_tournament_lane_before_its_row`
makes `fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)` the first
statement of both doors, before the row lock. It does this with one anchored
edit per door. Each edit is guarded by the production pre-image md5 and
followed by an assertion of the post-image md5, owner, ACL, SECURITY DEFINER
and search_path. A NULL id takes no lane.

At COMMIT the transaction already holds G shared and T(id) exclusive, so the
payer's lane request succeeds at once and the payer locks a row this
transaction already holds. Every partner in the log also takes T(id) before
the row. The closer and any partner therefore meet at T(id) first, and one of
them simply waits for the other to finish. A cycle cannot form.

The transaction does not ask for the lane any more often than before: it
always asked at COMMIT whenever the pool finalized. Now it asks earlier,
before it holds anything.

The doctrine still holds. A read-only walk on production (fn_ca_settlement_lane_doctrine
rule 4's own regexes) from both doors finds no global-lane caller within four
calls. The doors add no G-exclusive or F key.

## What was not touched

These are unchanged:

- `fn_finalize_tournament_entry_pool_locked`. It is pinned by the MTT
  admission contract guard and is reached only through these doors.
- `fn_apply_prize_guarantee`, and the terminal settlements that call it under
  their own finish lane or global lane.
- The payer and its trigger, the lane helpers, and the doctrine.

This adds no retry, sweep or cron.

## Payouts

The payer's idempotent obligation doors and its exactly-once place keys are
unchanged. When a close deadlocked, the close itself still committed, because
the refusal was caught in a subtransaction. All 14 events are COMPLETED, and
their terminal settlements pay every unpaid place through the same keys.
Nothing is owed by this change. Once this is live, the 9 open alerts can be
resolved with this changelog as the resolution note. They need no money
movement.

## Proof

`scripts/ci/test-entry-close-takes-the-lane-before-its-row.py` runs on a
throwaway PostgreSQL cluster, with the workflow
`.github/workflows/entry-close-takes-the-lane-before-its-row.yml`. It loads
the exact production definitions of both doors, the lane helper and the
deferred trigger; each fixture's md5 equals the production
`pg_get_functiondef` md5. It then tests each door against an add-on partner
and a hand partner.

Before the migration, all 4 cases deadlock: the partner waits on the row, the
payer gets a 40P01, the alert is written and the payer does not complete.
After the unmodified migration file, all 4 are clean: the partner waits on
the advisory lane, there is no alert, the payer completes and both
transactions commit. The run makes 45 checks and all 45 pass, on PG16
locally.

The law is
`tests/entry-close-takes-the-tournament-lane-before-its-row.law.test.ts`.
