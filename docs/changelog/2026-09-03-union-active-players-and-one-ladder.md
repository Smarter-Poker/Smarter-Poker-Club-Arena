# 2026-09-03: Union active players = sum of its clubs; one ladder, one count, everywhere

Dan: "if shark club has 530 active and club jaqk has 526 active, why is midway
union showing 530 active? midway union 'active players' is a combination of
all active players inside all of the clubs." Then: "harden this for all clubs
and unions globally (and new accounts as well that haven't been started yet)."

## What was wrong (all measured in production before the fix)

1. `fn_batch_union_realtime_active_counts` counted DISTINCT users across the
   whole union. Shark and JAQK share almost the same roster, so the union
   collapsed to the larger club: Shark 500, JAQK 497, union 500.
2. `clubs.level` had THREE writers on `club_members`, two on the retired 1-50
   dual-axis ladder and one on the 1-55 member ladder the app shows. Last one
   to fire won. Deep Stack Society (417 members) was stored at level 1
   (should be 26); Shark 28 (29); JAQK 26 (29); Midway's club row 21 (25).
3. `unions.level` was written only by the 1-50 ladder (34 vs badge 33), and
   `unions.member_count` summed the denormalised `clubs.member_count`.
   Nothing fired on a union INSERT, so a new union sat at 0 / level 1 until
   its first club joined.
4. `UnionService.mapUnion` read `unions.online_count`, a column that does not
   exist (always 0 on UnionsPage and UnionDetailPage), took `Math.max` of two
   stale columns for members (a union could never show a decrease), and
   `getStats` invented "online" as 20% of members. Enrichment used
   `fn_batch_club_member_counts`, which returns no row for an empty club.
5. The "Recalculate Level" button ran the 1-50 ladder, making things worse.

## What changed

### `20260903180000_union_active_players_is_the_sum_of_its_clubs.sql` (applied)

`fn_batch_union_realtime_active_counts` = SUM over `union_clubs` of
`fn_batch_club_realtime_active_counts` (the exact function the club cards
use). `fn_union_active_player_counts` delegates to it. Asserts union = sum of
clubs. Verified live: JAQK 476 + Shark 480 = Union 956.

Deliberate: the union's own house-club row (Midway Union, 328 members, 273
active, not in `union_clubs`) is NOT in the sum, matching how the union's
Members figure (1177 = 593 + 584) is already computed. Dan's words were
"all of the clubs".

### `20260903190000_one_ladder_one_count_for_every_club_and_union.sql` (applied)

- `club_level_thresholds` (55 rungs) and `fn_club_level_for_members` declared
  in the repo (they had only ever been applied by hand). New
  `fn_club_level_min_members(level)`.
- ONE writer per row: `fn_apply_club_ladder(club)` and
  `fn_apply_union_ladder(union)`. Count from the realtime functions, level from
  the ladder, `player_threshold_current/next` from the ladder. Hierarchy stats
  still stored as data; they no longer decide `level`.
- Every entry re-pointed: `fn_sync_club_member_count` (club + its unions),
  `recompute_club_levels` (button), `recompute_club_levels_silent`,
  `recompute_union_levels`. The two retired club_members trigger functions are
  no-ops.
- New: `trg_new_club_gets_the_ladder` (clubs AFTER INSERT),
  `trg_new_union_gets_the_ladder` (unions AFTER INSERT). A new account is
  correct from row one.
- Backfilled every club and union; asserts zero drift and exactly one writer.

Locking lesson: `DROP TRIGGER` takes ACCESS EXCLUSIVE and deadlocked three
times against live seating traffic. `CREATE OR REPLACE TRIGGER` takes SHARE
ROW EXCLUSIVE and went through. Prefer it; retire old triggers by making
their functions no-ops.

Probe (rolled back): a fresh union row initialised to 0/0/0/level 1; deleting
30 Shark members moved Shark to 563 / level 28 and Midway to 1147 / 33 inside
the same statement.

### Frontend

- `UnionService.enrichWithRealtimeCounts` runs on every union from
  `getUnions`, `getMyUnions`, `getUnion`: members/totalPlayers from
  `fn_batch_union_realtime_member_counts`, onlineCount from
  `fn_batch_union_realtime_active_counts`, clubCount from `union_clubs`.
  `getUnionClubs` uses `fn_batch_club_realtime_member_counts`. `getStats`
  uses the same RPCs; the 20% estimate is gone.
- `UnionDetailPage`: removed both `totalPlayers > memberCount` patches.
- `HomePage`: comment corrected.
- Tests: `tests/club-card-realtime-human-stats.test.ts` pins the sum, the
  enricher wiring, the absence of `online_count` / the 20% estimate /
  `fn_batch_club_member_counts` in UnionService, and that the 55 SQL rungs
  equal `CLUB_LEVEL_THRESHOLDS`.

## Still Dan's

The ladder itself (what a level requires) is unchanged. Changing a rung is a
row in `club_level_thresholds` plus the same entry in
`src/utils/clubLevels.ts`; the test fails if they disagree.
