# tests/the-arena-stats-door-reads-its-own-hands.law.test.ts

The Diamond Arena's footer has a Stats door, and it opens the stats page with
the arena as its club (/stats?club=diamond-arena). The page used to read chips
whatever door it came from, so a player in the arena was shown their chip
figures under the Diamond footer, and the Rake tab's agent downline beside
them in an arena that has no agents. The page now takes its asset from the
arena it was opened from: every read on it (the page payload, the all-time
payload, rake, the Hands tab list, the pulse, the nemesis, EV and hand-grid
panels) names that asset, its local caches are keyed by it so neither asset is
served from the other's cache, and in the arena it reads no agent roles. The
Hands tab's reader learned the asset in migration
20260929213851_the_arena_stats_door_reads_its_own_hands (ca_player_hands and
ca_player_hands_v2, pinned and reversible, old signatures dropped, grants as
they were). The law pins each of those.
