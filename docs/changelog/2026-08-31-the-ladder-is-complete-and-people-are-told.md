# The Ladder Is Complete, And People Are Told

**2026-08-31 - Phase 5 Of 7, Agent Credit And Promotion Lifecycle**

## What Was Wrong

The promotion ladder worked, and said nothing.

`fn_club_set_member_role` changed a role, wrote an audit row, and stopped. The
only announcement was `masterBus.emit('MEMBER_ROLE_CHANGED')`, a browser-local
event: it reaches the tabs of whoever performed the change and nobody else. The
person whose role actually changed found out when a button appeared or vanished.

`public.notifications` is the estate's real channel - 11,362 rows, four RLS
policies, rendered by `NotificationDropdown`, the header store and
`NotificationsPage` - and nothing in the promotion path wrote to it.

`transfer_club_ownership` was worse. A club changing hands is the largest thing
that happens to a club, and it was the least recorded: one `role_changes` row
with `member_id` NULL - the column that says WHO - written inside
`EXCEPTION WHEN OTHERS THEN NULL`. A failed insert meant a club changed hands
leaving no trace at all, and neither party was told.

## What Changed

`fn_club_set_member_role` now raises a `club_role_changed` notification naming
the new role in words a person reads ("You Are Now Super Agent"), and for the
three agent roles the terms that came with it - commission, player rakeback, and
prepaid or the credit line and its size. The payload carries the same terms
machine-readably, and the link goes to the club.

`transfer_club_ownership` now writes TWO complete `role_changes` rows, both
carrying `member_id`, plus an `audit_trail` row naming the club and both owners,
and notifies both parties - including the outgoing owner, who is no longer an
owner and should hear that from the club rather than notice it.

## What May Be Swallowed, And What May Not

The notice is a courtesy and may fail silently; a courtesy that can roll back a
promotion is worse than no courtesy at all. So each notify sits in its own
`BEGIN/EXCEPTION` block, after the record is already durable.

The books may not be swallowed. The silent swallow around the ownership audit
insert is gone: a handover that cannot be recorded does not happen.

Both directions are pinned in
`tests/the-ladder-is-complete-and-people-are-told.law.test.ts`, including that
`transfer_club_ownership` contains exactly ONE `WHEN OTHERS` handler and that it
sits after both writes. The failure mode being guarded is a later edit widening
that swallow back up over an insert, which is invisible in review and silent in
production. The migration asserts the same thing about the live definition
before it commits.

## Provenance Of This Migration File

`20260901000010` was applied to production on 2026-08-31 and recorded in
`supabase_migrations.schema_migrations`. The worktree holding the file was lost
before it reached git.

The file in this change is reconstructed from the deployed definitions via
`pg_get_functiondef`, and verified rather than asserted: applied inside a rolled
back transaction, the definitions it produces are **byte identical** to the
live ones (18,959 and 3,570 bytes). It is idempotent - re-running it replaces
each function with the definition already in place.
