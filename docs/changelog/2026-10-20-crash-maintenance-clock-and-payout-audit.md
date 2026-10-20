# Crash preserves flight time through maintenance

Recovered the exact already-installed migration `20261020033541` from migration
history. It was missing from protected source. It makes the Crash receipt,
decision and time-settlement eligibility use elapsed flight time less the
overlap with completed and current maintenance freezes. Production installation
is recorded separately; this migration must not be replayed there.

A further guarded migration keeps the clock paused when an active freeze has
already written its thaw checkpoint. The active interval and recorded interval
are unioned per freeze start, preventing both early advancement during a
delayed thaw and double subtraction. Regression cases cover a checkpoint
overrun, future certified release, and exact resumption after its extension.

The client still extrapolated from its original wall-clock anchor after that
database installation. During a break its curve could reach a multiplier the
server would refuse. The page now adopts elapsed time on every open-round
answer, holds the curve at the server's elapsed time during maintenance, and
disables manual cash-out until play resumes. The sealed result, payout terms,
caps, rounding and timers of other games are unchanged.

Regression coverage exercises the rendered flight, the page across a full
five-minute break, and real authenticated PostgreSQL settlement before/after
the clock migration. Database cases cover current, historical and successive
freezes, a flight starting inside a freeze, exact interval boundaries, no
double subtraction, an exact resumed 2.57-chip payout, private permissions and
receipt replay. The existing accounting qualification runs these cases and
retains the Crash future-multiplier, foreign-player, cap and duplicate-payout
checks.

## Read-only production payout audit

The October 20 snapshot contains 200 nonfixture wheel spins, 35 Plinko games
(13 individual drops and 22 batches), 29 Crash rounds, 23 Crossing rounds and
40 Mines rounds. Their 174 positive chip credits total **1,327.87**:

| Game                                   | Chips Won | Chips Journaled |
| -------------------------------------- | --------: | --------------: |
| Wheel, including instant Upgrade chips |    396.80 |          396.80 |
| Plinko                                 |    383.38 |          383.38 |
| Crash                                  |    143.64 |          143.64 |
| Crossing                               |    193.28 |          193.28 |
| Mines                                  |    210.77 |          210.77 |

Every prize was compared with the sum of its canonical Promo/Main Bank journal
legs, recipient and club. No missing, excess, duplicate or orphan payment was
found. Crash, Plinko and choice amounts were independently recomputed from
their sealed stakes, multipliers, minimums, ladders and cent-rounding draws.
Versioned wheel chip receipts agree with their stored prizes. Wheel-earned
bonus payments remain within their original award reservations. Public roles
cannot call the private chip payer or settlement decider.

Historical September 9/10 transaction metadata predates the Promo/Bank split
fields; those rows still reconcile through their canonical journal keys.
Recorded receipt agreement is evidence for these observed games, not a
guarantee against every future failure. No player funds were spent by this
audit and no odds, rounding rule or payout amount was changed.

Protected review, publication and affected live proof are tracked separately in
the task checkpoint.
