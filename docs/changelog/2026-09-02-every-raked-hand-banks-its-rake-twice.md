# Every raked hand banks its rake twice

Correcting the supply measure (`club_wallets` had been measured and then left
out of the total) made the drift **bigger**, not smaller, and pointed straight
at the cause. This is the largest live money defect found in the whole sweep.

## What happens

`atomic_distribute_rake` writes two legs for one hand's rake, and credits a
real balance for each:

| leg                | credit                                           |
| ------------------ | ------------------------------------------------ |
| `club_accumulator` | `club_wallets.chip_balance += (rake - bbj)`      |
| `union_rake`       | `union_wallets.rake_wallet += rake` (union game) |
| `chip_treasury`    | `clubs.chip_treasury += rake` (club game)        |

Both destinations are spendable. `club_wallets` is not a tally - its
transaction log carries **46,991 `commission_out`** rows and 49,590 negative
amounts, so agents are paid out of it - and `union_wallets` and
`clubs.chip_treasury` are already inside the supply total.

## Measured, not inferred

Over 90 minutes on the live floor: rake collected **3,032.55**, legs
distributed **5,770.40**. The distribution exceeds the collection by
**2,737.85**, on **1,629 of 1,692** raked hands, at exactly **2.00 legs per
hand**. Two times 3,032.55 minus BBJ lands on 5,770. One extra rake per raked
hand: **~1,762 chips an hour, ~40,000 a day.**

Hand-level settlement was ruled out first, because it was the obvious suspect:
across 1,690 raked hands the winners receive pot minus rake, and the net is
**-293.97**. Nothing is created when the pot is paid. The chips appear
afterwards, when the same rake is banked in two places.

## What this change does and does not do

It does **not** change the split. Whether the club's share comes out of the
union's rake or sits alongside it is a commercial ruling, and rewriting a money
path used by every hand on the floor on my own authority is what CLAUDE.md 11.5
forbids. What it does is make the invariant permanent and impossible to lose:

> the legs for a hand must sum to the rake taken from the pot

which holds whatever split Dan chooses. Today it is violated on ~96% of raked
hands, so the ratchet is seeded there and can only improve. It already
tightened itself from 96 to 94 on the second reading.

## A mistake caught in the same hour

The first version of the ratchet counted mismatching **hands** per hour. Two
consecutive reads gave 1,130 and 1,133 - the metric moves with how busy the
floor is, so it would have raised an incident on an ordinary Saturday night and
taught everyone to ignore it. That is the exact failure this sweep exists to
stop, and I nearly shipped it. It measures a **percentage** now, sampled over
ten minutes (~190 hands): volume-independent, and a sixth of the scan cost. The
hourly watch had grown to 46 seconds and is back to 25.

That is the third time today a watcher outgrew its budget, so the rule is
written into the migration rather than re-learned: _a ratchet reports whether
the floor moved; it does not re-audit history to do it._
