# tests/a-browser-cannot-forge-its-own-profile.law.test.ts

Launch audit, 2026-10-05. A signed-in account held table-level INSERT and DELETE
on `profiles`, the row policies checked only `auth.uid() = id`, and the
privileged-column guard fired on UPDATE alone, so a player could delete its own
profile and insert it again with `role = 'god'` and a diamond balance
(`fn_is_platform_admin()` reads that column). The 2026-08-27 attempt was a
column-level `REVOKE INSERT`, which does nothing under a table-level grant.
Migration 20261005220434 closes the two doors themselves: no browser role may
DELETE a profile, and a profile INSERTed from a browser context may carry
nothing privileged (server-side creators pass untouched). It also takes the
KYC, age, MFA and farming flags out of a player's own UPDATE grants. Migration
20261005221203 moves `dblink`, which `anon` could call through
`/rest/v1/rpc`, out of the exposed `public` schema and re-points its one caller
in the same transaction. The law pins that both migrations exist, close the
doors rather than describe them, assert their own effect, and that no later
migration grants DELETE back, drops the insert guard, or returns dblink to
`public`.
