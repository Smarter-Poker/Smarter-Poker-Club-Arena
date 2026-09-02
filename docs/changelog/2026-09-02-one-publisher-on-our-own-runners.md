# One Publisher, On Our Own Runners

2026-09-02, late afternoon. For about ninety minutes Club Arena had **two**
publishers, both firing on every push to main, and every safety net still
pointed at the one that was being retired.

## What was actually wrong

`publish-club-arena.yml` was added earlier today (#2670) because
`build-for-world-hub.yml`'s workflow ENTRY had wedged: runs sat `queued` with
zero jobs for up to fifty minutes while every other workflow in the repo picked
up runners normally, and GitHub refused to cancel or delete them. Adding a new
file with a new path was the right escape.

What was not done in the same change is delete the old one. So:

|                   | old                            | new                                |
| ----------------- | ------------------------------ | ---------------------------------- |
| file              | `build-for-world-hub.yml`      | `publish-club-arena.yml`           |
| triggers          | push to main, `*/30`, dispatch | push to main, `*/30`, dispatch     |
| concurrency group | `build-world-hub-g2-*`         | `publish-club-arena-*`             |
| runners           | `ubuntu-latest` (billed)       | `vars.CI_RUNNER` (our Hetzner box) |

**Different concurrency groups, so nothing serialised them.** Every merge ran
two full publishes of the same commit - four test shards and a production build
each - and both pushed a bundle to the World Hub. Observed live: commit
`0090aaa7` was being built by both at the same moment.

The old one also still ran on billed hosted runners, which is the exact cost
the offload work existed to remove.

## The part that mattered more: the nets pointed at the retired file

This is what would have bitten later. Every mechanism that catches a failed
publish was still wired to `build-for-world-hub.yml`:

- `.github/scripts/publish-watchdog.sh` - `PUBLISH_WORKFLOW` defaulted to it,
  so **the watchdog's re-dispatch would have re-dispatched the wedged
  workflow**. The safety net was aimed at the broken path.
- `tests/no-commit-left-behind.law.test.ts` - the publisher law read it.
- `tests/shipped-invariants.test.ts`, `deployAndPublishAreHonest`,
  `runtimeAssetRetention`, `ciBoxProvisioning` - all pinned it.
- `wait_for_pr_and_deploy.sh` waited on it; `check-no-vercel-deploy.mjs` and
  `agent-autopilot.yml`'s no-token warning both named it.

A half-finished migration where the new thing works and every guard watches the
old thing is worse than either state on its own, because the guards go quiet
rather than red.

## What this does

Deletes `build-for-world-hub.yml` and repoints all fourteen references.

Before deleting, the two files were proved equivalent rather than assumed:
normalise name, path, concurrency group and `runs-on`, drop comments, and the
diff is **zero lines** - 320 non-comment lines each.

`publish-club-arena.yml` is now the only path to production. Its nets are the
`*/30` catch-up, `publish-watchdog`'s re-dispatch (now aimed at it), and the
tip-of-main convergence inside the workflow itself.

## The new law

`no-commit-left-behind.law.test.ts` gains a pin that **counts the publishers**:
any workflow containing a `sync-to-world-hub` job is one, and there must be
exactly one. Re-introducing a second file turns it red.

The same test stopped pinning the concurrency group by NAME. It had hardcoded
`build-world-hub`, which meant the group could not be renamed - and renaming it
was itself the remedy when a group wedged (`-g2-`), and again when the workflow
was replaced. A test that fails on the fix is a test people learn to delete.
What is pinned now is the property that matters: a running publish is never
cancelled.

## Verified

- 168 of 168 pins green across the eight affected suites.
- Two mutations red: re-adding a second publisher, and flipping
  `cancel-in-progress` back to `true`.
- The surviving workflow parses, with all four jobs intact.
- Publishing proven working before the change: `publish-club-arena.yml` run #1
  published `14b9d894` to production at 17:35 UTC.

## Note on the GitHub App, recorded because it decided this

At 17:50 the personal access token in `.env` began returning 401 - it had been
printed in full in another agent's transcript and is now revoked.

Publishing and merging both survive that, and it is worth knowing why: the
autopilot merges with `app-token || GH_PAT || GITHUB_TOKEN` and the World Hub
sync pushes with `wh-token || WORLD_HUB_SYNC_TOKEN`, both preferring a **GitHub
App installation token** that is minted per run and cannot be revoked with a
PAT. The PAT is only a fallback. Keep it that way: if the App is ever removed
and the estate falls back to a PAT, one leaked transcript stops all publishing.

## And the reason agents' work was stranding: the docs and the automation disagreed

CLAUDE.md 11.0 tells every agent to claim a worktree as `fix/<slug>`.
`agent-open-pr.yml` opened a pull request only for branches starting with
`agent/`, and the orphan sweep in `report-stuck-prs.sh` auto-opened only
`agent/*` too. So an agent that did exactly what the docs said pushed a
`fix/...` branch and got nothing - and on 2026-09-02, when every PAT on the Mac
was revoked at once, that was three agents' finished, tested work (including
this branch) sitting on the remote with no route to `main`.

The namespace was the wrong proxy. The AGE gate is the real safety: a branch
under a day old with commits ahead of main is somebody who stopped one step
short today, whatever they named it. `agent-open-pr.yml` now opens a pull
request for ANY new branch, excluding only the namespaces that are never
proposals (`backup/`, `ci-marker/`, `build/`, `dependabot/`, `renovate/`,
`sentry-autofix/`, `revert-*`).

The 30-minute orphan sweep in `report-stuck-prs.sh` has the same `agent/*`
limit and the same fix is owed there - but that file is one of the
byte-identical SHARED_FILES `estate-integrity.sh` checks across all seven
repos, so it cannot be changed in this repo alone. It is done as a separate
seven-repo change, together with the other shared-file gap found today: a
pull request whose head has **no CI run at all** is never re-triggered by
autopilot (`LAST=none` matches neither refresh condition), so it sits "left to
merge" forever - eight of the oldest open pull requests are in exactly that
state.

CLAUDE.md 1.1 was rewritten. It had been telling agents that the deploy path
was a local script that in fact never pushes, to `git push` to a protected
`main`, and that a deleted workflow would publish. It now describes the one
real route, where the agent's job ends, the three nets, and how to verify.
