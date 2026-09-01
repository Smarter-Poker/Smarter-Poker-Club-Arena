# Recording two migrations that were already live (2026-09-01)

## What was wrong

Two functions were applied to production via the Supabase MCP and the
migration files were never committed:

- `fn_audit_river_aggression_ev` (with PR #2470)
- `fn_audit_fleet_health` corrections (with PR #2479)

Both PRs merged. The database has the change; the repository did not.

The rule is "save migrations under `supabase/migrations/` **AND** apply them
to production" and only half of it was done. A definition that exists only in
the database cannot be reviewed, cannot be reproduced on a fresh project, and
disappears from the audit trail the moment someone asks why the function looks
the way it does.

## How it was caught

The Playbook's own verification pass, Part C item 3 -- "Did you write a
migration? Was it actually APPLIED?" Checking each new symbol for a caller in
the repo, `fn_audit_nightly_job_health` and `fn_audit_river_aggression_ev`
both came back with zero references. The first was explained (its file is in
PR #2460, still open). The second was not.

## What this adds

The two files, containing the definitions that are **already live**. Both are
idempotent by construction:

- the river EV migration is `CREATE OR REPLACE` plus a splice that returns
  early if the hook is present;
- the fleet migration returns early if `coalesce(horse_status` is already in
  the function body.

Verified against production before committing: both guards currently evaluate
to "already applied", so re-running either is a no-op. Neither writes data, so
both rollbacks are pure definition reverts.

## Note for the next agent

Applying through the MCP and committing the file are two separate acts and the
MCP does not do the second one. If a session applies a migration, the file
belongs in the same PR as the code that depends on it.
