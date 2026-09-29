# 2026-09-29 - Club staff can remove a settled member again

Found while building account closure, which applies the staff departure rules
to every club: removing a member from a club failed for every member.

## Why

`fn_remove_settled_club_member` - what Member Management calls through
`MembershipService` - read `club_members.id` three times: in the downline
check, as the audit row's `target_id` and in the departure UPDATE's WHERE.
`club_members` has no `id`; its key is `(club_id, user_id)`. PL/pgSQL does not
check a record's fields until the line runs, so the function was created
cleanly and failed at run time: 42703 `record "v_target" has no field "id"`.
Measured on production in a rolled-back transaction as SHARK CLUB's owner
removing a zero-balance player: 42703. `audit_trail` held no
`depart_club_member` row, and no membership had ever been departed by staff.

## What changed

Migration `20260929062121_staff_can_remove_a_settled_member_again`: the same
function with the three reads corrected - the downline is a member whose
`agent_id` or `parent_agent_id` is the player (`agent_id` references
`profiles.id`), the audit row names the membership by the player's id beside
the club, and the departure finds the row by `(club_id, user_id)`. Every
refusal, lock, grant and the money-registry row are unchanged.

Measured before applying, rolled back: the owner removing a zero-balance
player succeeds (departed, suspended, "Removed By Club Staff", one audit row);
removing the owner and a member holding chips is refused with the same words.
Applied 06:21 UTC; the live body's md5 matches the file's. A search of every
live function found no other `club_members` record read as `.id`.

`tests/a-membership-has-no-id-of-its-own.law.test.ts` holds every function in
force to it (a mutant reading `v_target.id` fails both cases).
