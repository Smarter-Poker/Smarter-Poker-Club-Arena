# An Open-Week Refusal The Database Already Proved Is Not Asked Again (2026-09-26)

## What Was Slow

After #5269 the rakeback settler's watermark moved again, but between 06:59 and
07:35Z it drained only about 7,000 records an hour. The engine log shows the 60 s
catch-up re-arming after every halt; the pages themselves were slow. Each page
called `fn_rakeback_recompute_periods` for up to three club-weeks of the open
week, and each call took 20 to 222 s because `fn_calculate_cash_rakeback_periods`
reads the whole week before it refuses with `cash_source_receipts_incomplete`.
While the settler is behind, that refusal is certain.

## The Fix

The refusal carries `source_count`, the number of the club-week's attributions
without an accrued source. Only the settler accrues cash sources, each accrued
source returns one credit, and one credit completes at most one attribution. The
settler remembers the reported count per club-week, lowers it by every credit
later pages return for that club-week, and while at least one must still be
incomplete it records the page's period as deferred without sending the call. A
fresh start, any other outcome or an exhausted count sends the real call, so the
page carrying a week's last record is always recomputed, and the weekly close
recomputes every whole period before paying.

## Regression Protection

`server/src/services/rakebackWatermark.test.ts`: one call across three pages
while the bound holds (fails before: three calls), the real call once the bound is
exhausted, after any other reason, after a restart, and for malformed counts.
