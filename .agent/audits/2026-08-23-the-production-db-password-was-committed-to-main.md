# The production database password was committed to main

Date: 2026-08-23
Author: cowork-nocreds
Severity: credential exposure. **Requires a rotation that no code change can do.**

## 1. What was there

`.github/workflows/run-sql.yml` contained the **production Postgres superuser
connection string, password inline**, as a literal in a tracked file on `main`:

    run: psql "postgres://postgres:<PASSWORD>@db.kuklfnapbkmacvwxktbh.supabase.co:5432/postgres" -f supabase/migrations/<file>.sql

That is the `postgres` role on the smarter.poker project — full read/write on
every table, RLS not applicable, no scope limit of any kind.

It has been on `main` since `4edf94705` ("Fix members page loop and add union
wallets", PR #191).

This directly contradicts `AGENT-PLAYBOOK.md`, which states that **no secret
value is written in any file in these repos** — only the place it lives. Every
other credential in the estate honours that: `AUTOPILOT_APP_PRIVATE_KEY`,
`GH_PAT`, `SUPABASE_SERVICE_ROLE_KEY`, `HETZNER_SSH_PRIVATE_KEY` are all repo
secrets. This one was typed in.

## 2. Why it was removed rather than converted to a secret

Three reasons, any one sufficient:

1. **There is no secret to convert it to.** `gh secret list` has no
   `SUPABASE_DB_PASSWORD` / `SUPABASE_DB_URL`. Creating one requires the
   password value, which must now be treated as compromised anyway.
2. **The workflow was a loaded gun.** It triggers on any push to
   `chore/run-sql` and runs a **hardcoded, stale** migration path
   (`20260821_leaderboard_by_dates_rpcs.sql`). Anyone pushing that branch for
   any reason re-executes a migration from two days earlier against production.
3. **It is redundant.** The playbook names the Supabase MCP `apply_migration`
   as the route for migrations, and it works — `20260823050524_retire_ofc_pineapple_variant`
   was applied through it minutes before this file was written. For a psql-style
   path, `scripts/orb-sql-deploy.cjs` (`npm run db:push`) already exists and is
   correctly env-backed: `env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_DB_PASSWORD || ''`,
   with no literal fallback.

`scripts/orb-sql-deploy.cjs` was checked and is **clean**. An initial scan
flagged it, but the match was on the identifier `dbPassword`, not a value.

## 3. What deleting the file does NOT fix

**The password is in git history permanently.** Removing the file stops the
exposure going forward and stops the stale-migration hazard; it does not
un-publish the secret. Anyone who has ever cloned this repository, and anything
that has ever mirrored it, still has it.

**The only real fix is rotating the Postgres password** in the Supabase
dashboard for project `kuklfnapbkmacvwxktbh`. That is a human action — it needs
the dashboard, and rotating it may require updating anything that authenticates
with it (`SUPABASE_DB_PASSWORD` wherever it is set locally; the service role key
is a separate credential and is unaffected).

This was already sitting in the backlog as "Rotate SUPABASE_PASSWORD" with no
stated reason. This is the reason, and it is more urgent than a housekeeping
item.

## 4. Note for whoever rotates it

Do not paste the new password into a workflow. If a psql-in-CI path is ever
genuinely needed again, add `SUPABASE_DB_URL` as a repo secret and reference it
as `${{ secrets.SUPABASE_DB_URL }}`, and take the SQL file from a
`workflow_dispatch` input rather than hardcoding one, so the workflow cannot
silently re-run last week's migration.
