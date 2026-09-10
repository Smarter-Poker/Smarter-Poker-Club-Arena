# tests/a-browser-never-writes-the-waitlist-itself.law.test.ts

`table_waitlist` had a FOR ALL policy on one's own rows with write grants to
the browser roles, so a signed-in player could write itself a `notified` hold
at any table for any duration and block chairs everywhere the hold is read.
The policy is SELECT-only, the write grants are revoked, and the two
legitimate browser writes go through `fn_table_waitlist_join` /
`fn_table_waitlist_leave`, SECURITY DEFINER doors keyed on `auth.uid()` that
refuse what the offer path refuses; every client caller of a direct write is
named in the migration for lane G to move.
