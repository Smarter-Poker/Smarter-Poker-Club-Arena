# tests/scratch-postgres-is-not-untracked-work.law.test.ts

Work is not usually lost by being deleted. It is lost by never being noticed.

The 2026-09-18 work-at-risk survey walked all 880 worktrees on the build Mac
and found 419 of them holding uncommitted edits. It also found 389,960
untracked files that were not work at all: `work/release-journal-pg-<random>/`,
the throwaway Postgres clusters the release-journal suite initdb's on every run
and never removes. Three trees held 8.3 GB of them. Nothing ignored them, so
every one appeared in `git status` beside the genuinely unsaved edits - in
`codex-pipeline-component-certification`, 128,453 lines of noise over the
handful of files someone had actually changed.

That is the failure this law exists for. An agent scanning a wall of untracked
paths for the three that matter will miss one, and the next `git checkout` or
`git clean` takes it. The pre-push hook already warns about worktree pressure
for the same reason; this is the same lesson one level down.

The rule is deliberately narrow: `work/release-journal-pg-*/` and nothing more.
`work/` itself stays visible, because an agent may leave a note or a query
there and should see it in `git status`. The pattern matches directories only,
so a file merely named like a cluster is still reported. And because a
`.gitignore` rule can hide the expectation of a file as easily as the file, the
law also asserts that nothing under that pattern is tracked today - if source
ever lands there, this test fails rather than letting the rule cover it.
