# 2026-09-02 - chip standard: a guaranteed seat is a guarantee, and the round-2 audit

Branch `fix/chip-std-seat-guarantee-and-roadmap`.

## Migration `20260902213000_a_guaranteed_seat_is_a_guarantee_and_is_funded_at_lock` (applied 21:34 UTC)

Found by the round-2 conflict audit (`docs/audits/2026-09-02-chip-standard-round2/lane3-conflicts.md`, item 1) two hours after the engine cut over to `fn_settle_tournament_obligation` (deploy shipped 20:57:57 UTC, first engine obligation 20:58:07).

Observed: satellites advertise `satellite_seats` seats that the engine awards regardless of the field (14 days: eleven satellites collected 3,217.50, awarded 4,600 in seats plus 2,200 cash). When a seat cannot be booked into the target (`fn_award_satellite_seat` returned 400 at 20:14, tournament 91dd8dbf) the engine pays the ticket in cash as a `place` obligation; against a pool that never held the money the new cap refuses it. Twelve open satellites (18 seats, 3,600 owed, 1,003.50 collected), first lock 23:00 UTC.

Change: `fn_ca_fund_overlay_on_lock` treats `satellite_seats x (target buy-in + fee)` as the guarantee for a satellite, same bank rules, same refusal when the bank is short, same `overlay` ledger row. Also revokes PUBLIC/anon/authenticated EXECUTE on the trigger function (lane 1 found it public).

Rolled-back probes on production:

- `610c5c41` Sunday Deep Stack Satellite $5 (pool 99.00, 1 seat, ticket 200): status -> RUNNING inside the transaction: `prize_pool` 200.00, union bank 69,820.84 -> 69,719.84, one ledger row `101.00 union_bank->prize_liability overlay`.
- `e6055ba9` Sunday Deep Stack Satellite $10 (pool 207.00, 1 seat): pool unchanged 207.00, bank unchanged, 0 overlay rows.

Stated cost for Dan: about 2,600 chips of union bank across the twelve open satellites at today's fields - the guarantee the lobby has been advertising, previously minted.

## Also in this PR

- `docs/CHIP-ACCOUNTING-ROADMAP.md` - the honest scorecard against the standard and the seven phases of what is left (Dan's question of 21:15 UTC).
- `docs/audits/2026-09-02-chip-standard-round2/lane1..4` - the four read-only audits (every chip path and legacy route; the union/club/agent hierarchy vs industry practice; the conflict check on today's changes; BBJ, backup BBJ, promo, spins, rake).
