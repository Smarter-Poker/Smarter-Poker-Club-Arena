# tests/a-revoke-from-anon-must-name-public.law.test.ts

A function is created with EXECUTE granted to PUBLIC, and `anon` is a member of
PUBLIC, so `REVOKE EXECUTE ... FROM anon` removes anon's own entry and changes
nothing about what anon can execute. PR #4872 "anon executes only what it
needs" merged on 2026-09-18 doing exactly that to thirteen inert grants; it was
never applied, and applying it on 2026-09-19 failed on its own assertion with
`anon still executes 9 of the thirteen` - those nine carried `=X/postgres` in
pg_proc.proacl and the revoke had not touched it. The other four had no PUBLIC
entry and would have been revoked correctly, which is what makes this worth a
law: the same statement works on some functions and silently does nothing on
others, and the difference is invisible in the diff. Meanwhile
docs/security/anon-executable-definers.json already described the post-revoke
world, 22 allowed against 35 live, so the repository documented a state the
database could not reach, and check-anon-definer-grants.mjs had been failing on
exactly those thirteen inside a workflow that was switched off. The fix revokes
PUBLIC as well as anon on all thirteen and proves before committing that anon
executes none of them while authenticated and service_role keep all thirteen.
The forward guard is the regression this expects: no migration after
20260919071318 may revoke EXECUTE from anon without naming PUBLIC, because that
statement reads correctly and does nothing, and nothing goes red for a day. A
statement that genuinely must not touch PUBLIC ends with `-- public-ok: <why>`.
