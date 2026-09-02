# A guarantee is a promise

Dan asked the right question: _"we never have to worry about wrong amounts
getting paid out or users not getting paid out?!"_

The honest answer was **no** — and the reason the platform couldn't answer it
is that every settlement check built so far, mine included, only looked at
**over**payment. Nothing watched the direction that hurts a player.

## What the check found

Over 48 hours, excluding satellites (paid in seats) and Spins (club-funded
multiplier): 8,380 completed events, 4 overpaid — and **six underpaid by
1,703.00 chips**. All six share one signature: `credited == prize_pool`
exactly, while `guaranteed_prize` is higher.

| event                    |  pool | guaranteed |  paid | short |
| ------------------------ | ----: | ---------: | ----: | ----: |
| Union Grand Championship | 1,860 |      2,500 | 1,860 |   640 |
| Union Grand Championship | 2,040 |      2,500 | 2,040 |   460 |
| Union Mystery Bounty     |   450 |        800 |   450 |   350 |
| Evening Mystery Bounty   |   225 |        400 |   225 |   175 |
| Afternoon Bounty         |   138 |        200 |   138 |    62 |
| Turbo Tuesday Opener     |   234 |        250 |   234 |    16 |

A guarantee is a promise that the pool gets topped up to a floor if the field
falls short. These events paid out only what the field put in. The advertised
number and the paid number are different, and the difference is owed.

`financial_alerts` already has a `Tournament.guarantee_not_met` source. It fired
once, on 2026-08-31, and nothing acted on it — the theme of this whole sweep,
and why this is now a ratchet rather than another log line. It is the eighth,
and underpayment is a **critical**: it is the one failure a player can see and
the operator cannot argue with.

## What "no escrow" actually means, and what the industry does

Researched because Dan asked how other rooms handle it. The standard design for
gaming ledgers is a **liability account per game** — the stake is held in a
"bet pool" liability, and settlement _debits that pool_ and credits users, so
double-entry forces the pool to reconcile to zero. If one side is missing, the
books don't balance and the system says so.

Club Arena has no such account. `tournaments.prize_pool` is a running total
that **nothing ever decrements** — verified: no function anywhere subtracts
from it. Payouts don't draw it down, and the supply snapshot counts it only
`WHERE status NOT IN ('COMPLETED','CANCELLED')`. So at the moment a tournament
completes, the liability simply stops being counted, whether or not the prizes
matched it. Overpay and chips appear; underpay and they vanish. Neither is
forced to balance by anything.

The fix that matches the industry pattern is to make the pool a real balance
that payouts drain and that stays counted until drained — an architecture
change to the buy-in and payout paths, and Dan's call. Until then the two
ratchets (over and under) are the guard, and they now cover both directions.

## Also verified in this pass

- **Satellite winners are being paid.** Nine events looked underpaid; all nine
  were satellites, and the winners were entered into the target tournament —
  the seat _is_ the prize. `fn_satellite_conservation_audit()` returns clean.
  The `tournament_tickets` table holds exactly one row (cancelled, 2026-08-21),
  so the ticket mechanism is unused; entry is direct.
- The rake double-bank fix holds: **0%** of raked hands bank twice, and
  `club_wallets` is flat on live traffic.
