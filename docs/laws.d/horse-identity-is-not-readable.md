# tests/horse-identity-is-not-readable.law.test.ts

Dan, 2026-09-02: "NOBODY SHOULD EVER EVER EVER BE ABLE TO LOOK AT OUR CODE OR
USE A DEVELOPER TOOL AND FIND THIS OUT." Cleaning the client's own queries was
necessary and not sufficient - a player can write their own. Measured as an
ordinary logged-in player before the fix: `profiles.is_horse=true` returned the
entire 1,000-row roster, `horse_profile` 1,308 rows, and `ai_horses` 100 rows
with no login at all. Three doors, each closed by its own migration and each
verified by probe: the column-level REVOKE on `profiles` (direct reads; safe
because `authenticated` has no table-level grant there and eighteen columns
were already withheld this way); a `fn_can_see_horse_flag` mask inside the four
SECURITY DEFINER RPCs that returned the flag to any club member (they run as
owner and walked straight around the revoke - a plain member got 200 of 200
flagged); and per-table column lists on the `supabase_realtime` publication,
which column grants cannot touch and which was broadcasting all three columns
to every profile subscriber. Staff identification survives through the same
RPCs (an owner still sees 200 of 200), because 10.5 sanctions it there. The law
pins that the closing migrations exist, assert their own effect, and are never
re-granted by a later "restore client read grants" pass - which is how the
grant got there. It also pins that exactly one god account exists, enforced by
a partial unique index rather than by every writer remembering.

2026-10-05: the fourth and fifth doors. `table_seats.horse_id` (965,180 of
1,303,476 seat rows) and `club_members.is_bot` were still readable by `anon` and
`authenticated` through a TABLE-level SELECT, under which a column REVOKE does
nothing - which is why the 2026-09-07 attempt on `table_seats` rolled itself
back. Migration 20261005115325 replaces the table-level grant with a column list
built from the catalogue less the one column, refuses to run while any reader a
browser can reach still names either column, and asserts the result. The
browser stopped naming both columns first (`tests/unit/tableSeatsCountNamesAColumn`
scans every `src` file and bans them). The law pins the migration and that no
later migration hands either table back whole.

Because those two tables are now granted column by column, a column added to
either later is unreadable by the browser roles until it is granted. The law
therefore also requires every later `ADD COLUMN` on `table_seats` or
`club_members` to carry its own `GRANT SELECT (column)` to `anon` and
`authenticated` in the same migration, or to say `WITHHELD` beside it.

2026-10-05: the sixth door. `content_authors` is the roster itself (1,000 of
1,000 profile ids are horses) and was readable logged out through "Public can
read authors" plus a table-level grant of every privilege to `anon` and
`authenticated`; `clip_usage_log` says which clip each horse posted. The World
Hub stopped reading either from a browser (World Hub #2127: presence and the
operator roster moved behind server routes). Migration 20261005162843 drops
every policy on both tables, revokes them, their sequence and the five roster
RPCs from every browser role, keeps the service role whole, and asserts the
result. The law pins the migration and that no later migration re-opens any of
them to `anon`, `authenticated` or `PUBLIC`.
