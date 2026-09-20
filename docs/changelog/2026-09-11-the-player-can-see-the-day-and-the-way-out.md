# The player can see the day, and the way out

**2026-09-11. Phase 4 of 6.**

Continues `docs/changelog/2026-09-11-the-operator-sees-the-money-and-the-room.md`.

## What the day was costing them

Every host sets a per-player daily ceiling. Both live hosts sit at 200 wheel
spins and 500 rounds, and at 100 diamonds a spin that is real money: 20,000
diamonds, two hundred dollars, per player per host per day on the wheel alone.

The wheel printed the spin **count** against its ceiling in a painted bay.
Plinko and Crash printed nothing at all and simply refused at the wall. And not
one of the three had ever shown a player what they had actually **spent**.

Both state reads now carry `diamonds_today`: every diamond this player has put
through the wheel, the board and the curve at this host today. One figure, not
three, because a player's diamonds are one wallet, over the same
America/Chicago day the caps themselves are counted on, so the number and the
ceiling turn together.

`fn_diamond_games_spent_today` is one definition with two callers, for the
reason the phase 3 audit found the hard way: `fn_diamond_games_entry` kept its
own copy of a rule the door also had, they drifted, and four player surfaces
promised a spin the fifth refused.

A welcome spin cost nothing, so it counts for nothing. An **open** crash round
does count, which is deliberately the opposite of what `fn_diamond_game_pnl`
does with the same row: the operator's profit is not real until the round
decides, and the player's money is gone the moment they bet it.

`TodayLine` renders it on all three pages, quiet at the start of a session, gold
at four fifths of the ceiling, red at the wall where it also says so in words
rather than leaving a plate mysteriously dead. The wheel passes `showCount`
false, because its bay already prints the count and saying it twice on one
screen is noise; there, the line carries only the cost. A line with nothing to
say renders nothing rather than an empty paragraph.

## And the way out

"Not Enough Diamonds For That Bet" was a dead end on all three games. The plate
sat disabled telling the player they were short and offering nothing.

It is the **one** blocker a player can do something about. Every other reason
the plate is dead is the club's to fix or the clock's. So the plate they were
already reaching for becomes **Get Diamonds** and opens the same route the
wallet's own plate opens. The string is named once per page and the door is
derived from that constant, so the blocker and the door cannot drift apart.

The exception is a crash round that is already **open**: the cash-out plate
survives any shortage, because the money is on the table and getting it back is
not something a wallet balance may stand in front of.

## The platform helper that named a store it could not open

`showDiamondTopUp` has taken a `navigate` since it was written and never called
it. The "universal" top-up path went nowhere: the toast said "Top up in the
Diamond Store!" and nothing happened. Its copy was also lower case, in a
codebase where Title Case is gated.

The toast carries an `onClick`, so the message **is** the door now: "Tap To Get
Diamonds". It still does not navigate on its own, and that is deliberate. This
fires at a table, mid-hand, when a player cannot afford a throwable. Yanking
them off the felt would be worse than the dead end it replaces.

## Verified

A rolled-back probe on both host shapes plays three spins, four drops and one
crash round left open, and asserts the day moves by exactly the sum of the
bets, that the wheel read and both game reads agree with the helper to the
diamond, that an open round is counted, that a welcome spin adds nothing, and
that exactly two functions call the helper. The helper is unreachable from any
browser role, and the per-player day is indexed on all three tables.
