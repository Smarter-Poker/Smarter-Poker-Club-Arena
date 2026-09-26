# A last table that never dealt continues from its entries

2026-09-26. Migration `20260926132457`. Law
`tests/a-last-table-that-never-dealt-continues-from-its-entries.law.test.ts`.
Qualified in the native shared-hand lane
(`scripts/ci/probes/f06-shared-hand-lane/first_hand_continuation_qualification.py`).

## What was frozen

- `e9c07fe8` "3 Chip Deep Stack Spin PLO4" (spin-v1), table `ea6124e9`: three
  players at 1,000 (the starting chips), nothing dealt since 2026-09-18 05:52.
  Park `f03313e2` is `park_requested`, custody generation = origin generation,
  and the table's only hand permit is `never_started`. The engine re-resumes the
  event about every 15 seconds and is refused every time
  (`F06_CONTINUATION_PRIOR_COMMIT_REQUIRED`, 120 refusals in 5 minutes at 13:25Z).
- `114c6069` "PLO4 Heads-Up 10" (sng-v1), table `f44931c2`: two players at 1,000,
  nothing dealt since 2026-09-23 00:11; park `eae81526`, same shape.

## Why

`fn_f06_continue_no_start_last_table` withdraws a positively never-started park
on an event's last table so the table can deal again. It proved every chair
against the table's last committed hand, and a table whose park landed before its
first hand has no committed hand, so it refused for ever.

## Change

When the table has no committed hand at all, the boundary is its entries.
`smarter_private.f06_no_start_first_hand_stacks` requires that the table never
dealt (no commit, history, private state, hole cards or snapshot of any number,
and no other permit) and that every chair holds exactly the event's starting chips
on a playing registration with no rebuy, add-on or elimination, with every entrant
seated and no purchase receipt beyond entry. Anything else refuses. The
prior-commit branch is byte-identical. No chip, seat, wallet or ledger row is
written; the continuation still only withdraws the park and records its receipt.
