# 2026-08-29 — A horse now plays one stake, because 64 of them were playing several

Dan: _"EACH HORSE SHOULD HAVE A SPECIFIC STAKES THEY'RE PLAYING. A HORSE
PLAYING 5/10 OR 10/25 SHOULD NEVER BE SEEN ON A 50 CENT ONE DOLLAR GAME OR
1/2 DOLLAR GAME, THAT JUST LOOKS SUSPICIOUS."_

## He was right, and it was measurable

Over the 48 hours before this change, 210 horses took a cash seat and **64 of
them — nearly a third — sat at more than one stake level.** The worst were not
marginal:

| horse                | stakes played                     | spread   |
| -------------------- | --------------------------------- | -------- |
| `yankee`             | 0.10/0.20 and 25.00/50.00         | **250x** |
| `mixedgame max`      | 0.10/0.20, 1.00/2.00, 10.00/25.00 | 125x     |
| `ronald calabrese 2` | 0.10/0.20, 2.00/4.00, 10.00/25.00 | 125x     |
| `duckcall`           | 0.05/0.10 and 2.00/4.00           | 40x      |

No human bankroll moves like that. A regular who knows a name from the 10/25
game sees it instantly in their 0.10/0.20 game.

## Why it happened

**Stakes were never an input to horse selection.** `HorseFleetManager` picked
from every enabled horse, filtered only by game lane and how many tables it
already sat at, then weighted the pick by `Math.random() / (1 + tables)`.
`small_blind` and `big_blind` were read in exactly one place — to compute a
buy-in amount. Nothing anywhere in the seating path had an opinion about which
game a given horse belonged in.

## The fix

A stake band is an **identity**, in the same sense a game lane is: assigned
once, stored in `profiles.horse_profile`, stable across days.

```
micro   0.05/0.10, 0.10/0.20, 0.25/0.50
low     0.50/1.00, 1.00/2.00              <- the fleet's own configs
mid     2.00/4.00, 2.00/5.00, 3.00/6.00
high    5.00/10.00, 10.00/25.00, 25.00/50.00
```

The boundaries are the real ladder, not round numbers picked in the abstract —
every live cash table falls inside one with nothing straddling an edge. Within
a band a horse still moves freely, because a mid-stakes regular playing both
2/4 and 3/6 is ordinary, and multi-tabling one's own stake is what real players
actually do.

`stakeBandAllows(horseId, bigBlind)` is consulted in the candidate filter,
before the weighted pick. That is the first time blinds have ever influenced
_which_ horse is chosen.

### No escape hatch, deliberately

The existing rescue path widens the _activity hour_ when a human is waiting and
the active pool ran dry. It now widens the hour and never the band. A human
waiting at 0.50/1 can pull an off-hours low-stakes horse out of bed, which is
believable; it can never summon the 25/50 regular, which is not. **A quiet
high-stakes table is ordinary. The wrong name in a micro game is the tell.**

When a band genuinely runs out, the log says so by name rather than looking
like the fleet is broken.

### The band is EARNED

Dan, on reading the first version: _"THEY CAN PLAY MORE THAN ONE STAKE, BUT YOU
SHOULD CLASSIFY THEM... A MICRO PLAYER ONLY PLAYS MICRO STAKES (WORST
PERFORMING HORSES). SMALL STAKES IS FOR SMALL PLAYERS (2ND WORST). MED WOULD BE
GOOD WINNING HORSES, AND HIGH FOR THE BEST HORSES."_

The mechanism was right; the **assignment** was arbitrary. It took contiguous
slices of the fleet ordered by uuid — reproducible, exactly balanced, and
meaningless. A horse bleeding 80 big blinds per hundred could hold a seat in the
25/50 game because its id sorted late.

A real card room sorts itself by results, and that is what makes a stake ladder
legible to anyone watching it. `fn_assign_horse_stake_bands` now ranks on
**bb/100** — winnings over the big blinds actually faced, the only measure
comparable across a ladder where 500 chips is a career at 0.05/0.10 and a
rounding error at 25/50.

The fleet had real signal to rank on: 584 horses, average 9,273 hands each,
576 of them past 2,000 hands. Spread from **-80.71 to +68.29 bb/100**, median
-12.60, 146 winners against 438 losers.

After the first merit run:

| band  | horses | avg bb/100 | winners |
| ----- | ------ | ---------- | ------- |
| micro | 127    | **-35.62** | 13      |
| low   | 336    | **-11.96** | 35      |
| mid   | 73     | **+1.65**  | 59      |
| high  | 48     | **+22.86** | 39      |

Monotonic, which the migration asserts rather than assumes: if the high band
does not out-earn the micro band, the migration aborts, because bands that are
not merit-ordered make the whole feature decorative.

Two guards that are not optional:

**A hands floor.** A winrate over a few hundred hands is noise, and promoting
noise to the 25/50 game is how a losing horse arrives there by luck. Below
1,000 hands a horse is unproven and starts at `micro` — a new player begins in
the smallest game and earns his way up. There is deliberately **no hash
fallback** for an unranked horse: a band is a claim about results, and hashing
a brand-new horse into `high` would seat an unproven player in the biggest game
on the strength of its uuid, which is the arbitrary assignment this replaced.

**Hysteresis.** The ranking re-runs. Without a margin, a horse on a band
boundary flips every time its winrate wobbles — and a regular who plays 10/25
today, 0.10/0.20 tomorrow and 10/25 on Sunday is _exactly the tell the bands
exist to remove_. A horse moves only when it is more than five percentile
points past the boundary it would cross. That is why the counts above are
127/336/73/48 rather than the exact 128/304/88/64: the first merit run held
near-boundary horses where they were, and it converges over subsequent runs.

The proportions stay demand-based, so **merit decides who is in a band and
demand decides how many** — no stake level is left without enough horses to
fill it. The two constraints are independent and both hold.

### Why the band lives in the database and not in a hash

Same reason lanes are assigned: `horseHash` is a weak multiply-add and a
low-bit modulo of it clusters on UUIDs — the lane hash aimed at 33/33/34 and
measured 32.0/39.0/28.9 across the real fleet. Here a skew is worse than
cosmetic, because a short band is a stake level with too few horses to fill its
tables, and the band is strict. The merit ranking needs the database anyway:
`player_stats` is where the winrates are.

Band sizes follow live seat demand (micro 83 seats, low 220, mid 36, high 26):
**22 / 52 / 15 / 11**. A third of the roster is events-only, but each horse may
hold four tables, so every band clears its seats several times over.

Applied to production, and the `lane` assignment survived the jsonb merge on
all 584 horses — the migration asserts that rather than assuming it, because
the merge writes into the same column a third of the fleet's behaviour depends
on.

## What this does not do

**It does not evict a horse already sitting at the wrong stake.** Existing
seats age out through the normal session rotator rather than being yanked
mid-hand; every _new_ seating from the moment the engine redeploys obeys the
band. The visible mixed-stakes names should be gone within a session cycle.

## Verification

`npx tsc --noEmit` exit 0. 24 new tests, 462 passing across `server/src/services`.
The pins include the headline rule (a 10/25 horse refused at 0.50/1), the exact
`yankee` case (no horse may be allowed at both 0.10/0.20 and 25.00/50.00),
exactly-one-band-per-table, garbage band values falling back rather than being
stored, an unproven horse starting at `micro` and never reaching `high` by luck
of its uuid, and three wiring pins that
fail if the filter is moved after the pick or if the rescue path is ever
widened past the band.
