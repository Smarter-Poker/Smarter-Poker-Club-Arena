# START HERE

The current continuation handoff is **`docs/HANDOFF_CURRENT_STATE.md`**.

**Read `§0 VERIFICATION ADDENDUM` first.** It was written by a second agent who
re-verified the first agent's closing claims against git, the GitHub API and the
production database. Three of them were wrong and are corrected in §0. §0 is
authoritative wherever it conflicts with the sections below it.

Fastest orientation:

- `§0.1` what was verified, and the three corrections
- `§0.3` PR #2526 is **draft on purpose** — only Dan marks it ready
- `§0.4` supply drift root cause: spin entries are funded from `prize_liability`,
  which is 204,089 chips overdrawn
- `§0.6` the four decisions that need Dan
- `§0.7` exact first actions
- `§0.9` honest limits — what is still unverified

Worktree: `/private/tmp/ca-drift`, branch `fix/a-correction-is-not-a-mint`.
Repo: `Smarter-Poker/Smarter-Poker-Club-Arena` (not `club-arena`).
