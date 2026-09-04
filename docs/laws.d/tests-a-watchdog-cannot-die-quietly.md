# tests/a-watchdog-cannot-die-quietly.law.test.ts

A token chain may not lead with an expiring secret unless check-token.sh guards it (an expired PAT is non-empty so it wins the fallback and the working link is never reached); the orphan sweep may not read open PRs through a truncating --limit; auto-opening a PR asks GitHub about that one branch by name and refuses when the answer is unavailable
