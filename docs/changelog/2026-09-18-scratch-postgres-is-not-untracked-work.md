# Throwaway Postgres clusters stop masking unsaved work

**2026-09-18**

While preserving work that existed only on the build Mac, the survey of all 880
worktrees turned up 389,960 untracked files that were not work: release-journal
test Postgres clusters under `work/release-journal-pg-<random>/`, left behind
by every run of the suite and ignored by nothing.

They are harmless in themselves and disastrous in aggregate. Untracked and
unignored, they are indistinguishable in `git status` from an edit somebody has
not committed yet, and they outnumbered the real unsaved edits by roughly three
orders of magnitude - 8.3 GB of them in three trees alone. Uncommitted work
does not survive being the 400,000th line of output.

`work/release-journal-pg-*/` is now ignored. The rule is scoped to those
directories: `work/` stays visible, a file merely named like a cluster stays
visible, and `tests/scratch-postgres-is-not-untracked-work.law.test.ts` holds
all three boundaries plus the assertion that the rule is not covering tracked
source.

This changes no test behaviour and removes no data - the clusters are still
written exactly where they were, they just no longer present themselves as
work. The 2026-09-18 archive of the work they were burying is recorded
separately under the agent-evidence volume.
