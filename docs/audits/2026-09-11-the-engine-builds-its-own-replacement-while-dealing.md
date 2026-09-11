# The engine builds its own replacement while it is dealing

2026-09-11, found while sweeping for more of the same class of defect as
`docs/changelog/2026-09-11-a-scrape-is-not-a-stall.md`. This one is larger than
that, and larger than anything else found today.

## What happens

`engine-release-transaction.sh` calls `build-engine-image.sh` on **engine-01
itself**, which runs `docker build` (npm install and `tsc` inside it) with a
1,500-second budget. engine-01 has three cores and is the box dealing live
poker. CLAUDE.md 1.1 records the intent - "the deploy workflow, which built the
image BEFORE the gate, while play continued" - and the reason is sound: keep
the maintenance break short by having the image ready before it starts.

Nobody measured what the build does to the play it runs beside.

## Measured, one deploy, 2026-09-11

`docker buildx build --build-arg GIT_COMMIT_SHA=0bde95ca...` running on the
host, engine serving throughout:

| UTC                      | load (3 cores) | `/health`            | tables dealing | hands in window |
| ------------------------ | -------------: | -------------------- | -------------: | --------------: |
| 21:06 no build           |           1.42 | fast                 |            311 |           1,051 |
| 21:21 build, heavy phase |      **20.46** | **timed out at 10s** |              - |               - |
| 21:22                    |          20.46 | **timed out**        |              - |               - |
| 21:23                    |           8.80 | slow                 |            170 |          **97** |
| 21:25 build, light phase |           2.08 | 18 ms                |            183 |             570 |

`/metrics` timed out at **20 seconds** during the same window, against 136-502
ms when the box is quiet. Hands in the dealRate window fell about 90%.

The heavy phase lasted roughly four minutes. In the last 24 hours this workflow
ran 10 successful deploys, 11 failures and 38 superseded runs.

## Why the cheap mitigations do not work

Worth writing down so nobody spends the hour proving it again:

- **A cgroup quota on the build command does nothing.** `docker build` is a
  thin client; the work happens in `buildkitd`'s own cgroup. Wrapping the CLI
  in `systemd-run -p CPUQuota=` bounds the wrong process. The running process
  tree confirms it: `runc ... /var/lib/docker/buildkit/executor/...`.
- **`--cpuset-cpus` and `--cpu-shares` are ignored under buildkit.** They apply
  to the legacy builder only, and switching to it changes caching and build
  semantics on the one path that must not surprise anybody.
- **Limiting buildkitd on the box** would be a hand edit to host configuration,
  which CLAUDE.md 10.84 forbids for exactly the reason that it then differs
  from the repo and nobody can see it.

## The fix

Build the image somewhere that is not serving poker, and let engine-01 only
pull and run it.

The estate already owns the hardware and it is already paid for. CLAUDE.md
1.1.7: `estate-ci-eu-1`, `-eu-2` and `-eu-3` are cpx62 boxes with **16 cores
each**, running CI runners, and the same section records them sitting at load 1
with idle runners while work queued elsewhere. A 16-core box builds this image
without noticing it.

Shapes, cheapest first:

1. **Build in the existing GitHub Actions job on an estate runner**, then ship
   the image to engine-01 as a `docker save | ssh | docker load`, or push to a
   registry the host pulls from. The release protocol is unchanged: the
   transaction still verifies the image id, the revision label, the source-tree
   label and the build contract before it will cut over, and those checks are
   what make the image trustworthy, not where it was built.
2. If the archive transfer is unattractive, run the build on an estate box over
   SSH from the same transaction, keeping every existing proof step.

Either way the maintenance break stays as short as it is now, because the image
is still ready before the gate.

## What this probably also explains

Several things measured today that were attributed to steady-state load, and
should be re-measured once the build moves:

- `EngineCoreOutOfHeadroom` pending, and main-loop p50 readings that bounced
  between 24 ms and 343 ms within minutes;
- the horse decision queue reaching 520 deep with its head pinned at the
  8-second deadline, and ~49 decisions a second expiring into blind folds;
- `poker_hand_projection_outbox` at 24,442 rows and 42 minutes behind, growing
  about 400 a minute, with drains deferring and failing;
- `up{job="engine_game_server"}` flapping twice in an hour.

None of those is necessarily caused by the build alone. All of them are made
worse by four minutes of near-total CPU starvation, several times a day, on the
one thread that cannot be parallelised.
