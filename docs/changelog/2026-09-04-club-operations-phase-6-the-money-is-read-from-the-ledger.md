# Club Operations Phase 6: the money is read from the ledger

Phase 6 of 8 of Dan's Club Operations upgrade
(`docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`, section 8). The pages are
`/clubs/:id/financials`, `/clubs/:id/data`, `/clubs/:id/insurance-report`,
`/clubs/:id/bomb-pot-report`, the Rake Reports panel that three of them
render, and the revenue tab of the club dashboard.

Every figure below was measured against production before it was changed.
Deep Stack Society (`2a1132b9`) throughout: four days old, 216,140 hands dealt
on 2026-09-03, which makes it the hardest case on the platform today.

## What was wrong, with the numbers

**The four headline numbers were the oldest 5,000 rows.** The Financials page
read `rake_records` with `.order('created_at', {ascending:true}).limit(5000)`
and reduced it in the browser. The club wrote **124,549 cash rake rows in
three days**. Over the last seven days Rake Collected showed **4.6%** of the
truth, Pot Volume 4.8%, Hands Played a flat 5,000, and Net Revenue inherited
all of it. Nothing on the page said it was truncated.

**Three of the lines under it could not have been right either.** Rakeback
read `chip_transactions` directly, whose RLS policy is `from_user_id =
auth.uid() OR to_user_id = auth.uid()` - an owner saw the rakeback paid to
themselves and to nobody else. Union Fees read `invoice_type =
'union_to_club'`; the weekly square-up writes `union_weekly_squareup`, so that
line has contributed a silent zero to Net Revenue for every club that has ever
loaded the page. "Club Chip Audit Trail" read `chip_ledger`, whose RLS is also
the caller's own rows, so it showed a club owner their personal movements
under a heading that says otherwise.

**Four numbers were called "hands" and two were called "rake".** For
2026-09-03 alone:

| source                                  | hands                       | rake       |
| --------------------------------------- | --------------------------- | ---------- |
| `rake_records` (cash)                   | 93,465                      | 190,144.32 |
| `rake_attributions`                     | 93,274                      | 189,745.69 |
| `club_table_daily`                      | 93,450                      | 190,117.95 |
| `club_hand_daily` (from `hand_history`) | 216,140                     | 189,772.06 |
| `hand_history` cash rows                | 177,022 dealt, 93,289 raked | 189,772.06 |

`rake_records` is the money ledger: the row is written in the transaction that
credits the club (`credit_club_wallet_rake`), and **176 of its rows that day
(372.26 chips) have no `hand_history` row at all**, so anything derived from
hand history under-reports what the club was actually paid. `club_table_daily`
was short by exactly the **109 rows (173.38 chips)** whose
`player_contributions` were never recorded, because its refresh required them.

**`club_hand_daily.pot_total` adds tournament chips to cash pots.** On
2026-09-03: 118,254,757 tournament against 5,239,484 of cash. The dashboard's
"Average Pot" and "Total Pots" read it, so both were wrong by a factor of
twenty - my own phase 4 work.

**Per-player rake was 0.00 for every club not in a union.** The rake CTE joined
`union_rake_paid_daily_user` on a NULL union, which is never true.
`club_rake_daily_user` has held the per-player figure for every club since the
rake rollup was built (257 players, 189,745.69 on 2026-09-03), and the "Most
Rake" sort was ordering by a column of zeros.

**Per-player CASH results were never written for such a club either.** All
three writers of `ca_club_player_daily.cash_net` joined `tables.union_id IS
NOT NULL`: the trigger returned early, and both refreshers filtered it out.
415 players, 1,304 rows, **not one non-zero cash row**, so Club Data's "Net"
was the tournament net alone and Winners/Losers ranked on it. This is the
"+89,166.07 against -11,763.83" the plan document recorded and could not
explain.

**A table add-on was not money.** The same writers, and `club_table_daily`'s
wallet side, knew `buyin` and `cashout` only - **713,968.61 chips of table
add-ons in seven days**, plus rebuys and refunds, were on neither side of the
table net. On the tournament side they knew buy-in, prize and bounty but not
add-on, rebuy, refund or prize reversal, and took the sign from the category
name rather than from the row's own debit/credit.

