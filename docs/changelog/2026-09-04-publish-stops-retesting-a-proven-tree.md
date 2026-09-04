# The publisher tested the same bytes twice

## The measurement Dan pushed back on

He is right that this used to be fast. Before, an agent pushed and Vercel
published in under five minutes. Measured on 2026-09-04, Club Arena is
**23-35 minutes** push-to-live. World Hub, on the same estate, is still
**~5-6 minutes** - its Vercel builds are 2m33s to 4m27s.

The difference is structural, and it arrived with the origin migration.

**World Hub**: merge -> Vercel builds -> live. One build.

**Club Arena**: merge -> `publish-club-arena.yml` runs the client suite in four
shards, builds the bundle, and rsyncs it. A second full build-and-test cycle
that World Hub does not have, because Vercel does that job for it.

Broken down, publish #222 took 12.6 minutes:

| job               | queued    | ran      |
| ----------------- | --------- | -------- |
| publish-needed    | 3.3m      | 0.1m     |
| client-tests x4   | 3.8-6.6m  | ~2m each |
| build-and-store   | 5.5m      | 3.4m     |
| publish-to-origin | **11.9m** | 0.6m     |

**~6 minutes of work, ~12 minutes waiting for a runner.**

## Two changes

**Capacity.** `estate-ci-eu-3` was provisioned and Club Arena went from 6
runners to 12 across two boxes. `estate-ci-eu-1` had been sitting at **load 41
on 8 cores** - the vitest cap holds per job, but Vite builds and Playwright
still take every core, so six concurrent jobs on one box thrash anyway. Load
fell to 4.85 immediately.

**Stop proving the same tree twice.** On a squash merge the resulting commit
usually has the SAME TREE as the pull request head that CI just proved green.
Identical bytes, tested twice, on the critical path between a merge and a
player seeing the change.

`publish-needed` now compares **tree hashes**, not merge lineage:

1. read the target commit's tree,
2. find the pull request that produced it,
3. read that PR head's tree,
4. if they are equal AND `Client Unit Tests (vitest)` was green on that head,
   set `tests_proven=true` and skip the shards.

If main moved between the PR's last CI run and the squash, the trees differ and
the shards run exactly as before. It can only skip when the content is
bit-identical to something that already passed. Any doubt - no PR, no green
check, an API error - and it stays false.

## The trap this change had to avoid

`publish-to-origin` declares `needs: [publish-needed, build-and-store,
client-tests]`, and **GitHub skips the dependents of a skipped job by default**.
Gating the shards without touching that would have made the publisher publish
NOTHING on exactly the fast path this exists to create - the same shape as the
2026-08-23 incident where a skipped `changes` job took every required check down
with it and a ruleset counted the skips as satisfied.

So `publish-to-origin` is now `always()` with explicit results: publish when the
build succeeded and the tests either passed or were provably unnecessary. **A
client-tests FAILURE still stops the publish.**

## What this does not fix

Autopilot latency. Measured on tonight's merges, the gap between the last check
going green and the merge landing was **9.6m, 3.6m, 1.8m, 1.9m** - dead time
after everything was already proven. That is the next thing to look at, and it
is not addressed here.
