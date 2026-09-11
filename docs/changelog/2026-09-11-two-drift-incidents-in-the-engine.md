# Two drift incidents, both in the engine

2026-09-11. Engine only. No migration, nothing under `supabase/` touched.

Two live drift incidents were open against the poker host. They are unrelated
faults that happen to share a shape: in both, the engine discovers a problem
only after something downstream has already destroyed work, and the thing that
reports it names neither the seat nor the cause.

---

## 1. "56 hand commits refused for stack mismatch across 15 tables"

Incident `07ebac1d-d829-401f-8008-d67dc2eb833b`, raised by
`fn_ca_hand_commit_refusals`, 14 occurrences.

### What the 56 actually were

The sweep buckets any refusal whose error text contains `stack` as
"stack mismatch". Read out of `financial_alerts` for the incident's own window,
all 56 (across 15 tables, 00:00:13 to 01:37:37 UTC) carried one sentence:

    atomic hand commit refused (rolled_back):
    tournament <id> hand <n> did not durably sync every final seat stack

Every one on a tournament table. Nothing since 01:37.

### Why that sentence means "fractional chip"

The two places a tournament stack is stored do not have the same shape, and
this was confirmed against the live schema:

| column                     | type            |
| -------------------------- | --------------- |
| `table_seats.stack`        | `numeric(15,2)` |
| `tournament_players.chips` | `integer`       |

`fn_ca_settle_hand_stacks_absolute` writes both from one target and then
asserts they agree
(`supabase/migrations/20260910054712_a_hand_settles_each_seat_once.sql:649`).
A fractional target cannot satisfy that: the integer column rounds it on
assignment, `1234.50` is stored as `1235`, the two mirrors disagree, and the
whole hand is rolled back. `ServerTableEngineSettlement` then calls
`killForRestart('authoritative_hand_semantic_refusal')`, so the engine
generation goes with the hand.

Three days earlier the SAME defect was refused under a different sentence -
`accepted tournament hand produced fractional stack 691173.50 for ...`, 500
alerts on 2026-09-08/09 - by the explicit guard that the 2026-09-10 rewrite
replaced. Same root cause, two messages, one incident.

### The inlet, and who closed it

`escalatedBlindLevel` invents a blind level as `ratio^k`, which is fractional
at every ratio but 2. At the observed 1.278 cadence 200/400 became
255.58/511.15, and the pots dealt from it were fractional. Closed at source by
**PR #4244** (`b93be238e4`, 06:12 UTC today) - already on `main`, already in
this branch's base. It is not re-fixed here.

The persisted ladders were checked and are clean: 0 fractional levels across
742,320 levels in 60,906 tournaments created in the last seven days, and 0
fractional live tournament seat stacks in 960 live seats. The Spin overflow
generators (`spinBlindsForLevel`, `continueBookedSpinBlinds`) round to whole
chips, and `capLevelToChipsInPlay` floors. No second live inlet was found.

### What this change adds

The invariant itself, stated where the payload is built:
`server/src/engine/tournamentWholeChips.ts`, called from `postHandTasks`
beside the existing tournament conservation gate, before the authoritative
commit. A fractional tournament stack now raises
`Tournament.fractional_seat_stack` naming every offending seat, which field
carried the fraction, and the value.

**It reports, it does not repair, and that is deliberate.** A tournament hand
is held to exact conservation; rounding a seat here mints or destroys the
fraction and buys a conservation refusal instead of this one. A fraction
cannot be fixed at settlement - it must not be created - so the only useful
thing the engine can do at this boundary is name it. The pin in
`tournamentWholeChips.test.ts` fails if anyone adds a `Math.round` to the gate.

Honest limit: this does not save a hand. It replaces a generic database
sentence, arriving after the hand is gone, with the seat and the number.

---

## 2. "Post-hand step leave_pending threw; later steps continued"

Incident `bf4ef6e0-14f7-4e6f-b90c-f2bfeab4f943`, 6 occurrences, from
`financial_alerts:postHandTasks.leave_pending_failed`.

    [postHandTasks.step_failed.leave_pending] Error: supabase_timeout
    table 0a936714-38a3-4bf4-b8db-0acdf8025acf, hand 9459694

### Why it timed out

Not a missing index, not a long transaction, not an unbounded query. The only
statement `processLeavePending` can reject on is its enumerate SELECT - a
per-seat cash-out failure is swallowed by `atomicCashout`'s own `onFailed` and
the loop continues - and in `pg_stat_statements` that SELECT measures **0.0 ms
mean, 162.8 ms max, over 749,233 calls**.

`supabase_timeout` is the flat 15-second per-attempt deadline in
`server/src/services/supabase/client.ts:103`. Fifteen seconds is a round trip
that never got a connection on a saturated database. The client deliberately
retries only pre-execution 503s (PGRST001/2/3), because replaying an executed
write is a money hazard - so a timeout was terminal there, and nothing above
it retried either.

### What was actually lost

The whole boundary, for one blink. `runStep` reported, alerted, and moved on,
so the sweep did not run, and neither did the announced seat moves that follow
it in the same step.

### The two changes

1. **A bounded retry with backoff, opt-in per step.** `STEP_RETRY` sits beside
   `STEP_LANE`; `leave_pending` gets two extra attempts at 250 ms and 1 s. A
   retry is taken only when `ServerTableEngineBase.isTransientDbError` says the
   database blinked and this generation still owns the table - every refusal
   the database meant falls straight through to the report, unchanged. The
   alert now carries `attempts` and `retry_budget`.

   Opt-in is the whole design. `leave_pending` qualifies because it is
   idempotent by construction, not by inspection: its first act is to re-read
   which seats still carry `leave_pending = true`, and a seat that already left
   is no longer in the answer. No other step opts in.

2. **A departure already cashed out is never lost.** `processLeavePending`
   gains an `onDeparted` reporter, called the moment each seat's own
   transaction commits. The engine records those in
   `departedSeatsAwaitingTeardown` and drains them in `tearDownDepartedSeats()`
   at the top of the next attempt. Before this, the engine-side teardown (the
   disconnect FSM, time bank, straddle, pre-action, stay clock and continuity
   entry) was reachable only through the sweep's RETURN value, and this
   boundary drops that value in two live cases: the sibling seat-move read
   rejecting after the sweep resolved, and lifecycle authority lost between the
   read and the teardown. Either way the next sweep cannot repeat the news,
   because those seats are no longer `leave_pending = true` - so the teardown
   was lost for good, which is exactly the ghost state in
   `hand_state_snapshots.disconnect_states` that Round 57 and Round 64 exist to
   prevent.

### The pin that moved

`CashDepartureReadOverlap.test.ts` asserted the sweep's exact argument list.
It now asserts the wider one AND that the fourth argument really records a
departure - stricter, not relaxed, moved in the same commit (CLAUDE.md 5.8).

---

## Verification

- `npx tsc --noEmit` (server): exit 0.
- Full server suite: **681 files, 9350 passed, 145 skipped, exit 0**.
- New tests, run against the branch base with only the test files applied:
  **5 of them fail**, which is the point - 3 retry/teardown assertions and 2
  wiring assertions. All 15 pass on this branch.

Not proven here: neither fix has been observed on a live break or a live
tournament hand. Merging and publishing are not this session's to confirm.
