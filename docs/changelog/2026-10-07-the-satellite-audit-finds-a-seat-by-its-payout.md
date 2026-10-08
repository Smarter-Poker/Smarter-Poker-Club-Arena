# The Satellite Audit Finds A Seat By Its Payout (2026-10-07)

Migration `20261007215112_the_satellite_audit_finds_a_seat_by_its_payout.sql`. Supersedes PR #5708 (`20261001151646`).

## Root Cause

`fn_satellite_conservation_audit` counted a funded seat from its payout row by joining the award `ON (tournament_id, place = position)`. A receipt_version 3 satellite keeps the survivor's real finishing position on the payout, which for an unranked co-qualifier is NULL, so the join found no award and the seat was not counted. "Sunday Deep Stack Satellite $25" (e2ea5f2a) paid all three of its 200.00 seats and closed its escrow at exact zero, but read as 600.00 undisbursed and paged hourly from 17:52 UTC.

## Fix

The payout arm joins `ON a.payout_id = p.id`, the award's own NOT NULL, UNIQUE foreign key to the payout. Applied as a pinned-text substitution: preimage md5 `462b1c631010e4bab0361967d2da2a75`, postimage `5d847143055fab40063ee1d968f2bb36` (derived read-only on production). Owner, SECURITY DEFINER, settings and grants are kept (service_role only).

Measured read-only on production over every satellite completed in the last 30 days (2,738): one changes its seat count (e2ea5f2a, 0 to 3), it balances, and no satellite becomes newly flagged.

## What Was Dropped From #5708

#5708 also rewrote `fn_tournament_conservation_delta` and the money-touching payer `fn_pay_backed_payout_shortfalls`. Both have since moved on main, and the 2026-10-03 ticket fallback plus the house_correction term already give the payout-keyed answer: switching their award joins to payout_id moves the delta of none of the 615 events whose joins differ. Those halves were dropped, so this change touches no money path.

## Regression

`scripts/ci/test-satellite-audit-seat-by-payout.py`, run by `.github/workflows/satellite-audit-seat-by-payout.yml` on PostgreSQL 17: the production definition flags the NULL-position satellites; after the migration they balance, a cash delivery is still not a seat, a satellite really a seat short is still flagged with its delivered seats counted, a ranked satellite and an out-of-window one are unchanged, the postimage md5 matches production's derivation, and a second run refuses.
