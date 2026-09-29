# Diamond Phase 10, Line 1: The Arena's Stats Door Reads Its Own Hands

Status: applied and client-side. In the Diamond Arena the Stats door shows the player's Diamond figures; everywhere else the page is unchanged.

## What Was Wrong

The Diamond footer's Stats door opens `/stats?club=diamond-arena`. The stats page ignored the club and always read chips, so a player in the arena saw their chip profit, sessions, positions, EV curve, nemesis and rake under the Diamond footer, and the Rake tab offered their chip-club agent downline in an arena with no agents. It could not do otherwise until `20260920065728_a_diamond_hand_keeps_its_own_statistics` taught the readers an asset; one reader, the Hands tab's `ca_player_hands_v2`, was still unscoped.

## The Database

Migration `the_arena_stats_door_reads_its_own_hands` (applied as `20260929213851`; stored text byte-identical to the repo file, md5 `8f8eb0e1b0545a0696143e8f92fd9d7e`): `ca_player_hands` and `ca_player_hands_v2` take `p_asset` (default `chips`, anything else refused) and list only that asset's hands. Asserted substitutions with the live md5 pinned and the reverse proved; old signatures dropped first; grants restated as they were (the inner reader to the service role only).

Rehearsal, one rolled-back transaction: one real player's hands list read in chips (recent, biggest won, biggest lost); one Diamond hand dealt through the real post-commit projection; the chip lists identical afterwards, default and explicit; the Diamond list exactly that hand; an unknown asset, another player's list and the service-only reader refused.

## The Client

- `PlayerStatsPage` takes its asset from the club it was opened with: the Diamond Arena gives Diamonds, anything else chips. The page payload, the all-time payload, rake, the Hands tab, the pulse and the nemesis, EV and hand-grid panels all read that asset; the SWR cache and the range memo are keyed by it; in the arena no agent roles are read. The page's eyebrow says which arena it is reading.
- `useStatsPulse`, `NemesisPanel`, `EVLuckChart` and `HoleCardHeatmap` take a `scope` (chips by default, so every other caller is unchanged).

Law: the-arena-stats-door-reads-its-own-hands.
