# tests/a-check-status-probe-cannot-say-pending-when-it-cannot-tell.law.test.ts

CI status is read from `/actions/runs?head_sha=` through `scripts/ci/pr-status.mjs`, and a probe that cannot read it exits UNKNOWN rather than "pending". `/commits/:sha/check-runs` 403s on the estate PAT (no `checks:read`) and `/commits/:sha/status` returns `{"state":"pending","total_count":0}` for green, red and never-built commits alike — an agent walked that ladder and reported "checks pending" on a branch red for three pushes, while PR #3163 sat `completed failure` for fifteen hours (2026-09-06).
