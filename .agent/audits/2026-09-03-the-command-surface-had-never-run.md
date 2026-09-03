# The Table Management command surface had never run in production

**Date:** 2026-09-03
**Scope:** `fn_execute_managed_game_command`, `fn_schedule_managed_game_close`,
`fn_run_due_managed_game_schedules`, cron job 223
**Outcome:** every path exercised, every path correct, nothing persisted

---

## The finding

```
managed_game_command_receipts   0 rows, ever
managed_game_schedules          0 rows, ever
```

Edit, Close and Schedule have been shipped and reachable on the board, and no
operator has ever completed one. The pg_cron job that executes scheduled closes
(job 223, `* * * * *`, 177/177 successful runs at the time of the audit) has
been scanning an empty table every minute since it was created. Its
`idx_managed_game_schedules_one_pending_close` index shows 1,220 scans and has
never matched a row.

Zero receipts is not itself a defect. It does mean the most consequential code
on this surface - the part that changes live games and the part that runs
unattended - carried no production evidence at all. Green unit tests over a
path that has never executed against real data are a claim, not a fact.

## How it was verified

Every probe below ran against **production**, as the club owner, inside a
transaction that was **rolled back**. Nothing was committed. Confirmed after
the fact: receipts 0, schedules 0, the probed table back at `waiting`, all 226
live tables intact.

This is the only honest way to test this particular thing. A staging copy would
not have production's contract versions, its seat rows, or its 79,142 games,
and those are exactly what the guards read.

## What each path did

### The command executor

| probe                                                        | result                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `update` at the correct contract version                     | `ok: true`, `command_status: succeeded`, one receipt written                                                                           |
| `update` at a valid but wrong version (1 -> 8)               | `ok: false`, `reason: stale_contract_version`, `command_status: rejected`, receipt records `current_version` so the client can recover |
| the **same `command_id`** resent, as the client's retry does | `ok: true`, **`replayed: true`**, returns the first receipt. Not executed twice                                                        |
| `expected_version: 0`                                        | `ok: false`, `invalid_request`, **no receipt**                                                                                         |
| unknown action `demolish`                                    | `ok: false`, `invalid_request`, **no receipt**                                                                                         |

Three calls against one game produced exactly **one** receipt. The distinction
the schema draws is right: a rejection is a command outcome and is recorded; a
malformed request was never a command and is not.

A first attempt at the conflict probe used `expected_version - 1`, which was 0,
and returned `invalid_request`. That would have been read as "conflicts are
reported as bad input" - wrong, and the confounder was the probe, not the
function. Re-run with a valid-but-wrong version, the real answer appeared. Worth
recording because the next person will reach for `version - 1` too.

`stale_contract_version` maps in `MANAGEMENT_ERRORS` to "This game changed after
you opened it. Your command was not applied." Every reason the executor can
return has an entry; none fall through to the underscore-stripping fallback.

### The scheduled close, end to end

| probe                                      | result                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| operator schedules a close two minutes out | `ok: true`, row `scheduled`                                       |
| operator schedules one ten seconds out     | `ok: false`, `invalid_schedule` - the two-minute floor holds      |
| cron runs, nothing due                     | `processed: 0`                                                    |
| cron runs, one due                         | **`processed: 1`**                                                |
| cron runs again                            | **`processed: 0`** - it does not re-run a finished schedule       |
| the schedule row afterwards                | `succeeded`, `completed_at` set, carrying the full command result |
| receipts afterwards                        | one, `close` / `succeeded`                                        |
| the table afterwards                       | `status: closed`                                                  |

The executor refuses any caller with a JWT that is not `service_role`, which is
why it can only be driven the way cron drives it - with no JWT at all. It takes
`pg_try_advisory_xact_lock` and reports `overlap_skipped` rather than running
twice, and selects `FOR UPDATE SKIP LOCKED`, so two workers cannot collide.

To make a schedule due inside a transaction, both `created_at` and `execute_at`
were moved back together - `CHECK (execute_at > created_at)` correctly refuses
the lazier version of that edit.

## What this does and does not establish

Established: the executor's optimistic concurrency, its idempotent replay, its
input validation, the two-minute schedule floor, and the cron executor
performing a real close and declining to repeat it.

Not established: anything about the **browser** path. These probes call the
same RPCs the client calls, with the same arguments, but the client's retry
loop, its `reconcileCommand` fallback and its toast handling were not driven by
a real browser. The RPC contract they depend on is now known-good, which is the
half that was unverifiable from a test suite.

Also not established: behaviour under a genuine concurrent writer. Two sessions
racing the same contract version would exercise the row lock rather than the
version check.

## Recommendation

Run one real close on a game that does not matter, from the board, and let the
receipt persist. Every mechanism behind that button now has evidence; the
button itself still does not.
