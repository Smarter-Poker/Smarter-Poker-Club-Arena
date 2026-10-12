# Agent worktrees live on the external SSD, and clean up after themselves

The estate law put agent worktrees on `/Volumes/SmarterWork/agent-work`. The
script agents actually run, `scripts/agent-workspace.sh`, defaulted to
`$HOME/Documents/.agent-trees`, so the trees went to the boot disk. On
2026-09-29 the Mac carried 659 registered worktrees, 490 of them there, and the
boot volume reached 100% with 116 MiB left. Nothing announced itself as a full
disk: `npm ci` died with ENOSPC inside a pre-push gate, vitest failed writing a
temp file, and a merge resolved into a tree that could not be written.

The helper now prefers the SSD whenever that volume is mounted and writable,
falls back to the old path with a note when it is not, and still honours
`AGENT_WORKTREE_ROOT`.

`scripts/agent-tree-janitor.sh` sweeps what is already there, in tiers, safest
first. Regenerable weight goes first: `node_modules`, `dist`, coverage and
report directories out of trees nobody has touched for `IDLE_DAYS`, which is
what the disk is actually full of and what `npm ci` makes again in a minute.
Then `scripts/prune-stale-worktrees.sh` removes trees that are clean, pushed
and idle. A tree abandoned for `ARCHIVE_DAYS` with work still in it is archived
before it is touched: the branch commits as a git bundle, the uncommitted diff
as a patch and the untracked files as a tar, under
`/Volumes/SmarterArchives/agent-evidence/abandoned-trees/`. It reports by
default and sweeps only with `--apply`.

The pre-push pressure reader names the janitor beside the pruner, and tells an
agent pushing from a tree on the boot disk where new trees go. The playbook now
says that finishing a delivery includes removing the worktree once the branch
is merged, and never leaving `node_modules` or a report directory behind.

No release, publication or application behaviour changes.
