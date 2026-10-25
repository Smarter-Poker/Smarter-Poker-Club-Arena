# The VPIP readers judge the same window as the eviction

Found while auditing the PLO5/PLO6 Classic 50% floor (20261024213131).

That migration turned the floor on mid-sitting and correctly started the
maintain window at the later of the player's join and the game's
`vpip_floor_since`, but only in `fn_nit_check`, the enforcer. The two readers
carried their own copy of the window and kept counting hands from before the
floor existed:

- `fn_nit_status`: the figure every horse steers by (`ownVpip`, `vpipFloorMul`).
- `fn_cash_vpip_status`: the player's own VPIP tracker on the felt.

Measured at 23:20 UTC on five live Midway tables: `fn_nit_status` flagged 20
seated players (31-49% over up to 850 hands) for eviction while the enforcer
judged the same players on the hands since 21:33 (850 vs 310 for one seat) and
stood nobody up. Horses were loosening toward a floor they already met, and a
human's tracker would have shown "below the floor" when the rule disagreed.

Fix (migration `20261024232218`): the window is one function,
`fn_nit_sitting_since(game, user, fallback)`, and all three call it.
`fn_nit_check` is patched by anchor; the two readers are replaced with bodies
identical to the live ones except the window (verified by md5 against the live
source with only that block substituted). The migration then proves, on live
floored tables, that the reader and the eviction flag exactly the same seats.

Law: `tests/the-vpip-readers-share-the-evictions-window.law.test.ts`.
