# server/src/engine/ATableThatCannotDealHoldsNobodyForABlind.law.test.ts

A cash table that cannot deal must not hold a seat out for the big blind. The
deal gate excludes a waiter from `activePlayers`, so a table whose seats are
mostly waiters reads as short and sleeps - and sleeping is what stops the big
blind that would have released them; the only other exit is the player tapping
POST, which a horse never does. On 2026-09-11 that shut seven live must-move
tables, one for 94 minutes with six funded seats on it, and every seated table
on the floor that was dealing nothing was a table with a waiter on it. The
release fires only when letting everyone in actually reaches
`minPlayersToDeal`, writes what the natural big-blind release writes, and never
seeds a released seat as a veteran, so "a new player never gets the button"
survives. It cannot run at a running table, so Dan's 2026-08-26 "no free hands
or coming in behind the blinds" is untouched.
