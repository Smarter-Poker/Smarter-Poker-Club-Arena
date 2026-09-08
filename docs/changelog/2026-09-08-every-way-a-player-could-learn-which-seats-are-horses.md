# 2026-09-08 - every way a player could learn which seats are horses

Dan, 2026-09-02, binding: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR
CODE OR USE A DEVELOPER TOOL AND FIND THIS OUT."

The 2026-09-02 pass closed the obvious doors: the client's own queries, the
`profiles.is_horse` column grant, the four SECURITY DEFINER RPCs that returned
the flag to any club member, and the Realtime publication column lists. This
entry records a full sweep taken afterwards - every relation, every function,
every payload and every URL a signed-in player can reach - and the seven
further doors it found. Each was measured before it was closed, and closed
where the leak was rather than hidden behind a check.

## What the sweep found

| #   | The door                                                                                                                                                | Measured                                                                                                                                        | Closed by                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `horse_bug_reports`: policy "Anyone can read bug reports" (`USING true`, role `public`) plus a grant to `anon`                                          | 16,101 rows naming 202 horses by `horse_id` and `horse_name`, readable **with no login at all**                                                 | migration `20260908021100`, admin-read via `fn_is_horse_admin()`                                                                                    |
| 2   | `club_memberships`: a `security_invoker` view over `club_members` exposing `is_bot`, which a trigger keeps equal to `profiles.is_horse`                 | 1,903 rows flagged - all 1,000 horses, no human. Nothing in either repo reads the view                                                          | same migration, revoked from `anon` and `authenticated`                                                                                             |
| 3   | `fn_club_union_join_blockers(club_id)`: returned `horse_count` and `horse_wallets` for ANY club to ANY authenticated caller, no guard, no client caller | probe as owner returned `horse_count=416`                                                                                                       | same migration, EXECUTE revoked; the union-join trigger that really calls it is SECURITY DEFINER and unaffected                                     |
| 4   | Horse avatars lived under `social-media/horse-avatars-v2/...` and `social-media/avatars/horse_avatar_<name>_<ts>.png`                                   | 541 of 1,000 horse profiles; **no human profile** had either. That URL is the `<img src>` on every seat, post, friend card and messenger thread | 541 objects copied to the human convention (`avatars/<uuid>/avatar.<ext>`, every destination verified 200), repointed by migration `20260908022510` |
| 5   | `tables.settings._snapshot` on inactive tables carried `"displayName": "Horse 63a2c2"` and the old avatar path                                          | 185 rows, none active, newest 2026-09-04; nothing reads the key any more                                                                        | stripped in the same migration                                                                                                                      |
| 6   | **The engine's own WebSocket payloads carried `is_horse` on every seat** - the resync, the hand broadcast and the between-hands roster                  | every state change, in any player's Network tab, under a comment citing "Bible V8 section 2.3"                                                  | `fix(engine): the engine never says horse on the wire` (#3645, merged)                                                                              |
| 7   | `EngineDashboard` counted the fleet with two browser filters on `profiles.is_horse`                                                                     | 42501 since 2026-09-02, so the panel showed **nothing to the admins it exists for**, and read `.length` of a count page rather than the count   | `fn_admin_horse_fleet_counts` (migration `20260908024019`) - counts only, `fn_is_horse_admin` only                                                  |

Every migration was probed first as a real non-staff player inside one
self-aborting `DO` block (11.5), and every one asserts its own effect in a
post-flight that raises rather than trusting the statements ran:

    bug_reports as player=0; club_memberships refused 42501;
    join_blockers refused 42501; bug_reports as god=16101;
    join_blockers as owner horse_count=416

    fleet counts: player refused 42501 admin only;
    god got {"seated": 0, "available": 1000}

The avatar repoint deadlocked (40P01) against the engine's own single-row
profile updates on its first attempt and rolled back cleanly; it takes the
row locks in `id` order now, which cannot deadlock with a single-row updater.
After it: 0 horses with "horse" anywhere in `avatar_url`, 541 repointed, 0
snapshots naming one. The originals are deliberately **not** deleted - a tab
holding the old URL keeps rendering - and the World Hub generators that wrote
those names are fixed at the root (`fix(horses): a horse avatar is uploaded
where a human one is`, WH #1577, merged) so no new ones appear.

## What was checked and is clean

Named here so the next sweep does not repeat the work: `hand_history.players`
and `.actions` (0 of the last 300 hands mention a horse), `notifications`
(0 of the last 2,000), `player_stats`, `table_chat`, every `*_snapshot` table
a player can read, every jsonb column on a player-readable table, and the
horse-only tables (`horse_daily_nets`, `horse_hand_reviews`, ... ) - RLS on,
no read policy, so a grant with no policy answers nothing. Display names,
usernames, bios, `player_number` ranges (128 horses sit within 50 of a human's
number), `last_seen`, `email_verified` and the other 99 granted `profiles`
columns show no pattern that separates a horse from a human. The eight
`ca_horse_*` analytics RPCs are `fn_is_horse_admin()`-gated. `profiles.email`
is not granted to a player at all, which is what keeps the
`@horses.smarter.poker` addresses invisible.

## The one door still open, and exactly how to shut it

`table_seats.horse_id` (populated by the 2026-09-05 backfill; 1,296 live seats)
and `club_members.is_bot` (1,903 rows) are both readable by a player, and both
need the SAME shape of fix: revoke the table-level SELECT and grant SELECT
column by column, omitting the one column. That fails any query naming the
column **or `*`** with 42501, so the client had to stop doing both first:

- `#3556` (merged): the two `table_seats` counts select `id`, not `*`.
- `#3536` (green, merging): no player-facing select names `horse_id`.
- `#3643`: every `club_members` read names its columns - `UnionDashboardPage`
  five columns instead of `*`, three membership counts `user_id`, and
  `MembershipService.addMember`'s bare `.select()` (which is `RETURNING *`)
  six columns. Pinned by `tests/unit/tableSeatsCountNamesAColumn.test.ts`.

Probed 2026-09-07, rolled back, table-level grant verified intact afterwards:

    count(*) ok=1296; count(id) ok=1296; named-cols ok=5;
    horse_id refused 42501; select * refused 42501

### The sequence

1. `curl -s https://smarter.poker/hub/club-arena/build-info.json` - `ca_sha`
   must be at or past the squash commits of `#3536` and `#3643`
   (`git merge-base --is-ancestor <squash> <ca_sha>` for each). Nothing else
   counts as deployed (1.4).
2. `git grep -n "horse_id\|is_bot" <ca_sha> -- src` must show no
   `table_seats` or `club_members` select naming either.
3. Reserve a version, and in ONE transaction, for each of the two tables:
   `REVOKE SELECT ... FROM anon, authenticated` then
   `GRANT SELECT (<every column except the withheld one>) ... TO anon, authenticated`,
   built by `string_agg` over `information_schema.columns` so a column added
   later cannot be forgotten. Post-flight: no table-level SELECT for players,
   no column grant on the withheld column, and one ordinary column still
   granted (proof the grant landed rather than nothing landing).
4. Re-probe as `authenticated`: named columns succeed, the withheld column is 42501.
5. Commit the migration with a law that reads the shape out of the SQL.

Checked and safe under that change: the Realtime publication for
`table_seats` already omits `horse_id`; every SECURITY DEFINER reader runs
with its definer's grants; `schedule_horse_leave` (invoker) is not executable
by a player; `trg_auto_cashout_on_table_close` fires on UPDATE of `tables`,
which RLS denies to players; the one `security_invoker` view over
`table_seats` does not touch the column. INSERT/UPDATE/DELETE grants are left
alone - RLS has no write policy for players, so they already permit nothing.

Until step 3 runs, `from('table_seats').select('horse_id')` and
`from('club_members').select('is_bot')` still answer for a signed-in player.
Everything else in the table above is shut.