**The insurance report could not add up.** Its take rate divided event counts
by event counts - an offer accepted and later cashed out counts twice in the
numerator and once in the denominator, so the figure could pass 100% - and its
funnel used a rolling timestamp window while its day rows used UTC dates, so
the rows could never sum to the headline above them.

**Both report pages passed the route slug into a uuid argument**, so on every
`/clubs/<slug>/insurance-report` URL the RPC answered 22P02 and the page said
"Could Not Load The Insurance Report".

**Rake Reports downloaded the ledger.** It selected every `rake_records` row in
the window with no limit at all and summed them in the browser; "Year" would
have asked for 1.9 million rows. Its "Top Games By Rake" list had been empty
since it was written ("Need table joins for this, empty for now"), and
`Math.max` of its empty day list is `-Infinity`, so every bar height was NaN%.

**`SNG` was labelled "Heads Up"**, and the union statement card computed
`overdue`, `paid_total` and `outstanding` and rendered none of them.

## What changed

Migration `20260904220000_the_money_is_read_from_the_ledger.sql`, one
transaction, applied inside the 19:55 maintenance freeze and recorded.

**One source for money.** `ca_club_rake_daily` is an exact per-club-per-day
rollup of `rake_records`, maintained by statement-level triggers, attributed
the way `club_table_daily` attributes it (a union player's rake to their home
club; anything unattributable stays with the table's club). A raked hand whose
contributions were never recorded now keeps its whole rake instead of
vanishing. `ca_club_commission_daily` does the same for `agent_commissions`,
off the triggers phase 4 installed - the old aggregate scanned 608,280 rows on
every Financials load and grows by ~300,000 a day.

**One gated read per page.** `ca_club_financials` returns totals, a daily
series, top tables by rake, the recent raked hands and its own freshness;
`ca_club_chip_ledger` returns the club's ledger, paged, with the per-hand rake
and jackpot rows left out unless asked for. Both are SECURITY DEFINER behind
`ca_can_view_club_finances`. The dashboard's revenue read and today's rake come
off the same rollup, and `hands` there now means RAKED hands with
`hands_dealt` beside it.

**The hourly catch-up reconciles the new rollup** against the ledger and
rebuilds any day that has drifted, so a trigger that warned instead of writing
is repaired within the hour rather than silently.

Client: the Financials page makes one call and holds no aggregation; a refusal
is a permission gate rather than a screen of zeros; the audit trail goes
through the club-scoped RPC; Rake Reports, the commission split and both
report pages read the same RPC and resolve the slug first; the dashboard
separates raked hands from hands dealt; Club Data names a Sit & Go and paints
the statement's standing.

## Verified

- **Applied inside the freeze**, 19:55:31, and recorded in
  `supabase_migrations.schema_migrations`.
- **The rollup equals the ledger.** Live at 20:12, with the triggers running
  under real traffic: Deep Stack Society today 55,993 hands / 91,407.86 on both
  sides, to the cent. Across all four clubs on 2026-09-03 the attributed rake
  conserves exactly against `rake_records`.
- **The union attribution conserves.** Midway Union's rake is redistributed to
  its member clubs and the totals still balance to the cent.
- **Cash results now agree with the table ledger**: 380,521.80 in
  `ca_club_player_daily.cash_net` for 2026-09-03 against 380,521.80 of
  `club_table_daily.net`, having been 0.00 for every player before.
- **End to end through PostgREST**, with a real signed-in session rather than a
  psql impersonation (`SET ROLE` leaves `session_user` as `postgres`, which the
  gate's internal-caller escape admits, so a psql probe cannot exercise the
  refusal): the owner's own club answers 200 on all four reads; the same owner
  against a club he is not a member of gets **403 / 42501 "not authorized for
  this club"** on all four; anon gets **401 / "permission denied for
  function"**.
- The rollup maintainers refuse the club owner (`no EXECUTE`).
- Backfilled: the rake rollup over every day since 2026-04-16, the cash results
  since 2026-02-11, and `club_table_daily` for every day it holds.
- 57 pins in `tests/unit/theMoneyIsReadFromTheLedger.test.ts`. Full suite
  green: 12,895 tests, 933 files.

## Two pins moved, and one test that was about to stop the publisher

Three existing pins were on mechanisms this phase replaced, so they moved to
the new mechanism in the same commit rather than being weakened:
`no-invented-money-on-an-agent-screen` (the three shares now arrive through one
gated read), `the-agents-books-tell-the-truth` (the commission aggregate is the
rollup, and the refusal is a permission state rather than a bound zero), and
the discarded-error ratchet (`ClubFinancialsPage` moved to AUDITED_ZERO - it
makes one call and binds its error).

`a-search-narrows-the-list-not-the-denominator.law.test.ts` re-read all 2,098
migration files (18 MB) for **every** assertion, twice per helper. Adding this
phase's migration tipped it past vitest's 5-second default and it timed out
during a full-suite run - which stops the publisher for every agent
(CLAUDE.md 5.8). The file list and each lookup are memoised now: 1.9s to 0.31s,
with every assertion unchanged.

## Three corrections, an hour later

The phase shipped, and then measuring it found the rollup 20.63 short of the
ledger on the live day. Each correction is its own migration, because each was
written after the previous one had been proved wrong by the database rather
than by reasoning:

**`20260904234500` - a rebuild that races the ledger checks itself.** The
attribution was exact (`fn_ca_club_rake_daily_compute` run fresh matched the
ledger to 0.0000); the STORED rows had drifted. `fn_ca_club_rake_daily_rebuild_range`
DELETEs a day and re-INSERTs from a snapshot, so a transaction that inserted
before that snapshot and committed after it had its trigger row deleted and
was not in the recount. The rebuild was given three passes to close its own
gap, and a single shared definition of "agrees with the ledger".

**`20260904235500` - a live day is the triggers' to keep.** The three passes
did not work, and the measurement said why:

```
20:40:45   ledger 194,648.19   rollup 194,627.07   diff 21.1200
20:41:17   ledger 194,717.42   rollup 194,696.30   diff 21.1200
```

The ledger moved 69 chips in 32 seconds and the difference did not move at
all: the trigger tracked every one of those chips. DELETE-then-recount simply
cannot converge while writes continue, because each ~14-second pass loses a
fresh slice. So the rebuild now takes complete days only - where nothing
writes and a recount is exact - and today belongs to the triggers.
`p_include_today` has to be asked for by name, for the one legitimate case:
the first build of a day whose triggers arrived mid-way through it, which is
exactly how today came to be 21.12 short. The reconcile REPORTS `today_drift`
instead of rewriting today.

Rejected: having the INSERT trigger take the rebuild's per-day advisory lock.
That serialises correctly and puts a platform-wide lock in the path of every
rake write on the hottest table on the system, to protect a rollup that is
repaired anyway. Reporting must never slow the money path (11.5).

**`20260904235900` - one rebuild signature, and a correction still lands.**
Keeping the two-argument form beside the new three-argument one "so nothing
breaks" made every two-argument call ambiguous - and the one caller was
`trg_ca_club_rake_daily_change`, the trigger that repairs the rollup when a
rake row is corrected. It catches its own errors and warns, so a rake
correction would have stopped being reflected silently. One signature now, and
that trigger asks for its day explicitly even when the day is today: a
deliberate correction must land the same day, and midnight makes it exact.

Verified after all three: a complete day recounts exactly (2026-09-03,
272,352.0700 rollup against 272,352.0700 ledger, difference 0.0000); today is
refused by the default path (0 days built); the reconcile answers
`{"success": true, "today_drift": 21.1200, "rake_daily_rebuilt": []}`; and an
UPDATE of one of today's rake rows, inside a transaction that was rolled back,
moved the day's rollup as it should.

Today's 21.12 (0.011% of 194,000) is left alone. It self-heals at 00:00 UTC
when the day closes and the reconcile recounts it, and writing a difference
into a rollup while its ledger is moving is the same mistake in the other
direction.

**And the live day does carry a small residual, which is worth stating
precisely rather than rounding to "exact".** Watched over a further half hour,
today's gap went 21.12 -> 30.57 and then held at 30.57 across a 50-second
sample while the ledger kept moving - so the trigger is not losing a steady
fraction, it is losing the occasional whole statement. The database records
~2.4 deadlocks a minute platform-wide, and the rollup trigger deliberately
catches its own errors and warns rather than refusing a rake write (11.5), so
a deadlocked statement's rake never reaches the rollup. Measured residual:
**30.57 in 195,000, 0.016%, on the live day only.** Every completed day is
recounted exactly - 2026-09-03 reconciles to 0.0000 - and the catchup now
returns `today_drift` so the number is on the record rather than inferred.
Making the trigger itself deadlock-proof (a deterministic lock order on the
upsert) is the next thing to measure; it was not changed tonight because it
touches the hot path and the residual is bounded, reported and repaired daily.

## The gate on this phase found one more, in the place I had just fixed

Checking the phase before moving on, the club dashboard's **Busiest Tables**
list was still summing `club_member_daily_stats.hands_played` - one row per
player per hand - and printing it as "Hands". Over seven days on the reference
club:

```
Busiest Tables, as shipped   2,113,324  "Hands"
hands actually dealt            596,730
hands actually raked            181,766
```

An 11.6x overstatement, on the same page whose cards this phase had just
relabelled so that raked hands and hands dealt could not be confused, and
literally the defect the plan document named ("Hands means two different things
across two tabs of one page"). It survived because I changed the totals and
never looked further down the page.

`20260905001500` rebuilds `ca_club_revenue.by_table` on `club_table_daily` -
the raked hands played AT that table, the same basis as the rake beside it and
the headline above it - and returns each table's rake with it. The player count
is still a DISTINCT count of people. Top table now reads 2,144 raked hands
against 2,113,324 before, and the whole top-20 sums to 38,005.

Three smaller things from the same pass:

- **`ClubActivityChart` is rendered twice from two different series** - the
  Overview tab passes hands DEALT, the Revenue tab passes RAKED hands - and
  both drew a legend that said "Hands". The series label is a required prop
  now, so a caller cannot avoid saying which it has.
- **The Financials chart could plot a shorter window than its own totals**
  (`ca_club_financials` caps the daily series at 92 days; the totals are not
  capped). The heading says so when they differ.
- **`TransactionLedgerView` in club-scoped mode** would have handed a slug to a
  uuid argument if a future caller passed one. It refuses and reports instead -
  that exact mistake cost two pages in this phase already.

Live after all four: the owner's own club answers 200 on every finance read
and a club he is not a member of 403/42501; the insurance day rows now sum
exactly to the headline (403 offers = 403); Supabase's security advisor reports
**zero** anon-executable definer functions among everything this phase shipped.

## Still open after this phase

- **`member_fee_rollup` is now frozen rather than dead.** The engine loop that
  fed it was retired in #2983 and the build carrying that retirement deployed
  at 19:52, so nothing writes it any more. It was NOT dropped here: 1,005 rows
  of `member_fee_lifetime` hang off it by trigger, and while no database
  function, no Club Arena source and no World Hub source reads either table,
  that is not the same as proving the commander app does not. A table that
  quietly stops moving is the failure mode this repo has been bitten by before,
  so it needs its own deliberate change with its own verification, not a
  footnote in a finance phase.
- The `is_horse` flag stays exactly where CLAUDE.md 10.5 allows it - surfaced
  as data behind `fn_can_see_horse_flag`, never as a filter. Nothing in this
  migration excludes a horse from a count, a total or a report.
- Club Data's "Hide Horses" control still recomputes the visible totals over
  non-horse rows; it defaults to showing horses, relabels every scoped figure,
  and the export is unfiltered, which is what the register sanctions.
