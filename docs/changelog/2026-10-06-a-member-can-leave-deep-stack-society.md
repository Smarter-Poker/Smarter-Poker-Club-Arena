# A member can leave Deep Stack Society (2026-10-06)

## What was wrong

`trg_deep_stack_members_are_protected` refuses every DELETE on a Deep Stack
Society `club_members` row unless the transaction has set
`app.deep_stack_teardown = 'on'`. It was added after the whole club was once
deleted with no audit trail. `fn_member_leave_to_treasury`, the one door a
member leaves through and an owner removes a member through, ends in a DELETE
of that row and never set it. So in the one public club every leave raised
`DEEP_STACK_PROTECTED`, the call rolled back (no chips moved), and the client
answered "Failed to leave club - please try again".

## The fix, at the cause

Migration `20261006041001`: the leave door declares itself for its own
single-row delete and restores the previous value of the setting straight
after, inside the same block. The guard is untouched: it still records the
delete in `deep_stack_delete_attempts` (now with `allowed = true`), and any
other DELETE on those rows, including one later in the same transaction, is
refused exactly as before.

## Proof

Scratch PostgreSQL 16 with the installed definition (md5
`b7d38f85200e6b248c37cbc0df25ce4c`) and a guard of the same shape: before the
migration the leave raises; after it the leave succeeds and returns the
member's chips to the treasury, the setting reads empty again immediately
afterwards, and a plain DELETE issued next in the same transaction is still
refused. Applying the migration twice is a no-op.
