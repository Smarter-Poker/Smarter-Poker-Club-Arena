# Two refusals that stalled a table for good

2026-09-08. Hand throughput fell from ~15,000/hour to **7,312**, and the drift
board went 87 -> 795 -> 1,311 while I watched. Two separate settlement guards
were refusing hands for conditions that **could never clear**, and because the
refusal is deterministic all five retries were identical: the engine generation
was terminated and the table stalled permanently.

Neither was a money bug. Both were guards that could not be satisfied.

## 1. A seat that has left cannot hold a time bank

`fn_ca_commit_hand_settlement` writes the accepted hand's time-bank state to
`table_seats` and refuses the whole hand unless every payload item matched a
row. Two tests could satisfy an item - the UPDATE matched a live seat, or a
live seat already held exactly that state. **Neither can be satisfied once the
seat is gone.**

A player stands up between the deal and the commit. The count comes up short.
The hand is refused. The player never comes back, so the retry is identical
forever.

Proving it took the durable witness, because the evidence deletes itself: the
first table I looked at showed `left_at = 16:44:00.971` against a refusal at
**16:44:33**, and by the time I queried again the row was gone - 584 seat exits
in two hours and the departed rows are pruned behind them. `ca_seat_stack_exits`
survives that, and against it **13 of 13 stalled tables** had a seat exit within
15 minutes of their refusal.

The chips were never at risk. The alert says so itself: the hand *committed*,
and only its post-commit envelope was held back.

Fixed at the root: an item whose seat is no longer present is **accounted for**,
not a mismatch. A seat that is still live and disagrees never reaches that
branch - the UPDATE would have matched it - and still refuses the hand whole.

Measured after the thaw: **zero** time-bank refusals across 148 seat exits, and
throughput back to ~18,900/hour.

## 2. A hand is refused for the fraction it creates, not one it inherited

The second refusal was `accepted tournament hand produced fractional stack
6249.50`.

That guard was added at 12:56 the same day, inside a 70KB migration about
something else entirely, **with no comment and no rule cited** - while every
other guard in the same block carries its reasoning. The written standard is
`docs/laws.d/a-chip-is-two-decimal-places-everywhere.md`, under which 6249.50 is
a legal chip value. CLAUDE.md 10.8 is explicit that deployed code is not a law,
so this was the defect, not a conflict of laws.

But whole tournament chips **is** real poker truth, so both halves were wrong.

**Nothing was missing.** 12 seats held 6.00 chips of fraction; every affected
tournament had an EVEN number of fractional seats and a whole `chips_in_play`
(2,630,000.00 / 312,000.00 / 234,000.00 / 3,000.00). Each `.50` is one half of a
single chip split two ways. And 7 tournaments carried a fraction while exactly
those 7 were stalled - a one-to-one match.

So the guard now refuses only a hand that **introduces** a fraction, and
tolerates one a player carried in. Tolerate the history, refuse the future -
the same shape as the `NOT VALID` constraints elsewhere in this repo.

## The root cause underneath both: a tournament chip does not divide

`PokerEngine.distributePot` split every pot into **cents**. Correct for cash,
where a chip is two decimal places. Wrong for a tournament, where the chip is
the indivisible unit: a 959-chip pot chopped two ways paid 479.50 each.

**This had been diagnosed before and fixed in the wrong place.**
`ServerTableEngineRunout.ts:2046` records it on 2026-08-26 - "live 3-run
tournament hand 41627f9a split 1760.88 into fractional chips and destroyed the
difference" - and carries a correct whole-chip algorithm that floors every
winner and hands the odd chips out clockwise from the button. That backstop
sits in the run-it-twice path, which is **cash-only by Dan's ruling**, so its
own comment calls the branch "UNREACHABLE in a healthy system". The right code
existed and ran on zero hands.

The pot is now divided into indivisible **units**: cents for cash, whole chips
for a tournament. `unitCents` is 1 in the cash case, which makes `wholeUnits ===
totalCents` and `subUnitCents === 0`, so **the cash arithmetic is identical to
what it always was by construction, not by inspection**. Anything finer than one
unit rides with the first winner clockwise rather than being created or
destroyed, so the awards always re-sum to the pot exactly.

`server/src/engine/aTournamentChipDoesNotDivide.law.test.ts` pins all of it,
including a 400-pot sweep asserting no tournament award is ever fractional and
every split re-sums exactly.

## What is still open

The 12 legacy fractional seats are left alone deliberately. They are inert once
the engine stops splitting chips - nothing rounds them, conservation is already
exact, and normalising them would move tournament chip counts for no gain.
