# The Weekly Close Proofs Outlive The Close (2026-10-16)

## What Dan Asked For

"GIVE THE RAKE BACK MORE TIME (UNLIMITED IF POSSIBLE)."

## What Was Wrong

The union weekly rakeback close for the week of October 5 to 12 had been
running since October 12, 154 attempts, and never finished. Job 272 proves a
close in pieces (two-hour earned-plan windows, flow windows, settlement
windows, P&L certificates) and trusted each piece for 12 hours. A union week
takes longer than that to prove inside job 272's 240 second ticks, so the first
pieces went stale before the last were proved and the close started over:

- October 15, 15:23: earned plan certified; 15:26 club P&L certified.
- 17:33 to 23:28: round 2 and round 3 windows proved.
- October 16, 03:23: the earned plan turned 12 hours old, every window was
  proved again (03:23 to 07:37), then the flows and certificates again
  (09:22 to 12:22), by which time the club P&L from October 15 had expired too.

## Why Not Unlimited Time Per Tick

The 240 second tick is not a tuning knob. One writing transaction open for
about 5.3 minutes makes Supabase Realtime drop its replication connection for
every player (`20261012134146`, pinned by
`tests/the-weekly-close-never-holds-replication.law.test.ts`). That bound is
unchanged. More time per tick would take the tables down.

## What Changed

Migration `20261016123337_the_weekly_close_proofs_outlive_the_close`:

- New helper `fn_accounting_close_proof_lifetime()` returns 72 hours.
- The 14 freshness tests in the 10 close functions now read it instead of a
  hard-coded 12 hours. Each function was rewritten only from its pinned live
  preimage with its exact occurrence count checked, in one transaction.

72 hours rather than unlimited: it is several times the longest close observed,
and a close that sits idle for days still re-proves its pieces before it pays,
because the combine steps trust stored proofs rather than re-reading every row.

Unchanged: the 240 second tick and 3 minute scope budget, the one hour life of
a proof that found a problem, the inventory generation key on P&L certificates
(an inventory change still invalidates them at once), and
`fn_rakeback_recompute_split`'s own 12 hour recompute rule.

## Verified Live

Recorded as `20261016123337`. `fn_accounting_close_proof_lifetime()` returns
72:00:00, all 10 functions read it, and no close function still carries the
12 hour text.

## Pinned

`tests/the-weekly-close-proofs-outlive-the-close.law.test.ts`.

## Correction The Same Day

`fn_accounting_close_certificate` turned out to be one of the 40 inventory
proof sources sealed by md5 in
`smarter_private.original_inventory_proof_sources_match()`. Rewriting it broke
the seal, the inventory generation went NULL at 12:33, and the close fell back
to re-proving the week live. `20261016133404` put that one function back on
its exact sealed body and the generation returned. The 72 hour lifetime still
covers the two-hour windows and the other nine readers, which is where the
time went; the six combined certificates keep 12 hours. See
`docs/changelog/2026-10-16-the-weekly-close-fits-its-tick.md`.
