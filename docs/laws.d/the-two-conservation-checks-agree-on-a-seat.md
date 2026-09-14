# tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts

`fn_tournament_conservation_delta` and `fn_satellite_conservation_audit` read the same `tournament_payouts` rows and must agree on which `source` values mean a seat was delivered, and must both decide seat-or-cash from `tournament_satellite_awards.delivery_kind` - on 2026-09-09 only the audit was taught about `satellite_ticket`, and the delta raised 117 false "retained money" alerts worth exactly the 9,100.00 of ticket-delivered seats it could not see.
