# Anon executes only what it needs

A `SECURITY DEFINER` function runs with its owner's privileges, so the set of
them a logged-out visitor may `EXECUTE` is the anonymous attack surface of this
database. Nobody had a list of it.

Measured 2026-09-18: 2,571 definer functions in `public`, **35** reachable by
`anon`, 772 by `authenticated`. The reassuring number first, because it is the
one that matters: **2** of the 2,571 leave `search_path` mutable, and neither
is anon-executable, so definer plus anonymous plus mutable path - the
combination that is actually exploitable - is empty. That is better hygiene
than an estate this size usually has.

Thirteen of the 35 grants do nothing, and are revoked.

Eight are `trgfn_award_*` trigger functions, named by no policy, view, default
or other function. Six of their eight tables do grant `anon` INSERT, so "nothing
can reach them" was not good enough. Whether firing a trigger checks the
triggering role's `EXECUTE` was settled by experiment rather than from memory:
a throwaway temp table, a temp `SECURITY DEFINER` trigger function with
`EXECUTE` explicitly revoked from `anon`, and an `INSERT` performed as `anon` -
which succeeded, with the trigger running. Postgres checks that privilege when
the trigger is created, not when it fires.

Five are policy helpers - `is_admin`, `fn_my_club_ids`,
`fn_notification_has_personal_destination` and the two chat-silenced checks -
named only by policies `anon` never evaluates, by no `SECURITY INVOKER`
function `anon` may call, and by no `security_invoker` view `anon` may read.
`authenticated` keeps `EXECUTE` on all thirteen, and the migration refuses
itself if that is not true afterwards.

**Six were deliberately kept, and they are the reason this is thirteen rather
than fifteen.** An RLS policy expression is evaluated as the QUERYING role, not
as the policy owner. `fn_can_view_post`, `fn_is_public_video_playback_eligible`,
`fn_is_video_library_asset_eligible`, `fn_is_video_library_lineage_eligible`
and both overloads of `legacy_transition_eligible` are named by policies on
`social_posts`, `social_reels` and `video_library_videos` that `anon`
evaluates; revoking those would have broken anonymous reads of public content.
`fn_home_is_group_staff` is the same hazard through a `security_invoker` view
`anon` can `SELECT`. The first reading of this change had all six on the
revoke list.

The remaining 22 are now written down. `docs/security/anon-executable-definers.json`
names every one with a reason - load-bearing for an anonymous policy, for an
invoker view, or a read deliberately offered to logged-out visitors: username
and club-name availability, venue and profile pages, leaderboards,
`find_live_games_nearby`. That is the signed-out surface and it should stay.

`scripts/ci/check-anon-definer-grants.mjs` compares the live grants to that
file. It fails on a function nobody has accounted for - including one that
arrives by default privilege, which is the way nobody notices - and reports but
does not fail on a listed grant that has been tightened away, because a guard
that punishes tightening teaches people to skip it. It refuses rather than pass
when it cannot reach the database, and it carries no credential of its own.

Pinned by `tests/anon-executes-only-what-it-needs.law.test.ts`, which fails on a
trigger function in the list, an entry with no reason, a duplicate signature,
an empty list, and a migration that touches `authenticated` or does not check
its own work.
