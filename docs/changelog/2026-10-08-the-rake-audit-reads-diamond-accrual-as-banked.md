# The Rake Audit Reads Diamond Accrual As Banked (2026-10-08)

## What Fired

`fn_rake_bbj_audit` raised a critical `RAKE_BBJ_INVARIANT_VIOLATION` every hour,
always `I7_raked_hand_never_banked = 20` (the sample LIMIT, not the count).

## Root Cause

Every flagged hand was a cash hand at a diamond club. Over two hours measured
read-only on production: 9,953 raked chip-club hands with 0 missing a
`rake_records` row, and 277 raked diamond-club hands with all 277 missing one.
That is by design. `fn_ca_process_hand_post_commit_obligations` refuses chip
obligations on a diamond hand (`diamond_hand_has_chip_obligations`), and the
diamond rake is banked per payer in `ca_diamond_rake_accrual`; for each of the
256 hands past the grace the accrual summed to exactly the hand's rake (14,344 of
14,344). I7 only read `rake_records`, so it called every diamond hand a loss.

## Fix

Migration `20261008044146`: I7 treats a diamond-club hand as banked only when its
`kind = 'rake'` accrual sums to exactly its rake. A short, missing or non-rake
accrual still counts, and chip clubs are unchanged. Pinned-text substitution;
detector-only, it moves no money.

## Hardening

- Regression: `scripts/ci/test-rake-audit-diamond-accrual.py` (native PostgreSQL,
  fails on the production preimage, passes on the candidate, reproduces the
  derived postimage md5).
- CI: `.github/workflows/rake-audit-diamond-accrual.yml`, path scoped.
- Detection: the audit itself keeps raising into `financial_alerts`, which the
  store intake routes to the alerts fleet task, if a real diamond or chip loss
  appears.
