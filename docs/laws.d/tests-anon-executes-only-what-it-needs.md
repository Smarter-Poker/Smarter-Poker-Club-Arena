# tests/anon-executes-only-what-it-needs.law.test.ts

A SECURITY DEFINER function runs with its owner's privileges, so the set of
them a logged-out visitor may EXECUTE is this database's anonymous attack
surface. On 2026-09-18 nobody had a list of it: 2,571 definer functions in
`public`, 35 reachable by `anon`, 772 by `authenticated`. Thirteen of the 35
grants did nothing - eight trigger functions, reachable only by the trigger
mechanism, and five policy helpers no anon-reaching policy, SECURITY INVOKER
function or security_invoker view names - and migration 20260918121836 revoked
those, leaving `authenticated` untouched. Six more were deliberately kept: an
RLS policy expression is evaluated as the QUERYING role, so a helper named by a
policy anon evaluates is load-bearing, and revoking
`fn_can_view_post`, the video-eligibility predicates or either overload of
`legacy_transition_eligible` would have broken anonymous reads of social posts
and reels; `fn_home_is_group_staff` is the same hazard through a
security_invoker view. This law holds the half that needs no database: the
manifest stays a list somebody can be held to - every entry reasoned, none of
them a trigger function, no duplicates, never empty - and the revocation
migration checks its own work. The live comparison is
`scripts/ci/check-anon-definer-grants.mjs`, which refuses rather than pass when
it cannot reach the database.
