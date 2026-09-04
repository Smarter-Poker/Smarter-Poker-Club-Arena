# CSS Beat E2E moves onto the estate boxes

## Why it was pinned to ubuntu-latest

Its own comment: _"This job is still pinned to ubuntu-latest (it failed on the
4-core box)."_ That was true, and that box no longer exists.

## Why it can move now

CSS Beat E2E is **Club Arena's critical path**. Every other required check runs
in parallel and finishes sooner, so the merge waits on this one:

| required check      | duration                                  |
| ------------------- | ----------------------------------------- |
| **CSS Beat E2E**    | **12.2 min**                              |
| TypeScript Check    | 1.7 min (after the Dependency Audit move) |
| Client Unit Tests   | 2.4-3.2 min (after the vitest cap)        |
| Server Engine       | 3.5 min                                   |
| Silent Revert Guard | 0.4 min                                   |

Almost none of those 12 minutes is testing. On a cold GitHub runner the job
does `npm ci`, downloads Chromium and WebKit, and runs a full `npm run build`
before the first beat executes.

The estate boxes are 8 cores / 16 GB with six runners each, vitest capped at
two threads, and Chromium + WebKit + their system libraries already installed
(`playwright install-deps` was run when the boxes were provisioned - the gap
that made the first EU run fail with `browserType.launch`). The install step
becomes a cache hit.

## What is deliberately unchanged

The `runner.environment` branch on the install step stays. It is **not** a
duplicate install, which an earlier pass through this file wrongly claimed - it
is an if/else: `--with-deps` needs root, and the estate boxes already carry the
libraries, so requesting them again would fail as the unprivileged `ci` user.

The job still builds the commit under test rather than consuming the
`Production Build` artifact. Sharing that artifact is a real further saving and
a separate change: it needs the two jobs to agree on Vite env vars, and this
one should be proven on the boxes first.

Nothing about what the beats assert changes. The animation law
(`tests/animations-always-play.law.test.ts`, CLAUDE.md 10.6) is untouched -
this moves where the guard runs, never whether it runs.
