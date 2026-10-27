# 2026-09-01 — The night nobody could join a club

Five repairs, found while building a 416-account population for Deep Stack
Society. Four are defects that predate that work and hurt real users; one is a
ruling from Dan on a collision between two workstreams.

## 1. The Auth Admin API was broken for 295 accounts

GoTrue scans `auth.users` token columns into non-nullable Go strings, so a NULL
in any of them makes every admin read of that row fail with "Database error
loading user". 295 of 1,039 rows carried NULLs — **129 of them real human
accounts**. Password recovery, email change and admin user management were dead
for those people.

Proved by bisection, not inference: a row with non-null tokens loads through
`auth.admin.getUserById`; a row with NULLs does not. Same key, same client.

`''` and NULL mean the same thing to GoTrue, so this is a representation
repair. No password, identity, confirmation state or session was touched.

## 2. `listUsers` failed for the whole project

Fixing the 295 rows fixed every single-user read but not `listUsers`, which
scans every row. One row — `system@smarter.poker`, inserted directly rather
than through GoTrue — carried a NULL `instance_id`, which GoTrue scans into a
non-pointer `uuid.UUID`. One unscannable row broke the endpoint for everyone.

## 3. Nobody could join any club

`fn_join_club_atomic` is the only join path the app has, and it reads and writes
`public.rate_limits`. That table does not exist in production, so every call
raised `relation "public.rate_limits" does not exist`.

The table is not new. `supabase/migrations/20260311_rate_limit_rpc.sql` creates
it and **was never applied** — absent from `schema_migrations`. The repo and the
database disagreed, which is exactly what #2200 was about, in the opposite
direction: the repo held a migration production never received.

Applied verbatim from that file. The join function is unchanged; it simply gets
back the table it was always written against. The newer `rate_limit_buckets`
limiter is left alone — swapping this function onto it is a security-sensitive
change that deserves its own PR, not an outage fix.

## 4. Deep Stack Society joins the automated-member allowlist

Not a defect — a ruling. `20260902012000_user_clubs_reject_automated_members`
established that automated players belong only to house boards and "must never
appear in a club a player created through Create A Club", and its repair block
hard-codes Deep Stack Society's uuid. It removed a 416-account population that
had joined an hour earlier through the canonical workflow.

Two workstreams, one database, opposite instructions. Dan ruled that Deep Stack
Society is a house board: it is owned by `kingfish`, the same account that owns
all three boards already allowlisted, and it exists to exercise the horse
hierarchy against a standalone club.

This **adds one uuid**. The rule stands unchanged for every genuine user club,
and the migration verifies that all three original boards survive — evicting one
while adding Deep Stack would silently strand a live fleet.

## 5. A deleted user could not be told its dashboard changed

`bump_daily_challenge_dashboard_revision` fires `AFTER DELETE` on
`user_daily_challenges` and `challenge_streak_state`. A cascading account delete
reaches those tables, the trigger inserts a revision row keyed to the user, and
that column references `profiles` — already removed by the same cascade. The
insert violated its own foreign key and aborted the delete, surfacing as
"Database error deleting user".

The revision row exists so a live dashboard knows its data is stale. A user who
no longer exists has no dashboard, so the insert is now guarded on the profile
still existing. The DELETE trigger is kept: deleting one challenge row for a
user who is still present is a real change and must still bump.

**Deliberately not fixed beyond that.** With the guard in place a cascade next
reaches `diamond_transactions` and is refused by `fn_ca_journal_append_only`,
because financial journals are append-only. That refusal is correct and stays.
Every account receives a diamond grant at signup, so every account has journal
history, and erasing it to delete a user is the wrong trade. Authorized removal
goes through `app.ledger_maintenance` with an incident reference — verified
working by creating a throwaway account and removing it that way.

## Pins

`tests/unit/authAndJoinRepairsStayInTheTree.test.ts`, 5 assertions, guarding the
mirror image of the defect that caused the join outage: a migration that reached
the database drifting back out of the repo.

Seven mutations applied and observed. Two found weak pins of my own first:
`toContain('public.rate_limits')` still matched `public.rate_limits_renamed`,
and a whole-file uuid search matched the verify block rather than the
constraint's own list. Both re-anchored and re-mutated.

client 10936 passed / 788 files, tsc clean.
