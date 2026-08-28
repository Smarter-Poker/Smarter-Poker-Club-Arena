# A campaign can decay for a month and every number on the page stays fine

**2026-08-28.** Every figure this system reports is a **lifetime** total.
`fn_ad_stats` groups by ad and slot and nothing else, so a campaign that worked
for three weeks and has done nothing since looks identical to one that is
working now. The averages absorb the decline, and the longer a campaign runs
the more inertia its own history gives it.

That is the shape of a metric that cannot tell you to act. `last_event_at`
catches a surface that stopped completely; it says nothing about one that is
quietly halving.

## fn_ad_daily(days)

One row per ad, per slot, per **day** — impressions, clicks, and the people
behind them. The panel draws fourteen of them as a sparkline beside each
placement, in block eighths, with the day-by-day numbers in the tooltip.

Drawn only with two or more days: a single bar is not a trend, it is a number
wearing one.

## Why it is live-computed and not a rollup table

At 201 events that is not a close call, and a rollup would be a second source
of truth to keep in step — the estate has enough of those. `idx_ad_event_rollup`
already covers the query.

When `ad_event` gets large enough for it to matter, the answer is a materialised
daily table fed by **Open Claw** — `CLAUDE.md` §11: Open Claw is the only
sanctioned scheduler and a new cron is a governed change — not a bigger limit
here. That is written into the migration so the next person does not add a cron
casually, or a `.limit()` quietly.

The window is a parameter clamped to 1..365. A year of daily rows for one
campaign is 365 rows; a request for ten years is a mistake, not a need.

The migration checks its own arithmetic: if the daily impressions do not sum to
`ad_event` over the same window, it aborts. A trend that contradicts the totals
beside it is worse than no trend, because there is no way to tell which is
lying.

---

# And two things the panel had been assuming

## A weight must be positive

`weight` had no CHECK. `20260828070000` made weight the **share of voice**, and
its draw guards the exponent with `GREATEST(weight, 1)` precisely because a `0`
or a negative would divide by zero or invert the ordering.

That guard is correct and stays. But the panel offers a free-text weight box,
and the database should not be silently reinterpreting what somebody typed. A
weight of 0 is not "vanishingly unlikely", it is a mistake, and the save should
say so at the point it happens rather than the resolver quietly fixing it up
every draw for the rest of time.

## A flight window cannot end before it begins

`starts_at` and `ends_at` had no ordering rule, so a window that ends before it
opens saved cleanly. The resolver requires `starts_at <= now() AND ends_at >
now()`, which such a row can never satisfy — so it is a campaign that is live,
correct-looking in the editor, and dead everywhere else.

Exactly the silent-nothing this system keeps finding.

## Both refuse to constrain data they would reject

Zero violations today, verified before adding either constraint. If there had
been any, the migration aborts with a count rather than rejecting real rows
retroactively — a constraint that would invalidate existing data is a question
to answer, not a thing to force through.

## Verification

```
npx tsc --noEmit     clean
npx vitest run       504 files, 0 failures
fn_ad_daily(30)      2 days, sums matching ad_event exactly
```
