# A producer in this repo is not a producer in production

2026-09-21.

## What was asked

CLAUDE.md 10.84: "A rule is not live because it merged. It is live when
`curl -s localhost:9090/api/v1/rules` says so." Several pull requests had
added rules to `infra/monitoring/alert-rules.yml` and the report was that none
of them were running, because `infra/monitoring/deploy.sh` had never been run.

## What was true

That premise was stale, and checking it first is the only reason the real
defect was found. Measured against the live stack on 2026-09-21:

- The monitoring release receipt on engine-01 names `a44c5656`, and
  `infra/monitoring/` is **byte-identical** between `a44c5656` and current
  `origin/main` (`git diff --stat` is empty). The symlinks were rewritten at
  04:23 the same day. A deploy had run.
- **148 rules declared, 148 running. Zero drift in both directions** - no rule
  declared and not loaded, no rule loaded that this repo has never seen. The
  72-vs-79 / 15 / 8 split recorded in 10.84 is closed.
- `MonitoringCanary` is **firing**: `vector(1)`, `state=firing`, one alert held
  in Alertmanager.

So nothing needed deploying, and `bash infra/monitoring/deploy.sh` was not run.
(It could not have been run by hand anyway: the script has since been hardened
to refuse any invocation that is not a workflow-shipped checkout -
`MONITORING_SRC_FROM_CHECKOUT=1` plus a matching `DEPLOY_CONTROL_SHA` and a
payload manifest. 10.84's sentence describes an earlier version of it.)

## The defect

**Eight alert rules across two files read six metrics that have no series, and
the check built to catch exactly this reported every one of them as "not a
failure".**

| metric                                                | rules                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `poker_maintenance_breaks_since_restart_certified`    | `EngineCannotBeReplaced`, `PokerEngineCannotBeReplaced`                |
| `poker_tournaments_running_without_owner`             | `TournamentRunningWithNoOwner`, `TournamentRunningWithNoOwnerCritical` |
| `poker_tournament_manager_quarantine_oldest_seconds`  | `TournamentManagerQuarantineStuck`                                     |
| `poker_f06_drained_custody_outcomes_total`            | `F06DrainedCustodyRefused`                                             |
| `poker_fleet_wide_zombie_refusals_total`              | `PokerFleetWideStall`                                                  |
| `poker_tournament_table_never_started_oldest_seconds` | `PokerTournamentTableNeverStarted`                                     |

Not one of them wraps the metric in `absent()`. Every one is a positive
threshold comparison against a name with no samples, so every one evaluates to
an empty vector for ever. Prometheus reports each as `health=ok`,
`state=inactive` - the same thing it reports for an alarm that is genuinely
quiet.

The first two are the ones that matter. They were written **after** the
65-hour engine outage so that the next one would page somebody, and they were
structurally unable to fire during it.

## Root cause

All six metrics are emitted by code in `server/src` on `origin/main`. **None of
them exists at `8825af51`** - the build production is actually running, cut
2026-09-18 and 125 commits behind main. The engine's live `/metrics` carries
771 `poker_` series and none of the six.

The monitoring stack and the engine are two independently deployed halves of
one alarm, and nothing compared their generations. `check-alert-rules-match.mjs`
asked whether **this repo** emits the metric - `producerHaystack(repoRoot)` over
the working tree - found that it did, and printed:

```
HAVE A PRODUCER, NO SERIES YET (6) - not a failure:
  ...
  Something in this repo emits each of these. A counter has no series until
  its first event, and a gauge has none until its first scrape after release.
[alert-rules] OK - the box runs what this repo declares, every rule reads a
real series, and the canary is alive.
```

Both sentences are defensible and the conclusion is false. They conflate two
states that look identical from Prometheus and are not remotely alike:

- **awaiting its first event** - the producer IS in the running build, so the
  series appears the moment the thing happens. Failing on this would paint
  every post-restart deploy red, which is how a gate stops being read.
- **ahead of the running engine** - the producer is in the repo and not in the
  running build, so no event on the platform can ever produce a sample.

This is CLAUDE.md 10.86 rule 1 exactly: "I could not tell" folded into good
news. The check had two outcomes where it needed three.

`alert-rules.yml` carried the same error in prose - "has been published by the
engine since #4909", a claim about the environment written from the repo, with
no expiry and never checked (10.86, last paragraph). Corrected in place.

## The fix

`scripts/ci/check-alert-rules-match.mjs` now asks the engine for its own build
(`/health.version`), reads the producer **at that commit**, and splits what was
one bucket into three outcomes:

- series exists - live.
- no series, producer present at the deployed sha - _HAVE A PRODUCER IN THE
  RUNNING BUILD, NO SERIES YET_. Not a failure, as before.
- no series, producer absent at the deployed sha - **RULES AHEAD OF THE ENGINE
  THAT IS RUNNING. Fatal**, naming the sha and telling you to deploy the engine
  rather than delete the rule.
- the build cannot be identified or the commit is not in the checkout -
  **COULD NOT TELL, exit 2**, never a pass.

`git grep` at the engine's own commit is the oracle rather than scraping
`/metrics`, because a labelled counter registers no child series until its
first observation - absence from `/metrics` would have been a second signal
that answers when it does not know.

Run against the live stack it now exits 1 and names all six.

## What still has to happen

**The engine is 125 commits behind and that is the thing to fix.** These eight
rules become live the moment the half that publishes the metrics is the same
generation as the half that reads them; that goes through
`auto-deploy-hetzner.yml` at the `:55` break, which is a different lane and a
different owner. No rule was silenced, weakened or deleted to make the board
green, and none should be.

`Deploy Monitoring` is not in the ruleset, so its red run blocks no merge -
`scripts/ci/check-main-is-green.mjs` is the reader (10.83), and this is
precisely the class of thing it exists to raise.

## Thresholds

Checked as 10.84 requires. The thresholds on these rules are derived and the
derivation is written beside them: `TournamentRunningWithNoOwner` at 15m is
three times the worst legitimate re-adoption window (5s discovery x budget 25 =
~95s after a restart, 5m resume back-off cap); `PokerTournamentTableNeverStarted`
at 600s against a measured 391-of-554 tournaments undealt for over thirty
minutes; `F06DrainedCustodyRefused` against 1,551 unproven custody reads logged
in ninety minutes. One thing worth noting rather than changing: `EngineCannotBeReplaced`
(`>= 6` over 15m) and `PokerEngineCannotBeReplaced` (`>= 2`) read the same
metric with different thresholds from two different files. Both are defensible

- one lost window versus a day of them - but they should be one rule or two
  rules with distinct names and severities, and that is worth a decision once the
  metric actually exists.

## One more thing the hook caught, which is worth its own paragraph

The first push of this change was refused by `.husky/pre-push`, and it was
right. `producedAtBuild` and `haveCommit` shell out to `git` with an explicit
`cwd`, and **a git hook exports `GIT_DIR` and `GIT_INDEX_FILE`**. A child `git`
that inherits those ignores its `cwd` entirely and operates on the hook's
repository. So under the hook these helpers silently answered about a
different repository than the one they were handed - 10.86 rule 2 wearing
git's clothes, and invisible in every context except the one that matters.

It is worse than a wrong answer. The law test builds a scratch repository and
runs `git init` in it; inherited `GIT_DIR` sent that `git init` at the
canonical clone, which set `core.bare = true` on
`~/Documents/club-arena/.git` and overwrote `[user]` with the fixture
identity. Every `git add`/`git commit` in that clone and all of its worktrees
then failed with "this operation must be run in a work tree". Repaired in
place - `core.bare` back to false, `user.name`/`user.email` back to
`Smarter-Poker` - with nothing else in the 10,160-line config touched and
`main`, `origin/main` and every worktree ref intact (local `main` is 4 behind
`origin/main` and a clean ancestor of it, as 10.87 expects).

Both helpers and the test now strip `GIT_*` from the environment they pass to
`git`. Anything in this estate that shells out to `git` with a `cwd` and can
run from a hook needs the same treatment.
