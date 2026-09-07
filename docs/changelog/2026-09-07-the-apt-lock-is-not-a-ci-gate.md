# A shared apt lock is not a place to put a required check

2026-09-07

## What was red

`Production Build` on PR #3487 - a REQUIRED check, so it blocked the merge -
failed at the step `Install Performance Browser`. The last four lines of that
job's log:

```
E: Could not get lock /var/lib/apt/lists/lock. It is held by process 1672233 (apt-get)
E: Unable to lock directory /var/lib/apt/lists/
Failed to install browsers
Error: Installation process exited with code: 100
```

Everything above it was green. The bundle built, 482 media files optimised,
the size budget passed. The branch under review had nothing to do with the
failure.

## The cause, read rather than guessed

`npx playwright install --with-deps chromium` does two unrelated things:

1. downloads the browser into `~/.cache/ms-playwright`, which is per-user,
   idempotent and safe to run concurrently; and
2. shells out to `apt-get` to install that browser's system libraries, which
   takes a machine-wide lock at `/var/lib/apt/lists/lock`.

The estate runs 12 to 18 runners on each EU box (CLAUDE.md 1.1.7). Two
`Production Build` jobs landing on one box within the same few seconds is
ordinary, not rare. The second one does not wait and does not degrade: apt
exits 100 and Playwright reports "Failed to install browsers".

And the apt half could never have installed anything. `provision-ci-box.sh`
section 6 installs the chromium and webkit system libraries once per box, and
then verifies the result properly - it ignores apt's exit code, which lies on a
healthy box, and instead checks that every unpacked browser binary resolves all
of its shared libraries. So on these runners the correct number of apt calls at
job time is zero. This one existed only to lose a race.

## The fix

The repo had already solved this. Three other browser-install steps branch on
`runner.environment` and take the plain download on a self-hosted box, and two
of them carry a comment explaining exactly this. `Install Performance Browser`
was simply missed:

```yaml
if [ "${{ runner.environment }}" = "self-hosted" ]; then
npx playwright install chromium
else
npx playwright install --with-deps chromium
fi
```

Not a retry, and not a `flock`. Both of those keep the apt call and manage the
contention it creates; neither removes the reason the call is there, which is
nothing (10.11: fix the cause, and a net presented as the resolution is not a
fix).

`post-deploy-e2e.yml` was corrected in the same pass. Its branch was keyed on
`vars.CI_RUNNER`, which was right only by coincidence: that workflow has one
job and it routes on the same variable, so "the variable is set" happened to
mean "this job is on the box". Nothing holds those two facts together. Adding
a second job, or pinning that one back to `ubuntu-latest` for an afternoon,
would have made it skip `--with-deps` on a hosted image with no browser
libraries at all - a browser that cannot start rather than a browser that is
slow. `runner.environment` answers the question actually being asked.

## The pin

`tests/unit/theAptLockIsNotACiGate.test.ts` walks every workflow, splits it
into steps, and requires that any step running `--with-deps` also branches on
`runner.environment` - and that none of them keys on `vars.CI_RUNNER`.

Proven behavioural, not assumed: with the fix reverted the test fails naming
`ci.yml:1393 step "Install Performance Browser"`, which is the step whose log
is quoted at the top of this file. With the fix in place, three tests pass.

Two things the test was made careful about, because it got both wrong on its
first run:

- **Comments are not code.** A trailing comment block belongs textually to the
  step ABOVE the one it describes, so the paragraph explaining a branch was
  read as an unguarded `--with-deps` and three innocent steps were reported.
  Whole-line `#` comments are stripped before anything is judged.
- **An empty corpus is not a pass.** The test asserts it found workflows at
  all, and that at least one guarded `--with-deps` still exists, so deleting
  every browser install does not leave a guard silently green over nothing
  (10.86 rule 1).
