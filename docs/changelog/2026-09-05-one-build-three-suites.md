# 2026-09-05 - One build, three suites

Branch: `perf/one-build-three-suites`. Dan: "the speed time of the push and
publish of the Club Arena and World Hub, whatever is currently slowing these
down, needs to be fixed at the root cause, then hardened."

## Where the time actually goes

Measured from the GitHub API over the most recent runs, not estimated:

| stage                    | p50      | p90 / max |
| ------------------------ | -------- | --------- |
| PR created -> merged     | **6.8m** | 62.9m     |
| `ci.yml` wall time       | **6.8m** | 11.5m     |
| runner queue wait        | **2s**   | -         |
| `publish-club-arena.yml` | 3.1m     | 5.7m      |

The first two numbers being the same number is the finding: **CI is the merge
latency.** Auto-merge is already armed the moment `agent-open-pr.yml` opens the
PR, so nothing waits on a sweep, and the queue wait is two seconds - 33 runners
across three 16-core boxes is not the constraint. A Club Arena change reaches
players in about ten minutes and roughly seven of them are `ci.yml`.

Inside `ci.yml`, one job is the critical path:

| job               | p50      | max  |
| ----------------- | -------- | ---- |
| **CSS Beat E2E**  | **334s** | 420s |
| Client Unit Tests | 252s     | 614s |
| Server Engine     | 141s     | 213s |
| Production Build  | 110s     | 175s |
| TypeScript Check  | 99s      | 139s |

And inside that job, on runs 8843 and 8844:

| step                                     | run 8843 | run 8844 |
| ---------------------------------------- | -------- | -------- |
| Build this commit                        | 39s      | 79s      |
| Run the beats                            | 52s      | 98s      |
| **Table Studio purchase/sync/a11y gate** | **141s** | **200s** |
| Insurance and Rabbit Hunt gate           | 11s      | 15s      |

## The root cause

The Table Studio suite is not slow because of what it tests. It is slow because
it **starts a Vite DEV server and compiles the whole application a second
time** - in a job that had already built the application thirty lines earlier
and was already serving it on another port.

The only thing preventing it from using that build was
`VITE_CUSTOMIZATION_TEST_HARNESS`: a build-time flag gating the lazy dev
showcase route the spec drives. The suite could not see the route in the
existing bundle, so it made its own - and a dev server compiling a heavy route
on demand is far slower than a production build plus `vite preview`.

`test:e2e:financial-decisions` has the identical shape and pays the same cost
in miniature.

## The fix

CI builds **once**, with both harness flags, and every suite shares that one
preview.

- `Build this commit` sets `VITE_CUSTOMIZATION_TEST_HARNESS` and
  `VITE_FINANCIAL_DECISION_TEST_HARNESS`.
- The preview moves into its own step, `Serve one build to every suite`. It
  used to be started inside the beats step under `trap ... EXIT`, which is
  exactly why it could not be shared: it died with that step.
- Both Playwright configs take `ARENA_SHARED_PREVIEW_URL`. When it is set there
  is no `webServer` and no second compile. When it is not - a developer running
  the suite locally - they behave precisely as before.
- `Stop the shared preview` reaps it on `always()`. `--strictPort` means an
  orphan does not fall back to another port, it fails every later job on that
  runner, so a server that outlives its step needs a reaper that runs even when
  a suite fails.

## Proven, not projected

Run end to end on real hardware before this was committed:

```
build once, harness flags on ............... 34s   (the job already pays this)
/hub/club-arena/dev/customization-studio ... 200   (the route is in the bundle)
customization against the shared preview ... 21s   4 passed
financial-decisions against it ............. 6s    2 passed
```

Both suites pass against a `vite preview` of the production build, which was
the real risk: had either depended on dev-server behaviour, the gate would have
been weakened rather than sped up. They do not.

**152-215s of every merge becomes about 27s.** CSS Beat E2E should land near
175s, which hands the critical-path title to Client Unit Tests at 252s - see
the last section.

## Why the flag stays build-time

The obvious cheaper-looking alternative is to make the harness a **runtime**
toggle, so one bundle serves both production and the tests. That was considered
and rejected: it would put a switch in the players' bundle that turns on
internal routes, and the reason those routes are gated at all is that they
should not exist in production.

Keeping the flag build-time means the harness bundle is a throwaway CI artifact.
`Production Build` and `publish-club-arena.yml` both build without the flags, so
nothing a player downloads contains the harness routes.

That reduces the safety of this whole change to a single property, which is
what the law below exists to hold.

## Hardening

`tests/one-build-three-suites.law.test.ts` (registered in `docs/laws.d/`) pins:

- **the harness flags appear in the `css-beats-e2e` job and nowhere else** -
  not in `Production Build`, not in `publish-club-arena.yml`. If this ever
  fails, the fix is not to relax it; a throwaway CI flag has reached the bundle
  players download;
- the preview is started in its own step and the beats step starts none of its
  own, so the `trap ... EXIT` that forced the second compile cannot return;
- both harness suites point at the shared preview;
- the reaper runs on `always()`;
- both configs keep their `webServer` fallback, so the suites still run locally
  with no shared preview - without it this change would make them unrunnable
  outside CI.

## What this does not touch

**Client Unit Tests, p50 252s and max 614s**, becomes the critical path once
CSS Beat drops below it. That is a separate piece of work with a separate root
cause (a 9,000-test suite, and a max nearly triple its median, which usually
means one file is occasionally very slow rather than everything being slightly
slow). Measuring it properly comes before changing it.

**The World Hub** is measured in the same pass and is a different shape. Its
gates are fast (p50 1.4m, max 1.6m) and its merge p50 is 3.1m; the time is in
the Vercel build, ~2.6-4.1m, broken down from the build events as: clone 15.1s,
compile 30.4s, finalizing page optimization 32.4s, collecting build traces
22.2s, deploying outputs 28.5s, creating build cache 16.8s, uploading 644 MB of
build cache 7.4s. The single biggest lever there is not a config flag - it is
that `public/` holds **632 MB** of media (422 MB images, 120 MB avatars, 30 MB
videos) which is cloned, traced, deployed and cached on every build whether or
not a byte of it changed. Moving that to the static origin Club Arena already
publishes to is a real programme with real blast radius, and it is written down
here rather than started in this PR.
