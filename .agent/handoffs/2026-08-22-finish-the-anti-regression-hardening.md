> **CLOSED 2026-08-22. All four tasks are done**, each verified by outcome
> rather than by a status code. Task 2 included: GitHub App `4680372` is minting
> Autopilot's token in all 7 repos, and the proof is not that the mint step went
> green — it is that PR #215's auto-merge was enabled by
> `app/smarter-poker-autopilot` and that the merge triggered
> `build-for-world-hub.yml` through to production.
> Full record, including everything found along the way that this handoff did
> not know about, is in
> `.agent/audits/2026-08-22-anti-regression-hardening-completed.md`.
> Read that before acting on anything below.

# Handoff — finish the anti-regression hardening

**Written:** 2026-08-22 by the agent that built Agent Autopilot
**Repo state at handoff:** Club Arena `main` = `35a5587d3`

Read `.agents/rules/00-anti-regression-workflow.md` first. It is binding, and
rule 1a (one worktree per agent) applies to you starting now.

---

## What already exists — do not rebuild it

Across **7 active repos** (Club Arena, World Hub, smarter-poker-commander,
commander-shared, smarter-poker-workers, Smarter-Poker-Diamond-Arena,
PepNationLab) all of the following are live and byte-identical:

- `.github/workflows/agent-autopilot.yml` — enables squash auto-merge on every
  PR, sweeps open PRs on push to the default branch and every 10 minutes, and
  refreshes a branch only when it cannot merge as it stands.
- `.github/scripts/queue-pr.sh` — squash only, never `--admin`. Falls back to a
  direct merge on `CLEAN` where the branch offers no auto-merge.
- `.github/scripts/check-token.sh` — verifies the token before anything runs and
  warns 21 days before `GH_PAT` expires.
- `scripts/agent-workspace.sh` — one git worktree per agent.

**27 repos** carry a `main: no rewinds` ruleset (`non_fast_forward`, `deletion`).
Club Arena additionally requires 6 status checks with **0 bypass actors**.

**Agents never merge.** Open the PR and stop. If you catch yourself typing
`gh pr merge`, you are doing it wrong.

---

## Task 1 — land PR #178

`fix/hero-card-row-assertions`, **DIRTY**, 39 behind / 4 ahead. Touches only
`tests/e2e/hero-card-row.spec.ts` and `tests/e2e/live-animations.spec.ts`.

It updates hero-card-row layout assertions for the new offset design. Both files
have been edited on `main` since (the swNeonHalo halo-injection fix in #195 lives
in `live-animations.spec.ts`), which is why it conflicts.

**Resolve hunk by hunk. Never `--ours` / `--theirs` on a whole file** — that is
the exact move that deleted the leaderboard RPC call while its signature
survived. After resolving, `CSS Beat E2E (multi-table + animations)` must be
green; it is a required check and it is the test that these specs belong to.

If the assertions genuinely contradict what `main` now renders, the _test_ is
what changed on purpose — update it, do not weaken the check.

---

## Task 2 — a credential that does not expire

`GH_PAT` expires **2026-11-19 20:14:28 UTC**. On that date every PR stops
auto-merging and nothing publishes, while agents keep reporting success.

Dan asked for a token with no expiration. Two ways, and the first is better:

**Preferred — a GitHub App.** Create an App on the Smarter-Poker account with
`Contents: R/W`, `Pull requests: R/W`, `Workflows: R/W`, `Metadata: R`, install
it on all 7 repos, and have Autopilot mint an installation token per run via
`actions/create-github-app-token`. Installation tokens refresh automatically and
never expire, so this removes the cliff permanently rather than moving it.
Store `APP_ID` and `APP_PRIVATE_KEY` as secrets and replace
`${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}` with the minted token.
**Verify the App is not subject to the workflow-file restriction** before
relying on it — that restriction is what broke publishing (see the note below).

**Simpler — a classic PAT with "No expiration"** (`repo`, `workflow` scopes).
Fine-grained PATs cap at 1 year; only classic PATs offer no expiry.

Creating either requires Dan — it is a credential, one of the few legitimate
human exceptions in RULE 0. **Ask him for it in chat; do not write a handoff
asking him to run a script.**

Then rotate it everywhere:

```bash
for r in Smarter-Poker-Club-Arena Smarter-Poker-World-Hub smarter-poker-commander \
         commander-shared smarter-poker-workers Smarter-Poker-Diamond-Arena PepNationLab; do
  gh secret set GH_PAT --repo "Smarter-Poker/$r" --body "<NEW_TOKEN>"
done
```

Confirm with a sweep: `token OK — can read <repo>` must appear in each repo's
Autopilot log.

**Do not use `GITHUB_TOKEN` as the merge credential.** A merge made with it does
not trigger downstream workflows, so the commit lands on `main` and
`build-for-world-hub.yml` never fires — merged but never published, which is
indistinguishable from a regression.

---

## Task 3 — mandatory quality gates in the other repos

Right now only Club Arena has required checks. Everywhere else Autopilot merges
on `CLEAN`, which means "nothing is failing", not "something passed".

Most of the groundwork is already there:

