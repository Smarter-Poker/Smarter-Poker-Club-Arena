# The board and the flag disagree — two rake-law defects, characterised

**2026-08-31 — Phase 3 of the live cash games audit, item 1**

Both defects were found by `fn_rake_law_check`, the alarm shipped in #2191/#2210.
Neither is fixed here. This records what they are, what they cost, and — as
importantly — the five explanations that have been **excluded by evidence**, so
the next person does not re-run those experiments.

## Defect A — players are raked on preflop fold-outs

**20 hands in 24 hours, 9.15 chips.** Logged as `no_flop_no_drop`, severity
`critical`. Ongoing.

`calculateRake` returns 0 when `noFlopNoDrop && !sawFlop`, and `noFlopNoDrop` is
`true` at every live construction site (`ServerTableEngineBase` 3313/3317,
`ServerTableEngineDealing` 1988/1992). So `sawFlop` is `true` at settlement on
hands that never saw a flop.

A worked example, PLO6 1/2, five players (`c72989a7`):

| seat | action      | amount |
| ---- | ----------- | ------ |
| 2    | small blind | 1      |
| 3    | big blind   | 2      |
| 1    | fold        |        |
| 2    | fold        |        |
| 3    | raise       | 4      |
| 4    | fold        |        |
| 6    | fold        |        |
| 3    | return      | 3      |

Pot 2.00, **raked 0.20**. The big blind raised, everyone folded, and the winner
paid rake on a hand nobody contested.

### That the hand saw no flop is arithmetic, not inference

On the heads-up 2/4 example (`50d4006e`) the pot is **exactly 4.00**. For a flop
to be dealt heads-up both players must match, so the smallest possible flopped
pot at 2/4 is 8.00. A 4.00 pot cannot have seen a flop, whatever the hand record
says. Every one of the 20 has a pot too small to have reached a flop.

### That the money really moved

`hand_history.rake_amount` has a single writer — `this.currentHandRake`
(`ServerTableEngineSettlement` 1247) — and `services/supabase/rake.ts` books it
to the club or union whenever it is above zero. The rake on each hand is also
exactly the right rate for that hand's own pot: **10% multiway, 5% heads-up**
(2.00 → 0.10, 4.00 → 0.20). It is a live computation on this hand, not a stale
value carried over from the last one.

### Excluded by evidence — do not re-test these

| Hypothesis                                                                      | How it was excluded                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale `currentHandRake` from the previous hand                                  | Every rake is the exact correct percentage of _this_ hand's pot. A carried-over value matching 20 times is not credible.                                                                                   |
| The RIT path (`markFlopSeen()` — the only `sawFlop` writer that deals no cards) | All 20 hands: **0 `rit_boards`, 0 `community_cards2`, 0 all-in actions, 0 showdowns**.                                                                                                                     |
| Mandatory RIT mode reaching `dealAndResolveRIT` without a real all-in           | Every violation table is `run_it_mode = 'player_choice'`; **no table in production uses a mandatory mode** (921 `player_choice`, 51 `none`).                                                               |
| A `HandController` bug                                                          | The fuzzer asserts `sawFlop === (board.length >= 3)` on every hand (`HandFuzzer` 837). **18,000 randomized hands pass.**                                                                                   |
| Cross-hand state leaking                                                        | A fresh `HandController` is constructed per hand (`ServerTableEngineDealing` 1920) and its constructor unconditionally sets `sawFlop: false`, `communityCards: []`. There is no restore or rehydrate path. |

### Where that leaves it

`HandController` in isolation is correct, and the only `sawFlop` writer outside
its own dealing paths is `markFlopSeen()`, which the data rules out. So the flag
is being set somewhere in the **engine layer that neither the fuzzer nor
`server/sim` exercises** — neither harness constructs a `ServerTableEngine`.

The next step is a harness that drives the engine layer through a preflop
fold-out. That does not exist yet and is the single most useful thing to build
here; it would also have caught defect B.

## Defect B — the board is missing from hands that clearly had one

**16 hands in 24 hours.** Logged as `board_not_recorded`, severity `warn`,
**no chip overage — the rake on these is correct.**

These are the mirror image of A: A has the flag without the board, B has the
board without the record.

| signal                             | count of 16    |
| ---------------------------------- | -------------- |
| all-in action present              | 13             |
| reached showdown                   | 11             |
| **insurance enabled on the table** | **15**         |
| RIT enabled                        | 5              |
| `rit_boards` populated             | 0              |
| pot range                          | 88.00 – 704.00 |

Fifteen of sixteen sit on insurance-enabled tables, and `HandController` 1355
already names that path as one that behaves differently:

> "RAKE LEAK FIX 2026-08-18: same as runOutCommunityCards — the insurance
> per-street path deals the flop without marking it seen."

That path was patched for `sawFlop`. The evidence says its board still does not
reach `hand_history.community_cards`. The cost is not chips, it is that the
player cannot replay the hand — and that any analysis asking "did this hand see
a flop" is silently wrong, including this audit, which is why the alarm
separates the two classes on evidence rather than lumping them together.

## Why they are worth fixing even though A is only ~9 chips a day

Being raked on a walk is the kind of thing a player notices and does not
forgive, and the amount is not the point. B is worse in one specific way: it is
invisible to the player until they go looking for a hand they remember playing.
