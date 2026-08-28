# 2026-08-28 — Seat-first refusal reasons become sentences, and a dead-end sheet retires itself

Follow-up to `2026-08-28-reopen-the-seat-first-front-door.md`, from the same
line-by-line sweep of the sit-down flow.

**1. Register refusals rendered as raw codes.** `REGISTER_REASON_TEXT` knew
five reasons; `fn_register_for_tournament` returns nine. A player refused with
`seat_first_variant` (the guard that keeps lobby registration out of
Spin/Heads-Up events), `not_authorized_to_register`, `vip_only`, or
`misconfigured_bounty` saw "Could not register (seat_first_variant)". All four
now map to sentences. `seat_first_variant` matters most: it is the guard kept
deliberately in place by the front-door fix, so it IS reachable by any generic
register surface that lists a seat-first event.

**2. `not_a_seat_first_game` was a dead end.** If the server answers that a
table does not sell seats while the client is showing the seat-first sheet
(client thought pre-start Spin/HU; server disagrees — recycled table, changed
event), the sheet stayed up and every retry hit the same refusal behind the
generic toast. The refusal now retires the sheet (`setSeatFirstBuyIn(null)`),
shows "Seats Are Not For Sale At This Table", and counts as a mapped reason
for the outage-visibility reporter added in #1620.

Audited and found sound, no change needed: `fn_leave_seat_and_refund`
(status-gated, splits reversed, wallet symmetric with the
`atomic_deduct_wallet_and_log` home-club resolver, seat counter refreshed);
`fn_unregister_from_tournament` (deletes only `status='registered'`, so a
seat-first player cannot ghost-refund past their live seat); lobby Spin/HU
tiles (navigate to the table, never register).
