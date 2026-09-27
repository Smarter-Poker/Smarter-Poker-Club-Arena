# tests/a-satellite-award-is-found-by-its-payout-id.law.test.ts

`fn_tournament_conservation_delta` must find a `tournament_payouts` row's `tournament_satellite_awards` row by `a.payout_id = sp.id` (unique, NOT NULL, FK-constrained), never by `(tournament_id, place)` vs `(tournament_id, position)` - the latter silently misses whenever `tournament_payouts.position` is NULL, which let 8 still-unredeemed tickets be counted as arrived seats and raised 14 false "retained/paid money" alerts on 2026-09-27.
