# An operator's declared funding is not a mint loop (2026-10-03)

Phase 6 of 9 (money edges). Migration `20261003131810_an_operators_declared_funding_is_not_a_mint_loop`, live as schema_migrations `20261003131906`. The recorded statements are byte-identical to the repo file.

## What was wrong

`fn_ca_mint_velocity_watch` filed two warnings on 2026-10-03 saying "a mint loop is running":

- 03:15, 607,265.09: the Deep Stack Society standalone rake bank for weeks 09-14 and 09-21 (`20261002153151`).
- 10:30, 560,017.06: the owner-authorized funding of Deep Stack Society's overdue agent commission (`20261003092151`).

Both were one-off, reviewed fundings through `fn_ca_fund_club`. Each wrote a mint register row in `ca_mint_ledger` with origin `operator`, `op_id` equal to the leg's idempotency key, linked to the leg, the same amount, and a reason. The watch already left out a new club's declared opening grant on that kind of evidence, but it counted operator fundings as if they were a loop.

## What changed

An operator mint is left out of the velocity sum only in its exact declared shape: a posted `mint` leg from the issuance reserve, with a register row from `fn_ca_fund_club` that matches it on key, leg, amount and origin and carries a reason. Everything left out rides along as metadata (`operator_mints_10m`, `operator_mint_chips_10m`).

The exclusion holds only while at most three such mints land in the ten-minute window. A fourth means a loop through the declaring door, and then all of them count (`operator_mints_counted`). An auto-registered row (origin `journal`) declares nothing and is still counted. Thresholds, the opening-grant exclusion and the burn side are unchanged. The redefinition is declared to the guard watch in the same transaction.

## Evidence

- Replayed over the two windows: 607,265.09 and 560,017.06 become 0, and an auto-registered mint is still counted.
- The two mint incidents and the 2026-10-02 burn incident (certification fixture retirement, 1,595,500.00 across sixteen fixture clubs) were reviewed and resolved through `fn_ca_incident_action` with their root causes written down.

Pinned by `tests/an-operators-declared-funding-is-not-a-mint-loop.law.test.ts`. `tests/the-new-club-opening-grant-is-never-drift.law.test.ts` now reads this migration as the newest velocity watch; every clause it pins still holds.
