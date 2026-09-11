# A Table That Cannot Deal Holds Nobody For A Blind

2026-09-11. Found in the closing sweep of the must-move audit, on the live
floor, in production data rather than in a test.

## What was wrong

Seven of the 129 open cluster tables were seated and dealing nothing, and they
were exactly the seven carrying a seat held for the big blind. Every other
seated table on the floor was fine: 7 of 7 stuck, 0 of 48 healthy tables
affected.

| table    | seated | waiting | active | oldest hold | hands in 30m |
| -------- | -----: | ------: | -----: | ----------: | -----------: |
| 2755c54c |      6 |       5 |      1 |      94 min |            0 |
| 1c45cada |      6 |       5 |      1 |      94 min |            0 |
| 9e851fff |      6 |       5 |      1 |      94 min |            0 |
| 1dc09e13 |      4 |       3 |      1 |      94 min |            0 |
| e670d636 |      4 |       3 |      1 |      34 min |            0 |
| 5fceabfd |      2 |       1 |      1 |       7 min |            0 |
| 140532e7 |      2 |       1 |      1 |       6 min |            0 |

Two of those tables had dealt 48,925 and 28,722 hands in their life. They were
not new and they were not empty; they were shut.

## Why

The cycle closes on itself and cannot break itself.

`activePlayers` in the dealing loop excludes a player in `waitingForBB`, so the
deal gate counted one player and slept. Sleeping is what stops the big blind
moving. The big blind not moving is what stops the natural release at the top
of the loop, which only fires when the blind reaches a waiter's seat. The one
remaining exit is the player calling `POST /post-bb`, and every seat on those
tables was a horse, which never taps.

So a table drops to one player who can be dealt to, every later arrival is
registered to wait for a blind that will now never arrive, and six funded seats
sit at a dead table indefinitely while the floor shows the game as running.

## The fix

`releaseWaitersNoBlindCanReach()` on the base engine, called from the idle
branch of the dealing loop before it sleeps. While the table cannot deal,
nobody waits.

It fires only when the release actually starts the game: if the table would
still be short with everyone let in, the holds cost nothing and stay. It writes
exactly what the natural big-blind release writes (`hold: null, agreed: false`)
so a standing post agreement cannot survive to bill a second blind. It never
seeds a released seat into `dealtInUserIds`, so "a new player never gets the
button" holds on the hand they enter. It is cash only, and it logs, because a
silent release is how this was missed.

## What it does not change

Dan 2026-08-26, binding: "Every single player needs to either wait for the BB
or post when entering a cash game... no free hands or coming in behind the
blinds." That rule is about a RUNNING table and `EntryPostingAndButton` still
owns it. This release cannot run at a running table — the gate above it has
already decided the table cannot deal — so there are no posted blinds to come
in behind. Every released seat enters on the same hand, and that hand posts its
blinds by position: the same deal six players opening a brand-new table already
get from this engine's own first iteration.

## Pinned

`server/src/engine/ATableThatCannotDealHoldsNobodyForABlind.law.test.ts`, seven
guards, registered at
`docs/laws.d/server-src-engine-ATableThatCannotDealHoldsNobodyForABlind.md`.
Proven able to fail: deleting the call site turns one red, and making the
release count the very waiters it is deciding about turns another red.
