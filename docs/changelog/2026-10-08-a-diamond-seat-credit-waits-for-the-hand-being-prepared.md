# A Diamond Seat Credit Waits For The Hand Being Prepared

Date: 2026-10-08. Lane: Production Alerts fleet (PRIMARY-CHAT).

## What Happened

On 2026-10-07 three Diamond cash hands (04:35, 08:44 and 15:24 UTC) were
refused by `fn_poker_diamond_settle_cash_hand` with `diamond_hand_stale_seat`.
Each refusal raised `ServerTableEngine.authoritative_hand_semantic_refusal` and
`postHandTasks.hand_history_failed`, the engine generation for the table was
terminated, and the table stopped dealing until its seats were released.

Read from production: every refused hand had exactly one horse top-up through
`fn_poker_diamond_top_up` committed 2 to 4 seconds after the previous hand's
receipt in `poker_diamond_hand_receipts` (amounts 289, 103 and 1991, each with
`expected_stack` equal to the stack the refused hand later reported as its
opening stack). No seat joined or left in those windows.

## Root Cause

`addChips` reads `handController === null` as "between hands". `dealHand()`
snapshots every stack under the seat boundary and only then sets
`handController`. The chip lane has taken that boundary before deciding seat
versus queue since 2026-09-28, but the Diamond branch returned above it, so a
direct Diamond top-up that arrived while the next hand was being prepared
raised `table_seats.stack` under a roster that still held the old stack. The
settler then compared the seat row with the hand's `stack_before`, found them
different, and refused the whole hand.

Horse Diamond reloads began with #6309 (2026-10-06), which is why the class
appeared on 2026-10-07.

## Fix

- A between-hands Diamond top-up takes the seat boundary and decides only once
  it owns it: either it lands before the roster is snapshotted, so the dealt
  stack includes it, or the hand has started and it becomes an intent that
  lands after settlement.
- The intent sweep that lands queued Diamond top-ups also holds the seat
  boundary. It runs under the dealing loop's step budget, which stops waiting
  without cancelling the RPC, so a landing still in flight could otherwise
  commit after the roster was snapshotted.

## Hardening

1. Regression: `server/src/engine/ADiamondSeatCreditWaitsForTheHandBeingPrepared.test.ts`
   fails on the previous code (the custody RPC fires while preparation holds the
   boundary) and passes with the fix.
2. Invariant: the settler's `diamond_hand_stale_seat` refusal is unchanged and
   remains the database-side proof that a hand's opening stacks are the seat rows.
3. Detection: a recurrence still raises
   `ServerTableEngine.authoritative_hand_semantic_refusal` into
   `financial_alerts`, which the intake mirrors into `operational_alert_events`.
4. CI: the server job in `ci.yml` runs every server test on pull requests that
   touch `server/`.
