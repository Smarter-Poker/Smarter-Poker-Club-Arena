# The floor is full, and a horse gets up only for a person

**Dan, 2026-09-02, verbatim:** "HORSES CAN FILL ALL SEATS, AND ONLY 'GET UP'
WHEN A REAL HUMAN IS ON THE WAITING LIST FOR 75% OF ALL GAMES. THE OTHER 25% OF
GAMES SHOULD HAVE ANYWHERE FROM ONE, TO A FULL GAME. IT SHOULD BE SPARATIC, BUT
HORSES NEED TO BE OCCUPYING AT LEAST 75% OF ALL SEATS IN THE CASH GAMES, AND
THEY SHOULD BE PLAYING 4 TABLES AT ONCE!"

## What the floor looked like before

Measured 2026-09-02, 01:30 UTC:

|                                 |                                                     |
| ------------------------------- | --------------------------------------------------- |
| Open cash tables                | 1,091 across 209 configs                            |
| Seats on them                   | 6,786                                               |
| Seats filled                    | 229 (3.4%)                                          |
| Distinct players in those seats | 229 — **1.00 tables per horse**, against a cap of 4 |
| Tables actually dealing         | 77 of 1,091                                         |

Three rules were producing that, and all three were Dan's own:

- **The vibe drift (2026-08-23)** gave 30% of tables a "steady" target of 2-3
  open seats and 18% a "quiet" target of 3-5. Three quarters of the floor was
  BELOW full by construction, so 75% occupancy was arithmetically unreachable.
- **The held-empty rule (2026-08-26)** put a further 15% of cash tables at
  exactly zero.
- **The seat weight** was `random / (1 + tablesAlreadyPlayed)`, which ranks a
  horse sitting at NOTHING above one sitting at three. The fleet spread itself
  one seat per horse across a thousand tables, and nothing ever approached the
  four-table cap.

## What replaces them

**`cashTableFill`** gives every cash table one of two characters for a
three-hour bucket: **full** (75%) or **sporadic** (25%). Deterministic per
(table, bucket) through the murmur3 finalizer, because `horseHash` is a weak
multiply-add and folding a consecutive bucket into it makes a table WALK
through the band instead of re-rolling — the bug that took a whole variant's
room dark for thirty hours when this was the held-empty roll.

**`occupancyTargetFor`** asks a full table for every seat, and a sparse one for
one seat to all of them. The floor is ONE, never zero: the sparse quarter is
Dan's "anywhere from one to a full game", and a table with nobody at it is the
rule this replaced.

**The waiting list is the release, and the only release.** `humansWaiting` is
subtracted from the seat target, so the fleet's ordinary "seat up to target"
loop becomes the eviction path — three people queued means three fewer horse
seats wanted — and the rotator stands exactly that many horses up, certainly
rather than probabilistically, through the same hand-boundary-safe
`leaveTable()` a human uses. Horses no longer queue at all: a queue is now a
signal that a real person wants in, and a horse standing in it would both delay
that person and make "is a human waiting" unanswerable.

**A full table with nobody waiting does not shed players.** Both discretionary
departures — fancying a change of game, and the session simply ending — are
held. The money departures are NOT held: a horse that plays past its stop-loss
because the table wanted to look full is a bug in the bankroll law, and this
rule does not get to break that one.

**Four tables is the target.** A horse already playing, and not yet at four, is
now the FIRST choice for an open seat. Four remains the hard ceiling.

**A full table fills in one pass.** The 1-2 seats per 30-second cycle stagger
took four minutes to fill a nine-hander, and in the meantime spread the fleet
one horse per table across the whole floor. It survives where it still reads as
human: the sparse quarter, and a human's rescue.

**The populated set is stable.** With tables filled to max in one pass the
fleet runs out of horses partway down the list, so WHICH tables get them is now
decided deterministically (humans first, then table id). An unstable order
would move every horse in the room every cycle for no visible reason.

## The number that is not code, and is Dan's

**"At least 75% of all seats" is not reachable with today's fleet, and no code
change can make it so.** 75% of 6,786 seats is 5,090. At four tables each that
needs 1,273 horses seated simultaneously. The fleet is 1,000, a third of them
are events-only by Dan's 2026-08-26 lane rule, and each is inside its daily
activity window 10-17 hours out of 24 — so roughly 370 are available to sit at
any moment, for about 1,480 seats.

The three levers, in Dan's hands rather than mine:

1. **Fewer open cash tables.** 75% is reachable today at about 1,900 seats —
   roughly 300 tables. There are 1,091, across 209 distinct configs, and only
   9 of those configs belong to the fleet; the rest are club-created, so the
   fleet may not close them.
2. **More horses.** Filling 75% of the CURRENT floor needs roughly 3,500.
3. **Widen the lane or activity gates**, which would raise the fraction of the
   existing fleet seated at once. Both are Dan's earlier rules and I have not
   touched either.

What this change does deliver, whichever lever he picks: the tables the fleet
CAN fill are full, they stay full, a seat opens the moment a person asks for
one, and every seated horse is driven toward four tables instead of one.
