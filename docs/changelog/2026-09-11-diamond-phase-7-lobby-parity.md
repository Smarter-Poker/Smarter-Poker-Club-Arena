# Diamond Phase 7: One Open Club Renders The Shared Lobby

Status: Phase 7 In Progress. No Phase 7 Checklist Item Is Claimed Complete. Public Funded Diamond Games Remain Closed.

## Why This Came First

Dan restated the product target on September 11, 2026, verbatim: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA. (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS AND ITS PLAYED WITH DIAMONDS INSTEAD OF CHIPS)".

Phase 7 is cash game parity and table features. None of those features can be exercised, or even seen, through a five line placeholder panel, so the phase opens on the lobby itself rather than on a feature from the checklist. Nothing in the Phase 7 exit gate is claimed by this work.

## What Changed

The arena's own route renders the shared Club Arena lobby, the same component a joined chip club renders. The chip operator routes underneath a club, finance and agents among them, keep the safe Diamond shell: those are chip club screens with no Diamond meaning, and "no unions or agents" has to hold on a typed URL, not only on a hidden link.

Three guards stood between the arena and its own lobby, and all three read `club_members`, which a Diamond entitlement has no row in.

- `ArenaAccessBoundary` returned the placeholder and never rendered its children. It now publishes the entitlement the SERVER returned through a small React context and renders the lobby on the arena route. Nothing is derived from the route: the boundary's own verified read of `fn_poker_arena_context` is the only source, and RLS still decides every read underneath.
- The chip membership guard redirected the player to a Join page that must never exist for this arena.
- Two membership checks inside the lobby evicted them again on load and on every refocus.

Played with Diamonds, not chips: the wallet visibility law gained a `chipWallet` option, false for an arena the server says holds none, so no club wallet row is drawn there. The Bad Beat Jackpot strip, a chip pool banked by chip rake that Diamond hands never pay into, no longer renders in the arena.

The placeholder cash board `DiamondCashLobby` was deleted. The shared lobby queries the same tables under the same club scope, so the component had no caller left, and a second lobby only Diamond can reach is the opposite of a one to one clone.

The arena identity rail now carries `ACTIVE` with the count under it and the freeroll countdown, replacing a member level and a painted "PLAYING NOW" label that say nothing true about one open club. The label being retired is paint on the master image, not markup, so the rail is opaque and sits over both zones; it is painted before the share button, which keeps that button on top and keeps the 44px target its `::after` already guarantees.

## Two Defects This Work Introduced And Repaired

Both were found after CI was green, which is the point of recording them.

1. A note above the jackpot strip was written as a bare block comment in JSX children position, where a comment is not a comment but text. Left in place it would have painted its own explanation across every chip club lobby. Caught while resolving a merge, before it reached main.
2. The arena lobby threw on every load: `[ClubHomePage.fastPath] Cannot read properties of undefined (reading 'id')`. Refusing to act on the fast path's membership read was the wrong shape, because the read itself dereferenced `home.club.id` and the fast path payload carries no club row for the arena. The page still painted from the authoritative chain, which is why CI and the first route check were both green. Both membership reads are skipped outright now, which also removes two round trips per arena load.

## Merges And Publication

| Increment                       | Merge                                    | Published                     |
| ------------------------------- | ---------------------------------------- | ----------------------------- |
| Shared lobby on the arena route | 5a550b6343f613a7134011b41d69cdad613642f7 | run 34620011628, 16:07:59 UTC |
| Membership read fix             | 7c999a727cc529c479f9954f957e3985faa0351c | run 34622787222, 16:37:25 UTC |
| Arena identity rail             | 9a5217b7272587d1e6c2341125ad913c710c6437 | run 34624103249, 17:00 UTC    |
| Freeroll label fits its column  | 4f25710cb661c4889b4d5228d685e7e79991b9e0 | included in served a8be599e   |

## Verified In Production

Checked in the Claude desktop app's built in browser pane on Dan's Mac, signed in with his own joined Shark Club account.

- Arena route on served a8be599e: the shared lobby renders. Club identity card, My Wallets showing 1 Balance, Live Club Schedule, Find Your Game with the full filter set, and the honest "No Tables Yet" board. No placeholder, no Join wall, no error boundary.
- One wallet row, not five. No Player Wallet chip row and no jackpot strip.
- The identity rail reads ACTIVE 0 and FREEROLL 0:00, both labels measured unclipped (23px and 31px against their own scroll widths).
- A brand new tab with an empty console buffer loads the arena lobby with zero console errors.
- Shark Club is unchanged on the same build: identity card with 558 playing and Level 29, jackpot strip present, 5 balances, 463+ games, no arena rail, no error boundary.

## Still Open, And Why It Matters Next

There is no way to create a Diamond table at all. The only live cash creation door, `fn_cash_game_create` into `fn_cash_cluster_open_table`, always writes a cluster id, run it twice on and `rake_percent` -1, every one of which the Phase 6 admission guard refuses. Phase 6 created tables by fixture insert only. Until a Diamond creation door exists, the arena's game board is honestly empty and no variant or table feature from the Phase 7 checklist can be exercised in production. That is the next increment.

Recorded gaps, not defects: the arena still reports its member count as the number playing, which is the figure the rail now shows on purpose; house ads render in the arena's shared ad slot, which Dan confirmed should stay as a location without curating what appears in it; and Dan asked for a white or light colour scheme for Diamond Arena against Club Arena's dark one, explicitly in the next phase rather than this one.

No production migration, engine deployment, player mutation, balance change or admission change was made by any of this work. `cash_games_enabled` remains false.
