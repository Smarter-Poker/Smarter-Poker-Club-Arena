# tests/a-migration-version-is-reserved-not-guessed.law.test.ts

`scripts/reserve-migration-version.sh` must keep handing out a migration version that this tree, `origin/main` and every sibling worktree agree is free, and must create the file so the reservation is visible to the next agent.
