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
