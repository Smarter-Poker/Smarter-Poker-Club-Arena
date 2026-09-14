# Diamond Phase 8: A Seat Exit Goes Home Through Its Own Door

Status: Phase 8 defect closed on both sides. Diamond Tournaments Remain Refused At Every Door (`tournaments_enabled` is false). No real entry has been written against a real wallet.

## What The Recheck Found

The Phase 8 recheck (a second, deeper pass after the phases 1 through 8 audit) walked every caller of the chip unregistration authority, `fn_ca_unregister_tournament_player_exact`, and found that only the two-argument lobby door had been taught to send a Diamond entry home. The seat exit a heads-up or sit-and-go player uses (`fn_leave_seat_and_refund`, both overloads), the one-argument lobby door, the administrator's removal and the launch's release of a registrant it could not seat all reached the chip authority with a Diamond event. With a fee it refused ("cannot leave divergent tournament state", because a Diamond event writes no `rake_records`); with no fee it deleted the roster row for a refund of nothing and left the player's Diamonds in custody, where the terminal would later have paid them to the winners. Phase 8's own title names sit-and-gos and heads-up, whose only way in is the seat.

Three more, smaller: the Diamond door answered a replayed request id with three keys, so the client's one exact replay after a lost response parsed it as an invalid receipt and told the player the withdrawal could not be confirmed after it had committed; the seat-first purchase receipt dropped `asset` and `diamonds_after`, so the balance on screen did not move after a paid Diamond seat; and the seat-first toast read every `insufficient*` as "Not Enough Chips" and treated the two other Diamond refusals as unknown outages.

## The Database

Migration `a_diamond_seat_exit_goes_home_through_its_own_door` (applied as `20260914103912`; stored text byte-identical to the repo file, md5 `5a41ec0d7182742f6fcdbf6b9eccb534`):

- The chip unregistration authority itself routes a Diamond entry to `fn_poker_diamond_tournament_unregister` before it takes the lane - one in-place edit with the live md5 pinned and the reverse substitution proved - so every caller, present and future, is covered. A caller that named no request id is given one exactly as the authority mints its own. A seat exit naming a table the player does not sit at answers `not_seated`, as the chip authority does, unless the request id is already settled, in which case the receipt replays.
- The seat-first purchase receipt passes `asset` and `diamonds_after` through when the registration receipt carried them (in place, pinned, proved).
- The Diamond door is redefined with the same signature (pinned first, declared to the guard watch after): a replayed request id answers with the whole receipt rebuilt from the refund ledger row, and the door keeps the chip authority's clock - a scheduled event closes at its start time, a spin or heads-up sit-and-go closes when it actually starts, the launch's release is past the clock by design and is held to the seat-first proofs, a persisted hand closes every product.

Rehearsed as real clients through the real doors, rolled back, nine paths: the seat purchase receipt (`asset: diamonds, diamonds_after: 890, cost: 110`); the two-argument seat exit (110 home, seat released, roster row gone, custody released); its exact replay (a receipt, nothing paid twice, one refund row); a new request from an unseated player (`not_seated`); the one-argument seat exit; the one-argument lobby door; the chip administrator's removal (refused `not_authorized` before the authority - the arena has no club owner by design; a staff removal for Diamond events is Phase 10's audited adjustment); the scheduled clock refusing past `start_time` with custody and wallet untouched; the launch's release going home under its own request id. The Diamond identity did not move through any of it; no custody was left open.

## The Client

- `seatFirstBuyInRefusalText` and `seatFirstBuyInReasonIsKnown` live beside the lobby door's reason text, so the seat door says the same thing: `insufficient_diamonds` is read before the bare chip `insufficient`, and the two other Diamond reasons are known refusals rather than reported outages.
- The seat-first handler raises `DIAMOND_BALANCE_CHANGED` from the receipt's `diamonds_after`, exactly as the lobby register path does.

## Tests

- `tests/a-diamond-seat-exit-goes-home-through-its-own-door.law.test.ts` pins the migration's mechanics.
- `tests/unit/aDiamondSeatIsBoughtWithDiamonds.test.ts` pins the helper texts and the handler's use of them.

## What Is Still Not Here

Unchanged from the phases 1 through 8 recheck: the lobby's projected ladder and the sign-up dialog speak chips for a Diamond event (display only); no isolated SQL fixture runner for the tournament lifecycle; the ruling path prices in cents; a staff removal door for Diamond events (Phase 10); bounties, satellites, spins and guarantees (Phase 9).

Law: a-diamond-seat-exit-goes-home-through-its-own-door.
