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
