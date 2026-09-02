# My own regression: a running Spin took five entrants

2026-09-02. Found by auditing my own work rather than by an alarm, which is the
only reason it was found at all.

## What I broke

Earlier tonight `fn_enforce_tournament_capacity` counted **every**
`tournament_players` row with no status filter, so a player who had already
busted held their place forever. On a three-handed Spin that was fatal: one
horse leaving a REGISTERING board made it read 3 of 3 with two live seats, the
top-up was refused `tournament_full`, and the board could never again reach the
three paid seats it starts on. 2,059 such refusals in a single hour. I changed
it to count only live entrants.

That fix was right and incomplete. Once a Spin is RUNNING and players start
busting, their rows go terminal, capacity frees up, and a **late registration is
accepted into a game already being played.**

## What it cost, measured

Across the 965 seat-first games created between my change and this one:

|                           |           |
| ------------------------- | --------- |
| over-subscribed boards    | **2**     |
| extra entrants admitted   | **3**     |
| excess prize pool written | **40.00** |

The worked example:

```
"20 Chip Spin PLO5"   buy-in 20, multiplier 2   -> prize should be 40.00
entrants                5  on a 3-handed board
prize_pool written     80.00
winner credited        80.00
reserve pool drew      40.00   <- correct
```

The player was overpaid **40.00**, and the extra forty did **not** come out of
the Spin treasury. That is exactly the divergence between what a player is paid
and what the pool records that this entire body of work exists to prevent, and I
introduced it.

## The rule, stated so neither half can be dropped

Both halves are needed and each one alone has now been shipped and broken
something:

1. **While a board is open, count LIVE entrants.** A departed player frees the
   seat, so a board that loses a horse can refill. Without this, the deadlock
   returns.
2. **Once the board is no longer joinable, it takes nobody** - whatever the live
   count says. A Spin is three seats sold once; it is not a field that
   back-fills as players bust. Without this, a running Spin takes a fourth.

Non-seat-first formats are deliberately untouched: an MTT with late registration
or re-entry legitimately admits players after it starts.

## Proved by execution, both directions

Against production, in transactions that were rolled back:

- a RUNNING Spin now refuses another entrant -
  `23514 tournament_full: 3 Chip Spin PLO4 is running and takes no further entrants`
- a REGISTERING board carrying a dead `eliminated` row still **admits** a
  refill, so the original deadlock stays cured

The migration asserts both halves at apply time by name, so removing either one
fails the apply rather than quietly reopening a bug that has already happened.

## The forty chips

Left where they are. Clawing back a credited prize from a player is not a
decision an agent should take on its own, and the amount is small enough that
the record matters more than the recovery. It is written down here, in the
migration, and in the law test.
