# A Repo Variable Is Not A Runner

2026-09-02, phase 3 of the push/publish cost audit. Six more `ci.yml` jobs move
off GitHub-hosted minutes onto the self-hosted box, and one bug in the draft
that would have stopped every pull request is fixed before it shipped.

## What moved

`changes`, `Source Windows Are Structural`, `Stub Gate`, `What this run
verified`, `Live Production E2E` and `Post-Deploy Verification` now read
`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`, the same shape `TypeScript
Check`, `Client Unit Tests`, `Server Engine` and `Production Build` already
used. Unset the repository variable and all ten are back on `ubuntu-latest`
with no code change, which stays the rollback.

None of the six is a required status check, so a bad day on the box cannot
block a merge through this change. The two scheduled jobs (`Live Production
E2E`, `Post-Deploy Verification`) do not run on pull requests at all, so their
routing is first exercised on the next schedule tick rather than on this PR.

`CSS Beat E2E` stays on `ubuntu-latest` deliberately. It failed on the 4-core
box and has not yet been shown to pass three times on the resized one.

## The bug that did not ship

The draft gated the Playwright install like this:

    if [ -n "${{ vars.CI_RUNNER }}" ]; then npx playwright install chromium webkit
    else npx playwright install chromium webkit --with-deps; fi

`--with-deps` is dropped because the box already carries the browser system
libraries and the `ci` user cannot `apt-get`. That reasoning is right. The
condition is not. `vars.CI_RUNNER` is a repository variable: it is set for
every job in the repository, including jobs still pinned to `ubuntu-latest`. So
this branch would have skipped `--with-deps` on a GitHub-hosted runner, and the
one job it appears in twice is `CSS Beat E2E`, which is a required check. A
hosted runner without WebKit's system libraries fails that step, the required
check goes red, and nothing merges or publishes until a human notices. The
class of outage the whole audit exists to prevent.

Both installs now key on `runner.environment`, which GitHub resolves from the
runner the job actually landed on. It is correct for a routed job, correct for
a pinned one, and stays correct if `CI_RUNNER` is unset for a rollback or if
this job is routed later.

The rule the next agent should carry: a repository variable describes the
repository, never the machine. If a step needs to know where it is running,
ask `runner.environment`.

## Verified

- `npx vitest run` over `ciBoxProvisioning`, `deployAndPublishAreHonest`,
  `postDeployE2eHonestyLaw`, `no-commit-left-behind.law`, `shipped-invariants`
  and `law-registry.law`: 147 of 147 passing.
- `ci.yml` parses; 12 jobs, 10 routed, `css-beats-e2e` and the disabled
  `auto-revert` still hosted.
- Box before the change: 10 runners online, all 8 CA runners carrying
  `VITEST_MAX_WORKERS=4`, GC cron present, 13 GB free, 23 percent disk.

Not yet verified, and the next agent must confirm it on this PR rather than
assume it: that each routed guard reports a job whose runner name begins
`estate-ci-`. Saturation is the thing to watch. A pull request now wants up to
eight runners at its peak and the box has eight, so two concurrent pull
requests will queue. Queueing on a free runner beats paying for a hosted one,
but if the queue starts eating the publisher's 25-minute budget the answer is
more runners, not fewer routed jobs.
