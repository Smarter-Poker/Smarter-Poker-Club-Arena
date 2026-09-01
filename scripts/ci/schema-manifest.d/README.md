# Declare what you just created HERE, not in the big manifest

`supabase-schema-manifest.json` and `supabase-columns-manifest.json` are
nightly snapshots of the live database. They are **read-only to agents**. They
were the single most-changed file on main - 25 commits in 24 hours, ahead of
every source file - because every agent shipping a migration had to append its
own names to the same sorted array, so any two such branches conflicted by
construction. This is CLAUDE.md rule 10.9 all over again: two files written
independently cannot conflict.

So write your own file instead. Name it after your branch or worktree:

```jsonc
// scripts/ci/schema-manifest.d/cowork-cash-audit.json
{
  "_owner": "fix/seat-exit-repair-arm",
  "tables": ["ca_engine_deploy_attempts"],
  "functions": ["fn_ca_engine_deploy_truth_watch"],
  "columns": { "tables": ["no_rathole"] },
}
```

Every key is optional. The CI gates read the base snapshot UNION every
fragment here, so your new table or function is known immediately and you never
touch a file another agent is touching.

**You do not need to clean up.** The nightly refresh regenerates the base from
production, deletes every fragment it has absorbed, and goes red on any
fragment naming something production does not actually have - so a fragment
that lies survives at most a day and says so.
