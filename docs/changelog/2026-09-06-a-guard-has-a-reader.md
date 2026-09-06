# A guard has a reader, and Club Arena did not have one

2026-09-06.

Three separate investigations today ended at the same place, so this file is
about the shape rather than the three bugs.

## The gap

CLAUDE.md 10.83 was written this morning and says a detector raises an issue
for any workflow red on `main` with nobody watching. It names
`scripts/ci/check-main-is-green.mjs` **"(World Hub, in `publish-watchdog.yml`)"**.

That sentence is inside **Club Arena's** CLAUDE.md, and Club Arena did not have
the detector. Every agent reading this repo's instructions has been told a guard
was watching, and none was. That is worse than the plain gap: a stated guard
stops people looking.

Pointed at Club Arena for the first time, it found three workflows failing on
`main` with no open issue naming any of them:

```
SILENT CI — Build & Type Safety                 1.4h, last green 11:00:19Z
SILENT Applied Migrations Are Recorded          1.0h, no green in the window
SILENT Deploy Monitoring (infra/monitoring)     0.3h, no green in the window
```

It also correctly ignored `Publish Club Arena`, whose latest run was
**cancelled** - the publisher superseded by a newer merge, which happens several
times an hour. A detector that counted that as red would have been muted inside
a day.

**The third row is the whole argument.** `check-alert-rules-match.mjs` could not
read the running rules off engine-01 and refused to pass - doing precisely what
CLAUDE.md 10.84 built it to do yesterday, refusing to be silently green when it
cannot reach the stack. It went red. Nobody was told. A check behaving perfectly
is worthless if its result has no reader.

## Shipped

- `scripts/ci/check-main-is-green.mjs`, the World Hub's file unchanged (it is
  already parameterised by `GITHUB_REPOSITORY`), so the two repos converge
  rather than growing two dialects of the same detector.
- A `main_is_green` job in this repo's `publish-watchdog.yml`: raises one issue,
  comments on it while it persists, closes it when every workflow's latest run
  on `main` is green again.
- `tests/a-guard-has-a-reader.law.test.ts`, which pins the detector **and its
  reader**.

The law is deliberately about the alarm's plumbing, because that is where this
class of bug hides:

- `runs-on: ubuntu-latest`, never `vars.CI_RUNNER`. The alarm shells out to
  `gh`, which is preinstalled on GitHub-hosted runners and not guaranteed on the
  estate's self-hosted boxes - and an alarm must not share a failure domain with
  the boxes it watches. (Club Arena's other watchdog job already pins this for
  the same reason.)
- `issues: write`, or `gh issue create` 403s and the detector is decorative.
- Both a raise **and** a close path. An alarm that cannot clear itself becomes
  wallpaper, which is the thing 10.83 exists to stop.
- The exit code read from `${PIPESTATUS[0]}`, because `tee` always succeeds.

**One pin was a false green and had to be fixed before this shipped.** The
PIPESTATUS check started as `toContain('PIPESTATUS[0]')` and passed against the
_comment_ above the code explaining why PIPESTATUS matters - so replacing the
real line with `code=$?` left the law green. It now matches the assignment on a
non-comment line. Verified in both directions: green clean, and red against each
of the four regressions (detector deleted, alarm moved to a self-hosted runner,
PIPESTATUS swapped for `$?`, CLAUDE.md re-crediting the World Hub).

## The doctrine, so it stops being re-derived: CLAUDE.md 10.86

Every finding today was a component giving a well-formed answer it had no
business giving. Not one was carelessness:

| what answered                        | what it said                    | what was true              |
| ------------------------------------ | ------------------------------- | -------------------------- |
| `/commits/:sha/status`               | `pending`, HTTP 200             | red for fifteen hours      |
| `/commits/:sha/check-runs`           | 403 -> `undefined` -> `\|\| []` | "nothing failed"           |
| a wait budget equal to `testTimeout` | `Test timed out in 10000ms`     | names no cause             |
| `pr-status.mjs` on a 403             | "the token lacks a scope"       | rate limited; token fine   |
| the `--all` mergeability read        | every branch clean              | eight conflicted           |
| CLAUDE.md 11.0                       | "the GitHub MCP is dead"        | it works                   |
| AGENT-PLAYBOOK's CI section          | four `gh` commands              | `gh` is not installed here |
| 10.83 itself                         | "a detector raises the issue"   | not in this repo           |

Four rules follow, and the fourth is the one that caught good work twice:

1. **"I could not tell" is a distinct outcome and needs its own name.** Never
   fold it into pending, green, empty, zero or silence.
2. **Never coerce an unreadable answer into an empty one.** Check `res.ok`.
3. **A guard must have a reader, and you must name them.** "It goes red in
   Actions" is not a reader.
4. **A fix that leaves the same trap one level up has not landed.** Two agents
   correctly de-flaked a `sleep` into a conditional wait and both set the budget
   to the ceiling they had just read. The playbook correctly diagnosed the
   `checks:read` 403 and then offered four commands that do not exist on this
   machine. When you fix something, ask what the next person reaches for, and
   check that it works.

Plus an expiry rule: claims about the environment ("the MCP is dead", "`gh` is
installed") go stale without anyone touching this repo, and a note that retires
a working tool costs more than the outage that prompted it. Date the claim and
re-check it in one call before routing around anything.

## Still open, and not mine to close

`Deploy Monitoring` is red because
`ssh root@… curl -sf localhost:9090/api/v1/rules` failed. Either Prometheus on
engine-01 is not answering or the deploy path to it is broken. **Monitoring may
currently be blind**, which is the precondition for the 22-hour outage in 10.10.
CLAUDE.md 10.84 puts the box itself out of an agent's reach - monitoring changes
are a pull request plus `deploy.sh`, never an editor or a fix over ssh - so this
is reported here and named in the alarm the new job will raise, rather than
touched.
