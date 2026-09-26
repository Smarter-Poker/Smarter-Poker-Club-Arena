# A dead generation's hand that never reached a commit is a misdeal

2026-09-26. Migration `20260926075505`. Law
`tests/a-dead-generation-hand-that-never-reached-a-commit-is-a-misdeal.law.test.ts`.

## What was frozen

The abandoned-generation door (`fn_f06_abort_abandoned_generation`) voids the
hand a dead lease generation left reserved so an adopting successor can take
the table. The engine's table admission asks it again every ten minutes. Eleven
legacy events kept getting the same refusal on every ask, and their tables
have not dealt since 2026-09-18 or 2026-09-22.

| shape                                                                                 | events                                                                                                                                                                             | players                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT`                                                | b5a48510 $100 Freeroll 6:00 PM, 3203a371 100 Chip Spin NLH, 140ecf5f 20 Chip Deep Stack Spin PLO4, 887802a7 5 Chip Spin PLO4, fc2898f1 50 Chip Spin PLO5, 23ef2d58 NLH Heads-Up 25 | 14 horses (2, 2, 2, 3, 3, 2) |
| `F06_ABORT_COMMITTED_OR_DISPATCHED` (a dispatch row, no commit, platform disposed it) | 0147ba18 50 Chip Deep Stack Spin PLO5, 64609b68 100 Chip Deep Stack Spin NLH, 9470a333 PLO4 Heads-Up 10, 991c7324 20 Chip Deep Stack Spin PLO6                                     | 9 horses (2, 3, 2, 2)        |
| `F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION`                                        | 8ec7e81d $100 Freeroll 6:00 PM (5 tables)                                                                                                                                          | held, see below              |

## What the rows say, per table

The ten misdeal tables all show the same things:

- There is no `hand_atomic_commits`, `hand_history` or `hand_private_state` row
  at or after the permit's hand number.
- No other table keyed by `(table_id, hand_number)` has a row for the hand, in
  `public` or `smarter_private`: no discard, no BBJ contribution, no knockout,
  no financial fact and no submission.
- Every hole card was dealt to a live chair at that table.
- Every live chair holds exactly the same player's end stack from the table's
  last committed hand. The table totals agree, in the same order as the event
  list above:
  - misdeal (cards) tables: 90,000, 900, 3,000, 900, 900 and 2,000;
  - dispatch tables: 3,000, 3,000, 2,000 and 3,000.

**Cards without a snapshot.** The hole cards were written at 13:53:28 and
15:12:00 on 2026-09-22, 9 to 41 seconds after each table's last committed
hand. The engine writes the hand-start snapshot straight after the deal, and
that write never landed, so the process died inside that window.

**Dispatched without a commit.** `fn_ca_commit_hand_settlement` writes the
dispatch row, then returns (it does not raise) its core's refusal, so the
dispatch commits but the hand does not. The platform also recorded each of
these four hands as `disposed` with no submission. That is its own verdict
that the hand was not accepted.

## The ruling: misdeal

The hand is void, and every player keeps exactly the chips in their chair.
Those chips are what the last completed hand left them, and nothing from the
unfinished hand was ever taken. A void is the standard rule for a hand the
house could not complete. Here the rows prove it takes nothing from anybody,
and for the dispatched hands the platform had already ruled it.

**Paragraph.** The ten misdeal events hold 23 players, all horses:

- b5a48510: 2 players, 90,000 chips between them;
- 3203a371: 2 players, 900;
- 140ecf5f: 2 players, 3,000;
- 887802a7: 3 players, 900;
- fc2898f1: 3 players, 900;
- 23ef2d58: 2 players, 2,000;
- 0147ba18: 2 players, 3,000;
- 64609b68: 3 players, 3,000;
- 9470a333: 2 players, 2,000;
- 991c7324: 2 players, 3,000.

Each keeps exactly the stack in their chair, which is to the chip the stack
the last completed hand gave them. No blind, ante or bet of the voided hand was
ever taken from them, so nothing is returned, and nobody is credited or
debited. Each event resumes dealing from those stacks. A human in the same
chair would get the same ruling (CLAUDE.md 10.5).

## Five tests

| test                   | cards without snapshot                                                             | dispatched without commit                        |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1. read, not assumed   | PASS: the rows above                                                               | PASS: the rows above plus the `disposed` verdict |
| 2. nobody paid twice   | PASS: the door credits nothing, one idempotent receipt per generation              | PASS: same                                       |
| 3. nothing clawed back | PASS: every chair keeps its stack                                                  | PASS: same                                       |
| 4. proved rolled back  | PASS: all 6 accepted in the rolled-back probe; a chip moved between chairs refuses | PASS: all 4 accepted; a recorded discard refuses |
| 5. the paragraph       | PASS: above                                                                        | PASS: above                                      |

## The door change

The door gains one named outcome, `misdeal_voided`, for those two shapes only.
It is taken only when every clause below holds; otherwise the old refusal is
raised unchanged.

- No commit, history or private state exists at or after the hand.
- No discard is recorded for it.
- No staged snapshot is still open.
- Every hole card is at a live chair.
- The last committed hand exists, and every live chair holds that player's end
  stack in it.
- Every roster, bust, park, lease and custody check passes as before.

The permit goes to `aborted_unsettled` under the door's receipt. Its
`f06_generation_abort_hands` row names the ruling and fences the hand number,
because `a00_f06_aborted_hand` refuses any late commit or history for it. No
permit is deleted and no hand number is re-issued. `snapshot_id` may now be
NULL, and a CHECK allows that only on a misdeal receipt.

## Held: 8ec7e81d, the retained submission

Table c1ee060b holds `hand_submissions` 3a095f5f, the engine's complete
settlement request for hand 12976717. It was retained 2026-09-18 23:08:14,
three seconds after the hand ended at 23:08:06, and was never committed.

- **The hand was played out.** It was raised preflop and everyone folded.
  iashford won the 125 pot, a net +75 (14,936 to 15,011). the_bubble lost 50
  (21,095 to 21,045) and RVARay lost 25 (4,005 to 3,980).
- **All three are horses.** `has_human` is false and the rake is 0.
- **This is not a misdeal.** The platform holds the witness of a finished hand,
  and voiding it would take a won pot from the player who won it.
- **It cannot be committed today.** `fn_ca_commit_hand_submission` requires the
  original owner (instance 1-3846b8bb, generation 7c88dac4), which is dead. No
  door commits a dead owner's retained submission.
- **The whole event waits on this one table.** The other four tables' permits
  hold ordinary preflop snapshots that the door would void. The door decides
  the whole generation at once, so they wait too.

Options:

1. **Commit the witness (recommended).** Extend the door, or add a sibling
   door, so an adopting successor can commit a dead generation's retained
   submission exactly as submitted, through `fn_ca_commit_hand_settlement`'s
   core. It would be bound to the submission's request hash, the unchanged
   pre-hand stacks and the dead generation, and then void the other four
   preflop hands. Cost: a new path into the commit core, which needs its own
   proof, law and review. It moves 75 chips between three horses exactly as
   the hand decided.
2. **Void it as a misdeal.** Cost: iashford loses a pot he won, a clawback of a
   result the platform itself recorded. That fails test 3, so I rejected it.
3. **Leave it held.** Cost: five of its eight tables stay frozen; 62 registrations are still playing in the event and three tables keep dealing around them.

## Measured after apply

Recorded on the pull request after the apply door installs the migration and the admission path has re-asked.
