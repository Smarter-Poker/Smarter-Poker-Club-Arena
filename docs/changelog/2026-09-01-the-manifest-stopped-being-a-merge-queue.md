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

---

## 4. And main went red a second time, from the other direction

An hour after the watchdog test was fixed, `noFixedSizeSourceWindows` started
failing on three source pins that had landed meanwhile:

```
server/src/engine/GtoDepthCeiling.test.ts:141        league.slice(at, at + 300)
server/src/engine/SqueezeAndPagination.law.test.ts:47  logicSrc.slice(at, at + 900)
server/src/engine/SqueezeAndPagination.law.test.ts:69  logicSrc.slice(at, at + 900)
server/src/services/PagedReadsAreDeterministic.law.test.ts:53  src.slice(idx, idx + 60)
```

That guard exists because of a real publish outage on 2026-08-28: a 7000-byte
window drifted off the code it was watching when comments were added, three
pins went red, the guarded code had not changed by a character, and the whole
estate published nothing for 39 minutes.

**This one was hidden.** Main's own CI gates the unit job behind the changed
files, so a docs-only commit to main goes green in 0.2 minutes without ever
running the suite - main showed a wall of green ticks while carrying a red
test. It only bit branches that touch `tests/` or `src/`, which is every branch
doing real work.

All four windows are now bounded by the structure they are about, using the
extractors the guard's own message points at:

- the `squeezed:` branch is bounded by the next property in the same object
  literal (`sliceBetween(logicSrc, 'squeezed:', 'omahaAA:')`), which matters
  most for its `not.toMatch(/\bcallers >= 1\b/)` - a forward byte window can run
  past the property and read a match belonging to something else;
- the `.range(` argument check is bounded by the call's own matching paren
  (`sliceCall`);
- `GtoDepthCeiling` was fixed on main by another agent while this was in flight.

27 tests across those three files pass, and the meta-guard is green.

### The durable half: the guard cannot be hidden any more

Fixing the four windows was the easy part and it did not hold - a fifth landed
(`ActionStageTravelsWithTheEvent.test.ts`, `src.slice(at, at + 4000)`) while the
first four were being fixed, and three agents spent the same morning
rediscovering the same red test one file at a time.

The reason it kept happening is that **main could not see it**. `ci.yml` gates
the unit job behind the changed files, so a docs-only commit to main goes green
in twelve seconds without running the suite. Main showed an unbroken wall of
ticks while carrying a red test that failed on every branch touching `src/` or
`tests/` - which is every branch doing real work.

`noFixedSizeSourceWindows` now runs in its own **ungated** CI job, on pushes to
main as well as on pull requests, alongside `typecheck` and `stub_gate`. It
reads source and asserts on text: no database, no build, no network, well under
a second. There was never a reason for it to sit behind a gate that could hide
it. The guard now also pins its own wiring, so nobody can quietly move it back
behind one.

## 5. Main went red a third time, from the same root cause

`headsUpTurboAndSeatCount` pinned `PAYOUT_SWEEP_DEEP_LIMIT = 40000` as a
literal. The limit was deliberately raised to 150,000 - about 3x the current
event population, with the reasoning written beside it in
`RakebackSettlerService` - and the pin went red on a change that made the sweep
strictly better. Nothing published for anyone until it was noticed.

Three red-main incidents in one session, all the same shape: **a pin written as
an exact literal, and an improvement that changes the literal.** The pin is now
a floor rather than an equality. The bug it exists to catch is a limit too
SMALL to cover its window - a large one costs seconds, a small one silently
shrinks the window back down and is the original defect in a new coat - so it
asserts the direction that can actually hurt and lets the number grow with the
platform. The invariant test directly below it already checks the same property
against the measured population.

That is the general lesson for anyone writing a source pin here: **assert the
direction that can hurt, not the value that happens to be there today.** An
equality pin turns every future improvement into a publish outage, and the
person who pays is whoever is trying to ship something unrelated.
