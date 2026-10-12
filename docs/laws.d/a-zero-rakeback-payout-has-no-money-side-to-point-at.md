# tests/a-zero-rakeback-payout-has-no-money-side-to-point-at.law.test.ts

The settlement correctness check asks a wallet or chip pointer only of a rakeback payout or transfer that moved chips; a 0.00 period row that moved nothing is never filed as missing evidence.
