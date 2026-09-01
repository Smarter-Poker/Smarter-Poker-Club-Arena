# 2026-09-01 - What was blocking every agent from pushing, and what fixed it

Two things were stopping work from landing. Neither was in anybody's code.

## 1. Main was red, so the bundle could not publish for ANYONE

`build-for-world-hub.yml` is what publishes the client bundle. Its "Client
tests must pass before the bundle ships" step had failed four times in the last
hour, and production was serving `4ea44a83` while main was `596eaed4`.

Exactly one test out of 10,900 was red:

```
tests/engine-watchdog-asks-production.test.ts
  > it fails in the safe direction
  > gives the catch-up schedule a grace window before raising anything
  790 passed, 1 failed
```

The watchdog's grace rule had been deliberately replaced with a better one. It
used to raise 45 minutes after a commit landed; but the engine does not restart
on merge, it restarts at `$RESTART_HOURS` America/Chicago, so a flat 45 minutes
was never a deadline the platform was trying to meet and the alarm fired every
morning about a system behaving exactly as designed. The new deadline is the
first restart window at or after the commit, plus one deploy, floored at
`GRACE_MIN` so it can never be less patient than the rule it replaced.

The mechanism improved. The test still asserted the old sentence
`inside the ${GRACE_MIN}m grace window`, which the script no longer says. This
is CLAUDE.md rule 8: replace behaviour a test pins and you update that test in
the SAME commit, because "someone else will fix the test" means "nobody ships
until they do". Four publishes and every agent behind them are what that costs.

**The pin moved rather than weakened.** It now asserts the floor is a floor
(`[ "$GRACE_DEADLINE" -gt "$DEADLINE" ] && DEADLINE=$GRACE_DEADLINE`) and that
inside the window the script reports and exits 0 without raising - a stronger
guarantee than the sentence it replaced, and one that cannot be broken by
rewording a message.

## 2. The schema manifest had become a merge queue

Measured on main over 24 hours:

| file                                          | commits |
| --------------------------------------------- | ------- |
| **scripts/ci/supabase-schema-manifest.json**  | **25**  |
| tests/unit/GlobalHeaderNav.test.ts            | 14      |
| **scripts/ci/supabase-columns-manifest.json** | **14**  |
| src/pages/club/ClubDataPage.tsx               | 13      |

The two manifests were the most-changed files in the repository, ahead of every
piece of source code. They are sorted JSON arrays that every agent shipping a
migration has to append its own names to, so **any two such branches conflict by
construction**. Main takes a commit every seven minutes here. A branch that has
to merge main, re-resolve the manifest, wait three minutes for the pre-push hook
and twenty-five for CI loses that race about half the time - and then loses the
retry. PR #2453 went `dirty` twice inside twenty-five minutes without one line
of its own code changing.

This is CLAUDE.md rule 10.9 happening a second time. MIGRATION-CHANGELOG.md was
18 of 108 conflicting pull requests because every agent appended to the last
line of one file, and the cure was to give each agent its own file: "two files
written independently cannot conflict."

**Same cure.** The base snapshots are now read-only to agents. Declare what you
created in `scripts/ci/schema-manifest.d/<your-slug>.json`:

```json
{
  "_owner": "fix/seat-exit-repair-arm",
  "tables": ["ca_engine_deploy_attempts"],
  "functions": ["fn_ca_engine_deploy_truth_watch"],
  "columns": { "tables": ["no_rathole"] }
}
```

`scripts/ci/schema-manifest.mjs` reads the base UNION every fragment, and the
three gates that used to read the base directly now read that overlay:
`check-phantom-tables`, `check-phantom-columns`, `check-migrations-applied`. All
three were run against the live tree before and after: identical output, 0
phantoms, 0 unapplied objects.

### Why this does not weaken the gates

The overlay only ever ADDS names, so everything nobody has declared is policed
exactly as strictly as before. What keeps a fragment honest is that fragments
are temporary. `prune-schema-fragments.mjs` runs inside the nightly refresh, at
the one moment the base is a fresh copy of production:

- names production now has are **absorbed**, and a fragment with nothing left to
  declare is **deleted** - the directory empties itself and no agent has to
  remember to clean up;
- a name production does not have is a **warning** under a day old, because an
  agent may legitimately commit the fragment minutes before applying the
  migration, and an **error that fails the job** after that, because by then it
  is widening the phantom-reference gate for something that will never exist.

Drilled both directions before shipping: a fragment naming a live function was
absorbed and its file removed; one naming `fn_this_does_not_exist_drill` was
kept, reported, and would go red tomorrow.

## 3. The docs sent agents down a dead route

CLAUDE.md section 11 described the cloud sandbox - device-bridge GitHub MCP,
`device_bash`, no direct git push. In a Cowork session on Dan's Mac the reverse
is true, and the GitHub MCP has been returning `Bad credentials` on every call.
Section 11.0 now says which environment you are in and what works in each: the
host terminal, the worktree claim, the `node` PATH, the three-minute pre-push
hook, `curl` instead of `gh`, and merge-not-rebase. `AGENT-PLAYBOOK.md` was
deliberately not touched - it is byte-identical across seven repos and
`estate-integrity.sh` checks that hourly.
