# A Pre-Start Refund Does Not Block A Cohort Satellite Receipt

## What Happened

Cohort satellite 32190e8c (three full tickets into target 6561f9f4) reached its
qualifier boundary at 17:34 UTC on 2026-10-07: three players left, three
tickets. The engine asked `fn_settle_satellite_qualifiers` to seat them, the
settlement ran to the end, and its closing receipt
`fn_ca_satellite_cohort_receipt` refused with "missing or extra obligation
evidence". The transaction rolled back, the engine read the refusal as
pending, and asked again about every six seconds for eleven hours. The event
dealt no hand and the qualifiers held no seat.

## Why

The receipt requires the satellite's `tournament_obligations` rows to number
exactly its cash tickets plus one remainder row. The satellite also held three
settled refund rows written by `fn_unregister_from_tournament` for players who
left before the start. Migration 20261003023500 had already taught both
settlement guards and the single-winner receipt to ignore exactly those rows;
the cohort receipt was missed.

## What It Cost Elsewhere

Every retry ran the satellite's money path (tournament rake, union wallet, VIP
credit) before rolling back, and deadlocked with hand post-commit work. Of 385
deadlocks in the 24 hours to 05:10 UTC on 2026-10-08, 309 had
`fn_settle_satellite_qualifiers` in the cycle, all but one from 17:00 UTC on. That
is what `DatabaseDeadlocksElevated` paged on twelve times, and what
`MttPlayStopped` paged on every hour from 18:11.

## The Fix

Migration 20261008050135 gives the cohort receipt's obligation count the
identical predicate the single-winner receipt already carries: a row is
ignored only when it is a fully paid, settled `refund` from
`fn_unregister_from_tournament`. Every other obligation still counts. It is a
pinned-preimage substitution (live md5 08e2b78f, derived postimage b77ddbf6)
that also proves both receipts now carry the same rule.

## Regression

`scripts/ci/test-satellite-cohort-receipt-refund.py` loads the exact
production text of the cohort receipt and the single-winner count of
20261003023500, proves the cohort receipt counted the refunds before the
change, applies the migration verbatim and proves the
count for seven obligation mixes, run by
`.github/workflows/satellite-cohort-receipt-refund.yml`.

## After Install

Satellite 32190e8c settles on the engine's next ask with no manual step. The
change was reasoned from the receipt's text and executed against fixtures; the
live settlement itself was not probed (CLAUDE.md 11.5 rule 5).
