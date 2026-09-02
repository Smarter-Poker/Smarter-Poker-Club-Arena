# The Publisher Queue Was Wedged, Not Busy

2026-09-02, 16:07 to 17:05 UTC. Four commits merged to `main` and not one
push-triggered publish run was created. Production stayed on `0f47ad06`.

## The evidence that it was the queue, not the trigger

`Main Rewind Guard` triggers on exactly the same `push: branches: [main]` as
the publisher. It fired for every one of the four merges:

| Commit           | Main Rewind Guard | Build for World Hub Sync |
| ---------------- | ----------------- | ------------------------ |
| `94093ed4` 16:39 | ran               | **no run**               |
| `2c7d411a` 16:59 | ran               | **no run**               |
| `06d8df1b` 17:00 | ran               | **no run**               |
| `9c7bd892` 17:01 | ran               | **no run**               |

So pushes were being delivered and this workflow alone stopped receiving them.
The workflow's `state` was `active` throughout, `allowed_actions` was `all`,
and githubstatus reported Actions operational.

Meanwhile three `workflow_dispatch` runs (3036, 3037, 3038) sat `queued` with
**zero jobs**, and the API refused to cancel any of them:

    409 Cannot cancel a workflow run that has not been queued yet.

Two more had been in that state since the previous evening, one for 21 hours.

Three runs pending in one group is already impossible under the rule this
workflow uses. `cancel-in-progress: false` means a new run cancels the older
PENDING run, so the group holds at most one in-flight build plus one waiting.
Three of them, none running, none cancellable, and nothing executing to release
them, is a group that is wedged rather than busy.

## The fix

There is no API to reset a concurrency group. What there is, is the key: a run
only queues behind runs that share its group name. So the key now carries a
generation, and the generation is bumped:

    group: build-world-hub-${{ github.ref }}      ->
    group: build-world-hub-g2-${{ github.ref }}

Every future run gets a clean group. If it happens again, bump it again, and
say in the commit which runs were stuck so the next person can tell a wedge
from a busy queue.

The old group is left to whatever GitHub eventually does with those runs. They
are harmless if they ever wake: every run publishes the TIP of main, so a late
one either publishes the current tip or has its bundle refused by the sync step
as older than what is deployed.

`cancel-in-progress: false` is unchanged and still correct, for the reason
recorded above it in 2026-08-21.

## What this does not explain

The same afternoon, every scheduled workflow in the repository stopped firing
and stayed silent through two full disable/enable cycles. That is tracked
separately in #2660, which stops the healer sleeping through it and dispatches
the starved work rather than only re-registering the cron. Whether the two
share a cause is not established; what is established is that `push`,
`pull_request` and `workflow_dispatch` were all being delivered normally while
both were happening.

## Verified

- `no-commit-left-behind.law`, `deployAndPublishAreHonest`,
  `shipped-invariants`, `law-registry.law`: 120 of 120 passing. The law's
  pattern is `group: build-world-hub[^\n]*`, so the generation suffix is
  matched by the existing pin rather than needing it weakened.
- The workflow still parses, with all four jobs intact.
