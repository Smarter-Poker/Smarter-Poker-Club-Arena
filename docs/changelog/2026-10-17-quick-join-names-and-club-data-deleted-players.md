# 2026-10-17 - Quick Join keeps full table names; Club Data drops deleted accounts

Follow-ups found while verifying #7263 (Dan's five lobby screenshot fixes) on the live site.

## Quick Join: the table name gets its own line on a phone

With the type doubled, the reason tag ("SAME STAKES", "ONE LEVEL UP") shared the name's line and cut every name to "NLH .25/.50...", so the row no longer said whether it was Action, Madness or Classic. Below 704px the name now takes the full row and the tag wraps beneath it (`src/pages/MultiTablePage.css`, pinned in `tests/unit/quickJoinIsTwiceAsLarge.test.ts`).

## Club Data: deleted accounts leave the player rankings

Dan, 2026-10-16: deleted players must never appear anywhere, for all clubs and unions. `20261016224731` covered directories, rosters, cashier and leaderboards, but the Club Data player ranking (`ca_club_player_breakdown` and `ca_club_player_page_core_20261006`) still built its list from `club_members` without the profile's status. Club JAQK's last 14 days had 17 players with a result, 12 of them deleted accounts shown as "Deleted-xxxxxxxxxxxx".

Migration `20261017160101` adds one predicate to the shared `merged` set of the breakdown, the page core and the Players CSV export (`ca_club_player_export_start`), so rows, totals, `player_count`, `filtered_count` and the downloaded file all agree. It is an md5-guarded exact-text patch, and after each replacement it re-reads the owner, SECURITY DEFINER, volatility, search_path and grants and refuses if any changed. `20261017005207`'s live proofs pinned the exact postimage hashes, so they now check the range read it installed instead; the hashes stay recorded in that file.

## The rule readout says Minimum VPIP

The create-game rule readout still labelled the row "VPIP Floor", Classic read "No VPIP Floor", and the refusals said "The VPIP Floor ...". All now say Minimum VPIP, matching the lobby descriptions from #7263.

## Desktop board: the Action / Madness note wraps instead of clipping

The live desktop board cut the note to "Action | Small Blind Ante, 30% Minimum VPIP, Double", losing the bomb timing. `.lt-name__table` now wraps on desktop as it already did on phones; the cash row is `height: auto`, so it grows by a line.

## Hosted Club Data specs accept the club-named heading

The everyday Club Data heading is now "<CLUB NAME> - CLUB DATA" (Dan 2026-10-17). `mobile-tap-targets.spec.ts` and `club-operations-exhaustive.spec.ts` still required a heading named exactly "Club Data", which failed the full post-deploy browser verification on every release. Both now accept the club-named heading.

## The late-greeting lobby specs wait for their fixture

`mobile-lobby-chrome.spec.ts` mounted the closed-doors fixture, waited for its NLH tab to paint, and then called `window.showLobbyDoor`, which the fixture installs in a React effect that runs after that paint. On WebKit the call landed first (post-deploy run 39051205956: "window.showLobbyDoor is not a function"). `mountLobbyDoors` now waits for the function to exist before it returns.

## Found, not fixed here

The same run's cashier certification got a 500 from `fn_cashier_conservation_report` (statement timeout). It re-sums every chip_ledger player leg since the baseline, 1.07M for Club JAQK, 4.5s cold. Filed as #7309 for the cashier conservation owner.
