# A failed hand-number allocation is one attempt, not a standing error (2026-09-26)

## What production showed

Release 92d59cfb, 2026-09-26 03:45-03:48 UTC. A bust write held a tournament's
settlement lane; one table's pre-allocation of its next hand number
(`fn_f06_allocate_hand_number`) waited behind `fn_ca_lock_settlement_lane_for_tournament`
and came back `canceling statement due to statement timeout`. The Manager's
allocator reported it as `f06_allocation_unproven`, exactly as it should.

What happened next was wrong. The engine wrote that one failure to
`preparedF06AllocationError` in `prepareNextHand` and re-threw it from
`takePreparedHandNumber` on every later deal attempt
(`deal_error_attempt_1`, `_2`, `_3` ... `Error: f06_allocation_unproven`), even
after the lane was free and a fresh allocation would have succeeded. The only
thing that ever cleared it was the Manager's round-robin
`recoverF06OriginalAdmissions`, one table per balance pass, through
`getF06FailedAllocation` / `retryF06FailedAllocation`.

Measured: table 16de0024 dealt nothing for 183 s, until the zombie watchdog
rebuilt it. About 15 tables hit the same stuck error after the restart.

## Why a failed allocation can be forgotten

An allocation claims no hand. Custody begins at `fn_f06_begin_hand`; before it
there is no permit, no reservation and no identity to lose. A lost or refused
allocation reply costs at most a burned number, which the Manager's own
comment on the retry sweep already said ("A failed allocation can burn a
number; no BEGIN identity is discarded").

## What changed

- `prepareNextHand` carries an F06 allocation failure inside that
  preparation's own outcome instead of a standing field.
  `settlePreparedHandNumber` replaces the previous outcome whole, so a newer
  success is never vetoed by an older failure no deal attempt took.
- `takePreparedHandNumber` still fails the deal attempt the failure belongs to
  (no inline second allocation on the F06 path, same log as before) and then
  forgets it. The next pass of the dealing loop allocates fresh.
- `getF06FailedAllocation`, `retryF06FailedAllocation` and the Manager's
  allocation branch of `recoverF06OriginalAdmissions` are removed; nothing else
  used them. The sweep's original-permit branch is unchanged.
- A fresh-projection failure in `reserveF06Hand`
  (`f06_fresh_hand_projection_unproven`) happens before `f06CurrentPermit` is
  set and was already one attempt; it is now pinned by a test.
- Once `fn_f06_begin_hand` has been called, nothing changed: an unknown BEGIN
  keeps the original permit and every later attempt refuses with
  `f06_prior_hand_unresolved` until the permit's own recovery resolves it.

No timers, no repair loop: the retry is the dealing loop's existing next pass.

## Proof

`server/src/engine/AFailedAllocationIsOneAttempt.test.ts` drives the real loop
order (`prepareNextHand`, the rest's settle, `dealHand`) on a real
`ServerTableEngine` with the F06 allocator and admission installed:

- statement timeout, then success: the next attempt deals a fresh 1000002, the
  one after deals 1000003, nothing left over. Before this change it failed with
  `f06_allocation_unproven` on the second attempt.
- a failure that is never dealt (a pause between rest and deal) does not veto
  the next preparation's number. Before this change: `f06_allocation_unproven`.
- fresh-projection failure before any permit: the next attempt deals.
- failure after BEGIN: the original permit is retained, both later attempts
  refuse with `f06_prior_hand_unresolved`, `fn_f06_begin_hand` is called once.
