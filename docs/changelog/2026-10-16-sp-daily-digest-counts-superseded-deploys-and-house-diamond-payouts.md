# The Daily Digest Counts Superseded Deploys And House Diamond Payouts

**Date:** 2026-10-16
**Migration:** `20261016103449_sp_daily_digest_counts_superseded_deploys_and_house_diamond_.sql`
**Law:** `tests/sp-daily-digest-counts-superseded-deploys-and-house-diamond-payouts.law.test.ts`

## "2 Engine Deploy Attempts Did Not Ship"

Both Oct 14 rows in `ca_engine_deploy_attempts` were stand-downs: "stood down
before cutover; protected main had moved to <sha>". Each named revision shipped
and was independently verified. Nothing failed. The digest now counts a
stand-down as shipped only when the revision it names really shipped within
twelve hours, and reports it as superseded. Real non-ships (Oct 7 and Oct 9 in
the last ten days) still show.

## "1 Diamond Movement Over 10,000"

KingFish's Diamond Spins daily net settlement for Oct 13, +42,080. Legitimate.

It exposed a counting gap: every `transfer`-typed diamond row in the last week
(7 rows, 100,460 diamonds) is a house payout with the player as their own
counterparty, Diamond Spins daily net settlements and Wheel cards. The digest
drops `transfer` so peer transfers net out, and these payouts vanished from
diamonds given out. They are now named `diamond_spins_daily_net` and
`wheel_cards` and counted.
