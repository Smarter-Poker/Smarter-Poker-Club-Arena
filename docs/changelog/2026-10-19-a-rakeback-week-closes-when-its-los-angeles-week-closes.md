# A rakeback week closes when its Los Angeles week closes

**What was wrong.** A rakeback week is a Los Angeles week: the live calculator
(`fn_calculate_cash_rakeback_periods`) and the weekly settlement floor
(2026-09-21T07:00Z) both use Los Angeles midnight. Three gates decided "this
week is over" at the UTC midnight after `period_end` instead, 7 hours (PDT) or
8 hours (PST) early: the `rakeback_periods` paid-status trigger
(`fn_ca_legacy_period_maturity`), the rakeback wallet-credit trigger
(`fn_ca_legacy_round3_wallet_receipt`) and the retired per-period payer
(`fn_close_settlement_period`, no caller). From Monday 00:00 UTC until the Los
Angeles week rolled over, a week that was still being played could be marked
paid.

**Measured 2026-10-19.** 420 periods of the week of 2026-09-07 (2 clubs) were
paid 2026-09-14 00:29-06:27 UTC, inside that window. That week and the week of
2026-09-14 were later settled by the owner's 2026-09-26 decisions (measured
legacy payment; union pays directly), so nothing is reopened here. No period
has been paid inside the window since the 2026-09-21 settlement floor; the
scheduled payer runs Monday 04:00 America/Chicago, after the Los Angeles close.
The player claim door (`fn_claim_rakeback`) is already retired.

**The fix.** Migration `20261019092211` replaces only the closing instant in
the three gates with the calculator's own expression,
`(period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles'`. Los Angeles
midnight is always later than UTC midnight on the same date, so each gate is
strictly stricter: it can refuse an early payment and never admits one.
Refusal text, error codes, the retired payer's UTC-day basis, owners,
SECURITY, configuration and grants are unchanged and asserted; exact
preimages are required; no row is written.

**Proof.** `scripts/ci/test-rakeback-week-closes-in-los-angeles.py` (required
accounting shard 1) installs both live triggers from their exact production
definitions, shows them admitting payment inside the window (PDT and PST),
rebuilds them from the migration's own pairs and shows them refusing inside the
window and admitting after the Los Angeles close.
