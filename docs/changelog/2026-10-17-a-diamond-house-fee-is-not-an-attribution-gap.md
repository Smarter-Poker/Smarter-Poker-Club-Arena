# A Diamond House Fee Is Not An Attribution Gap

**Date:** 2026-10-17
**Alert:** RakeAttributionBacklog ("142 settled rake rows have credited nobody")
**Migration:** `20261017105232_a_diamond_house_fee_is_not_an_attribution_gap.sql`

Read on production at 10:50 UTC: all 144 rows in `v_tournament_rake_attribution_gaps` were Diamond Arena events (club `002c2d27`, `destination = 'diamond_house'`, verdict `credited_nobody`, settled from 2026-10-07, when the arena's first tournaments ran). Every chip settlement in the last 30 days (508,227 rows) was attributed; there were no chip gaps.

The Diamond Arena is diamonds only. `fn_settle_tournament_rake` pays a Diamond event's fee to `ca_diamond_house` and writes no chip fee source, so no VIP points, chip rakeback or agent commission is owed on it. Crediting nobody is the designed result, and counting it kept the alert permanently on, which would also have hidden a real chip gap.

The view now leaves out exactly `destination = 'diamond_house'`. The migration is pinned to the reviewed view definition (md5 `316450d4...`), keeps every column, owner and grant, and proves in the same transaction that no Diamond Arena row is still counted and that the view still returns every chip gap. Nothing was backfilled, because nothing was owed.

Law: `tests/a-diamond-house-fee-is-not-an-attribution-gap.law.test.ts`. Runbook: `docs/runbooks/rake-attribution-backlog.md`.
