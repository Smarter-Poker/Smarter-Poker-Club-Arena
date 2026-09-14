# What the tightened bar turns away

BBJ programme, round 2 of the post-audit work. 2026-09-12.

Dan's mini bar shipped. This is what was still wrong underneath it.

## 1. The rule tightened PLO5 and nothing recorded what it refused

`detectMiniBBJNearMiss` returns `none` when nobody clears the bar, with a
comment saying so: _"Nobody cleared the bar. That is not a near miss - it is an
ordinary hand, and recording it would bury the real ones."_

**That reasoning was written when the bar was "any quads."** Under it, a loser
below the bar really was ordinary: two pair, a straight. Dan's ranked bar
changed what the phrase covers. On PLO5/FLO5 the bar is Quad Tens, so a loser
below it can be **quad nines beaten by quad aces** - a monster that paid the
mini the day before and pays nothing today.

Dropping that silently makes the cost of the new bar unmeasurable. Nobody could
say how many beats it turned away, which is the exact hole `bbj_near_misses`
was built to close for the main jackpot - and the mini's tightening is the one
change most worth measuring.

`mini_loser_below_bar` is back, **but only where it means something**: inside
the ranked-bar branch, and only for a loser who actually holds quads. An
ordinary hand still records nothing. The message names the bar it missed
("the Mini needs Quad Tens Or Better in this game"), and the panel already had
a label for it, so the row renders the moment the engine writes one.

Chain verified end to end: engine detects, `recordBBJNearMiss` writes the row
fire-and-forget, `fn_bbj_near_miss_summary` groups it, the panel labels it.

## 2. A law of mine was green for the wrong reason

`the-near-miss-log-has-a-reader` derives "every gate the engine can name" by
regex over `RakeConfig.ts` - **including comments**. The comment explaining why
`mini_loser_below_bar` had been _deleted_ quotes `reason: 'mini_loser_below_bar'`
in order to explain it. So the law counted a deleted gate as live, demanded a
label for it, the panel grew one, and both halves agreed about a gate that
could not fire.

It had been wrong since the day it was written, and a green test never showed
it. I found it by reading my own diff and noticing the expected list already
held a value I had not added. It strips comments now - the same fix the
promo-sweep law and the mini-surface law already carry. **A check that reads
prose as code reports on prose.**

## 3. The payout's own refusals rendered as raw snake_case

A `mini_refused:<reason>` row is the one entry on the panel that is an
_incident_ - a hand that cleared the bar and was turned away. Its reason had no
label, so an operator read `no_mini_amount_for_tier` on the row that matters
most. All five reasons `fn_bbj_mini_payout` can return now have words, read off
the live function rather than guessed:

| reason                    | reads as                                   |
| ------------------------- | ------------------------------------------ |
| `reserve_at_floor`        | The Backup Reserve Was At Its Floor        |
| `mini_disabled_for_club`  | The Mini Was Switched Off For This Club    |
| `mini_disabled_for_tier`  | The Mini Was Switched Off For These Stakes |
| `no_mini_amount_for_tier` | No Mini Amount Is Set For These Stakes     |
| `pool_not_found`          | The Jackpot Pool Could Not Be Found        |

A law holds the list against the function, so a sixth refusal cannot ship
unlabelled.

## A law re-pointed, not weakened

`the-mini-reserve-has-a-runway` pinned the ABSENCE of `mini_loser_below_bar`.
Its premise - "a value no caller ever read" - stopped being true: the panel
grew a reader, and the ranked bar gave the phrase a meaning. The case now
asserts the _shape_ instead of the absence: the reason may appear only inside
the ranked-bar branch, only for a loser holding quads, and an ordinary hand
must still return `none`. Updated in the same commit as the behaviour it pins
(CLAUDE.md 5.8), with the reasoning written down rather than the assertion
deleted.

## Verified

13 engine cases including the four new ones: quad nines under the Quad Tens bar
is a near miss naming the bar; an ordinary hand under the bar is not; PLO4 with
no ranked bar stays silent; FLO5 behaves like PLO5. Client **19,495** tests,
server **10,308**, both typechecks clean.
