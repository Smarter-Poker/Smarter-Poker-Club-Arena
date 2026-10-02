# A cash batch yields the commission key to a finish (2026-10-02)

## Symptom

`fn_ca_tournament_finished_but_not_completed(15)` raised a critical for Spins and
Sit & Gos left with one player for more than 15 minutes: 7,113 alerts between
2026-09-30 19:25 and 2026-10-02 19:10 UTC, and incident
f43669d8-78b3-435a-a0d0-385cbc15f0d1 (tournament bef0d2b8, last bust 18:54:46,
still RUNNING at 19:16) kept `fn_ca_midway_burnin_gate` red. Every flagged event
was eventually paid, but waits ran 20-70 minutes, not just across the hourly
maintenance freeze: 170 events decided between 18:30 and 18:42 were still unpaid
at the 18:53 freeze while the platform was live.

## Cause (read from rows and locks)

- A finish holds its bank scope's lane (`fn_ca_lock_settlement_lane_for_finish`:
  one finish at a time per union or club bank). The two busy unions finished one
  event every 8-10 s (18:40-18:52) against about 5 decided a minute, so each lane
  ran near full; the freeze left a backlog the lane could not drain before the
  next hour.
- In 5 of 6 lock snapshots (19:25-19:35, engine ac2024b8) the finish holding a
  union's lane was waiting on `agent-commission:<club>`, held by
  `fn_credit_agent_commissions_batch` (the cash rakeback settler: 31 items per
  call, mean 5.3 s, one transaction that keeps every key to commit). The settler
  sized its batch only against the client's 15 s timeout.
- #5848's extra decided slots (deployed 19:15) do not help: the engine slots fill
  with finishes queued on the same lane (decided queue 391 at 19:25).
- `docs/evidence/chip-deadlocks-2026-10-01.md` had already measured 1,170 finish
  waits over 1 s at the commission step and named a shorter cash batch as the cure.

## Fix

`server/src/services/cashAccountingBatchBudget.ts`: `cashAccountingBatchSize`
takes a second budget, `COMMISSION_KEY_HOLD_MS` (1,500 ms), and the tighter of
the two binds. The credit batch and the durable-refusal retry go from 31 items to
5 (about 1-1.5 s per transaction), so a finish waits at most one short batch for
the key. At 4,800 cash raked hands an hour the settler still clears more than
three items a second.

Not done, on evidence: finishing decided events before the maintenance freeze
(the lane, not the freeze, sets the drain rate), and discounting frozen time in
the detector (winners were genuinely unpaid for 20-70 minutes).

## Tests

`server/src/services/cashAccountingBatchBudget.test.ts` pins the hold budget; `rakebackWatermark.test.ts` and
`tests/a-cash-batch-is-derived-not-written-down.law.test.ts` pass unchanged.
