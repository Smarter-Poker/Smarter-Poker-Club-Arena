# The VIP page stops inventing two figures (2026-09-30)

`/vip` printed four VIP point figures. The platform computes two of them.

`vipPoints.monthly` and `vipPoints.activeStreak` were initialised to `0` in
`VIPPage.tsx` and **nothing in the repo or the database ever wrote either
one**. They reached the screen as their own initial state, in two places
each:

| Surface                       | Label           | What every player was told |
| ----------------------------- | --------------- | -------------------------- |
| `RewardsSurfaceHeader` metric | "Monthly"       | `0`                        |
| `RewardsSurfaceHeader` metric | "Active Streak" | `0 Days`                   |
| `VIPMembershipPlate` dl       | "This Month"    | `0`                        |
| `VIPMembershipPlate` dl       | "Active Streak" | `0 Days`                   |

This is the same shape as the `diamondBalanceState` / `vipPointsState` defect
fixed on this page in `2026-09-30-four-honest-reads-on-the-diamond-wallet.md`,
which made a failed read print "Unavailable" instead of a confident zero. That
fix covered the two figures the `vip_points` read actually owns. These two were
left behind because no read owns them.

## What decided it

**`monthly`: the raw data exists; a correct client-side read does not.**

```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('vip_points','vip_points_ledger');
```

`vip_points` has exactly four columns: `user_id`, `current_points`,
`lifetime_points`, `updated_at`. There is no monthly column, so the page's
own read could never have filled the field.

`vip_points_ledger` does carry `points` and `created_at`, and it is
client-readable (RLS `vip_points_ledger_select_own`, `auth.uid() = user_id`).
So "points earned this month" is derivable in principle. It is not derivable
_here_:

```sql
SELECT source_type, count(*) rows_this_month, count(DISTINCT user_id) users
FROM vip_points_ledger WHERE created_at >= date_trunc('month', now())
GROUP BY source_type;
--  rake             5,474,114 rows   1,002 users
--  tournament_rake    649,505 rows   1,001 users
```

That is **6.1 million rows this month across 1,002 players, roughly 6,100 rows
per player per month**. Summing that in the browser would be a catastrophic
read on a page load, and it would also be _wrong_: PostgREST caps a request at
1,000 rows by default, so the client would silently sum the first page and
print a confident under-count. Exactly the defect class being fixed.

No aggregate exists to call instead. There is no rollup table
(`vip_points_carry` is a fractional rounding carry, not a monthly total) and no
RPC returning monthly points. A correct wiring needs a new SQL aggregate, which
is a migration, and migrations are out of scope for this task.

**`activeStreak`: there is no source at all.**

No table is the VIP active streak. `profiles.login_streak` is the closest
candidate and it is a dead counter:

```sql
SELECT login_streak, count(*) profiles, max(last_login_date) newest
FROM profiles GROUP BY login_streak ORDER BY login_streak;
--  0 -> 1,421 profiles, newest last_login_date 2026-09-30
--  1 ->     4 profiles, newest 2026-09-23
--  4 ->     1 profile,  2026-09-29
--  6 ->     1 profile,  2026-09-12
```

1,421 of 1,427 profiles read `0`, **including players whose `last_login_date`
is today** - so the counter is not maintained on the live login path. The six
non-zero values are frozen, not live: a streak of `6` whose last login was
2026-09-12 is a broken streak the column still reports as running.
`AchievementTriggerService.onLogin` writes the column, and the repo's own
comment beside it already says as much: "profiles.login_streak the run length
(0 on all 1,023)".

It is also the wrong figure. `login_streak` is a **login-day** counter, and it
already has a home: ProfilePage renders it as "Daily Streak". Putting it in a
VIP _points_ dl beside Points and Lifetime would assert something different
from what it measures. The other six streak tables belong to other products
(`user_daily_streaks` is the daily challenge, plus training, trivia, share,
challenge-freeze state; `user_streaks` and `share_streaks` hold zero rows).
Picking one would be inventing a definition and presenting it as the
platform's number.

