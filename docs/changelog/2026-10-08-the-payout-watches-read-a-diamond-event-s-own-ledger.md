# The Payout Watches Read A Diamond Event's Own Ledger (2026-10-08)

## What Was Wrong

`fn_payout_guarantee_check` (earner_not_paid) and
`fn_ca_tournament_settlement_mismatch` (read hourly by the
`tournament_underpaid_48h` ratchet of `fn_ca_ratchet_watch`) measured what a
tournament paid from `wallet_transactions` only. A Diamond event
(`clubs.asset = 'diamonds'`) pays its prizes and bounties from its own custody
and records them in `poker_diamond_tournament_ledger`, so every completed
Diamond event read as "paid 0".

Measured read-only on production: 32 open earner_not_paid alerts across 11
tournaments and 11 underpaid settlement mismatches, all 11 Diamond MTTs. In
every one the ledger's prize rows sum to the prize pool exactly, all 32 named
earners hold a ledger prize row, and no place differs from its flat structure
share by a whole Diamond. Nobody was owed anything.

## The Fix

Migration `20261008045808` edits both live functions in place with the pinned
substitution helper: every place the watches sum wallet prize or bounty
credits also sums the event's ledger `prize` (pool) or `prize` and `bounty`
(per player) rows. A chip event has no ledger rows, so it reads exactly as
before. No writer changes and no money moves.

## Proof

`scripts/ci/test-diamond-payout-watches.py` (native PostgreSQL, run by
`.github/workflows/diamond-payout-watches.yml`) rebuilds the production
definitions byte for byte, shows the false alarms, applies the migration and
shows a Diamond event paid in full raises nothing and its open alert clears, a
real Diamond shortfall still alarms in both watches, chip events are
unchanged, grants do not move, and the result matches the postimage md5
derived read-only on production.
