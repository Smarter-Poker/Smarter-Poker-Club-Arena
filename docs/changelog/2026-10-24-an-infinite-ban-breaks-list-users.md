# An infinite ban broke listUsers for the whole project (2026-10-24)

**Club Create Certification** failed 59 runs in a row from 2026-10-23 18:38Z with `Legacy Certificate Inventory Failed: Database error finding users`. No commit caused it. GoTrue's own log gave the reason for every `GET /admin/users`:

> unable to fetch records: sql: Scan error on column index 1, name "banned_until": unsupported Scan, storing driver.Value type string into type \*time.Time

One `auth.users` row, the post-deploy customization certification fixture `0021dadd-59e8-41b7-9b11-a5a6e9975b76`, held `banned_until = 'infinity'`: the only non-finite timestamp among 3,662 users. Postgres returns it as the string "infinity", GoTrue cannot read it into a Go time, and so listing users failed for every caller in the project, not just the certificate.

It was written between 18:22:35Z and 18:38:29Z on 2026-10-23 by a direct SQL write. GoTrue's `ban_duration` only writes finite times, and no function, trigger or tracked script writes `banned_until`.

## Fix

- `20261024220826_an_infinite_ban_breaks_list_users`: the ban is kept in the finite form GoTrue itself writes for a permanent ban (`now() + 876000 hours`), and the migration asserts no non-finite `auth.users` timestamp is left. Data only, no DDL.
- `tests/no-auth-user-timestamp-is-infinite.law.test.ts`: refuses any tracked SQL that writes `'infinity'` / `'-infinity'` into an `auth.users` column.

Same class of fault as `20260901013451_20260831_the_system_row_breaks_list_users` (a NULL GoTrue could not scan).
