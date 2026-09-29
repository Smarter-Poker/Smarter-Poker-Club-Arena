# Diamond Phase 10: The Arena Counts Active Players, Not Fixtures

September 29, 2026. Phase 10 of the Diamond Arena build programme, line 6 ("Verify no agent panels, union menus, chip metrics or synthetic players appear as real activity"), the two pieces [the lines 1, 2 and 6 audit](../DIAMOND-PHASE-10-LINES-1-2-6-2026-09-29.md) left buildable without a decision. Both arena switches stay closed. Nothing is written and nothing is priced.

## What Was Wrong

- **ACTIVE counted certification fixtures.** The arena's one live figure, ACTIVE on its home card and its lobby rail, is read from `get_club_players_playing`: distinct users with a live seat at a table the lobby can see. It did not apply the rulings' "Fixture accounts are not players; horses are" ([DIAMOND-RULINGS](../DIAMOND-RULINGS.md)), which the arena's own Players page already applies to its At Tables figure (`fn_diamond_arena_counts`, #5616).
- **A typed member URL opened the chip management screen.** `/clubs/diamond-arena/members/<id>` is on the arena's player allowlist and rendered `MemberManagementPage`, the chip club's member screen with its agent and downline panels. The server answered it with nothing, so it showed "Member Not Found", but it was the wrong page.

## The Database

Migration `the_arena_counts_active_players_not_fixtures` (`20260929233000`, md5 `227ac5fd00d5efa9a703eedb4f0faaae`), rehearsed, then applied and recorded at 23:23 UTC:

- `fn_diamond_arena_players_playing(club)`, new: the players with a live seat at an open arena table, counted by `fn_diamond_arena_seated_players`, so it is the same rule and the same number as the Players page's At Tables (fixtures and deleted accounts out, horses in). It answers NULL for any club that is not the one arena. Signed-in players and the service role may call it; a visitor may not.
- `get_club_players_playing` gained one branch, by asserted substitution with the live md5 (`d0deada158658ba9e1f88cbfba85c6ae`) pinned and the reverse proved: a diamonds club answers from the new reader. The chip count below the branch is unchanged byte for byte, a chip club never reaches the branch, and the function is still an invoker read with its grants and comment as they were.

The rehearsal (one rolled-back transaction on production) read the figure as an ordinary signed-in player by the arena's uuid, slug and number: 0, 0 and 0, equal to the Players page's seated figure (0; no Diamond seat has ever existed, and none can while the cash switch is closed), in 2.1 ms. The busiest chip club answered 484 before and 484 after in one snapshot, and the player's own view of it matched too. The rule the figure now reads answered a fixture account out, a horse on a sentinel uuid in and a person in. After the apply, in fresh transactions: a signed-in player read 0 by all three keys, and a visitor was refused at the new reader (a visitor was already refused this count on every club, by the `tables` policy's `fn_union_oversees_club`).

## The Client

`/clubs/:clubId/members/:userId` now renders `ClubMemberDoor`. Inside the arena (the server-verified entitlement, as `ClubPlayersDoor` reads it) it replaces the address with the arena's Players page; a chip club renders `MemberManagementPage` exactly as before. The home card and the lobby rail are unchanged: they already asked `get_club_players_playing`, and the rail stays as Dan set it on September 11.

Law: the-arena-counts-active-players-not-fixtures. Unit test: `tests/unit/clubMemberDoor.test.tsx`.
