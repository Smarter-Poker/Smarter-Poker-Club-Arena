# The dead-generation permits drain after f1d956c3; twelve legacy wedges remain on named refusals

2026-09-26. Measurement only; no money moved.

## The cutover

`f1d956c3` (#5280 "a fresh adoption asks the abandoned-generation door before
it holds the event" + #5267) went live at 04:06:38 UTC in a Deployment
Recovery window (run 36216375852, sealed and independently verified, deploy
attempt 695 `shipped=true`). The parallel run 36216296821 for target
`31ee0764` refused "does not contain the sealed high-water release" because
f1d956c3, which contains it, had sealed first (see
`2026-09-26-the-release-path-drops-its-last-exception.md`).

## Reserved F06 permits whose generation is not the tournament's live lease

| time (UTC)       | dead-gen permits | events | of those, dealt nothing | RUNNING dealt      |
| ---------------- | ---------------- | ------ | ----------------------- | ------------------ |
| 04:03 (92d59cfb) | 160              | 75     | 75 (30 min)             | -                  |
| 04:08 (adopting) | 47 of 48 leases  | 22     | 22                      | -                  |
| 04:14:49         | 89               | 57     | 48 (3 min)              | 279 / 356 (3 min)  |
| 04:23:09         | **18**           | **12** | 10 (10 min)             | 296 / 357 (10 min) |

`aborted_unsettled` permits 954 -> 1085; `f06_generation_aborts` wrote 60
receipts in the 15 minutes after the thaw. The outgoing 92d59cfb process left
**zero** new dead-generation permits: its 227 live-generation reserved permits
all resolved in the break's last-hand phase, and every permit still dead at
04:23 dates from 2026-09-18 or 2026-09-22.

The door refused 124 asks at adoption (04:12, while the fleet was still
thawing); a rolled-back probe at 04:17 showed 39 of the 57 remaining
(event, generation) pairs would already be accepted, and the table admission's
10-minute re-ask (`ABANDONED_GENERATION_REFUSED_COOLDOWN_MS`) took them by
04:23. So #5280 plus the admission re-ask drain a restart's inheritance
without help.

## What remains: 18 permits, 12 events, all legacy

A rolled-back probe (one `DO` block ending in `RAISE EXCEPTION`) at 04:24:

| refusal                                                                 | events                                                | permits |
| ----------------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| `F06_ABANDONED_CARDS_WITHOUT_SNAPSHOT`                                  | 140ecf5f 23ef2d58 3203a371 887802a7 b5a48510 fc2898f1 | 6       |
| `F06_ABORT_COMMITTED_OR_DISPATCHED` (dispatch row, no commit, no cards) | 0147ba18 64609b68 9470a333 991c7324                   | 4       |
| `F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION`                          | 8ec7e81d ($100 Freeroll 6:00 PM, 64 players)          | 5       |
| `F06_ABANDONED_ROSTER_CHANGED`                                          | 8da2c394 (Sunday $200 Deep Stack, 48 players)         | 3       |

Ten are one-table Spins / heads-up events. **No chips moved in any of them.**
For every one of the 18 tables, every seated player's `table_seats.stack`
equals exactly that player's end stack in the table's last committed
`hand_history` row (the two 8ec7e81d tables whose totals differ by 5,000 each
hold one extra player seated after that hand). Nothing is owed, nothing was
lost; the players are frozen, not short.

Resolution needs the door to accept a hand that provably never moved chips:
for CARDS_WITHOUT_SNAPSHOT and dispatch-without-commit, "no snapshot, no
commit, no history, no private state at or after this hand, and every seated
stack equals the last committed hand's end stack" is the misdeal ruling - void
the hand, stacks unchanged. That is a change to a money door
(`fn_f06_abort_abandoned_generation`) and belongs in its own PR with a
rolled-back proof per shape; the retained-submission and roster-changed
events need their own reading first.
