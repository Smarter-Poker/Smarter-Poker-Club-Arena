# Cashier Exact Balance Certificate

The production certificate retained the former million/billion abbreviations after Cashier and Club Bank switched to exact chip balances. It rejected valid values such as 5,533,125.65 and accepted obsolete M/B wallet figures.

Require comma grouping and exactly two decimals for chip balances at every magnitude, including Downline Holdings. Keep malformed/unavailable balance refusals, explicit absent Agent Float handling, whole Diamond counts, and compact transaction/statistic/preset checks. This changes verification only; the published wallet frames, selectors and Club Bank Transaction Ledger remain intact.

Validation: the maintained wallet contract tests fail against the former helper for large exact and abbreviated values, then pass with the correction. Follow normal protected checks and production Cashier certification.
