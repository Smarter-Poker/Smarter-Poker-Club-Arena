# Only club staff can remove a member

**Date:** 2026-10-12 (launch day)
**Migration:** `supabase/migrations/20261012132509_only_staff_can_remove_a_member.sql` (database only; no engine or client release)
**Qualified by:** `scripts/ci/test-only-staff-remove-member-db-postgres.py` (PostgreSQL 17, accounting_postgres shard 2)
**Law:** `tests/only-staff-can-remove-a-member.db.law.test.ts`

## What was wrong

`fn_remove_settled_club_member` marks a club membership departed. It runs with
the database owner's rights and every signed-in player may call it, so the
function itself has to decide who may use it.

Production, read-only, 2026-10-12 13:20 UTC: its body was not the reviewed one.
It had been edited by hand on production, outside every migration, before 06:14
UTC (20261012061427 recorded that body as its preimage and changed only its
error code). The edit:

- turned a caller with no signed-in user into the all-zero user ("Allow system
  bypass") instead of refusing them;
- removed the check that the caller is the club owner, a co-owner or a club
  admin;
- removed every settlement check ("BYPASSED SEAT CHECKS FOR BOT RETIREMENT!"):
  the owner, staff, a player seated at a live table, a player holding chips,
  credit, diamonds, escrow, a cashout, a ticket, a chip request, a tournament
  entry, an agent wallet or a downline;
- removed the locks and the audit row.

So any signed-in player could mark any member of any club departed, including
the club owner, a seated player or a player holding chips.

## Who needed the bypass

Nobody. No database function calls it (two only name it in comments), nothing
in the engine, scripts or World Hub calls it, pg_stat_statements has no call to
it, and `club_members` holds no departed row at all: no membership has ever left
through it, by staff or by "system". The 1,903 bot memberships are all active;
bots are kept out of user-created clubs by `trg_club_members_human_user_club_only`,
not by a departure. A system path nothing uses is only a hole, so none is kept.

## What changed

The reviewed function from `20260929062121_staff_can_remove_a_settled_member_again`
is back, byte for byte, with the one later reviewed change (the "membership
changed during departure" error is 55000, from 20261012061427):

1. A caller with no signed-in user: **Authentication Required**.
2. Anyone but the club owner, a co-owner or a club admin: **Only Club Staff Can
   Remove A Member**.
3. The owner is never removed; staff must be demoted first.
4. A member with any balance, seat, entry, escrow, cashout, ticket, chip
   request, agent wallet or downline is refused with the same words as before.
5. A departure is audited and keeps the row.

Its settings return to the reviewed ones (search path `public, pg_temp`, a 5
second lock timeout). Owner, SECURITY DEFINER, result and grants (signed-in
players and the service role; never anon) are unchanged and re-checked. The
union owner guard (`trg_union_owner_membership_is_kept`, 20261012112707) is a
trigger and still refuses on its own.

The migration refuses an unknown starting body (definition md5
`acdfe7bc5b3138c9c188cdf1e8e24f22`, source md5
`081b54ee2f9dd672bc1c7deee24a8119`) before it changes anything, checks its
result (`4231ca3eb326ffc7e9b2ed529b532bc6`), and a re-run changes nothing.

The client already shows each refusal's own words; no client change.

## Evidence

PostgreSQL 17 with production's drifted body installed byte for byte and the
union owner guard installed first: 16 of 23 cases fail before (a stranger
removes another club's member and its owner, a plain member removes another,
staff remove the owner, a seated, chip-holding, diamond-holding, entered,
escrowed, requesting or downline-holding member is removed, a signed-out caller
removes a member, no audit row), 23 of 23 pass after. A drifted body, a
rolled-back run and a browser role install nothing; a re-run changes nothing.

## Other definer functions checked (read-only)

Every SECURITY DEFINER function a signed-in player can call was searched for
"bypass" and for a missing user being replaced instead of refused. Only this
function had a hole. `set_push_type_pref` uses its `p_user_id` argument when
there is no signed-in user, but anon cannot call it and a signed-in caller
always has a user, so it can only change the caller's own preferences. The other
"bypass" matches are comments about the service role or money-cap alarm text.