A login-day streak also could not be earned by a horse, which has no browser
(CLAUDE.md 10.5). Introducing a figure that structurally reads zero for every
horse is not a filter, but it is a figure horses cannot earn, and that is a
further reason not to invent one.

## What changed

Both readouts are **removed**, in all four places, along with the two state
fields behind them and the two members of `VIPMembershipPlateProps.points`.

Removed rather than given the "Unavailable" treatment its neighbours get.
"Unavailable" means _the read could not answer this time_, which invites a
player to refresh and wait for a number. These two have no source to read
from, so the honest act is to stop making the claim rather than to promise a
figure that will never arrive.

Deleting the state fields, not just the JSX, is the part that matters: a
`monthly: 0` sitting in a state object is what the next reader renders.

The header now carries one metric, "Current Points", which keeps its
`Unavailable` / real-zero behaviour. The plate's dl drops from four cells to
two, "Points" and "Lifetime". Both grids are `minmax(0, 1fr)`
(`.vmp__points` is a fixed two-column grid, `.metrics` is `auto-fit`), with
`min-width: 0` and no `nth-child` rule assuming four cells, so at 375px fewer
items can only give each one more room. Nothing clips.

Deliberately **not** done: the two freed header slots were not backfilled with
Lifetime or Diamonds. Both are real and already read, but adding them is a
product change, not this fix.

## The sweep, and `readAt`

`DiamondService` parsed `read_at` into a `readAt` field on all three diamond
RPC shapes (`DiamondWalletSummary`, `DiamondArenaStatement`, `DiamondFlow`)
and no surface in `src/` rendered any of them, while
`useDiamondWalletSummary`'s own comment described its result as "the truth as
of `readAt`" - a staleness promise nothing kept.

Dropped rather than rendered. Rendering it is new UI on three panes; leaving it
parsed is a fourth unread figure on a money shape, which is how a value nobody
chose ends up on a screen. `tests/the-route-and-the-client-agree.law.test.ts`
already refuses an RPC key that is neither read nor declared, so `read_at` now
sits in each contract's `unread` map with the reason and the note that
restoring the parse and the rendering surface belongs in one commit
(`ChipStatement`'s "Generated ..." line is the precedent if a pane should date
its figures later).

`getBalance()` returned a hardcoded `lifetimeEarned: 0, lifetimeSpent: 0`
under a JSDoc still claiming "Also computes lifetimeEarned/lifetimeSpent from
`wallet_transactions`" - untrue since those reads were deleted. No caller
rendered them, so no player saw the zero, but a doc promising a computed
figure over a literal `0` is how the next reader ships it to a screen. Both
fields are gone from `DiamondWallet`; lifetime totals come from
`getLifetimeStats`, which answers `null` when it could not read.

Everything else the sweep found is reported in the task notes rather than
changed: unrendered-but-correct fields (`onHand`, `arenaSeats`, `arenaEntries`,
summary `lifetimeEarned`/`lifetimeSpent`, `openCashTables`, cheapest-table
blinds, `clubProjectedRakeback`, `clubTreasury`, `bbjPoolId`,
`Transaction.walletType`), and the `DepositWithdrawModal` deposit flow whose
success block, `referenceId`, `feeAmount` and `withdrawAddress` are unreachable
behind `FUNDING_ENDPOINT = null` - staged work behind a flag, not a lie on a
screen, and not mine to delete.

## Pinned

`tests/unit/VIPMembershipPlate.test.tsx` and
`tests/unit/VIPPageHonestReads.test.tsx` each gain a pair: one test that the
fabricated figures are gone, and one that a **genuine zero still prints**. The
pairing is the point. A suite that only proved the invented figures were absent
would pass just as happily against a page that had stopped reporting real
figures at all, which is the same dishonesty facing the other way.
