# A bounded function puts an obligation on its callers

2026-09-07, the same afternoon as
[the rakeback drain fix](./2026-09-07-the-rakeback-that-was-earned-is-the-rakeback-that-is-paid.md).
That change made `settle_club_rakeback` **bounded** — at most 40 periods, at
most ~4 seconds — because the unbounded version could not finish inside the 8
second `statement_timeout` every server-side role carries, and had therefore
settled nothing for eighteen days.

Bounding it was right. What I did not do in the same breath was ask what that
does to the three things that call it. Every one of them called it **once per
club and moved on**, which was correct when one call settled everything and is
under-draining now.

This is the verification pass finding what the build missed.

## What was wrong

### 1. The engine drained 40 periods per club and then latched for a week

`RakebackSettlerService.runWeeklyFinancialClose()` is gated to run **once per
ISO week** and stamps `daemon_state.high_water_mark` at the end whether or not
anything drained. Player rakeback was step 1 inside that gate. So: 40 periods
per club, once, then sealed for seven days. Nothing re-arms it —
`scheduleCatchUp()` covers the `rake_records` drain, not the payout.

It also called through `supabaseRpc()`, which returns `{ error }` and
**discards `data` entirely**. A refusal comes back as HTTP 200 with
`success: false`, so a call that settled nothing because it was not authorised
was completely invisible.

**Fixed:** the drain moved out of the weekly gate into `runRakebackDrain()`,
which runs **every 30-minute cycle**, loops per club until `periods_remaining`
is 0, and reads the response. This is the treatment `runUnionWeeklyRakeback()`
already had, for the reason its own comment gives: the RPC is idempotent and
no-ops when nothing is due, so a club not finished this cycle is finished half
an hour later instead of next Monday. It is ordered **after** the union 90%
lands, because player rakeback is funded from `clubs.chip_treasury` and the
union payback is what fills it.

### 2. The browser service read a key that has never existed

`FinancialCronService.settleAllClubRakebacks()` read
`settlement.total_distributed`. The RPC returns `total_payout`. `undefined > 0`
is `false`, so `clubsSettled` and `totalDistributed` were **always 0** and the
debug line never fired, whatever the RPC actually paid. It also discarded
`error` and never checked `success`.

This one predates today. Nothing schedules the method any more (`start()`
retired it), so it was never a live money risk — but a wrong key sitting in a
money path is a trap for whoever calls it next.

**Fixed:** reads `total_payout`, checks `success`, reports a refusal, and says
how many periods are still pending rather than implying it finished.

### 3. The admin button would roll back the periods it had just paid

**This is the one that mattered.** `fn_run_pending_rakeback_settlement` is what
*Settle Now* on the settlement dashboard calls, and the dashboard passes
`p_max_clubs = 200`. It loops `settle_club_rakeback` over every club with
pending work **in one transaction**, and carries no `statement_timeout` of its
own. The `authenticated` role it arrives as is pinned at 8 seconds.

That was harmless while the inner function returned instantly — which it did,
because it was being cancelled. Now that it does real work, the second busy club
exhausts the 8s budget, the statement is cancelled, and **because it is one
transaction every period it just settled is rolled back**. The admin sees
`canceling statement due to statement timeout`, the players are not paid, and
the money that appeared to move did not.

The same defect this phase started with — a drain cancelled by a timeout nobody
budgeted for — one level up, introduced by fixing the level below.

**Fixed** (`20260907195018`): a 6-second wall-clock budget checked *between*
clubs, so it returns with what it did instead of being shot with what it did. It
now also reports `deferred_reasons`, `periods_remaining` and `out_of_time`, so
an admin who presses the button and sees nothing move is told why.

### 4. And a starvation bug in the batch itself

`fn_settle_club_rakeback_batch` took the **oldest 40** pending periods each
pass. A deferred period is still `pending` — deliberately, the money is still
owed — so the same 40 were re-selected on every pass for ever. A club whose
oldest 40 are all permanently deferred would do forty indexed refusals, settle
nothing, and never reach the payable periods behind them, while reporting
success.

Measured on Midway, where it would bite: **24 of the first 40 in queue order are
periods whose player has no membership at the earning club**, 16 are payable.
So the head is not fully blocked today and the drain does make progress — but
60% of every batch was being spent on periods that cannot pay, and it is one
unlucky ordering away from zero. 792 of its 1,767 periods carry that reason
permanently.

**Fixed** (`20260907195158`): `ORDER BY defer_count, period_end, id`, with a
matching partial index. Least-refused first. Nothing is skipped or given up on —
`defer_count` only decides *order* — so a period that becomes payable is picked
up on the next pass it reaches the head. Self-balancing, and it needs no list of
"permanent" reasons to maintain and get wrong.

Proved in a rolled-back fixture: with every no-membership period pushed to
`defer_count = 9`, the head of the queue becomes 40 untried periods and 0
repeatedly-refused ones.

## What is not changed

The World Hub's Monday cron (`/api/cron/rakeback-period-settle`) still calls
once per club per week. With the engine draining every 30 minutes it is now a
redundant safety net rather than the primary path, and it is fixed separately in
that repo.

## The lesson worth keeping

A bound is a contract with two halves. I shipped one half and verified it
thoroughly — conservation to the cent, 1,691 periods, 987 players — and the
half I did not look at would have quietly capped the platform at 120 periods a
week. **When you make a function stop early, go and read everything that calls
it in the same change.**
