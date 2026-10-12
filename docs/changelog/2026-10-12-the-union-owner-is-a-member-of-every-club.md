# The union owner is a member of every club in the union

**Date:** 2026-10-12 (launch day)
**Owner rule (Dan, verbatim):** "union owner MUST BE A MEMBER OF EVERY CLUB THAT JOINS."
**Migration:** `supabase/migrations/20261012112707_the_union_owner_is_a_member_of_every_club.sql` (database only; no engine release)
**Qualified by:** `scripts/ci/test-union-owner-membership-db-postgres.py` (PostgreSQL 17, accounting_postgres shard 2)

## What existed

Nothing tied a union's owner to the clubs in the union. A club joined a union by a
`union_clubs` row (application approval, invitation, direct add, a founding club,
a re-join, or a reassignment) and the owner's membership in that club was whatever
it happened to be: none, pending, departed, banned. Any removal door
(`fn_remove_settled_club_member`, `fn_club_set_member_status`,
`fn_member_leave_to_treasury`, a direct write) could end the union owner's
membership in a club of the union.

Production, read-only, 2026-10-12 11:10-11:30 UTC: one union (Midway Union) with
two clubs (Club JAQK, SHARK CLUB); the union owner already owns both, so every
pairing was already an active membership. Union owners banned or suspended in
any club: 0. No database function writes `union_clubs` or `unions.owner_id`;
joins come from the server and staff tools.

## What changed

1. **Every join makes the owner a member.** `trg_union_owner_joins_every_club`
   (after insert, or after a reassigning update, on `union_clubs`) calls
   `fn_union_owner_holds_membership` in the same transaction. An active
   membership is left exactly as it is (a club owner stays the owner); a
   pending, inactive or departed one is activated with its role kept (as the
   ordinary rejoin keeps it); otherwise a new zero-chip `player` row is
   written, the role every ordinary join gets.
2. **A change of union owner adds the new owner** to every club in the union
   (`trg_union_new_owner_joins_every_club` on `unions.owner_id`). The previous
   owner's memberships stay as ordinary memberships.
3. **The membership is kept while the club is in the union.**
   `trg_union_owner_membership_is_kept` (before update or delete on
   `club_members`) refuses, with `UNION_OWNER_MEMBERSHIP_REQUIRED`, any change
   that ends or moves the union owner's active membership in a club of the
   owner's union: removal, ban, suspension, leave, deactivation, delete. A role
   change is not a removal. Once the club leaves the union nothing is removed
   automatically, and the club may then remove the former union owner like
   anyone else. A club or person being deleted outright is not refused.
4. **Club discipline is never lifted silently.** A union owner banned in the
   club refuses the join with `UNION_OWNER_BANNED_IN_CLUB`; suspended, with
   `UNION_OWNER_SUSPENDED_IN_CLUB`. The same refusal stops a union passing to
   someone banned or suspended in one of its clubs.
5. **Two gates admit the system membership.** `fn_require_explicit_club_membership_source`
   admits the new source `union_owner_membership`, and `fn_enforce_four_club_limit`
   lets only that source past the personal 10-club cap, so a union with many
   clubs is never refused because its owner already belongs to ten. Both are
   one counted edit, md5-pinned before (`3c4e9aa5...`, `6df4cf34...`) and after
   (`f694fef8...`, `7c79db5e...`); owner, SECURITY DEFINER, search_path and grants kept.
6. **Backfill:** every club already in a union gets its owner's active membership.
   Measured on production: 0 to create, 0 to change.

The client words the three refusals (`SERVER_REFUSALS` in
`src/utils/safeErrorMessage.ts`), so a club owner who taps Remove, Ban or Suspend
on the union owner, or a union owner who taps Leave, reads
"The Union Owner Must Stay A Member Of Every Club In The Union." instead of a
generic failure.

## Money and side effects

No chips move. The new row has zero chips (`fn_membership_starts_with_zero_chips`
forces it too), so no wallet journal, autoledger or tally leg fires, and there is
no welcome grant on `club_members`. The row passes the same audit, member-count,
level, management-access and agreement-history triggers an ordinary join passes,
once each. A `player` membership grants no bank, cashier-staff or finance access:
`ca_can_view_club_finances`, `is_club_admin` and `fn_club_is_staff` stay false,
`fn_club_bank_role` answers `player`, and `fn_can_create_games` already admitted the
union owner through the union (proven before and after in the harness).

## Known consequence

The union owner's union memberships count toward their personal 10-club cap for
clubs they join on their own (`fn_club_membership_count` is unchanged). Only the
membership the union rule creates passes the cap.

## Verification

`python3 scripts/ci/test-union-owner-membership-db-postgres.py` on PostgreSQL 17:
both edited gates rebuilt byte for byte from main's migrations and matched to
production's md5; 22 of 35 cases fail before the install, 35 of 35 pass after; a
drifted gate, a union owner banned in a club of the union, a rolled-back run and
a browser role each install nothing; the backfill inserts 1, activates 2 and keeps
2 in the fixture; every `@live-proof` is false before and true after; a re-run
changes nothing.

**Install:** by the release lead after merge, once, outside the :50-:03 UTC break
window. Expected production effect: 0 rows created, 0 rows changed.
