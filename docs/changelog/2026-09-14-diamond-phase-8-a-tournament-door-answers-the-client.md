# Diamond Phase 8: The Doors Answer The Client, The Engine Deals The Table

Status: Phase 8 complete on every side but the switch. Diamond Tournaments Remain Refused At Every Door (`tournaments_enabled` is false). No real entry has been written against a real wallet.

## The Database: Three Receipts

Migration `a_diamond_tournament_door_answers_the_client` (applied as `20260914034708`; stored text byte-identical to the repo file, md5 `8fe22d542eb484ee22d5edd75adeab15`), three in-place edits with the live md5 pinned and the reverse substitution proved:

- `fn_poker_arena_context` now reports `tournamentsEnabled` beside `cashGamesEnabled`, read the same way from the arena's one settings row.
- The registration core answers an ordinary Diamond refusal with a reason - `insufficient_diamonds`, `diamond_tournaments_not_open`, `diamond_debt_requires_settlement`, `already_registered` - exactly as it answers a chip refusal, and re-raises anything else. Until this, every Diamond refusal was a raise, which the client treats as an unknown transport outcome: it retried once and reported "Could Not Confirm Tournament Registration" to a player who simply had too few Diamonds. Its success receipt now names the asset and the Diamond wallet after the charge.
- The Diamond unregistration receipt carries the wallet after the refund.

Rehearsed as a real client through the real doors, rolled back: closed door answers a reason and moves nothing; too poor answers a reason and leaves no roster row and no custody; paid answers `asset: diamonds, diamonds_after: 890`; withdrawn answers `refunded_diamonds: 110, diamonds_after: 1000`.

## The Client: Reads What It Is Told

- The unregistration receipt parser read only the chip shape (`refunded_chips`, `returned_ticket_value`, satellite chips) and would have thrown "invalid settlement receipt" AFTER a Diamond refund had been paid. It now reads the Diamond shape - whole Diamonds only, the same request and registration identity checks - and the success toast says "110 Diamonds Were Returned To Your Diamond Wallet."
- The three Diamond refusal reasons have words.
- A Diamond entry or refund moves `profiles.diamonds` through the database alone; no engine pushes that balance. The client now raises `DIAMOND_BALANCE_CHANGED` from the receipt's `diamonds_after`, which forces the wallet store to reload, instead of waiting out the thirty-second freshness window.
- The arena lobby labels every tournament "Not Open Yet" while the tournament switch is off - the card, the row and the panel, the same way the cash board already says it for a seat. A registered player still reads Registered; a finished event still reads Registration Closed; every chip club is untouched (the label is undefined there).

## The Engine: A Diamond Tournament Table Is A Tournament Table

Until now the engine refused a Diamond tournament table at four gates: `loadTable` held every Diamond table to the cash boundary (which refuses a tournament id and a zero buy-in range); `HandController` refused `isTournament` on a Diamond hand outright; the seat's add-funds and the mid-hand top-up sweep sent every Diamond seat down the custody path; and the once-a-minute rules refresh re-checked the cash boundary and refused the row. So a launched Diamond event would have had tables no engine could deal.

- `assertDiamondTournamentTable` holds the row the tournament manager writes to the tournament shape: the arena's games, a tournament id AND `game_type = 'tournament'`, whole positive blinds, a whole ante, no seat for sale (both buy-in columns zero), no union scope, and the same chip-schedule features refused. It does not check the rake and jackpot columns, which the manager leaves at the chip schedule's defaults and which every tournament hand ignores (`rakeConfig` is zero and the BBJ fee off for every tournament table). `assertDiamondTable` is the one door for both kinds.
- `loadTable` loads a Diamond tournament table only while `tournaments_enabled` is on, and a Diamond cash table only while `cash_games_enabled` is on; the cash switch does not open a tournament table.
- `HandController` admits a tournament hand under the same no-deduction rule as a cash hand: rake zero, jackpot off, no insurance, whole units.
- A Diamond tournament seat takes the chip tournament path for add-funds and pending add-ons, where it is refused exactly as a chip tournament seat is (no headroom; a tournament rebuy is the manager's own door).
- `placeLadderUnitCents` is Diamond-aware: the manager reads the tournament's club beside the tournament row and prices a place in whole Diamonds. The 2026-09-13 note held it at the chip unit because `fn_prepare_tournament_place_obligations` priced to the cent; read again, that function has no caller in the database or the engine, and the path the engine calls stamps `tournament_players.prize` from its own unit-aware ladder. A club that could not be read answers the named admission, reported, never a bare cent.

Server suite: 800 files, 11,832 tests green; typecheck clean. New tests: `DiamondTournamentBoundary.test.ts` (the boundary, the switch, the hand), a Diamond case in `BubbleReservedResult.test.ts` (whole-Diamond places and the not-read admission), `aClosedArenaOffersNoRegistration.test.ts` (the label, the reasons, the Diamond receipt).

## What Is Still Not Here

- The lobby's projected ladder (`TournamentService.calculatePayout`) and the sign-up dialog still speak chips for a Diamond event: they are display-only and read no club. They learn the asset when the switch is scheduled to open, not before a player can reach them.
- Horses stay outside Diamond tournaments (the horse door refuses by name; the joint-live policy says `diamond_tournament_unavailable`).
- Bounties, PKO, mystery bounties, satellites, spins, guarantees: Phase 9.

Law: a-diamond-tournament-door-answers-the-client.
