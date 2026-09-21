# A hand that ended preflop has no board to record

**2026-09-21.** `ledger_reconcile_log:board_not_recorded` had filed 61 findings
since the stream opened on 2026-09-19, reached the board's 25-incident storm
cap, and every single one of them was a false positive. The cause was one
disjunct in `fn_rake_law_violations`, and the fix is migration
`20260921023500_a_hand_that_ended_preflop_has_no_board_to_record`.

## What the finding means

`board_not_recorded` is a rake-law finding, not a money finding. It says: this
cash hand has no community cards recorded, but the record shows play that
implies a flop, so the board is MISSING and the amount the spec allows cannot
be computed. It deliberately returns `NULL` for the allowed rake - that is the
law in `20260919153843`, an amount that cannot be computed is not a number.
Because `allowed` is NULL, these hands are also excluded from `over_spec` and
`under_spec` checking, so a hand it flags is a hand whose rake goes unverified.

## The defect

The test was:

```sql
board_n = 0 AND (has_showdown OR agg >= 4)
```

`agg` counts every `call`, `raise`, `bet` and `allin` in the hand. The second
disjunct is a PROXY for "a flop must have been dealt" and it is not one. A limp,
a raise, two calls and a three-bet is an ordinary multiway preflop pot, and it
clears four aggressive actions without a single card on the table.

Worked example, hand `b11a63bc-f322-489e-bafe-77bbc4dbbaeb`: five aggressive
actions, every one of them carrying `"stage": "preflop"`, `"boards": [""]` in
every captured node, the last live player folding to a raise, the uncalled 31
returned, pot 50.00, `rake_amount` **0.00**. No flop was ever dealt, so there
was no board to record and no rake was owed. The check called that an
incomplete record.

## Measured

Across **all 61 hands** this finding has ever produced:

|                                          |       |
| ---------------------------------------- | ----- |
| took rake                                | **0** |
| took a BBJ drop                          | **0** |
| reached a showdown                       | **0** |
| had any action on a street after preflop | **0** |

A 100% false-positive rate over the whole life of the check. No money was ever
involved, and no rake ever went unverified because of it.

## Why it was worth fixing rather than closing

The board caps a source at 25 open incidents and diverts the rest into one
DETECTOR STORM row. This source reached that cap: 15 individual rows plus a
storm row that had swallowed 28 more findings. A genuine over-rake filed by
this same source would have landed in that storm row and been read as more of
the same. **A false positive that reaches the storm cap is not noise, it is a
place for a real finding to hide.**

## The fix

Every action the engine writes already carries the street it happened on -
`stage` on the action and `street` on its captured `publicNode`. The check had
the fact it needed in the record it was already reading, and consulted a
head-count instead. So the proxy is replaced by the record:

- `played_past_preflop` - some action names `flop`, `turn` or `river`;
- `streets_unreadable` - the hand HAS actions and not one of them names a stage.

```sql
board_n = 0 AND (has_showdown OR played_past_preflop OR streets_unreadable)
```

`streets_unreadable` is the third outcome law 10.86 rule 1 demands. A record
whose streets cannot be read is not quietly passed as "ended preflop"; it is
reported as the evidence gap this finding is named for. Absence of a stage is
not absence of a flop.

Both genuine detections survive: a showdown on an empty board is still a
finding, and play past preflop with no board is still a finding - now read off
the record instead of guessed at.

`agg` is deleted rather than left unused. It was a jsonb scan of every action
of every cash hand in the window and this was its only reader.

## Not vacuous, and proved before it committed

A finding that can never fire is a deleted finding, not a fixed one (10.84: an
empty alert group reads as coverage). Over the 26,243 cash hands dealt in the
six hours to 02:30Z:

- **9,662** hands read as played past preflop, every one with a board of three
  cards or more - the mechanism works;
- **14** hands carry a board with no post-flop action - preflop all-ins that
  ran out, which is correct and is why `has_showdown` stays its own disjunct;
- the old rule flagged **4**; the new rule flags **0**.

The migration asserts two things inside its own transaction before committing:
that every hand already filed stops flagging _because it ended preflop_ rather
than because the rule went blind, and that a flop is still detectable at all.

## Verified

- `fn_rake_law_violations('6 hours')` returns **0** findings of every kind,
  where the old rule returned 4.
- The **02:40Z** scheduled `rake-law-adherence-hourly` run then completed and
  wrote **0** new `rake_law` rows. Before the fix that job was producing one to
  three `board_not_recorded` rows every hour.

All 16 incidents resolved with `closure_basis='verified_remeasured'`. One of
them, `27d3b066`, had been retired honestly by the escalation tick's silence
rule at 02:40:00Z as `aged_out_unverified` two minutes before; it was restated
forward with the measured cause rather than left implying nobody knew why it
stopped.
