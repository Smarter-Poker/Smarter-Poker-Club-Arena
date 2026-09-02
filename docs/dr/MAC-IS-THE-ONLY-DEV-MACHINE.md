# The Mac is a single point of failure for development

Written 2026-09-01 (audit phase 6), companion to `RESTORE-RUNBOOK.md`.

The **running platform** (Vercel + Supabase + Hetzner) does not depend on the
Mac at all — see the DR runbook's Scenario C. This page is about the other
risk: the Mac is where nearly all _development_ state lives, and until phase 6
a lot of finished work existed on its disk and nowhere else.

## What lived only on the Mac, and what phase 6 did about it

| State                                                      | Risk before             | After phase 6                                                                                                      |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Canonical clones (`club-arena`, `Smarter-Poker-World-Hub`) | Re-clonable from GitHub | unchanged (fine)                                                                                                   |
| Agent worktrees with **unpushed commits**                  | Gone if the disk died   | **85 pushed to `origin` under `rescue/<name>` — every 2+-commit branch; single-commit remainder is one loop away** |
| Uncommitted edits in worktrees                             | Gone                    | snapshotted to `refs/wip/*` (existing tooling)                                                                     |
| Engine secret backup (`.dr-backups/`)                      | Mac-local               | still Mac-local — see below                                                                                        |
| Keychain credentials (GitHub, Hetzner, DR passphrase)      | Mac-local               | still Mac-local — see below                                                                                        |

## The unpushed-work rescue (phase 6)

~112 worktrees held commits that were on no remote branch — real finished or
in-progress work that existed on exactly one disk. As of 2026-09-01, **85 were
pushed to `origin` as `rescue/<worktree-name>` — that is 100% of every branch
more than one commit ahead of main** (the substantive work). The ~30 remaining
are single-commit branches, which the estate's SHA-duplication pattern
(CLAUDE.md 12) makes almost certainly already-upstream under a different id;
push any you want the same way — nothing about them is urgent:

```bash
cd ~/Documents/club-arena
git ls-remote origin 'refs/heads/rescue/*' | sed -E 's#.*/rescue/##' | sort > /tmp/done
git worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r WT; do
  nm=$(basename "$WT"); grep -qxF "$nm" /tmp/done && continue
  [ -z "$(git -C "$WT" branch -r --contains HEAD 2>/dev/null)" ] &&
    git -C "$WT" push -q origin "HEAD:refs/heads/rescue/$nm" && echo "rescued $nm"
done
```

The push is **by ref, without a checkout**, so the commit objects are durable
on GitHub. Nothing auto-merges: these are
parked branches, not pull requests (`report-stuck-prs.sh` only auto-opens PRs
for `agent/*` branches under a day old, by design — an old branch gets
_reported_, never merged).

To see what is parked and mine it later:

```bash
git ls-remote origin 'refs/heads/rescue/*'          # everything rescued
git log --oneline origin/main..origin/rescue/<name> # what that tree was doing
git checkout -b recover/<name> origin/rescue/<name> # pick it up
```

Much of it is probably already upstream under a different SHA (the estate's
GitHub-MCP path re-creates content under new ids — see CLAUDE.md 12). The
rescue push costs nothing and removes the doubt: a branch that is redundant
can be deleted, a branch that was lost is now not.

## STANDING RULE (the real fix)

This whole rescue was cleanup for a habit that section 13 of World Hub's
CLAUDE.md and the AGENT-PLAYBOOK already forbid: **commit and push small and
often; never let finished work sit only in a worktree.** Antigravity's
`git reset --hard origin/main` loop _discards_ uncommitted and local-only work
without warning. Phase 2 of the earlier audit added
`scripts/prune-stale-worktrees.sh`, which now refuses to prune any tree that is
unpushed — so the safety net is in place, but the habit is the actual control.

## If the Mac dies

- **Running platform:** unaffected. Players and money are fine (Scenario C).
- **Resume agent work** from any machine with `gh auth` and the GitHub App
  credentials: clone the two repos, and every `rescue/*` branch is right there.
- **Two things are genuinely Mac-local and must be re-established, not
  restored** if the disk is lost with no other copy:
  1. The engine-secret DR backup passphrase (keychain service
     `dr-engine-env-pass`) and the `.dr-backups/engine.env.enc` file. Mitigation
     already recommended in the DR runbook: keep a second encrypted copy in a
     password manager. Without either, engine secrets get **rotated fresh**
     (new Supabase service-role key, new INTERNAL_API_KEY, new TURN secret) —
     recoverable, a rotation not a restore.
  2. Local `gh`/git credentials — re-authenticate on the new machine.

Nothing here is a data-loss risk to the platform. The worst case is a few
hours of credential rotation and re-clone, which is the definition of a
tolerable dev-machine failure.
