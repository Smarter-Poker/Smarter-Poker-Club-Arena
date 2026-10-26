# Every browser install uses the primary Ubuntu mirror

2026-10-26

## What failed

Post-deploy run 40316470963's `Client browser verification` job ran out of
its 80-minute cap before it reached the page sweep. Its first step,
`Install Chromium and WebKit`, took 59 minutes. The Playwright browsers
themselves downloaded in seconds. The time went to `--with-deps` pulling
97 MB of Ubuntu packages from `azure.archive.ubuntu.com` at 27 kB/s. The
`Live-table and engine verification` job in the same window took 60 minutes on
the same step.

Over the previous two days that step normally took about 40 seconds, but it
ran 1137 s, 767 s, 3598 s and 3539 s whenever the Azure mirror slowed down.

## Why it was still possible

On 2026-10-22 the same mirror stalled engine qualification, and
`scripts/ci/ubuntu-apt-mirror.py` was added to point APT at Ubuntu's primary
HTTPS mirror. It was wired into only two jobs in `ci.yml`: the CSS beats
browser install and the PostgreSQL tools install. Those jobs have stayed fast
since (12 browser installs, 50 to 75 s). Every other workflow step that lets
Playwright pull Ubuntu packages still used the Azure mirror. That included all
three in post-deploy E2E, the certificate that says whether production works.

## The fix

The mirror selection now runs before every Playwright system-package install
in every workflow:

- post-deploy E2E: client browser verification, live-table and engine
  verification, and the club channel lifecycle;
- `ci.yml`: Performance Browser, the deployed-page Playwright job and the
  Diamond playfields;
- club-create certification, the Diamond visual baseline, the Lightning
  pilot stage, and the Lightning pilot witness (only on its fallback
  `install-deps` path).

`tests/ubuntuAptMirror.test.ts` now reads every workflow and fails if any step
runs `playwright install ... --with-deps` or `playwright install-deps` without
the mirror selected earlier in that step or in that job. Reverting the
post-deploy edits turns it red and names all three steps.

All the affected jobs run on GitHub's hosted runners, so they have
passwordless sudo, and `tests/unit/theAptLockIsNotACiGate.test.ts` still
holds.
