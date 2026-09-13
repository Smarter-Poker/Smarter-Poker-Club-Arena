# The rail knows when to stay quiet, and a self-excluded player was told they were fine

2026-09-13. Phase 2 of the ticker programme. Two states in which a selling
surface must go silent, neither of which this component knew existed - and one
of them could not even be ASKED about honestly.

## The finding: the responsible-gaming check failed open

The estate has a responsible-gaming system. The World Hub exposes
`/api/rg/self-exclude`, `/api/rg/limits`, `/api/rg/session/start`,
`/api/rg/session/end` and `/api/rg/session/reality-check`; the database carries
`responsible_gaming_limits` with `self_excluded_until` and `cooling_off_until`,
and seven `fn_rg_*` functions.

Club Arena's entire `src/` referenced none of it. Not the rail, not
registration, not the cashier.

The obvious check is `fn_rg_require_not_excluded(p_user_id)`, and EXECUTE on it
is granted to `authenticated` and `anon` - so it reads as a check any client may
make. **It answers the wrong thing.** Demonstrated against production in a
transaction that was rolled back: one user given `self_excluded_until = now() +
30 days`, the same function called twice on the same row.

| caller                                | answer                                                                |
| ------------------------------------- | --------------------------------------------------------------------- |
| `service_role` (the World Hub's path) | `{"ok": false, "error": "self_excluded", "self_excluded_until": ...}` |
| that player's own client              | `{"ok": true, "reason": "no_limits_set"}`                             |

The function is `STABLE` and **not** `SECURITY DEFINER`, so it reads the limits
table with the caller's own privileges. That table has RLS on and exactly two
policies - `rg_limits_admin_select_all` and `rg_limits_service_all`. Neither
admits the user the row is ABOUT. The player's own row is invisible to the
player, and the function's "no row means no limits" branch turns invisibility
into permission.

A check that fails open is worse than no check. It looks like protection in
review and it is an advertisement in production.

**Blast radius today: none.** `responsible_gaming_limits` holds zero rows -
nobody on this platform has ever set a limit or self-excluded. This closes the
hole before the first person walks into it.

### The fix, and why it is a policy rather than a definer

`20260913172658_a_player_can_see_their_own_responsible_gaming_state.sql` adds
one SELECT policy: a player may read the row that is about them, and only that
row.

Making the function `SECURITY DEFINER` would also work and would be worse: it
takes `p_user_id` as an argument, so as a definer it would answer for any user
id any caller passed, and one person's self-exclusion is not a fact other
players get to query. A policy scoped to `auth.uid()` closes the same hole and
cannot be pointed at somebody else.

It discloses nothing new - `GET /api/rg/limits` already selects this row and
returns it to the player it belongs to - and it mirrors
`rg_sessions_user_select_own`, which the sibling sessions table has carried all
along. The limits table was the one that did not, which is why the gap survived.

The migration verifies the BEHAVIOUR rather than the policy's existence: inside
the same transaction it gives a user an exclusion, asks the question both ways,
requires the two answers to agree, and deletes the row again.

Two things that would have failed it on apply, found before shipping rather
than after:

- The estate's hoisted-auth guard already reports **one** pre-existing offender
  (`player_boosts.player_boosts_owner_reads`). An `expected 0` assertion would
  have failed this migration for somebody else's row, so the assertion is
  scoped to this policy.
- One transaction, one `BEGIN`/`COMMIT`, per the production DDL policy: every
  DDL event reloads PostgREST's schema cache and one reload costs ~28 seconds.

## The second silence: the house is closed

There is an hourly maintenance break. `useMaintenanceBreak` is careful work -
three independent sources of authority so the countdown survives the engine
dying in the middle of its own break.

The rail had four references to the word "maintenance" and every one of them was
the OPERATOR'S service-notice source. It did not know the platform freeze
existed. At :55 it could count "Starts In 0:12" toward an event that cannot
start, and say "Jump In Now" about a table nobody can join. It defers to the
break now, which already owns a banner and a full screen.

## What an unknown answer means

`SPEAK_WHEN_UNKNOWN` is the entire policy, in one exported constant, on purpose.

A failed read is not a "no". Failing closed silences the rail for every player
during any Supabase blip; failing open shows an advertisement to someone who may
have asked not to see one. Today the limits table is empty and the answer is
re-read per player per session, so an unknown state is brief. On that evidence
the open default is right - and it is one line to flip when the first player
self-excludes and the evidence changes. An unknown answer is never cached.

## Verified

- `tsc --noEmit` clean; eslint 0 errors; title-case and painted-text OK
- 225 assertions green across the 13 ticker-touching files, 15 of them new
- Full suite, four shards: **20,035 tests, one failure** - this machine's
  Python 3.9 lacking `tomllib` in `engine-release-seal.law.test.ts`, which
  mentions the ticker zero times and fails identically on clean `origin/main`
- The migration was NOT probed against production: CLAUDE.md's DDL policy
  forbids DDL probes, so it is reviewed, transactional, and self-verifying on
  apply
