# The check that could not see

2026-09-10. Dan: _"WHY HAVE WE NOT STOPPED THIS FROM OCCURING STILL? WHAT IS
LEFT TO DO TO STOP MORE CHIP DRIFTS FROM HAPPENING?"_

The answer turned out to be that **the platform had not been checking.**

## fn_ca_trial_balance ran 168 times in a week and measured six

It is the global chip-conservation check: fourteen accounts, balance movement
against ledger net, and `fn_ca_trial_balance_watch` files when they disagree.
It is the one thing that would notice chips appearing or vanishing anywhere in
Club Arena.

It chose its window with a clock guess - the first snapshot at or after
`now() - 75 minutes`. Measured:

| thing                 | value                                |
| --------------------- | ------------------------------------ |
| snapshot cadence      | hourly, avg AND max gap **60.0 min** |
| snapshot offset       | **:05:00.9**                         |
| watch offset          | **:20:00.5**                         |
| window opened at      | **:05:00.5**                         |
| margin                | **0.4 seconds**                      |
| cron runs in 7 days   | 168                                  |
| actual readings       | **6 (3.6%)**                         |
| readings before today | **0**                                |

Scheduler jitter decided whether the platform measured its own chip
conservation.

**And it compounded.** The watch files only when two CONSECUTIVE readings
breach in the same direction ("one window is noise"), and records a run only
when it measured something ("a run that measured nothing is not a reading").
Both rules are individually correct and both were added deliberately. But
readings landing 3.6% of the time are almost never adjacent, so the persistence
rule could effectively never be satisfied. **The check was blind and the watch
above it could not fire.**

Nothing looked broken, because when the function has one snapshot it correctly
returns NULL rather than inventing a zero - the right behaviour, and exactly
why this survived. It is 10.86's failure mode with the sign flipped: not a
detector answering when it could not tell, but one that could rarely tell and
said so where nobody was reading.

## The fix

Two snapshots always exist, so the window is taken **from the snapshots** - the
two most recent rows, exactly one interval, every run, whatever the scheduler
does. `p_since` survives as an explicit override; its default becomes NULL. The
watch's default moves with it or it would keep passing the old timestamp down.

The migration refuses to finish unless all fourteen accounts return a non-NULL
difference.

## What it says now that it can see

First live reading, 23:05 to 00:05:

- **eight of fourteen accounts balance to exactly 0.00**
- `total_supply` difference **5.62** - which is precisely the "Unexplained Chip
  Supply" figure on the drift dashboard, now explained
- it decomposes exactly: table_stack 3.87 + union_banks 1.50 + bbj_pools 0.25
- `player_wallets` +5.00 and `tournament_liability` -5.00 cancel: one transfer
  journalled on a single side

The three contributors are the three highest-volume accounts - table_stack
alone took 8,284 ledger legs in that hour - and the dashboard series oscillates
around zero rather than trending. That is snapshot-boundary skew: a hand whose
balance write lands one side of the snapshot and whose leg lands the other. A
leak accumulates in one direction; this does not. The 100-chip threshold
correctly does not file on it.

## Also shipped in the same pass

**A re-point is not allowed to collide.** A cash seat move re-points the
player's open session to the destination table with an UPDATE, and
`cash_player_session_one_open` is unique on `(player, scope, table)` where
open - so a leftover open session on the destination made two open rows and
threw, taking out the whole post-hand `leave_pending` step. **The player did not
leave.** 1,091 of 4,751 seat moves in six hours met that condition (23%); 34
hands failed in 83 minutes. The leftover is now closed as `superseded_by_move`
immediately before the re-point, both swap re-points included. Zero failures
since.

**The big tables freeze early, and never together.** Twice in two days the
database came within hours of forced anti-wraparound autovacuum during live
play and a human had to run VACUUM (FREEZE) by hand. The cause is structural:
autovacuum's ordinary trigger is dead rows as a fraction of the table, so a
large append-only or read-only table never crosses it and waits for the
200,000,000 anti-wraparound path - and they all share one XID history, so they
all arrive together. 21 tables are now staggered between 120M and 180M, largest
first and alone. No cron: Postgres does its own job, earlier, at a different
time for each table.

## Nothing is owed

Checked at the end: **zero unpaid tournament obligations platform-wide, 0.00
owed, no players, no tournaments.** The escrow-vs-counter check reads 1,101 of
1,101 events balanced, 0 overpaid, 0 underpaid, net residual 0.00.