| Repo                        | `ci.yml` on PR?                              | Job name(s) to require                 | Work needed                                      |
| --------------------------- | -------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| smarter-poker-workers       | yes                                          | `Typecheck + Lint + Test + Build`      | just add the rule                                |
| Smarter-Poker-Diamond-Arena | yes                                          | `TypeScript Check`, `Production Build` | add rule — **do NOT require `Deploy to Vercel`** |
| PepNationLab                | yes                                          | `verify`                               | add rule                                         |
| smarter-poker-commander     | has `ci.yml`, would not parse as YAML for me | inspect first                          | fix/confirm, then add rule                       |
| commander-shared            | **no CI** — only `publish.yml` on push       | —                                      | write a `ci.yml` (`npm test`) first              |

For each repo, add a `required_status_checks` rule **and** a `pull_request` rule
to the existing `main: no rewinds` ruleset. Both matter: without the
`pull_request` rule a direct push to `main` skips the checks entirely, and
without required checks GitHub will not offer auto-merge at all.

```bash
gh api repos/Smarter-Poker/<repo>/rulesets            # find the ruleset id
gh api repos/Smarter-Poker/<repo>/rulesets/<id>       # read it, add rules, PUT it back
```

Model it on Club Arena's ruleset `21163380`: `allowed_merge_methods: ["squash"]`,
`required_approving_review_count: 0`,
`require_extra_approval_for_unattributed_changes: **false**` (true demands a
human approval for any commit whose author is not a linked GitHub account — a
landmine in an all-agent estate), and **`bypass_actors: []`**.

**Two ordering traps, both of which will strand every PR if you get them wrong:**

1. **Never require a check that does not run on `pull_request`.** The PR waits
   forever for a check that will never report.
2. **Update stale branches before you add a new required check.** For
   `pull_request` events GitHub reads the workflow from the PR's own head, so a
   branch cut before the trigger existed will never produce that check.

**Exception — World Hub.** Do **not** add a `pull_request` rule to its `main`.
`build-for-world-hub.yml` pushes the compiled Club Arena bundle straight to that
branch with `WORLD_HUB_SYNC_TOKEN`; requiring PRs blocks that push and stops
publishing outright. It keeps no-rewind only. If you want gates there, they must
run as `push` checks or the sync needs a bypass actor scoped to that identity
alone.

Verify by opening a throwaway PR in one repo and watching it merge unattended.
**Do not mark this done because the ruleset API returned 200** — that is exactly
how I nearly shipped an Autopilot that ran, reported success, and queued nothing
in 6 of 7 repos.

---

## Task 4 — make the worktree rule enforceable, not advisory

`scripts/agent-workspace.sh` and rule 1a exist in all 7 repos, but nothing stops
an agent ignoring them. This is the single largest remaining cause of lost work:
several agents share one checkout, and a working tree has exactly one HEAD, one
index and one set of uncommitted files. When agent B runs `git checkout -b`,
agent A's edits ride onto the wrong branch or are stashed out from under it —
and then the Antigravity `git reset --hard origin/main` loop destroys whatever
is still uncommitted.

The evidence is in the clone right now: **8 abandoned stashes, 6 `backup/*`
branches** from `git-unstick.sh` rescues, and World Hub was carrying **12 stale
ad-hoc worktrees under `/private/tmp`** — agents inventing isolation by hand.

Build a `pre-commit` guard (Husky is already wired here) that **blocks a commit
made in the shared clone**:

```bash
# a worktree has --git-dir != --git-common-dir; the shared clone has them equal
if [ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ]; then
  # shared clone -> refuse, and print the exact command to get a proper tree
fi
```

Requirements, learned the hard way:

- **Escape hatch required.** `scripts/git-safe-push.sh`, the World Hub sync, and
  any CI checkout legitimately commit in the main clone. Honour an explicit
  `AGENT_SHARED_CLONE_OK=1` and set it inside those scripts.
- **The error must teach.** Print the exact `agent-workspace.sh` invocation, not
  just "blocked".
- **Never auto-stash or auto-checkout to "fix" it.** Moving an agent off its own
  uncommitted work is the precise destruction being prevented.
- Roll it to all 7 repos once proven in Club Arena, and document it in
  `.agents/rules/00-anti-regression-workflow.md` rule 1a.

Consider also a scheduled janitor that reports worktrees with uncommitted work
older than N hours — that is unpushed work one `reset --hard` away from gone.

---

## Ground rules for this work

1. **One worktree per agent.** Start with
   `eval "$(bash scripts/agent-workspace.sh <you> fix/<slug>)"`.
2. **Open the PR and stop.** Autopilot merges it. Never `--admin`, never
   `--merge`, never `--rebase`, never a polling script.
3. **Resolve conflicts hunk by hunk.**
4. **Pin behaviour you fix** in `tests/shipped-invariants.test.ts`, anchored on
   the RPC name / route / file — not on phrasing.
5. **Verify outcomes, not status codes.** Every bug in this session hid behind
   something that reported success: a merge script that exited 0 without
   merging, a sync that built the bundle and never pushed it, an Autopilot that
   swept happily and queued nothing.

## Known-good verification commands

```bash
# every repo running the same Autopilot, and its last sweep result
for r in Smarter-Poker-Club-Arena Smarter-Poker-World-Hub smarter-poker-commander \
         commander-shared smarter-poker-workers Smarter-Poker-Diamond-Arena PepNationLab; do
  echo "$r $(gh run list --repo Smarter-Poker/$r --workflow agent-autopilot.yml \
        --limit 1 --json conclusion --jq '.[0].conclusion')"
done

# what production is actually serving right now
curl -sL https://smarter.poker/hub/club-arena/build-info.json

# Club Arena's gate
gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/rulesets/21163380 \
  --jq '.rules[]|select(.type=="required_status_checks").parameters.required_status_checks[].context'
```
