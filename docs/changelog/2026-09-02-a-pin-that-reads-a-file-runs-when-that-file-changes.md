# A pin that reads a file runs when that file changes

2026-09-02, fix-first. Main was red, the one publisher's client-tests shard
1/4 failed on every merge, and production sat at 19:10 while `main` kept
moving.

## What broke

#2695 was a correct engine fix: `isPausedByDesign()` gained
`|| this.maintenancePaused`, because the maintenance break set a flag the
predicate never read and 1204 hands were dealt inside one break.

`tests/unit/tournamentRakeAndBreaks.test.ts` pins that predicate by reading
`server/src/engine/ServerTableEngineBase.ts` with `readFileSync` and matching
the two-term form. The pin went red the moment the engine was made right.

Nothing ran the pin before merge:

- `ci.yml`'s `changes` job classified the diff as `server/` only and SKIPPED
  `Client Unit Tests (vitest)`. 96 files under `tests/` read `server/src/**`
  that way. The migrations lesson from #2580 (a migrations-only PR skipping
  the suite that reads migration files) applied one directory over and had
  not been generalised.
- `.husky/pre-push` ran `vitest related` on the changed engine file. `related`
  follows imports. A source pin does not import what it pins, so `related` has
  never once run a pin for the file it reads.

## What changed

1. The pin itself was repaired concurrently by #2705 (each term asserted on
   its own, nothing said about order or neighbours). That version is kept;
   this change ships only the root cause below.
2. `ci.yml`: `tests=` now fires on `server/` as well. A server-only pull
   request runs the client suite (about two minutes on the box).
3. `.husky/pre-push`: after `related`, every test under `tests/` that names
   the basename of a changed source file runs too. For the #2695 diff that is
   11 files, one of which was the red one.

Verified: 19 pin files / 364 tests green, including `noFixedSizeSourceWindows`.

## Found while landing this: the nets around the publisher were cut (2026-09-03)

Verifying the fix above against the live run history turned up four more
wiring faults in the publish pipeline, all in this same change because they
share one subject - work reaching production and someone noticing when it
does not.

1. **Two `workflow_run` listeners named the deleted publisher.** #2676
   deleted `build-for-world-hub.yml` (name `Build for World Hub Sync`) and
   repointed fifteen files by filename. `publish-watchdog.yml` and
   `post-deploy-e2e.yml` listen by `name:` and were missed. From 19:17 on
   2026-09-02 neither fired on a publish: the watchdog (and the dispatcher
   inside it) could only run from GitHub's throttled scheduler, and the
   production E2E did not run at all. Both now name `Publish Club Arena`, and
   `tests/workflow-run-names-a-live-workflow.law.test.ts` refuses any
   listener whose name no workflow carries.

2. **The watchdog's orphan sweep died of its own timeout, every run.**
   `orphan-work-watchdog.sh` called `gh api compare` once per branch for all
   ~570 branches that are ahead of main. Six minutes is the job timeout; every
   scheduled run since 19:17 ended "cancelled" at SIGTERM inside that loop and
   never reached the stuck-PR pass. The walk is now local git against the
   full-history checkout: 16 seconds, zero API calls per branch.

3. **The dispatcher never dispatched the autopilot sweep.** `lastAnyRun()`
   counted any run as "the workflow ran". Autopilot runs on every
   `pull_request` event, and those runs skip the sweep job by design, so the
   sweep - the thing that opens pull requests for orphaned branches and
   re-triggers dead ones - had run twice in six hours on a thirty-minute cron
   while the dispatcher saw a workflow that ran ten times an hour. Per-item
   events (`pull_request`, `pull_request_target`, `issue_comment`, ...) are no
   longer evidence that scheduled work happened.

4. **`agent-open-pr.yml` fired on `create` only.** A branch born at main's
   sha - an interrupted first push, an agent pushing twice - had nothing to
   open at `create`, got nothing at `push`, and waited on the sweep in (3).
   Measured on this very branch: pushed with a real commit at 01:23, no pull
   request at 01:40. It now fires on `push` as well, guarded by "no open PR
   and at least one commit ahead of main", and runs on the estate's runner
   where the 2026-08-23 cost reason no longer applies.

The watchdog's alarm job ("Production is serving main") stays on GitHub's
pool on purpose: if the box dies it must be able to say so. The heavy sweep
and the dispatcher move to the box.
