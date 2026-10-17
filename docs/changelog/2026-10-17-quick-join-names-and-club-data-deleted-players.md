# 2026-10-17 - Quick Join keeps full table names; Club Data drops deleted accounts

Follow-ups found while verifying #7263 (Dan's five lobby screenshot fixes) on the live site.

## Quick Join: the table name gets its own line on a phone

With the type doubled, the reason tag ("SAME STAKES", "ONE LEVEL UP") shared the name's line and cut every name to "NLH .25/.50...", so the row no longer said whether it was Action, Madness or Classic. Below 704px the name now takes the full row and the tag wraps beneath it (`src/pages/MultiTablePage.css`, pinned in `tests/unit/quickJoinIsTwiceAsLarge.test.ts`).

## Club Data: deleted accounts leave the player rankings

Dan, 2026-10-16: deleted players must never appear anywhere, for all clubs and unions. `20261016224731` covered directories, rosters, cashier and leaderboards, but the Club Data player ranking (`ca_club_player_breakdown` and `ca_club_player_page_core_20261006`) still built its list from `club_members` without the profile's status. Club JAQK's last 14 days had 17 players with a result, 12 of them deleted accounts shown as "Deleted-xxxxxxxxxxxx".

Migration `20261017160101` adds one predicate to the shared `merged` set of both functions (rows, totals, `player_count` and `filtered_count` all read it, so the breakdown and the page still agree). It is an md5-guarded exact-text patch. `20261017005207`'s live proofs pinned the exact postimage hashes, so they now check the range read it installed instead; the hashes stay recorded in that file.
