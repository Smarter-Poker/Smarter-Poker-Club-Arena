# Round 3 reads its scope's week of sources once (2026-10-03)

## What happened

The auto_explain log of the Midway close of 2026-10-01 (22:43-23:51Z, job 391) shows round 3
(`fn_settle_accounting_rakeback_stage`) took 1,379 s of the 68-minute transaction:

- 887 s locking the week's periods. A period of a club outside the scope (382 Deep Stack Society
  periods) is admitted when the scope earned from its player in the week; that EXISTS walked the
  club's whole week of sources once per period (one probe measured 19.8 s cold).
- 240 s in the missing-period check, which read the scope's whole week of sources again right after
  the set path had read the same rows.

The week closing 2026-10-05 carries ~2.3x those sources, so this stage alone would approach an
hour.

## Fix

Migration `20261003081100_round_3_reads_its_scope_week_of_sources_once` (three exact anchors on the
2026-10-03 preimage):

- The periods statement reads, in the same statement, the clubs of such periods and the scope's
  (club, player) pairs of the week for exactly those clubs, and admits an outside period by
  membership in those pairs. A club the pairs do not cover still asks the sources directly. Same
  rows, same order, `FOR UPDATE OF rp` (the only table the original locked).
- The set path's week table also keeps each source's `is_union_house` text; when the set path
  admitted the book, the missing-period check reads those rows with the same cast; otherwise it runs
  the original query. The rows were read under the scope's week lock, which every accrual of the
  week shares.

## Proof

Read-only, week 2026-09-21, the original EXISTS in its textbook IN form against the new statement:
Midway scope 598 periods, identical md5 `f1ce5dd0410a2b4705dbdef3e9dd197c` (new 21.8 s cold); Deep
Stack Society scope 382 periods, identical md5 `ef4eb70f10c670c5f22047b0a984fb9a` (new 6 ms, old
17.5 s).

## What does not change

Which periods are paid, the payer, the amounts, the lock order, every refusal, and the fallback loop.
