# Diamond Phase 10: The Arena Counts Its Players

September 29, 2026. Phase 10 of the Diamond Arena build programme, line 3 ("Show real member/online/seated/table counts with meaningful zero/error states") and the Players-page half of line 6 ("no agent panels, union menus, chip metrics or synthetic players as real activity"). Item 6 of the ordered build list in [the Phase 10 audit](../DIAMOND-PHASE-10-AUDIT-2026-09-21.md). Both arena switches stay closed. Nothing is written and nothing is priced.

## What Was Wrong

The arena's Players door opened the chip roster. Its summary read looks the viewer up in `club_members`, where the arena has one row with status `automatic`, so every Diamond player was told "This Roster Is Available Only To Approved Club Members." Answered, it would still have been the chip roster, with My Downline, Agents, Admins, Fees 100+ and Wallet Balance. Nothing counted the arena's members, who in it is online, who is seated, or how many tables it has open; the chip readers answer a structural 0 for it.

## Who Counts As A Player

Every account with a profile is a Diamond member (`fn_poker_arena_context` grants the entitlement to any signed-in profile). Of those, a player is an account whose sign-in is live, whose account is open and which is not a certification fixture. Horses are players and count like anyone (docs/DIAMOND-RULINGS.md, "Fixture accounts are not players; horses are"; CLAUDE.md 10.5). The rule lives in one function, `fn_diamond_arena_is_player`.

The live sign-in clause is new and it matters today. 185 profiles belong to deleted sign-ins, 182 of them post-deploy and crest certification accounts created since September 27. Their soft delete scrubbed the `.invalid` address that `fn_ca_is_fixture_account` recognises them by, so the fixture predicate alone would have counted them as 182 new players. Read at 20:45 UTC: 1,369 profiles, 185 deleted sign-ins, 35 fixtures and 1,149 players (1,000 horses and 149 people), the audit's figure exactly.

## The Database

Migration `the_arena_counts_its_players` (`20260929214500`) creates six functions and changes none:

- `fn_diamond_arena_counts()`, for signed-in players: members, online, seated and open tables, each a number or NULL when it cannot tell, with the reason under `unknown`. A figure whose read fails is NULL on its own and the others still answer. Tables are the arena's open tables (waiting or running, not closed, not deleted); seated is players with a live seat at one of them.
- Online uses the chip roster's rule (seated, or `profiles.is_online` with `last_seen` inside five minutes) and is a number only while the presence feed shows the person asking. They are online by definition, so a feed that does not show them is not seeing where players are. Nothing in Club Arena writes presence (World Hub's messenger and social page do), so a player who only uses the arena reads Online as Unavailable today. That is the truth, not a fault.
- `fn_diamond_arena_roster(search, filter, cursor, limit)`, for signed-in players: the arena's players, searchable by name, username or player number, filterable to those at tables, ordered seated, online, then by name, and paged by a keyset cursor. A row carries name, username, avatar, player number and presence only.
- Four internal rules, callable by no player: the arena, who is a player, the arena's open tables, and who is seated at them.

The rehearsal ran the migration and its fixture as one rolled-back transaction on production: 1,149 members (1,000 horses), 17 tables, 0 seated, online NULL until the presence feed saw the caller and then 1, the whole roster walked in 6 pages with no fixture or deleted account and every horse present, a failed read left NULL on its own, and the seat rule matched an independent count on a live chip club (354 players). Counts answered in 332 ms and a first roster page in 363 ms.

## The Client

`/clubs/:clubId/members` now renders `ClubPlayersDoor`, which picks `DiamondPlayersPage` when the server-verified arena entitlement says membership is automatic and `ClubMembersPage` otherwise. A chip club renders the chip roster exactly as before; `ClubMembersPage` is unchanged.

The Diamond Players page wears the chip roster's look. Its four tiles print "..." while loading, the number once read (a real 0 included) and "Unavailable" when the arena could not tell, with a line saying Unavailable is not zero. The list has All Players and At Tables, search, refresh and Show More Players. There is no agent, admin, downline, fee, wallet, sort, column, selection or export control, no field says which players are horses, and a row opens nothing, because the member page under it is the chip club's management screen.

Both pages share one chunk. The Diamond page wears the chip roster's class names, so beside it it compresses to about 1.5 kB gzipped instead of 3.9 kB alone; the whole-app bundle measured 2,880.19 kB against Dan's 2,880 kB ceiling with it, so the next page anyone adds will need that ceiling raised, which is his call.

The counts are on the Players page. The lobby rail stays exactly as Dan set it on September 11 ("JUST 'ACTIVE' AND THE NUMBER UNDER IT. AND THE FREE ROLL STARTS CLOCK"). Where the counts live is Dan's decision 1 in the audit, and they can move if he wants them elsewhere.

Law: the-arena-counts-its-players.
