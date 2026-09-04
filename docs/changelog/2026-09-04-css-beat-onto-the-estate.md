# The longest job was the only one not using the machines we pay for

Measured on one pull request, 2026-09-04, after the CI boxes were rescaled to
16 cores:

| job                                     | time       | ran on                  |
| --------------------------------------- | ---------- | ----------------------- |
| CSS Beat E2E (multi-table + animations) | **11.13m** | GitHub Actions, 2 cores |
| Production Build                        | 5.35m      | estate-ci (16 cores)    |
| TypeScript Check                        | 2.63m      | estate-ci               |
| Client Unit Tests (vitest)              | 1.38m      | estate-ci               |
| Server Engine                           | 1.07m      | estate-ci               |

`css-beats-e2e` was the **only** job in `ci.yml` with a hard-coded
`runs-on: ubuntu-latest`; every other job reads `vars.CI_RUNNER`. So the single
longest step of every merge ran on two cores while 52 sat idle next to it, and
it was the last job still billing GitHub minutes.

There was no reason for it beyond an oversight: Chromium and WebKit are already
cached on the boxes, and the install step already branches on
`runner.environment` to skip `--with-deps` when self-hosted. It was prepared for
this and never switched over.

Playwright's worker count is now derived from the box for the same reason the
vitest and rollup caps are (`2026-09-04-caps-follow-the-cores.md`): `4` was
chosen for a 2-core GitHub runner and is wrong on a 16-core one. It is now
`max(4, cores / 2)`, so the old value is the floor and nothing regresses on a
small runner. `PLAYWRIGHT_WORKERS` overrides.

## How this was verified

`CSS Beat E2E` is a **required check** — if it cannot run on the estate, nothing
merges. This change is therefore self-testing: this pull request's own CSS Beat
E2E job runs under the new `runs-on`. Green here means the job works on the
estate; red means it is reverted and nothing else was risked, because no other
branch had adopted it yet.
