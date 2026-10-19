# Weekly revenue digest classifies real payouts

The digest treated every rakeback transfer as a club payment and every promo/opening-allocation leg as spend. The October 19 digest therefore combined 2,180,462.68 club rakeback with 588,824.90 onward player rakeback, and counted both sides of 225,900.00 opening reserve funding as expense. Signed supply observations also cancelled to zero without showing 21 nonzero readings.

The same scheduled digest now reads posted legs over one bounded snapshot, separates club/player/other rakeback and promo funding from player-wallet/table awards, and reports opening setup and reserve allocations separately. Supply observations include coverage, absolute/max variance and an explicit status; no observations return NULL, not a clean zero. Cert-player flow is explicitly a separate metric, with no horse exclusion or changed payout rule. Original notifications remain immutable. No wallet, schedule or settlement transaction is changed.

Native PostgreSQL 17 reproduces the old misclassification and passes exact amounts, void/future/past exclusion, recipient scope, ACL, replay refusal, signed cancellation, missing snapshots and basis-transition cases. This runs unconditionally through the existing required accounting floor qualification. Installed/runtime verification remains separate from source qualification.
