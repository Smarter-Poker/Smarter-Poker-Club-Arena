# The Horse journal's evidence waited behind the decisions it describes, and expired there

Date: 2026-09-29. Owner lane: Phase 6A/6B/6D final live evidence on `c0c986aded5d25e952cb154c46599b6307f165bd`.

## What was measured

Release c0c986ad (container started 2026-09-29T03:55:58Z) carries the journal fixes of the previous lane: validate once per segment digest, writer not niced, queue 8,192 records / 64 MiB, one catalog per shard. Read from `public.horse_brain_flush_receipts` (`source_release like 'c0c986ad%'`, 03:56Z to 05:56Z, 15-minute bins, `docs/evidence/phase6d/capture-health-2026-09-29-c0c986ad.json`):

- `phase15_journal_queue_capacity` 0 and `phase15_journal_lock_retry` 0 in every bin. The journal's own queue and catalog shed nothing, and it recorded exactly what it was offered: 888,955 enqueued, 888,955 recorded.
- `phase15_journal_capture_unavailable` 55,701 against 888,955 enqueued (6.27%), and not spread evenly: 0 in the calm half hours (04:45Z to 05:14Z), 547 to 6,825 a bin from 04:00Z, 21,304 in the 05:15Z bin (20.0% of that bin's enqueued) and 21,143 in the 05:30Z bin. Over the 0.5% line the assignment sets, so the evidence run stopped and the cause was read instead.

## Root cause, read from the running host and the code

`capture_unavailable` is not the journal failing. Its client-side sources are the `.catch` of the enqueue that carries a finalized execution (`OBSERVE_EXECUTION`), a discarded-card execution and the retirement record of an undispatched request (`OBSERVE_REQUEST_RETIREMENT`) to the decision worker, which owns the journal writer. Each of those was an ordinary job at the TAIL of the worker client's FIFO with the decision deadline of 8 seconds.

engine-01 is CPU-saturated in bursts (at 05:49Z: 1.0% idle, 24.9% system, the two niced decision-worker threads at 22% and 30% of a core), read over ssh and Prometheus:

| 5-minute sample, UTC | 05:10 | 05:15 | 05:20 | 05:25 | 05:30 | 05:35 | 05:40 | 05:45 |
| -------------------- | ----: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| worker queue depth   |    20 |   497 |   743 |   700 |   830 |   757 |   682 |   156 |
| oldest queued age ms |   304 | 6,539 | 8,538 | 13,730 | 12,420 | 13,559 | 9,509 | 2,377 |
| expired jobs / s     |   0.0 |   0.0 |  23.4 |  39.3 |  47.5 |  45.7 |  40.8 |   9.4 |

The queue was 500 to 830 deep with its head 8.5 to 13.7 seconds old, so a job at its tail was more than 8 seconds old before the worker reached it and expired unposted. A capture job expiring counted `capture_unavailable`. A decision that expires undispatched makes it worse: `observeUndispatchedRetirement` enqueues that request's retirement record at the same tail with the same 8 seconds, at the moment the queue is proven to be more than 8 seconds deep, so that record is lost by construction. Minute by minute over 105 minutes (04:05Z to 05:49Z) `capture_unavailable` and the engine log's `HandHistory.horse_mind_observation_failed` (a completed-hand observation expiring after 8000 ms, 22,794 lines) correlate at 0.949; `capture_unavailable` totals 55,701, 2.44 per expired observation. The same expiry also dropped the completed-hand observation itself, which carries the `accepted_hand` journal record and the horses' learner update. That is a correlation and a code path, not a per-type counter: expiry counts are not exported by request type.

The saturation is a capacity condition (engine-01: two physical cores, four SMT threads, 514 active tournaments and 837 active tables at 05:49Z) and is not addressed here. Decisions in the same window fell back at 137 to 165 a minute (`poker_horse_decision_fallbacks_total`) between 05:25Z and 05:40Z. What this changes is that the evidence of what the horses did no longer disappears when they are slow.

The same bursts are visible on the previous release: fa480b9b's receipts carry 57,554 `capture_unavailable` in bursts (`capture-health-2026-09-29-fa480b9b.json`). Its shape is the same and it runs the same code; it was not separately measured against the host.

## The changes (`server/src/engine/horseDecision/client.ts`)

- A capture lane. `OBSERVE_EXECUTION`, `OBSERVE_DISCARD_EXECUTION` and `OBSERVE_REQUEST_RETIREMENT` are queued after other capture jobs and ahead of every unposted decision, so they wait only for the at most `maxInFlight` (32) jobs already posted to the worker (about three seconds at the measured rate), never for the backlog. They write private evidence and touch no decision state; the worker spends well under a millisecond on one. The lane holds 1,024 jobs (`HORSE_CAPTURE_LANE_MAX_QUEUED`); a job past that queues at the tail like any other and is not refused. A dispatch barrier's commit keeps its place: the barrier index moves with the insertion.
- `OBSERVE_COMPLETED_HAND` keeps its FIFO position, because the learner it runs shares state with decisions and effect commits and this change does not reorder that. It and the capture jobs take `observationDeadlineMs` (default `HORSE_OBSERVATION_DEADLINE_MS`, 60 s, never below `jobTimeoutMs`) instead of the decision's 8 s. A decision keeps the turn clock. The worker-integrity (execution) clock is unchanged.

## Pinned by

Six tests in `client.test.ts` ("the capture lane"), run against the previous `client.ts` five are red (the sixth pins that a decision still expires on the decision deadline and is green either way):

- a finalized execution is posted ahead of two unposted decisions (old: the next post was the decision behind it);
- capture jobs keep their own order, and a dispatch barrier's commit still lands after older work and before its successors (old queue `[3, 100, 101, 5, 4]`, new `[100, 101, 3, 5, 4]`);
- the lane is bounded at 1,024 and the job past it queues at the tail;
- a finalized execution behind unposted decisions is not expired at 1,100 ms with a 1,000 ms decision deadline (old: expired, which is the `capture_unavailable` fire);
- a completed-hand observation behind two decisions is not expired at 1,100 ms with a 1,000 ms decision deadline (old: expired).

## What is not claimed

Nothing here is verified on a serving release. c0c986ad and every release before this merge carry the tail queueing. The fix reaches engine-01 through `stage-engine-release.yml` and `auto-deploy-hetzner.yml` in a certified maintenance window. Until a release containing it serves and its own receipts show `phase15_journal_capture_unavailable` near zero at comparable load, G5 and G6 for 6A, 6B and 6D stay `defective` and the population, replay and route proof are not run on it. If the box saturates hard enough that even three seconds of posted work exceeds the 60 second observation deadline, jobs still shed, and they shed as expiries. The CPU condition itself is not fixed by this change.
