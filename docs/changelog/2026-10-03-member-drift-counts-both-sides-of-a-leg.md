# Member drift counts both sides of a leg (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003131341_member_drift_counts_both_sides_of_a_leg`, live as schema_migrations `20261003131420`. The recorded statements are byte-identical to the repo file.

## What was wrong

`fn_chip_integrity_report` read CRITICAL from 2026-10-01: "670 member(s) drifting, worst 103747.97. Baseline 2026-08-26." `fn_ca_conservation_sweep` re-filed it every hour (57 sightings).

Read from production on 2026-10-03:

- the 670 drifts summed to exactly 0.00;
- gross 645,215.28: 664 members up, 6 down;
- all six "down" were horses that had paid rakeback or commission out of their own wallets.

`fn_chip_drift_since_baseline` grouped each journal leg under one player: the to side if it was a `player_wallet`, otherwise the from side. It summed both sides into that one group. A leg between two player wallets therefore netted to zero for the receiver and never reached the payer. Since 2026-09-29, rakeback and commission are paid wallet to wallet: 1,905 legs, 1,022,959.37 chips (rakeback 1,643 legs, 313,753.57; commission 262 legs, 709,205.80).

No chip moved and no balance was wrong. The reading was.

## What changed

Each side of a leg is its own movement: +amount for the to side's member, -amount for the from side's member. Same baseline, same club filter, same balances.

## Evidence

- Recomputed on production with both sides counted: 0 of 1,502 baseline memberships drift, worst 0.00.
- The migration refuses to commit unless that reading holds.
- After apply, `fn_chip_integrity_report` reads ok on every one of its seven checks.

Pinned by `tests/member-drift-counts-both-sides-of-a-leg.law.test.ts`.
