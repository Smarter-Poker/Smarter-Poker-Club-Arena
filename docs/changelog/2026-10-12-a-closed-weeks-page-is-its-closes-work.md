# A Closed Week's Page Is Its Close's Work (2026-10-12)

## What Happened

From 07:02 UTC the rakeback settler held its watermark at 2026-10-12T06:51:48Z. Its page straddled the week that closed at 07:00 UTC (2026-10-12 00:00 America/Los_Angeles): 302 buckets of the closed week for Club JAQK and SHARK CLUB. Every page-scoped `fn_rakeback_recompute_periods` call of that week went to the calculator's evidence path. Its evidence checkpoint is keyed by `fn_accounting_clubs_scope_digest()`, a digest of every club on the platform, which changed when a club was created that morning, so each call re-read the whole week from its first batch, ran into the function's 300 s `statement_timeout` and rolled back without recording anything. 140 failures a cycle, every 30 minutes; the cursor never moved.

Because the settler had not reached the end of the week, the conservation sweep and the settlement correctness check both reported it (incidents f7258367 and c4f239d1): the union weekly cascade refuses a week whose cash rake is not fully accrued.

## Fix

`RakebackSettlerService`: a page of a week that has ended is not sent. `periodWeekHasClosed(periodEnd, now)` answers whether the Pacific accounting week holding now starts after `period_end` (the same week boundary the database reads), and the per-club-week loop counts such a group as a deferred period, exactly as it already does for an open week the database has proved it would refuse.

This is sound because a page call can never certify a closed week: it writes request status `pending`, and `fn_prepare_accounting_week` reuses only a `complete` `ready` whole-period receipt and otherwise recomputes every club of its scope for the week from source before any payer stage. Sources, agent commissions and the cursor are unchanged; an open week's page is sent exactly as before.

The settler is byte-pinned by `tests/fixtures/private-cash-earning-scope/source-binding.json`; the new pin and its review record are `closed_week_page_left_to_its_close_rebinding_20261012`.

## Left For The Union Accounting Lane

`fn_accounting_clubs_scope_digest()` covers every club, so creating or deleting any club, including one in no union, invalidates every club's evidence checkpoint mid-week, and late in a week the largest club's rebuild cannot finish inside 300 s. This fix stops that from holding the watermark across a week boundary; narrowing the digest to the union shape the counts actually read is a change to the calculator's validity rule and is recorded here for its owners.

Law: `server/src/services/aClosedWeeksPageIsItsClosesWork.law.test.ts`.
