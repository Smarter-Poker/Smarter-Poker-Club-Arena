# tests/no-auth-user-timestamp-is-infinite.law.test.ts

Nothing tracked may write 'infinity' or '-infinity' into an auth.users column. GoTrue scans those columns into Go time values and cannot read a non-finite one, so a single such row makes GET /admin/users fail with HTTP 500 for every caller in the project: on 2026-10-23 one fixture's banned_until = 'infinity' broke listUsers for over a day and failed Club Create Certification 59 times (repaired by 20261024220826). A permanent ban is GoTrue's ban_duration, which always writes a finite time.
