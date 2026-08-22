# Why work regressed, and the loop that now prevents it

**Date:** 2026-08-22
**Trigger:** "I keep building things inside Club Arena and they work, but then
hours or a day later they regress."

## The finding

The code was not flaky. Three mechanisms, compounding.

### 1. Agents were driving the merge, and failing silently

Every incident traced back to an agent hand-rolling the final step.

| What an agent did                                               | What happened                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait_and_merge.sh` polling CI, ending in `gh pr merge --merge` | Merge commits are **disabled** here. The API call failed **silently**, the loop exited 0, and the PR sat open for hours while the agent reported success. |
| `gh pr merge --squash --admin` (the workaround for the above)   | `--admin` **bypasses required status checks**. This is how red code reached `main` four times in one day.                                                 |
| Nothing at all                                                  | All five open PRs had auto-merge off. Nobody remembered.                                                                                                  |

### 2. The gate could not see what actually breaks

Required checks were only `TypeScript Check` and `Client Unit Tests`.
`Production Build`, `Server Engine` and `CSS Beat E2E` were **not required** —
so a PR could merge with a broken production build. It repeatedly did.

### 3. The one E2E gate tested the wrong thing

`Production Build` ran Playwright against the **deployed** `smarter.poker`. On a
pull request that is not the pull request's code — it is whatever `main` last
shipped. It could never validate the change under review; it only imported
production's health and Vercel's deploy timing into an unrelated PR as a red X.

That is why branches with sound builds went red, and it is the direct cause of
agents reaching for `--admin` in the first place. A gate that fails for reasons
unrelated to the change teaches everyone to bypass it.

## What changed

**Agents no longer merge.** `.github/workflows/agent-autopilot.yml` enables
squash auto-merge on every PR the moment it opens, sweeps all open PRs on each
push to `main` and every 10 minutes, and runs `gh pr update-branch` on anything
`BEHIND` so a merge never resolves from a stale base. An agent's job now ends at
`gh pr create`.

It prefers `GH_PAT` deliberately: a merge made with `GITHUB_TOKEN` does not
trigger downstream workflows, so it would land on `main` and never fire
`build-for-world-hub.yml` — merged but never published, indistinguishable from a
regression.

**The gate now covers what breaks.** Required: `TypeScript Check`,
`Client Unit Tests (vitest)`, `Server Engine (typecheck + tests)`,
`Production Build`, `CSS Beat E2E (multi-table + animations)`.
Ruleset is squash-only, zero bypass actors, and
`require_extra_approval_for_unattributed_changes` is **off** — that flag demands
a human approval for any commit whose author is not a linked GitHub account,
which is a human-intervention landmine in an all-agent repo.

**The wrong E2E moved.** Live-production specs are now `Live Production E2E`,
main-only, post-deploy, and they open an issue when production genuinely breaks.
`Production Build` is purely deterministic (vite build + bundle budget).

## The mistake this workflow made on its own first run

Worth recording, because it is the same shape as everything above.

Autopilot failed twice immediately: the `queue-pr` job had no `actions/checkout`
(exit 127), and **`GH_PAT` was expired** — `HTTP 401: Bad credentials` surfacing
only as a red job with no indication that a _credential_, not the code, was at
fault. A dead token means nothing merges and nothing publishes while agents keep
reporting success.

The token is now verified before anything else runs, and when invalid the job
states the exact remediation and opens an issue using the built-in token, which
is valid even when `GH_PAT` is not.

## Verified, not assumed

- PR #197 and #198 both auto-merged with all five checks green. No `--admin`.
- The push-triggered sweep queued #188 unassisted after it had been stuck.
- #178 is `DIRTY` (a real conflict) and was correctly left for an agent — the
  system does not paper over conflicts, which is the failure mode that deleted
  the leaderboard RPC call while its signature survived.
- `chore(club-arena): sync build <sha>` commits confirm the publish chain fires.

## Deliberately not changed

`Smarter-Poker-World-Hub` `main` has no ruleset. That is **correct**: it
receives automated `sync build` commits directly from
`build-for-world-hub.yml`. Requiring pull requests there would break publishing.
