# Phase 4 (continued): the definer sweep only ever looked at writers

2026-08-31. Continues `2026-08-31-phase4-security-sweep.md`, which closed 61
anon-executable SECURITY DEFINER functions and then watched the count grow back
twice while the phase was still running.

## What actually went wrong

I closed the surface, verified 22, came back and found 23. Closed
`fn_tournament_metrics`, verified again, found 23 again. The third was
`fn_truly_unused_indexes`.

I had been treating each one as a fresh mistake by a fresh author. It was not.
**Every guard on this estate only ever asked about functions that WRITE**, and
all three of these are read-only:

| function                  | what it hands a caller with no account       |
| ------------------------- | -------------------------------------------- |
| `fn_tournament_metrics`   | operator dashboard numbers                   |
| `fn_truly_unused_indexes` | table names, index names, sizes, scan counts |
| `fn_nit_evictions`        | who was evicted from which table, and when   |

The middle one is the one that matters. Index names on this project encode
their columns, so it hands an unauthenticated caller a partial column map of
the schema plus a read of which access paths are hot. That is the
reconnaissance step, free.

Three in one afternoon is not three authors being careless. It is a rule
nothing enforced.

## Closed

**`fn_truly_unused_indexes`** — revoked from PUBLIC/anon/authenticated,
service_role granted explicitly. Zero RLS policies reference it, zero callers in
`club-arena/src`, `server/src`, or the World Hub. Verified as anon over REST:
`42501 permission denied` (HTTP 401), while `fn_club_name_available` still
returns 200 — so the revoke landed and public surface is untouched.

**`check_upcoming_tournament_pushes()`** and **`fn_check_ungated_money_rpcs()`**
— found by the daily live audit on its first run after the change below, by
questions that have existed since 2026-08-28. Both zero-argument writers that
`authenticated` could execute, neither called from anywhere in either repo.

The first queues the 15-minute push notification for every registrant of every
upcoming tournament: a logged-in caller could loop it and push-spam the whole
platform from its own verified sender. The second INSERTs `critical` rows into
`financial_alerts` — a logged-in caller could bury the real alarm under its
output. An alarm anybody can ring is an alarm nobody reads, and this estate
already learned that lesson once today when the payout reconciler re-raised
accepted overpayments every cycle.

**`fn_home_is_group_staff`** — the interesting one. It is an RLS policy helper:
15 policies across 8 tables call it, and every single one passes
`(SELECT auth.uid())`. The function never looked at `auth.uid()`. It trusted its
`p_caller` argument.

Because it is a policy helper, `anon` **must** hold EXECUTE (a policy expression
evaluates as the querying role, and anon can SELECT 6 of those 8 tables). So an
unauthenticated caller could also just call it directly:

```
POST /rest/v1/rpc/fn_home_is_group_staff
{ "p_caller": "<any user uuid>", "p_group_id": "<any group uuid>" }
```

and get a boolean back. A membership oracle: name any person and any private
home-game group, learn whether they run it. Not a write and not a chip — but
somebody's private association, answerable by a stranger, one uuid pair at a
time.

**Revoking was not available.** It would have denied every anon SELECT on
`commander_home_posts`, `_post_comments`, `_game_tables`, `_game_reviews`,
`_seat_reservations` and `home_game_vouches`. So the function learns to ask
instead: it derives the caller from `auth.uid()` and ignores `p_caller` for
anybody who has one. `p_caller` is still honoured for a connection with no JWT
at all (`auth.role()` NULL), which is how this estate recognises the engine.

Behaviour through the policies is bit-identical, and the migration asserts all
three cases rather than claiming it: anon probing the real owner now gets
`false`; the owner presenting their own JWT is still staff; a logged-in caller
naming the owner in `p_caller` is answered for themselves. Confirmed live over
REST too — anon SELECT on `commander_home_posts` still returns 200 with rows.

## The durable fix, in both gates

The estate has two, and it needed both, because they cover different doors.

**`scripts/ci/check-definer-authorization.mjs`** catches a function arriving
through a migration in this repo. It gained **rule 2**: a new SECURITY DEFINER
function that **anon** can execute and that never consults
`auth.uid()/auth.role()/auth.jwt()` fails, whether or not it writes. It fails on
`anon` rather than any browser role, because plenty of read-only functions are
legitimately open to a logged-in player and failing those would just train
everybody to stuff the allowlist. The line worth defending is the one before
login. Escape hatch is a separate `anonPublicSurface` key, deliberately empty —
the rule only fires on functions a branch newly declares, so nothing needed
grandfathering.

**`scripts/ci/audit-live-definer-exposure.mjs`** is the one that matters more
here, and its own header said why before I did: this estate applies schema
straight to production through the Supabase MCP, so the repo gate _cannot see_
the path all three arrived through. `fn_definer_exposure_audit()` gained a
fourth question, `anon_readers`, excluding extension-owned functions (PostGIS
ships three `st_estimatedextent` overloads that are not ours to revoke). The
daily script consumes it against a new `reviewedAnonReaders` baseline holding
the 7 genuine public-surface functions, each with a written reason.

## The new gate's first catch was the migration that shipped it

Run against its own branch, rule 2 flagged `fn_definer_exposure_audit` —
declared with no GRANT beside it.

On production that was a false alarm: `CREATE OR REPLACE` preserves grants, and
it was already revoked (verified: anon=false, authenticated=false,
service_role=true). **On a fresh database it was not.** Replay these migrations
into an empty project and `CREATE FUNCTION` takes the Postgres default, EXECUTE
to PUBLIC — and the security audit itself, the function that enumerates every
definer function and every RLS-off writable table, would answer anybody who
asked. Made explicit.

Then rule 1 flagged it too, for a different reason: the function's body contains
the literal string `'(insert into|update |delete from)'` as its own detection
regex, so it reads as a writer. **I did not teach the detector to ignore string
literals** — `EXECUTE 'insert into ...'` is a real write and a blind spot there
would be worse than a false positive here.

Instead both rules now read grants **across the whole branch**. A branch's
migrations are applied as a unit, so a REVOKE landing in a sibling migration
genuinely closes the function; reading one file alone reports a hole that will
never exist. Pinned by two new tests.

## Verified

- live audit end-to-end against production: `live: 2, baselined: 2, new: 0 · anon writers: 0 · RLS-off writable: 1 (0 new) · anon-readable: 7 (0 new)`,
  exit 0
- repo gate against the real committed branch: OK, 2 definers across 6
  migrations
- `npx tsc --noEmit` clean; 57 tests green across the three definer specs, 23 in
  the gate spec after the two additions
- the new rule proven to fire on the shape that actually shipped, and on the
  revoke-anon-only trap (anon inherits PUBLIC, so revoking anon alone changes
  nothing)

## Two things for Dan, recorded rather than quietly accepted

Both are player-visible product decisions, not bugs to fix inside a security
sweep, so they are written into the baseline entries and raised here:

1. **`get_public_profile_by_username` returns `diamonds`** — a balance-like
   number — to anyone who knows a username, alongside the intended public
   profile fields.
2. **`fn_club_leaderboard_period_v2` takes any `p_club_id` with no membership
   check**, so a caller with no account who has a club's uuid can read that
   club's members' profit, losses, rake and hands. Club uuids are not
   enumerable, but they appear in invite links and URLs.

Whether a club leaderboard is public, members-only, or a club setting is Dan's
call.

## Still open, unchanged

`lapsed_week_unclosed` (blocked by Dan's `GLOBAL_SETTLEMENT_FREEZE`) and
`bbj_pool_conservation_drift` (~74k, alert deliberately left red).
